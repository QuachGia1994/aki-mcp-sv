import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_MODEL = 'opencode/muse-spark-1.3-contributor-free';
const DEFAULT_TIMEOUT_MS = 90_000;
const SERVER_START_TIMEOUT_MS = 15_000;
const POLL_MS = 500;
const SUPPORTED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitModel(value) {
  const model = String(value || DEFAULT_MODEL).trim();
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) throw new Error(`invalid OpenCode vision model: ${model}`);
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1), label: model };
}

export function resolveOpenCodeExecutable(env = process.env) {
  const explicit = String(env.AKI_OPENCODE_EXE || '').trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const home = String(env.USERPROFILE || os.homedir() || '').trim();
    const bunExe = home ? path.join(home, '.bun', 'bin', 'opencode.exe') : '';
    if (bunExe && existsSync(bunExe)) return bunExe;
  }
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

async function freePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchText(url, init = {}, timeoutMs = 15_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}: ${text.slice(0, 2000)}`);
  return { response, text };
}

async function fetchJson(url, init = {}, timeoutMs = 15_000) {
  const { text } = await fetchText(url, init, timeoutMs);
  return text ? JSON.parse(text) : null;
}

function boundedLog(current, chunk) {
  const next = current + chunk.toString();
  return next.length > 12_000 ? next.slice(-12_000) : next;
}

async function startServer({ exe, cwd, env }) {
  const host = '127.0.0.1';
  const port = await freePort(host);
  const baseUrl = `http://${host}:${port}`;
  const username = 'opencode';
  const password = randomBytes(24).toString('base64url');
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const childEnv = { ...env, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password };
  const child = spawn(exe, ['serve', '--pure', '--hostname', host, '--port', String(port), '--log-level', 'WARN'], {
    cwd,
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs = boundedLog(logs, chunk); });
  child.stderr?.on('data', (chunk) => { logs = boundedLog(logs, chunk); });

  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited with code ${child.exitCode}: ${logs.trim()}`);
    try {
      const health = await fetchJson(`${baseUrl}/global/health`, { headers: { authorization: authHeader } }, 1500);
      if (health?.healthy) return { child, baseUrl, authHeader, logs: () => logs };
    } catch {}
    await delay(150);
  }
  await stopServer({ child });
  throw new Error(`OpenCode server did not become healthy: ${logs.trim()}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  if (process.platform === 'win32' && server.child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(server.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
    return;
  }
  server.child.kill();
  const deadline = Date.now() + 2_000;
  while (server.child.exitCode === null && Date.now() < deadline) await delay(50);
}

function assistantText(messages) {
  const assistants = Array.isArray(messages) ? messages.filter((message) => message?.info?.role === 'assistant') : [];
  const latest = assistants.at(-1);
  if (!latest) return null;
  if (latest.info?.error) {
    const error = latest.info.error;
    throw new Error(error?.data?.message || error?.message || error?.name || 'OpenCode vision request failed');
  }
  const text = (latest.parts || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}

export async function analyzeImageWithOpenCode({
  buffer,
  mimeType,
  filename = 'image.png',
  prompt = 'Describe the visible UI, read important text, and identify the main state, error, or issue in this image.',
  model = process.env.AKI_OPENCODE_VISION_MODEL || DEFAULT_MODEL,
  timeoutMs = Number(process.env.AKI_OPENCODE_VISION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('OpenCode vision requires a non-empty image buffer');
  if (!SUPPORTED_MIME.has(mimeType)) throw new Error(`OpenCode vision supports PNG, JPEG, GIF, or WebP; got ${mimeType || 'unknown'}`);
  const requestText = String(prompt || '').trim();
  if (!requestText) throw new Error('OpenCode vision prompt is empty');
  const selected = splitModel(model);
  const exe = resolveOpenCodeExecutable(env);
  const server = await startServer({ exe, cwd, env });
  let sessionID;

  try {
    const session = await fetchJson(`${server.baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: server.authHeader },
      body: JSON.stringify({ title: 'Aki Postman vision analysis' }),
    });
    sessionID = session?.id;
    if (!sessionID) throw new Error('OpenCode did not return a session id');

    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    await fetchText(`${server.baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: server.authHeader },
      body: JSON.stringify({
        model: { providerID: selected.providerID, modelID: selected.modelID },
        agent: 'build',
        tools: {},
        system: 'Analyze only the attached image. Do not call tools. Return factual, concise plain text. Clearly separate visible facts from any inference. Do not reproduce passwords, API keys, tokens, invite codes, session identifiers, or similar secrets unless the user explicitly asks for that exact value; state that such a value is present instead.',
        parts: [
          { type: 'text', text: requestText },
          { type: 'file', mime: mimeType, filename, url: dataUrl },
        ],
      }),
    }, 10_000);

    const deadline = Date.now() + Math.max(5_000, Math.min(180_000, timeoutMs));
    let idleSince = 0;
    while (Date.now() < deadline) {
      const statuses = await fetchJson(`${server.baseUrl}/session/status`, { headers: { authorization: server.authHeader } }, 5_000);
      const state = statuses?.[sessionID];
      const busy = state?.type === 'busy';
      if (!busy) {
        if (!idleSince) idleSince = Date.now();
        const messages = await fetchJson(`${server.baseUrl}/session/${encodeURIComponent(sessionID)}/message`, { headers: { authorization: server.authHeader } }, 10_000);
        const text = assistantText(messages);
        if (text) return { text, model: selected.label };
        if (Date.now() - idleSince >= 5_000) throw new Error('OpenCode vision completed without a text response');
      } else {
        idleSince = 0;
      }
      await delay(POLL_MS);
    }

    try {
      await fetchText(`${server.baseUrl}/session/${encodeURIComponent(sessionID)}/abort`, { method: 'POST', headers: { authorization: server.authHeader } }, 3_000);
    } catch {}
    throw new Error(`OpenCode vision timed out after ${timeoutMs} ms`);
  } catch (error) {
    const logTail = server.logs().trim();
    const suffix = logTail ? ` | server: ${logTail.slice(-2000)}` : '';
    throw new Error(`${error.message || String(error)}${suffix}`);
  } finally {
    if (sessionID) {
      try {
        await fetchText(`${server.baseUrl}/session/${encodeURIComponent(sessionID)}`, { method: 'DELETE', headers: { authorization: server.authHeader } }, 3_000);
      } catch {}
    }
    await stopServer(server);
  }
}

export const OPENCODE_VISION_DEFAULT_MODEL = DEFAULT_MODEL;
export const OPENCODE_VISION_SUPPORTED_MIME = SUPPORTED_MIME;
