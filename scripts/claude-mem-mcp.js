import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ok, fail } from './mcp-tool.js';

const DEFAULT_WORKER_HOST = '127.0.0.1';
const DEFAULT_WORKER_PORT = 37700 + ((process.getuid?.() ?? 77) % 100);
const DEFAULT_TIMEOUT_MS = 5000;

function readSettings() {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || path.join(homedir(), '.claude-mem');
  const settingsPath = path.join(dataDir, 'settings.json');
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid claude-mem settings at ${settingsPath}: ${error.message}`);
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid ${name}: expected a positive integer`);
  return parsed;
}

function workerSettings() {
  const settings = readSettings();
  const host = process.env.CLAUDE_MEM_WORKER_HOST || settings.CLAUDE_MEM_WORKER_HOST || DEFAULT_WORKER_HOST;
  if (typeof host !== 'string' || !host.trim() || /[\s/]/.test(host)) throw new Error('invalid CLAUDE_MEM_WORKER_HOST');
  const port = positiveInteger(process.env.CLAUDE_MEM_WORKER_PORT ?? settings.CLAUDE_MEM_WORKER_PORT, DEFAULT_WORKER_PORT, 'CLAUDE_MEM_WORKER_PORT');
  if (port > 65535) throw new Error('invalid CLAUDE_MEM_WORKER_PORT: expected 1-65535');
  const timeoutMs = positiveInteger(process.env.CLAUDE_MEM_API_TIMEOUT_MS ?? settings.CLAUDE_MEM_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'CLAUDE_MEM_API_TIMEOUT_MS');
  return { baseUrl: `http://${host}:${port}`, timeoutMs };
}

function queryString(args) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}

function readablePayload(payload) {
  if (payload && Array.isArray(payload.content)) {
    const text = payload.content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n');
    if (text) return text;
  }
  return JSON.stringify(payload, null, 2);
}

async function workerRequest(endpoint, { query, body } = {}) {
  const { baseUrl, timeoutMs } = workerSettings();
  const suffix = query ? `?${queryString(query)}` : '';
  const options = {
    signal: AbortSignal.timeout(timeoutMs),
    ...(body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  };

  let response;
  try {
    response = await fetch(`${baseUrl}${endpoint}${suffix}`, options);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(`claude-mem worker timed out after ${timeoutMs}ms at ${baseUrl}`);
    throw new Error(`claude-mem worker unavailable at ${baseUrl}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`claude-mem worker ${response.status}: ${await response.text()}`);
  return readablePayload(await response.json());
}

export function register(server) {
  server.registerTool(
    'claude_mem_search',
    {
      title: 'Claude-Mem Search',
      description: 'Step 1 of the read-only claude-mem workflow. Search memory and return compact observation IDs; then use claude_mem_timeline and claude_mem_get_observations.',
      inputSchema: {
        query: z.string(),
        limit: z.number().optional(),
        project: z.string().optional(),
        platformSource: z.string().optional(),
        type: z.string().optional(),
        obs_type: z.string().optional(),
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
        offset: z.number().optional(),
        orderBy: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await workerRequest('/api/search', { query: args }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'claude_mem_timeline',
    {
      title: 'Claude-Mem Timeline',
      description: 'Step 2 of the read-only claude-mem workflow. Get chronological context around a filtered observation ID or query.',
      inputSchema: {
        anchor: z.number().optional(),
        query: z.string().optional(),
        depth_before: z.number().optional(),
        depth_after: z.number().optional(),
        project: z.string().optional(),
      },
    },
    async (args) => {
      try {
        if (args.anchor === undefined && !args.query) throw new Error('anchor or query is required');
        return ok(await workerRequest('/api/timeline', { query: args }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'claude_mem_get_observations',
    {
      title: 'Claude-Mem Get Observations',
      description: 'Step 3 of the read-only claude-mem workflow. Fetch full details only for observation IDs already filtered by search/timeline.',
      inputSchema: {
        ids: z.array(z.number()).min(1),
        orderBy: z.string().optional(),
        limit: z.number().optional(),
        project: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await workerRequest('/api/observations/batch', { body: args }));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
