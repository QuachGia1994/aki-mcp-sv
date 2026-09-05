import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveOrFail, resolveRealUnderRoot } from './roots.js';
import { USER_DIR } from './userdata.js';
import { ok, err, fail } from './mcp-tool.js';

const PROVIDER = 'opencode';
export const DEFAULT_OPENCODE_MODEL = 'opencode/muse-spark-1.3-contributor-free';
export const OPENCODE_CONFIG_PATH = path.join(USER_DIR, 'opencode.json');
const READ_AGENT = 'Aki-readonly';
const EXEC_AGENT = 'Aki-exec';
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT_BASE = 4097;
const SERVER_PORT_MAX = 4106;
const AKI_OPENCODE_CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.opencode');
let activeServerPort = null;
const REQUEST_TIMEOUT_MS = 120_000;
const EXEC_REQUEST_TIMEOUT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 60_000;
const MAX_EXEC_PROMPT_CHARS = 20_000;
const MAX_PLAN_CHARS = 40_000;
const MODEL_CACHE_MS = 5 * 60_000;
const HIDDEN_LAUNCHER = fileURLToPath(new URL('./run-hidden-command.vbs', import.meta.url));
let modelCache = { at: 0, models: [] };

const serverArgs = (port) => ['serve', '--pure', '--hostname', SERVER_HOST, '--port', String(port)];

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
  return {
    model: normalizeModel(envModel || storedModel || DEFAULT_OPENCODE_MODEL),
    source: envModel ? 'env' : storedModel ? 'file' : 'default',
    execEnabled: stored.execEnabled === true,
  };
}

export function writeOpenCodeConfig({ model, execEnabled }) {
  const stored = readStoredConfig();
  if (model !== undefined && process.env.AKI_OPENCODE_MODEL?.trim()) throw new Error('AKI_OPENCODE_MODEL is set; clear the environment override before changing the panel selection');
  const next = {
    ...stored,
    $schema: stored.$schema || 'https://opencode.ai/config.json',
    model: normalizeModel(model ?? stored.model ?? DEFAULT_OPENCODE_MODEL),
    execEnabled: execEnabled === undefined ? stored.execEnabled === true : execEnabled === true,
  };
  const tmp = `${OPENCODE_CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, OPENCODE_CONFIG_PATH);
  return { model: next.model, source: 'file', execEnabled: next.execEnabled };
}

export function buildOpenCodeServerLaunch({ executable = resolveOpenCodeExecutable(), cwd, port = SERVER_PORT_BASE, platform = process.platform, env = process.env, launcherPath = HIDDEN_LAUNCHER, configDir = AKI_OPENCODE_CONFIG_DIR } = {}) {
  const args = serverArgs(port);
  const options = { cwd, detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, OPENCODE_CONFIG_DIR: configDir } };
  if (platform !== 'win32') return { command: executable, args, options };
  const windowsRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  return { command: path.win32.join(windowsRoot, 'System32', 'wscript.exe'), args: [launcherPath, executable, ...args], options };
}

export function buildOpenCodePromptBody(prompt, model = DEFAULT_OPENCODE_MODEL, agent = READ_AGENT) {
  const full = normalizeModel(model);
  return { model: { providerID: PROVIDER, modelID: full.slice(PROVIDER.length + 1) }, agent, parts: [{ type: 'text', text: prompt }] };
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
    return { configured, source: config.source, selectedModel: config.model, effectiveModel, fallback: effectiveModel !== config.model, execEnabled: config.execEnabled, freeModels };
  } catch (error) {
    return { configured: false, source: config.source, selectedModel: config.model, effectiveModel: null, fallback: false, execEnabled: config.execEnabled, freeModels: [], error: error.message || String(error) };
  }
}

export async function saveOpenCodeModel(model, { execEnabled, runner = runOpenCodeCli } = {}) {
  const freeModels = await listFreeOpenCodeModels({ runner });
  const normalized = normalizeModel(model);
  if (!freeModels.some((entry) => entry.id === normalized)) throw new Error(`OpenCode model is not currently free and tool-capable: ${normalized}`);
  return writeOpenCodeConfig({ model: normalized, execEnabled });
}

function canConnect(host = SERVER_HOST, port = SERVER_PORT_BASE, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const serverUrl = (port) => `http://${SERVER_HOST}:${port}`;

export async function serverHasAkiAgents(port, cwd) {
  if (!await canConnect(SERVER_HOST, port)) return false;
  try {
    const response = await requestJson(`${serverUrl(port)}/agent?directory=${encodeURIComponent(cwd)}`, { method: 'GET' }, 5_000);
    if (!response.ok || !Array.isArray(response.body)) return false;
    const names = new Set(response.body.map((agent) => agent?.name || agent?.id).filter(Boolean));
    return names.has(READ_AGENT) && names.has(EXEC_AGENT);
  } catch {
    return false;
  }
}

export async function ensureOpenCodeServer({ executable = resolveOpenCodeExecutable(), cwd } = {}) {
  if (activeServerPort && await serverHasAkiAgents(activeServerPort, cwd)) {
    return { ok: true, port: activeServerPort, url: serverUrl(activeServerPort), reused: true };
  }
  for (let port = SERVER_PORT_BASE; port <= SERVER_PORT_MAX; port += 1) {
    if (await canConnect(SERVER_HOST, port)) {
      if (await serverHasAkiAgents(port, cwd)) {
        activeServerPort = port;
        return { ok: true, port, url: serverUrl(port), reused: true };
      }
      continue;
    }
    const launch = buildOpenCodeServerLaunch({ executable, cwd, port });
    const child = spawn(launch.command, launch.args, launch.options);
    child.unref();
    let connected = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!await canConnect(SERVER_HOST, port)) continue;
      connected = true;
      if (await serverHasAkiAgents(port, cwd)) {
        activeServerPort = port;
        return { ok: true, port, url: serverUrl(port), reused: false };
      }
    }
    return { ok: false, error: connected ? `opencode serve started on ${SERVER_HOST}:${port} but did not load the Aki agent profiles from ${AKI_OPENCODE_CONFIG_DIR}` : `opencode serve did not become ready on ${SERVER_HOST}:${port}` };
  }
  return { ok: false, error: `no Aki-managed OpenCode port is available in ${SERVER_PORT_BASE}-${SERVER_PORT_MAX}; existing listeners did not expose both Aki agent profiles` };
}

