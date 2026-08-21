import { log } from './log.js';
import { callSharedTool } from './streamable-bridge.js';

const TABLE = 'aki_bridge_tasks';
const DEFAULT_POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 15_000;
const REQUIRED_ENV = ['AKI_D1_ACCOUNT_ID', 'AKI_D1_DATABASE_ID', 'AKI_D1_API_TOKEN'];

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  tool TEXT NOT NULL,
  arguments_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  result_json TEXT,
  error TEXT,
  claimed_at INTEGER,
  finished_at INTEGER
)`;
const TABLE_INFO_SQL = `PRAGMA table_info(${TABLE})`;
const ADD_IDEMPOTENCY_KEY_SQL = `ALTER TABLE ${TABLE} ADD COLUMN idempotency_key TEXT`;
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_${TABLE}_pending ON ${TABLE} (status, id)`;
const CREATE_IDEMPOTENCY_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_idempotency_key ON ${TABLE} (idempotency_key) WHERE idempotency_key IS NOT NULL`;
const SELECT_PENDING_SQL = `SELECT id, tool, arguments_json FROM ${TABLE} WHERE status = 'pending' ORDER BY id LIMIT 1`;
const CLAIM_SQL = `UPDATE ${TABLE} SET status = 'running', claimed_at = unixepoch() WHERE id = ? AND status = 'pending'`;
const FINISH_SQL = `UPDATE ${TABLE} SET status = ?, result_json = ?, error = NULLIF(?, ''), finished_at = unixepoch() WHERE id = ? AND status = 'running'`;

function resultError(body, fallback) {
  const messages = [...(body?.errors ?? []), ...(body?.messages ?? [])].map((entry) => entry?.message).filter(Boolean);
  return messages.length ? messages.join('; ') : fallback;
}

function firstQueryResult(body) {
  return Array.isArray(body?.result) ? body.result[0] : body?.result;
}

function toolErrorText(result) {
  return result?.content?.find((item) => item?.type === 'text')?.text ?? 'tool returned an error';
}

export function readD1BridgeConfig(env = process.env) {
  const present = REQUIRED_ENV.filter((name) => env[name]);
  if (!present.length) return { enabled: false };
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length) return { enabled: false, error: `incomplete D1 bridge config, missing ${missing.join(', ')}` };
  const pollMs = Number(env.AKI_D1_POLL_MS ?? DEFAULT_POLL_MS);
  if (!Number.isFinite(pollMs) || pollMs < 500) return { enabled: false, error: 'AKI_D1_POLL_MS must be a number >= 500' };
  return {
    enabled: true,
    accountId: env.AKI_D1_ACCOUNT_ID,
    databaseId: env.AKI_D1_DATABASE_ID,
    apiToken: env.AKI_D1_API_TOKEN,
    pollMs,
  };
}

export function createD1Client(config, fetchImpl = fetch) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}/query`;
  return {
    async query(sql, params = []) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sql, params }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        let body;
        try {
          body = await response.json();
        } catch {
          return { ok: false, error: `Cloudflare D1 returned non-JSON HTTP ${response.status}` };
        }
        if (!response.ok || body?.success === false) {
          return { ok: false, error: resultError(body, `Cloudflare D1 HTTP ${response.status}`) };
        }
        const data = firstQueryResult(body);
        if (!data || data.success === false) return { ok: false, error: resultError(body, 'Cloudflare D1 query failed') };
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  };
}

export async function ensureD1BridgeSchema(client) {
  const table = await client.query(CREATE_TABLE_SQL);
  if (!table.ok) return table;

  const info = await client.query(TABLE_INFO_SQL);
  if (!info.ok) return info;
  const columns = info.data.results ?? [];
  if (!columns.some((column) => column?.name === 'idempotency_key')) {
    const alter = await client.query(ADD_IDEMPOTENCY_KEY_SQL);
    if (!alter.ok) return alter;
  }

  const pendingIndex = await client.query(CREATE_INDEX_SQL);
  if (!pendingIndex.ok) return pendingIndex;
  return client.query(CREATE_IDEMPOTENCY_INDEX_SQL);
}

export function parseD1Task(row) {
  const id = Number(row?.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'task id must be a positive integer' };
  if (typeof row?.tool !== 'string' || !row.tool.trim()) return { ok: false, error: 'task tool must be a non-empty string' };
  let args;
  try {
    args = JSON.parse(row.arguments_json ?? '{}');
  } catch {
    return { ok: false, error: 'arguments_json must contain valid JSON' };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'arguments_json must decode to an object' };
  return { ok: true, data: { id, tool: row.tool, args } };
}

async function finishTask(client, id, status, result, error) {
  const serialized = result === undefined ? null : JSON.stringify(result);
  return client.query(FINISH_SQL, [status, serialized, error ?? '', String(id)]);
}

export async function processNextD1Task(client, callTool = callSharedTool) {
  const pending = await client.query(SELECT_PENDING_SQL);
  if (!pending.ok) return pending;
  const row = pending.data.results?.[0];
  if (!row) return { ok: true, data: { processed: false } };

  const claim = await client.query(CLAIM_SQL, [String(row.id)]);
  if (!claim.ok) return claim;
  if (Number(claim.data.meta?.changes ?? 0) !== 1) return { ok: true, data: { processed: false } };

  const parsed = parseD1Task(row);
  if (!parsed.ok) {
    const finished = await finishTask(client, Number(row.id), 'error', null, parsed.error);
    return finished.ok ? { ok: true, data: { processed: true, id: Number(row.id), status: 'error' } } : finished;
  }

  const { id, tool, args } = parsed.data;
  let toolResult;
  try {
    toolResult = await callTool(tool, args);
  } catch (error) {
    const finished = await finishTask(client, id, 'error', null, error.message);
    return finished.ok ? { ok: true, data: { processed: true, id, status: 'error' } } : finished;
  }

  const status = toolResult?.isError === true ? 'error' : 'done';
  const error = status === 'error' ? toolErrorText(toolResult) : null;
  const finished = await finishTask(client, id, status, toolResult, error);
  return finished.ok ? { ok: true, data: { processed: true, id, status } } : finished;
}

export function startD1Bridge({ env = process.env, fetchImpl = fetch, callTool = callSharedTool } = {}) {
  const config = readD1BridgeConfig(env);
  if (!config.enabled) {
    if (config.error) log(`[d1-bridge] disabled: ${config.error}`);
    return null;
  }

  const client = createD1Client(config, fetchImpl);
  let stopped = false;
  let timer = null;
  let schemaReady = false;

  async function cycle() {
    if (stopped) return;
    if (!schemaReady) {
      const schema = await ensureD1BridgeSchema(client);
      if (!schema.ok) {
        log(`[d1-bridge] schema check failed: ${schema.error}`);
      } else {
        schemaReady = true;
        log(`[d1-bridge] ready: account=${config.accountId}, database=${config.databaseId}, poll=${config.pollMs}ms`);
      }
    } else {
      const result = await processNextD1Task(client, callTool);
      if (!result.ok) log(`[d1-bridge] poll failed: ${result.error}`);
      else if (result.data.processed) log(`[d1-bridge] task ${result.data.id} -> ${result.data.status}`);
    }
    if (!stopped) timer = setTimeout(cycle, config.pollMs);
  }

  timer = setTimeout(cycle, config.pollMs);
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
