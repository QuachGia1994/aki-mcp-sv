import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1Client, ensureD1BridgeSchema, parseD1Task, processNextD1Task, readD1BridgeConfig } from '../scripts/d1-bridge.js';

test('readD1BridgeConfig stays off until D1 config is complete', () => {
  assert.deepEqual(readD1BridgeConfig({}), { enabled: false });
  const partial = readD1BridgeConfig({ AKI_D1_ACCOUNT_ID: 'acct' });
  assert.equal(partial.enabled, false);
  assert.match(partial.error, /AKI_D1_DATABASE_ID/);
  const valid = readD1BridgeConfig({
    AKI_D1_ACCOUNT_ID: 'acct',
    AKI_D1_DATABASE_ID: 'db',
    AKI_D1_API_TOKEN: 'token',
    AKI_D1_POLL_MS: '750',
  });
  assert.equal(valid.enabled, true);
  assert.equal(valid.pollMs, 750);
});

test('createD1Client unwraps Cloudflare query result', async () => {
  const calls = [];
  const client = createD1Client({ accountId: 'acct', databaseId: 'db', apiToken: 'secret' }, async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, result: [{ success: true, results: [{ id: 1 }], meta: { changes: 0 } }] };
      },
    };
  });
  const result = await client.query('SELECT ?', [1]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.results, [{ id: 1 }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /accounts\/acct\/d1\/database\/db\/query$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
});

test('ensureD1BridgeSchema migrates existing mailboxes for idempotency keys', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('PRAGMA table_info')) {
        return { ok: true, data: { results: [{ name: 'id' }, { name: 'tool' }, { name: 'arguments_json' }] } };
      }
      return { ok: true, data: { results: [], meta: { changes: 0 } } };
    },
  };
  const result = await ensureD1BridgeSchema(client);
  assert.equal(result.ok, true);
  assert.equal(queries.some((sql) => sql.startsWith('ALTER TABLE') && sql.includes('idempotency_key')), true);
  assert.equal(queries.some((sql) => sql.startsWith('CREATE UNIQUE INDEX') && sql.includes('idempotency_key')), true);
});

test('ensureD1BridgeSchema does not re-add an existing idempotency column', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('PRAGMA table_info')) {
        return { ok: true, data: { results: [{ name: 'id' }, { name: 'idempotency_key' }] } };
      }
      return { ok: true, data: { results: [], meta: { changes: 0 } } };
    },
  };
  const result = await ensureD1BridgeSchema(client);
  assert.equal(result.ok, true);
  assert.equal(queries.some((sql) => sql.startsWith('ALTER TABLE')), false);
});

test('parseD1Task rejects malformed arguments before tool execution', () => {
  const result = parseD1Task({ id: 4, tool: 'local__run_cmd', arguments_json: '[]' });
  assert.equal(result.ok, false);
  assert.match(result.error, /object/);
});

test('processNextD1Task claims once and stores a successful tool result', async () => {
  const writes = [];
  const client = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT')) {
        return { ok: true, data: { results: [{ id: 7, tool: 'local__run_cmd', arguments_json: '{"command":"git status"}' }] } };
      }
      writes.push({ sql, params });
      return { ok: true, data: { meta: { changes: 1 }, results: [] } };
    },
  };
  const called = [];
  const result = await processNextD1Task(client, async (tool, args) => {
    called.push({ tool, args });
    return { content: [{ type: 'text', text: 'clean' }] };
  });
  assert.deepEqual(called, [{ tool: 'local__run_cmd', args: { command: 'git status' } }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { processed: true, id: 7, status: 'done' });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].params, ['7']);
  assert.equal(writes[1].params[0], 'done');
  assert.match(writes[1].params[1], /clean/);
  assert.equal(writes[1].params[2], '');
  assert.equal(writes[1].params[3], '7');
});

test('processNextD1Task records tool failures without retrying the task', async () => {
  const writes = [];
  const client = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT')) {
        return { ok: true, data: { results: [{ id: 8, tool: 'filesystem__read_text_file', arguments_json: '{}' }] } };
      }
      writes.push({ sql, params });
      return { ok: true, data: { meta: { changes: 1 }, results: [] } };
    },
  };
  const result = await processNextD1Task(client, async () => ({ content: [{ type: 'text', text: 'rejected: bad path' }], isError: true }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { processed: true, id: 8, status: 'error' });
  assert.equal(writes[1].params[0], 'error');
  assert.equal(writes[1].params[2], 'rejected: bad path');
});
