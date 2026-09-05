import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveOrFail } from './roots.js';
import { USER_DIR } from './userdata.js';
import { ok, err, fail } from './mcp-tool.js';

const PROVIDER = 'opencode';
export const DEFAULT_OPENCODE_MODEL = 'opencode/muse-spark-1.3-contributor-free';
export const OPENCODE_CONFIG_PATH = path.join(USER_DIR, 'opencode.json');
const AGENT = 'Aki-readonly';
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 4097;
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const REQUEST_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 60_000;
const MODEL_CACHE_MS = 5 * 60_000;
const HIDDEN_LAUNCHER = fileURLToPath(new URL('./run-hidden-command.vbs', import.meta.url));
const SERVER_ARGS = ['serve', '--pure', '--hostname', SERVER_HOST, '--port', String(SERVER_PORT)];
let modelCache = { at: 0, models: [] };

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

function normalizeModel(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_OPENCODE_MODEL;
  if (!raw.includes('/')) return `${PROVIDER}/${raw}`;
  if (!raw.startsWith(`${PROVIDER}/`)) throw new Error(`OpenCode Zen model must use provider ${PROVIDER}: ${raw}`);
  return raw;
}

function readStoredConfig() {
  if (!existsSync(OPENCODE_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readOpenCodeConfig() {
  const stored = readStoredConfig();
  const envModel = process.env.AKI_OPENCODE_MODEL?.trim();
  const storedModel = typeof stored.model === 'string' ? stored.model.trim() : '';
  return { model: normalizeModel(envModel || storedModel || DEFAULT_OPENCODE_MODEL), source: envModel ? 'env' : storedModel ? 'file' : 'default' };
}

export function writeOpenCodeConfig({ model }) {
  if (process.env.AKI_OPENCODE_MODEL?.trim()) throw new Error('AKI_OPENCODE_MODEL is set; clear the environment override before changing the panel selection');
  const next = { model: normalizeModel(model) };
  const tmp = `${OPENCODE_CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, OPENCODE_CONFIG_PATH);
  return { model: next.model, source: 'file' };
}

export function buildOpenCodeServerLaunch({ executable = resolveOpenCodeExecutable(), cwd, platform = process.platform, env = process.env, launcherPath = HIDDEN_LAUNCHER } = {}) {
  const options = { cwd, detached: true, stdio: 'ignore', windowsHide: true };
  if (platform !== 'win32') return { command: executable, args: SERVER_ARGS, options };
  const windowsRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  return { command: path.win32.join(windowsRoot, 'System32', 'wscript.exe'), args: [launcherPath, executable, ...SERVER_ARGS], options };
}

export function buildOpenCodePromptBody(prompt, model = DEFAULT_OPENCODE_MODEL) {
  const full = normalizeModel(model);
  return { model: { providerID: PROVIDER, modelID: full.slice(PROVIDER.length + 1) }, agent: AGENT, parts: [{ type: 'text', text: prompt }] };
}

export function extractOpenCodeText(message) {
  return message?.parts?.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim() || '';
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function parseOpenCodeVerboseModels(output) {
  const groups = [];
  let current = null;
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^opencode\/[^\s]+$/.test(trimmed)) {
      if (current) groups.push(current);
      current = { id: trimmed, lines: [] };
    } else if (current) current.lines.push(line);
  }
  if (current) groups.push(current);
  return groups.flatMap((group) => {
    try {
      const meta = JSON.parse(group.lines.join('\n').trim());
      return [{ ...meta, id: group.id }];
    } catch {
      return [];
    }
  });
}

function allNumbersZero(value) {
  if (typeof value === 'number') return value === 0;
  if (Array.isArray(value)) return value.every(allNumbersZero);
  if (value && typeof value === 'object') return Object.values(value).every(allNumbersZero);
  return true;
}

export function isFreeOpenCodeModel(model) {
  return model?.providerID === PROVIDER && model?.status === 'active' && model?.capabilities?.toolcall === true && model?.cost && allNumbersZero(model.cost);
}

function runOpenCodeCli(args, { executable = resolveOpenCodeExecutable(), cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 12 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stripAnsi(stderr || error.message)));
      resolve(stripAnsi(stdout || stderr || ''));
    });
  });
}

export async function listFreeOpenCodeModels({ refresh = false, runner = runOpenCodeCli } = {}) {
  if (!refresh && runner === runOpenCodeCli && modelCache.models.length && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  const output = await runner(['models', PROVIDER, ...(refresh ? ['--refresh'] : []), '--verbose']);
  const models = parseOpenCodeVerboseModels(output).filter(isFreeOpenCodeModel).map((model) => ({ id: model.id, name: model.name || model.id, releaseDate: model.release_date || '', context: model.limit?.context || null, output: model.limit?.output || null })).sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || a.name.localeCompare(b.name));
  if (runner === runOpenCodeCli) modelCache = { at: Date.now(), models };
  return models;
}

export function chooseOpenCodeModel(requested, models) {
  const wanted = normalizeModel(requested);
  if (models.some((model) => model.id === wanted)) return wanted;
  if (models.some((model) => model.id === DEFAULT_OPENCODE_MODEL)) return DEFAULT_OPENCODE_MODEL;
  if (models[0]?.id) return models[0].id;
  throw new Error('OpenCode Zen has no active zero-cost tool-calling model in the current catalog');
}

export async function getOpenCodeStatus({ refresh = false, runner = runOpenCodeCli } = {}) {
  const config = readOpenCodeConfig();
  try {
    const [authText, freeModels] = await Promise.all([runner(['auth', 'list']), listFreeOpenCodeModels({ refresh, runner })]);
    const configured = /OpenCode Zen/i.test(authText);
    const effectiveModel = chooseOpenCodeModel(config.model, freeModels);
    return { configured, source: config.source, selectedModel: config.model, effectiveModel, fallback: effectiveModel !== config.model, freeModels };
  } catch (error) {
    return { configured: false, source: config.source, selectedModel: config.model, effectiveModel: null, fallback: false, freeModels: [], error: error.message || String(error) };
  }
}

export async function saveOpenCodeModel(model, { runner = runOpenCodeCli } = {}) {
  const freeModels = await listFreeOpenCodeModels({ runner });
  const normalized = normalizeModel(model);
  if (!freeModels.some((entry) => entry.id === normalized)) throw new Error(`OpenCode model is not currently free and tool-capable: ${normalized}`);
  return writeOpenCodeConfig({ model: normalized });
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
  const launch = buildOpenCodeServerLaunch({ executable, cwd });
  const child = spawn(launch.command, launch.args, launch.options);
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
  const status = await getOpenCodeStatus();
  if (!status.configured) return err(status.error || 'OpenCode Zen is not authenticated — run `opencode auth login`, select OpenCode Zen, then retry');
  const selectedModel = status.effectiveModel;
  const executable = resolveOpenCodeExecutable();
  if (!await ensureOpenCodeServer({ executable, cwd: r.dir })) return err('opencode serve did not become ready on 127.0.0.1:4097');

  const query = `?directory=${encodeURIComponent(r.dir)}`;
  let sessionID;
  try {
    const created = await requestJson(`${SERVER_URL}/session${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!created.ok || !created.body?.id) return err(`opencode session create failed (${created.status}): ${JSON.stringify(created.body)}`);
    sessionID = created.body.id;

    const prompted = await requestJson(`${SERVER_URL}/session/${encodeURIComponent(sessionID)}/message${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildOpenCodePromptBody(prompt, selectedModel)) });
    if (!prompted.ok) return err(`opencode prompt failed (${prompted.status}): ${JSON.stringify(prompted.body)}`);
    const text = extractOpenCodeText(prompted.body);
    if (!text) return err(`opencode returned no text: ${JSON.stringify(prompted.body?.info ?? prompted.body)}`);
    return ok(`${text}\n\n[OpenCode Zen ${selectedModel}${status.fallback ? ` · fallback from ${status.selectedModel}` : ''}]`);
  } catch (error) {
    return err(error?.name === 'AbortError' ? 'opencode request timed out' : (error?.message || String(error)));
  } finally {
    if (sessionID) requestJson(`${SERVER_URL}/session/${encodeURIComponent(sessionID)}${query}`, { method: 'DELETE' }).catch(() => {});
  }
}

export function register(server) {
  server.registerTool('opencode_read', { title: 'OpenCode Zen Free (read-only)', description: `Run OpenCode through a persistent local-only HTTP server with the project-local ${AGENT} permission profile. It can read/search local files only; edit, bash, web, task delegation, questions, and todo writes are denied. Aki uses the panel-selected zero-cost OpenCode Zen model and falls back only to another live zero-cost Zen model if that selection disappears. Ephemeral sessions are deleted after each call.`, inputSchema: { prompt: z.string(), cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root') } }, runOpenCodeRead);
  server.registerTool('opencode_status', { title: 'OpenCode Zen Free Status', description: 'Report OpenCode Zen authentication, selected/effective free model, fallback state, and current zero-cost tool-capable model catalog. API keys are never returned.', inputSchema: {} }, async () => ok(JSON.stringify(await getOpenCodeStatus(), null, 2)));
}
