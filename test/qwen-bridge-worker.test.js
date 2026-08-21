import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../cloudflare/qwen-bridge-worker/src/index.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const KIMI_SECRET = 'abcdef0123456789abcdef0123456789';
const IDEMPOTENCY_KEY = 'test-task-key-0001';

function makeEnv({ rows = new Map(), activeCount = 0 } = {}) {
  let nextId = 10;
  const calls = [];
  const idempotency = new Map();
  for (const [id, row] of rows) {
    if (row.idempotency_key) idempotency.set(row.idempotency_key, id);
  }
  const DB = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              calls.push({ kind: 'first', sql, params });
              if (sql.startsWith('SELECT id, status, tool')) {
                const id = idempotency.get(params[0]);
                return id === undefined ? null : { id, ...rows.get(id) };
              }
              if (sql.startsWith('SELECT status')) return rows.get(Number(params[0])) ?? null;
              throw new Error(`unexpected first SQL: ${sql}`);
            },
            async run() {
              calls.push({ kind: 'run', sql, params });
              if (!sql.startsWith('INSERT OR IGNORE INTO aki_bridge_tasks')) throw new Error(`unexpected run SQL: ${sql}`);
              const [key, tool, argumentsJson, maxActive] = params;
              if (idempotency.has(key) || activeCount >= maxActive) return { success: true, meta: { changes: 0, last_row_id: 0 } };
              const id = nextId++;
              rows.set(id, { status: 'pending', result_json: null, error: null, tool, arguments_json: argumentsJson, idempotency_key: key });
              idempotency.set(key, id);
              activeCount += 1;
              return { success: true, meta: { changes: 1, last_row_id: id } };
            },
          };
        },
        async first() {
          calls.push({ kind: 'first', sql, params: [] });
          if (sql.startsWith('SELECT id FROM aki_bridge_tasks')) return rows.values().next().value ?? null;
          throw new Error(`unexpected unbound first SQL: ${sql}`);
        },
      };
    },
  };
  return { env: { DB, AKI_BRIDGE_SECRET: SECRET, AKI_KIMI_SECRET: KIMI_SECRET }, rows, calls };
}

