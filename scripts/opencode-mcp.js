import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveOrFail } from './roots.js';
import { ok, err, fail } from './mcp-tool.js';

const PROVIDER = 'opencode-go';
const MODEL = 'muse-spark-1.2-contributor';
const AGENT = 'Aki-readonly';
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 4097;
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const REQUEST_TIMEOUT_MS = 120_000;

export function resolveOpenCodeExecutable({ platform = process.platform, env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  if (env.AKI_OPENCODE_PATH) return env.AKI_OPENCODE_PATH;
  if (platform === 'win32') {
    const candidates = [
      path.win32.join(home, '.bun', 'bin', 'opencode.exe'),
      env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'opencode', 'opencode.exe') : null,
    ].filter(Boolean);
    const found = candidates.find((candidate) => exists(candidate));
    if (found) return found;
  }
  return 'opencode';
}

export function buildOpenCodePromptBody(prompt) {
  return {
    model: { providerID: PROVIDER, modelID: MODEL },
    agent: AGENT,
    parts: [{ type: 'text', text: prompt }],
  };
}

export function extractOpenCodeText(message) {
  return message?.parts?.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim() || '';
}

function canConnect(host = SERVER_HOST, port = SERVER_PORT, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function ensureOpenCodeServer({ executable = resolveOpenCodeExecutable(), cwd } = {}) {
  if (await canConnect()) return true;
  const child = spawn(executable, ['serve', '--pure', '--hostname', SERVER_HOST, '--port', String(SERVER_PORT)], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await canConnect()) return true;
  }
  return false;
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function runOpenCodeRead({ prompt, cwd }) {
  const r = resolveOrFail(cwd);
  if (!r.ok) return fail(r.error);
  const executable = resolveOpenCodeExecutable();
  if (!await ensureOpenCodeServer({ executable, cwd: r.dir })) return err('opencode serve did not become ready on 127.0.0.1:4097');

  const query = `?directory=${encodeURIComponent(r.dir)}`;
  let sessionID;
  try {
    const created = await requestJson(`${SERVER_URL}/session${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!created.ok || !created.body?.id) return err(`opencode session create failed (${created.status}): ${JSON.stringify(created.body)}`);
    sessionID = created.body.id;

    const prompted = await requestJson(`${SERVER_URL}/session/${encodeURIComponent(sessionID)}/message${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildOpenCodePromptBody(prompt)),
    });
    if (!prompted.ok) return err(`opencode prompt failed (${prompted.status}): ${JSON.stringify(prompted.body)}`);
    const text = extractOpenCodeText(prompted.body);
    if (!text) return err(`opencode returned no text: ${JSON.stringify(prompted.body?.info ?? prompted.body)}`);
    return ok(text);
  } catch (error) {
    return err(error?.name === 'AbortError' ? 'opencode request timed out' : (error?.message || String(error)));
  } finally {
    if (sessionID) {
      requestJson(`${SERVER_URL}/session/${encodeURIComponent(sessionID)}${query}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

export function register(server) {
  server.registerTool(
    'opencode_read',
    {
      title: 'OpenCode API (read-only)',
      description: `Run OpenCode through a persistent local-only HTTP server with the project-local ${AGENT} permission profile. It can read/search local files only; edit, bash, web, task delegation, questions, and todo writes are denied. Model is locked to ${PROVIDER}/${MODEL}. Ephemeral sessions are deleted after each call.`,
      inputSchema: {
        prompt: z.string(),
        cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
      },
    },
    runOpenCodeRead,
  );
}
