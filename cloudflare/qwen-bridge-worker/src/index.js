const MAX_BODY_BYTES = 32 * 1024;
const MAX_ACTIVE_TASKS = 25;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/;
const TASK_PATH_RE = /^\/v1\/tasks\/(\d+)$/;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function configuredSecrets(env) {
  return [
    ['qwen', env?.AKI_BRIDGE_SECRET],
    ['kimi', env?.AKI_KIMI_SECRET],
  ].filter(([, secret]) => typeof secret === 'string' && secret.length >= 32);
}

function authorize(request, env) {
  const secrets = configuredSecrets(env);
  if (!secrets.length) return { ok: false, response: json({ error: 'bridge secret is not configured' }, 503) };
  const authorization = request.headers.get('authorization');
  const matched = secrets.find(([, secret]) => authorization === `Bearer ${secret}`);
  if (!matched) {
    return {
      ok: false,
      response: json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="aki-qwen-bridge"' }),
    };
  }
  return { ok: true, owner: matched[0] };
}

async function readJsonObject(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    return { ok: false, response: json({ error: 'content-type must be application/json' }, 415) };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: `request body exceeds ${MAX_BODY_BYTES} bytes` }, 413) };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: json({ error: 'invalid JSON body' }, 400) };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, response: json({ error: 'JSON body must be an object' }, 400) };
  }
  return { ok: true, body };
}

function validateCreateBody(body) {
  if (typeof body.tool !== 'string' || !TOOL_NAME_RE.test(body.tool)) {
    return { ok: false, error: 'tool must be 1-128 characters: letters, numbers, _, ., :, or -' };
  }
  const args = body.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'arguments must be a JSON object' };
  }
  return { ok: true, tool: body.tool, args };
}

function readIdempotencyKey(request) {
  const key = request.headers.get('idempotency-key') ?? '';
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    return { ok: false, response: json({ error: 'Idempotency-Key must be 16-128 characters: letters, numbers, _, ., :, or -' }, 400) };
  }
  return { ok: true, key };
}

async function findTaskByIdempotencyKey(env, owner, key) {
  return env.DB
    .prepare('SELECT id, status, tool, arguments_json FROM aki_bridge_tasks WHERE owner = ?1 AND idempotency_key = ?2')
    .bind(owner, key)
    .first();
}

function replayResponse(row, tool, argumentsJson) {
  if (!row) return null;
  if (row.tool !== tool || row.arguments_json !== argumentsJson) {
    return json({ error: 'Idempotency-Key is already bound to a different task payload' }, 409);
  }
  return json({ id: Number(row.id), status: row.status }, 200, { 'idempotency-replayed': 'true' });
}

async function createTask(request, env, owner) {
  const idempotency = readIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const validated = validateCreateBody(parsed.body);
  if (!validated.ok) return json({ error: validated.error }, 400);
  const argumentsJson = JSON.stringify(validated.args);

  const existing = await findTaskByIdempotencyKey(env, owner, idempotency.key);
  const replay = replayResponse(existing, validated.tool, argumentsJson);
  if (replay) return replay;

  // Admission and insert are one SQLite statement, so concurrent distinct keys cannot all observe the same pre-insert queue count and overfill the cap.
  const result = await env.DB
    .prepare(`INSERT OR IGNORE INTO aki_bridge_tasks (owner, idempotency_key, tool, arguments_json)
      SELECT ?1, ?2, ?3, ?4
      WHERE (SELECT COUNT(*) FROM aki_bridge_tasks WHERE status IN ('pending', 'running')) < ?5`)
    .bind(owner, idempotency.key, validated.tool, argumentsJson, MAX_ACTIVE_TASKS)
    .run();
  if (Number(result?.meta?.changes ?? 0) === 1) {
    const id = Number(result?.meta?.last_row_id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: 'failed to create task' }, 502);
    return json({ id, status: 'pending' }, 202, { 'idempotency-replayed': 'false' });
  }

  const raced = await findTaskByIdempotencyKey(env, owner, idempotency.key);
  return replayResponse(raced, validated.tool, argumentsJson)
    ?? json({ error: 'bridge queue is full; wait for an existing task to finish' }, 429, { 'retry-after': '5' });
}

function parseStoredResult(row) {
  if (row.result_json == null) return { ok: true, result: null };
  try {
    return { ok: true, result: JSON.parse(row.result_json) };
  } catch {
    return { ok: false };
  }
}

async function getTask(id, env, owner) {
  const row = await env.DB
    .prepare('SELECT status, result_json, error FROM aki_bridge_tasks WHERE id = ?1 AND owner = ?2')
    .bind(id, owner)
    .first();
  if (!row) return json({ error: 'task not found' }, 404);
  const parsed = parseStoredResult(row);
  if (!parsed.ok) return json({ error: 'stored task result is invalid JSON' }, 502);
  return json({ status: row.status, result: parsed.result, error: row.error ?? null });
}

async function readiness(env) {
  try {
    await env.DB.prepare('SELECT id FROM aki_bridge_tasks LIMIT 1').first();
    return json({ ok: true, service: 'aki-qwen-bridge', d1: true });
  } catch {
    return json({ ok: false, error: 'D1 mailbox is not ready' }, 503);
  }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    return json({ ok: true, service: 'aki-qwen-bridge' });
  }

  const taskMatch = url.pathname.match(TASK_PATH_RE);
  const isTaskEndpoint = url.pathname === '/v1/tasks' || url.pathname === '/v1/ready' || Boolean(taskMatch);
  let auth = null;
  if (isTaskEndpoint) {
    auth = authorize(request, env);
    if (!auth.ok) return auth.response;
  }

  if (url.pathname === '/v1/ready') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET' });
    return readiness(env);
  }

  if (url.pathname === '/v1/tasks') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
    return createTask(request, env, auth.owner);
  }

  if (taskMatch) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { allow: 'GET' });
    const id = Number(taskMatch[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'invalid task id' }, 400);
    return getTask(id, env, auth.owner);
  }

  return json({ error: 'not found' }, 404);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env).catch((error) => {
      console.error('[aki-qwen-bridge] request failed', error);
      return json({ error: 'internal server error' }, 500);
    });
  },
};