async function requestJson(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

function runGitStatus(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['status', '--short'], { cwd, timeout: 20_000, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? '(git status unavailable)' : (stdout.trim() || '(clean)'));
    });
  });
}

async function readExecPlan(planPath) {
  if (!planPath) return '';
  const real = await resolveRealUnderRoot(planPath);
  const text = readFileSync(real, 'utf8');
  if (text.length > MAX_PLAN_CHARS) throw new Error(`shared plan is too large for the free execution worker (${text.length} chars > ${MAX_PLAN_CHARS})`);
  return text;
}

async function runOpenCodeSession({ prompt, cwd, agent, model, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const executable = resolveOpenCodeExecutable();
  const server = await ensureOpenCodeServer({ executable, cwd });
  if (!server.ok) return { ok: false, error: server.error };
  const query = `?directory=${encodeURIComponent(cwd)}`;
  let sessionID;
  try {
    const created = await requestJson(`${server.url}/session${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, timeoutMs);
    if (!created.ok || !created.body?.id) return { ok: false, error: `opencode session create failed (${created.status}): ${JSON.stringify(created.body)}` };
    sessionID = created.body.id;
    const prompted = await requestJson(`${server.url}/session/${encodeURIComponent(sessionID)}/message${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildOpenCodePromptBody(prompt, model, agent)) }, timeoutMs);
    if (!prompted.ok) return { ok: false, error: `opencode prompt failed (${prompted.status}): ${JSON.stringify(prompted.body)}` };
    const text = extractOpenCodeText(prompted.body);
    if (!text) return { ok: false, error: `opencode returned no text: ${JSON.stringify(prompted.body?.info ?? prompted.body)}` };
    return { ok: true, text, port: server.port, reusedServer: server.reused };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'opencode request timed out' : (error?.message || String(error)) };
  } finally {
    if (sessionID) requestJson(`${server.url}/session/${encodeURIComponent(sessionID)}${query}`, { method: 'DELETE' }).catch(() => {});
  }
}

export function buildOpenCodeExecPrompt({ prompt, cwd, planText = '', worktreeBefore = '(unknown)' }) {
  const parts = [
    '[AKI_EXEC_CONTRACT]',
    `Project root: ${cwd}`,
    'Implement only the requested task. Preserve unrelated pre-existing worktree changes. Do not modify the shared plan; report outcome to the lead instead.',
    `[WORKTREE_BEFORE]\n${worktreeBefore}`,
  ];
  if (planText) parts.push(`[SHARED_PLAN]\n${planText}`);
  parts.push(`[TASK]\n${prompt}`);
  return parts.join('\n\n');
}