function request(path, { method = 'GET', body, secret = SECRET, contentType = 'application/json', idempotencyKey = IDEMPOTENCY_KEY } = {}) {
  const headers = {};
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  if (idempotencyKey !== null) headers['idempotency-key'] = idempotencyKey;
  if (body !== undefined) headers['content-type'] = contentType;
  return new Request(`https://bridge.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function body(response) {
  return response.json();
}

test('health endpoint is public and discloses no configuration', async () => {
  const { env } = makeEnv();
  const response = await handleRequest(request('/v1/health', { secret: null }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, service: 'aki-qwen-bridge' });
});

test('authenticated readiness checks the D1 mailbox', async () => {
  const { env } = makeEnv();
  const response = await handleRequest(request('/v1/ready'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, service: 'aki-qwen-bridge', d1: true });
});

test('task endpoints accept either client secret and fail closed when none is configured', async () => {
  const { env } = makeEnv();
  const unauthorized = await handleRequest(request('/v1/tasks', { method: 'POST', body: { tool: 'local__run_cmd' }, secret: 'wrong' }), env);
  assert.equal(unauthorized.status, 401);

  const kimi = await handleRequest(request('/v1/ready', { secret: KIMI_SECRET }), env);
  assert.equal(kimi.status, 200);

  const misconfigured = await handleRequest(request('/v1/tasks/1', { secret: null }), {
    ...env,
    AKI_BRIDGE_SECRET: 'short',
    AKI_KIMI_SECRET: 'short',
  });
  assert.equal(misconfigured.status, 503);
});

test('POST /v1/tasks validates shape and inserts only tool plus arguments', async () => {
  const state = makeEnv();
  const response = await handleRequest(request('/v1/tasks', {
    method: 'POST',
    body: { tool: 'local__run_cmd', arguments: { command: 'git status --short' } },
  }), state.env);
  assert.equal(response.status, 202);
  assert.deepEqual(await body(response), { id: 10, status: 'pending' });
  assert.equal(response.headers.get('idempotency-replayed'), 'false');
  const insert = state.calls.find((call) => call.kind === 'run');
  assert.match(insert.sql, /^INSERT OR IGNORE INTO aki_bridge_tasks/);
  assert.deepEqual(insert.params, [IDEMPOTENCY_KEY, 'local__run_cmd', '{"command":"git status --short"}', 25]);
  assert.match(insert.sql, /SELECT COUNT\(\*\).*status IN/s);
  assert.equal(state.calls.some((call) => call.kind === 'first' && call.sql.startsWith('SELECT COUNT')), false);
});

test('POST /v1/tasks requires a valid Idempotency-Key', async () => {
  const { env } = makeEnv();
  const missing = await handleRequest(request('/v1/tasks', {
    method: 'POST',
    body: { tool: 'local__run_cmd', arguments: {} },
    idempotencyKey: null,
  }), env);
  assert.equal(missing.status, 400);

  const invalid = await handleRequest(request('/v1/tasks', {
    method: 'POST',
    body: { tool: 'local__run_cmd', arguments: {} },
    idempotencyKey: 'short',
  }), env);
  assert.equal(invalid.status, 400);
});

test('POST /v1/tasks replays the same key without creating a duplicate', async () => {
  const state = makeEnv();
  const payload = { tool: 'filesystem__read_text_file', arguments: { path: 'C:\\safe.txt' } };
  const first = await handleRequest(request('/v1/tasks', { method: 'POST', body: payload }), state.env);
  assert.equal(first.status, 202);
  assert.deepEqual(await body(first), { id: 10, status: 'pending' });

  const replay = await handleRequest(request('/v1/tasks', { method: 'POST', body: payload }), state.env);
  assert.equal(replay.status, 200);
  assert.deepEqual(await body(replay), { id: 10, status: 'pending' });
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal(state.calls.filter((call) => call.kind === 'run').length, 1);
});

test('POST /v1/tasks rejects reusing a key for a different payload', async () => {
  const state = makeEnv();
  const first = await handleRequest(request('/v1/tasks', {
    method: 'POST',
    body: { tool: 'local__run_cmd', arguments: { command: 'git status' } },
  }), state.env);
  assert.equal(first.status, 202);

  const conflict = await handleRequest(request('/v1/tasks', {
    method: 'POST',
    body: { tool: 'local__run_cmd', arguments: { command: 'git log -1' } },
  }), state.env);
  assert.equal(conflict.status, 409);
});

test('POST /v1/tasks rejects arrays, bad tool names, and a full queue', async () => {
  const state = makeEnv();
  const arrayArgs = await handleRequest(request('/v1/tasks', { method: 'POST', body: { tool: 'local__run_cmd', arguments: [] } }), state.env);
  assert.equal(arrayArgs.status, 400);

  const badTool = await handleRequest(request('/v1/tasks', { method: 'POST', body: { tool: '../shell', arguments: {} } }), state.env);
  assert.equal(badTool.status, 400);

  const full = makeEnv({ activeCount: 25 });
  const fullResponse = await handleRequest(request('/v1/tasks', { method: 'POST', body: { tool: 'local__run_cmd', arguments: {} } }), full.env);
  assert.equal(fullResponse.status, 429);
});

test('GET /v1/tasks/:id returns only status/result/error', async () => {
  const rows = new Map([[42, {
    status: 'done',
    result_json: '{"content":[{"type":"text","text":"clean"}]}',
    error: null,
    tool: 'must-not-leak',
    arguments_json: '{"secret":"must-not-leak"}',
  }]]);
  const { env } = makeEnv({ rows });
  const response = await handleRequest(request('/v1/tasks/42'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    status: 'done',
    result: { content: [{ type: 'text', text: 'clean' }] },
    error: null,
  });
});

test('unknown task is 404 and task collection is not listable', async () => {
  const { env } = makeEnv();
  const missing = await handleRequest(request('/v1/tasks/999'), env);
  assert.equal(missing.status, 404);
  const listAttempt = await handleRequest(request('/v1/tasks'), env);
  assert.equal(listAttempt.status, 405);
});
