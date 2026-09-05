// xKiro free-tier read worker. It uses xKiro's OpenAI-compatible tool-calling API but exposes only
// Aki's read-only repo/file primitives to the remote model. No write/shell tool is present in this
// loop, so an xKiro model cannot widen the local mutation boundary server-side.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { USER_DIR } from './userdata.js';
import { resolveOrFail, containedIn } from './roots.js';
import { createRepoSnapshot } from './repo-snapshot-mcp.js';
import { findPath, searchContent } from './search-mcp.js';
import { readTextFile, getFileInfoText } from './filesystem-mcp.js';
import { ok, err } from './mcp-tool.js';

export const XKIRO_CONFIG_PATH = path.join(USER_DIR, 'xkiro.json');
export const XKIRO_API_BASE = 'https://api.xkiro.com/v1';
export const DEFAULT_XKIRO_MODEL = 'minimax/minimax-m3:free';
const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_TOKENS = 3000;
const MAX_TOOL_RESULT_CHARS = 120_000;
const MAX_PROMPT_CHARS = 120_000;

function readStoredConfig() {
  if (!existsSync(XKIRO_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(XKIRO_CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readXKiroConfig() {
  const stored = readStoredConfig();
  const envKey = process.env.XKIRO_API_KEY?.trim();
  const envModel = process.env.XKIRO_MODEL?.trim();
  const storedKey = typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
  const storedModel = typeof stored.model === 'string' ? stored.model.trim() : '';
  const apiKey = envKey || storedKey || '';
  return {
    apiKey,
    model: envModel || storedModel || DEFAULT_XKIRO_MODEL,
    configured: Boolean(apiKey),
    source: envKey ? 'env' : storedKey ? 'file' : 'none',
  };
}

export function writeXKiroConfig({ apiKey, model, clear = false }) {
  const current = readStoredConfig();
  const next = {
    apiKey: clear ? '' : (typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : (typeof current.apiKey === 'string' ? current.apiKey : '')),
    model: typeof model === 'string' && model.trim() ? model.trim() : (typeof current.model === 'string' && current.model.trim() ? current.model.trim() : DEFAULT_XKIRO_MODEL),
  };
  if (!clear && !next.apiKey && !process.env.XKIRO_API_KEY?.trim()) throw new Error('xKiro API key is required');
  const tmp = `${XKIRO_CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, XKIRO_CONFIG_PATH);
  return { configured: Boolean(process.env.XKIRO_API_KEY?.trim() || next.apiKey), model: process.env.XKIRO_MODEL?.trim() || next.model, source: process.env.XKIRO_API_KEY?.trim() ? 'env' : next.apiKey ? 'file' : 'none' };
}

export const isXKiroConfigured = () => readXKiroConfig().configured;

async function requestJson(url, { method = 'GET', apiKey, body, fetchImpl = fetch, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? Number(process.env.XKIRO_TIMEOUT_MS || 90_000));
  try {
    const res = await fetchImpl(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const message = data?.error?.message || data?.message || text || `HTTP ${res.status}`;
      throw new Error(`xKiro ${res.status}: ${message}`);
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('xKiro request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getXKiroUsage({ fetchImpl = fetch } = {}) {
  const config = readXKiroConfig();
  if (!config.configured) return { configured: false, model: config.model, source: config.source };
  try {
    const usage = await requestJson(`${XKIRO_API_BASE}/usage`, { apiKey: config.apiKey, fetchImpl, timeoutMs: 20_000 });
    return { configured: true, model: config.model, source: config.source, usage };
  } catch (e) {
    return { configured: true, model: config.model, source: config.source, error: e.message };
  }
}

export async function ensureFreeXKiroModel(model, { fetchImpl = fetch } = {}) {
  const catalog = await requestJson(`${XKIRO_API_BASE}/models`, { fetchImpl, timeoutMs: 20_000 });
  const entry = Array.isArray(catalog?.data) ? catalog.data.find((item) => item?.id === model) : null;
  if (!entry) throw new Error(`xKiro model not found in live catalog: ${model}`);
  if (entry.access_tier !== 'free') throw new Error(`xKiro model blocked by Aki free-only policy: ${model} has access_tier=${entry.access_tier ?? 'unknown'}`);
  return entry;
}

function scopedPath(dir, requested) {
  const abs = path.resolve(dir, requested || '.');
  if (!containedIn(abs, dir)) throw new Error(`path escapes worker cwd: ${requested}`);
  return abs;
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'repo_snapshot',
      description: 'Read one bounded repository snapshot for the locked cwd. Use this first for broad codebase understanding.',
      parameters: {
        type: 'object',
        properties: {
          maxFiles: { type: 'integer', minimum: 1, maximum: 80 },
          maxChars: { type: 'integer', minimum: 1000, maximum: 120000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_path',
      description: 'Find files or directories inside the locked cwd. path may be relative to cwd but cannot escape it.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_content',
      description: 'Search text recursively inside the locked cwd. Use a regex OR query for aliases; path may narrow scope.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_text_file',
      description: 'Read a text file inside the locked cwd. Prefer head/tail for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          head: { type: 'integer', minimum: 1, maximum: 5000 },
          tail: { type: 'integer', minimum: 1, maximum: 5000 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_info',
      description: 'Get metadata for a file or directory inside the locked cwd without reading its content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];

function capToolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n... truncated by xKiro worker tool-result cap`;
}

function estimateTurnTokens(messages, maxTokens) {
  // Deliberately conservative: JSON/function schema and English/code average better than 3 chars/token.
  // This is only a free-quota guard, not billing accounting; real usage from xKiro remains authoritative.
  const inputChars = JSON.stringify(messages).length + JSON.stringify(TOOL_DEFS).length;
  return Math.ceil(inputChars / 3) + maxTokens;
}

export async function executeXKiroReadTool(name, args, dir) {
  switch (name) {
    case 'repo_snapshot':
      return createRepoSnapshot({ path: dir, maxFiles: Math.min(args?.maxFiles ?? 60, 80), maxChars: Math.min(args?.maxChars ?? 90000, 120000) });
    case 'find_path':
      return findPath(args.query, scopedPath(dir, args.path), Math.min(args.limit ?? 100, 200));
    case 'search_content':
      return searchContent(args.query, scopedPath(dir, args.path), args.glob, Math.min(args.limit ?? 100, 200));
    case 'read_text_file':
      return readTextFile({ path: scopedPath(dir, args.path), head: args.head, tail: args.tail });
    case 'get_file_info':
      return getFileInfoText(scopedPath(dir, args.path));
    default:
      throw new Error(`tool not allowed in xKiro read worker: ${name}`);
  }
}

export async function runXKiroRead(
  { prompt, cwd, model, reasoning = 'none', maxSteps = DEFAULT_MAX_STEPS, maxTokens = DEFAULT_MAX_TOKENS },
  { fetchImpl = fetch, toolExecutor = executeXKiroReadTool } = {},
) {
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) return err(`rejected: ${resolved.error.message}`);
  const dir = resolved.dir;
  const config = readXKiroConfig();
  if (!config.configured) return err(`xKiro is not configured — set XKIRO_API_KEY or save a key in ${XKIRO_CONFIG_PATH}`);
  if (prompt.length > MAX_PROMPT_CHARS) return err(`xKiro prompt too large (${prompt.length} chars > ${MAX_PROMPT_CHARS})`);

  const selectedModel = model?.trim() || config.model;
  const steps = Math.max(1, Math.min(Number(maxSteps) || DEFAULT_MAX_STEPS, 10));
  const outputCap = Math.max(64, Math.min(Number(maxTokens) || DEFAULT_MAX_TOKENS, 12000));
  let freeRemaining = null;
  try {
    await ensureFreeXKiroModel(selectedModel, { fetchImpl });
    const usage = await requestJson(`${XKIRO_API_BASE}/usage`, { apiKey: config.apiKey, fetchImpl, timeoutMs: 20_000 });
    const remaining = usage?.free_tokens?.remaining;
    freeRemaining = remaining === null || remaining === undefined ? null : Number(remaining);
    if (freeRemaining !== null && freeRemaining <= 0) {
      return err('xKiro free token allowance is exhausted; Aki free-only policy will not fall through to wallet/paid models');
    }
  } catch (e) {
    return err(e.message);
  }
  const messages = [
    {
      role: 'system',
      content: `You are Aki's xKiro read-only repository worker. Your filesystem scope is locked to ${dir}. Use the supplied read tools for evidence; never claim edits or shell execution. Prefer repo_snapshot once for broad analysis, then narrow with search/read. Return a concise evidence-first answer with concrete paths.`,
    },
    { role: 'user', content: prompt },
  ];
  let totalTokens = 0;
  let toolCalls = 0;

  try {
    for (let step = 1; step <= steps; step++) {
      const estimatedTurn = estimateTurnTokens(messages, outputCap);
      if (freeRemaining !== null && estimatedTurn >= freeRemaining) {
        return err(`xKiro free-only guard stopped before step ${step}: estimated ${estimatedTurn} tokens but only ${freeRemaining} free tokens remain`);
      }
      const body = {
        model: selectedModel,
        messages,
        tools: TOOL_DEFS,
        tool_choice: 'auto',
        max_tokens: outputCap,
        reasoning_effort: reasoning,
      };
      const data = await requestJson(`${XKIRO_API_BASE}/chat/completions`, { method: 'POST', apiKey: config.apiKey, body, fetchImpl });
      const usedThisTurn = Number(data?.usage?.total_tokens || 0);
      totalTokens += usedThisTurn;
      if (freeRemaining !== null) freeRemaining = Math.max(0, freeRemaining - usedThisTurn);
      const message = data?.choices?.[0]?.message;
      if (!message) throw new Error('xKiro returned no assistant message');
      messages.push(message);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
        return ok(`${text}\n\n[xKiro ${selectedModel} · ${totalTokens} tokens · ${toolCalls} tool calls]`);
      }

      for (const call of calls) {
        toolCalls++;
        let result;
        try {
          const args = JSON.parse(call?.function?.arguments || '{}');
          result = capToolResult(await toolExecutor(call?.function?.name, args, dir));
        } catch (e) {
          result = JSON.stringify({ error: e.message });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    return err(`xKiro tool loop reached maxSteps=${steps} without a final answer`);
  } catch (e) {
    return err(e.message);
  }
}

export function register(server) {
  server.registerTool(
    'xkiro_read',
    {
      title: 'xKiro Free Read Worker',
      description: 'Delegate a broad read-only repo/codebase task to xKiro using only a live-catalog access_tier=free model and the account free-token allowance. The worker can call only Aki read tools inside cwd; no write or shell capability is exposed. Requires XKIRO_API_KEY or ~/.aki/mcpsv/xkiro.json.',
      inputSchema: {
        prompt: z.string(),
        cwd: z.string().describe('absolute project/repo root under an allowed Aki folder'),
        model: z.string().optional().describe(`xKiro vendor/model id; defaults to configured model or ${DEFAULT_XKIRO_MODEL}`),
        reasoning: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional().default('none'),
        maxSteps: z.number().int().min(1).max(10).optional().default(DEFAULT_MAX_STEPS),
        maxTokens: z.number().int().min(64).max(12000).optional().default(DEFAULT_MAX_TOKENS),
      },
    },
    runXKiroRead,
  );

  server.registerTool(
    'xkiro_status',
    {
      title: 'xKiro Free Quota Status',
      description: 'Report xKiro worker configuration and current account usage/free-token allowance without exposing the API key.',
      inputSchema: {},
    },
    async () => ok(JSON.stringify(await getXKiroUsage(), null, 2)),
  );
}