export async function runOpenCodeRead({ prompt, cwd }) {
  const r = resolveOrFail(cwd);
  if (!r.ok) return fail(r.error);
  const status = await getOpenCodeStatus();
  if (!status.configured) return err(status.error || 'OpenCode Zen is not authenticated — run `opencode auth login`, select OpenCode Zen, then retry');
  const selectedModel = status.effectiveModel;
  const session = await runOpenCodeSession({ prompt, cwd: r.dir, agent: READ_AGENT, model: selectedModel });
  if (!session.ok) return err(session.error);
  return ok(`${session.text}\n\n[OpenCode Zen ${selectedModel}${status.fallback ? ` · fallback from ${status.selectedModel}` : ''}]`);
}

export function validateOpenCodeExecRequest({ prompt, config }) {
  if (!config?.execEnabled) return { ok: false, error: 'OpenCode exec is disabled — enable the write worker in Aki panel section 1 → OpenCode before retrying' };
  const task = String(prompt || '').trim();
  if (!task) return { ok: false, error: 'OpenCode exec requires a non-empty implementation prompt' };
  if (task.length > MAX_EXEC_PROMPT_CHARS) return { ok: false, error: `OpenCode exec prompt is too large (${task.length} chars > ${MAX_EXEC_PROMPT_CHARS}); pass the shared plan by planPath and keep the implementation instruction compact` };
  return { ok: true, task };
}

export async function runOpenCodeExec({ prompt, cwd, planPath }) {
  const r = resolveOrFail(cwd);
  if (!r.ok) return fail(r.error);
  const request = validateOpenCodeExecRequest({ prompt, config: readOpenCodeConfig() });
  if (!request.ok) return err(request.error);
  const task = request.task;
  const status = await getOpenCodeStatus();
  if (!status.configured) return err(status.error || 'OpenCode Zen is not authenticated — run `opencode auth login`, select OpenCode Zen, then retry');
  let planText = '';
  try {
    planText = await readExecPlan(planPath);
  } catch (error) {
    return err(`OpenCode exec could not read shared plan: ${error.message || String(error)}`);
  }
  const worktreeBefore = await runGitStatus(r.dir);
  const execPrompt = buildOpenCodeExecPrompt({ prompt: task, cwd: r.dir, planText, worktreeBefore });
  const selectedModel = status.effectiveModel;
  const session = await runOpenCodeSession({ prompt: execPrompt, cwd: r.dir, agent: EXEC_AGENT, model: selectedModel, timeoutMs: EXEC_REQUEST_TIMEOUT_MS });
  const worktreeAfter = await runGitStatus(r.dir);
  if (!session.ok) return err(`${session.error}\n\n[WORKTREE_AFTER]\n${worktreeAfter}`);
  return ok(`${session.text}\n\n[OpenCode Zen Exec ${selectedModel}${status.fallback ? ` · fallback from ${status.selectedModel}` : ''}]\n[WORKTREE_AFTER]\n${worktreeAfter}`);
}

export function register(server) {
  server.registerTool('opencode_read', { title: 'OpenCode Zen Free (read-only)', description: `Run OpenCode through a persistent local-only HTTP server with the project-local ${READ_AGENT} permission profile. It can read/search local files only; edit, bash, web, task delegation, questions, and todo writes are denied. Aki uses the panel-selected zero-cost OpenCode Zen model and falls back only to another live zero-cost Zen model if that selection disappears. Ephemeral sessions are deleted after each call.`, inputSchema: { prompt: z.string(), cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root') } }, runOpenCodeRead);
  server.registerTool('opencode_exec', { title: 'OpenCode Zen Free Executor', description: `Implement a scoped task in the real project with ${EXEC_AGENT}. This mutating worker must be explicitly enabled in the Aki panel, uses only the selected live zero-cost Zen model, may edit files inside the project worktree, and is denied shell, web, delegation, skills, questions, todos, and external-directory access. Verification commands are returned for Aki to run separately.`, inputSchema: { prompt: z.string().describe('compact implementation instruction; put durable scope/acceptance details in planPath when available'), cwd: z.string().describe('real project directory; must be under an allowed root'), planPath: z.string().optional().describe('optional shared plan file; Aki reads it and injects its text without granting OpenCode external-directory access') } }, runOpenCodeExec);
  server.registerTool('opencode_status', { title: 'OpenCode Zen Free Status', description: 'Report OpenCode Zen authentication, selected/effective free model, write-worker enable state, fallback state, and current zero-cost tool-capable model catalog. API keys are never returned.', inputSchema: {} }, async () => ok(JSON.stringify(await getOpenCodeStatus(), null, 2)));
}
