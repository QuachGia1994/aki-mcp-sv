#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { POSTMAN_POOL_CONFIG_PATH, formatPostmanPoolReport, normalizeInviteUrl, resolveReportCredentials, sendPostmanPoolReportMessage, startPostmanPoolWatcher } from './postman-pool.js';
import { USER_DIR } from './userdata.js';

const SELF_PATH = fileURLToPath(import.meta.url);
const JOIN_SCRIPT = fileURLToPath(new URL('./postman-pool-join.py', import.meta.url));
const WATCHER_RUNTIME_PATH = path.join(USER_DIR, 'postman-pool-watcher-runtime.json');
const WATCHER_LOG_PATH = path.join(USER_DIR, 'postman-pool-watcher.log');
const JOIN_RUNTIME_PATH = path.join(USER_DIR, 'postman-pool-join-runtime.json');
const JOIN_REPORT_STATE_PATH = path.join(USER_DIR, 'postman-pool-join-report-state.json');
const VERIFY_RUNTIME_PATH = path.join(USER_DIR, 'postman-pool-verify-runtime.json');
const EVENT_PREFIX = '[postman-pool:event] ';

function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

function removeFile(filePath) {
  try { unlinkSync(filePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function tailText(filePath, maxBytes = 65536) {
  if (!existsSync(filePath)) return '';
  try {
    const text = readFileSync(filePath, 'utf8');
    return text.length <= maxBytes ? text : text.slice(-maxBytes);
  } catch {
    return '';
  }
}

export function parseWorkerEvents(logText) {
  const events = [];
  for (const line of String(logText || '').split(/\r?\n/)) {
    const index = line.indexOf(EVENT_PREFIX);
    if (index < 0) continue;
    try {
      const event = JSON.parse(line.slice(index + EVENT_PREFIX.length));
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    } catch {}
  }
  return events.slice(-500);
}

function readBrowserConfig(configPath = POSTMAN_POOL_CONFIG_PATH) {
  const raw = readJson(configPath, null);
  if (!raw) throw new Error(`Postman pool config not found: ${configPath}`);
  return {
    librewolfBinary: raw.librewolfBinary || '',
    profilesRoot: raw.profilesRoot || '',
    profileDirectories: Array.isArray(raw.profileDirectories) ? raw.profileDirectories.map(String).filter(Boolean) : [],
    scratchRoot: raw.scratchRoot || '',
    headless: raw.headless === true,
    timeoutSeconds: Number.isFinite(Number(raw.timeoutSeconds)) ? Math.max(10, Math.min(120, Number(raw.timeoutSeconds))) : 45,
  };
}

function pythonCommand(args) {
  if (process.platform === 'win32') return { file: 'py', args: ['-3', ...args] };
  return { file: 'python3', args };
}

export function browserArgs(config) {
  const args = [];
  if (config.librewolfBinary) args.push('--librewolf-binary', config.librewolfBinary);
  if (config.profilesRoot) args.push('--profiles-root', config.profilesRoot);
  for (const profile of config.profileDirectories) args.push('--profile-directory', profile);
  if (config.scratchRoot) args.push('--scratch-root', config.scratchRoot);
  if (config.headless) args.push('--headless');
  args.push('--timeout', String(config.timeoutSeconds));
  return args;
}

export function buildJoinWorkerInvocation(config, resultFile) {
  return pythonCommand([JOIN_SCRIPT, '--json-stdin', '--result-file', resultFile, ...browserArgs(config)]);
}

export function buildVerifyWorkerInvocation(config, resultFile) {
  const args = browserArgs({ ...config, headless: true });
  return pythonCommand([JOIN_SCRIPT, '--verify-login', '--result-file', resultFile, ...args]);
}

function runPythonJson(args, input = null) {
  const command = pythonCommand([JOIN_SCRIPT, ...args]);
  const result = spawnSync(command.file, command.args, {
    input: input == null ? undefined : `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Python exited ${result.status}`).trim());
  const text = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}';
  return JSON.parse(text);
}

export function scanProfiles(configPath = POSTMAN_POOL_CONFIG_PATH) {
  const config = readBrowserConfig(configPath);
  return runPythonJson([...browserArgs(config), '--dry-run']);
}

async function watcherRequest(runtime, method, pathname) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${runtime.token}` },
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`watcher control ${pathname} failed (${response.status})`);
  return response.json();
}

export async function watcherStatus() {
  const runtime = readJson(WATCHER_RUNTIME_PATH, null);
  if (!runtime || !processAlive(runtime.pid)) {
    removeFile(WATCHER_RUNTIME_PATH);
    return { running: false, log: tailText(WATCHER_LOG_PATH) };
  }
  try {
    const status = await watcherRequest(runtime, 'GET', '/status');
    return { ...status, log: tailText(runtime.logFile || WATCHER_LOG_PATH) };
  } catch {
    return { running: true, pid: runtime.pid, startedAt: runtime.startedAt, unresponsive: true, log: tailText(runtime.logFile || WATCHER_LOG_PATH) };
  }
}

export async function startWatcher() {
  const current = await watcherStatus();
  if (current.running) return current;
  readBrowserConfig();
  const logFd = openSync(WATCHER_LOG_PATH, 'w');
  const child = spawn(process.execPath, [SELF_PATH, '--run-watcher'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd);
  child.unref();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    sleep(100);
    const runtime = readJson(WATCHER_RUNTIME_PATH, null);
    if (runtime?.pid === child.pid) return watcherStatus();
    if (!processAlive(child.pid)) break;
  }
  throw new Error(`Postman watcher failed to start; see ${WATCHER_LOG_PATH}`);
}

export async function stopWatcher() {
  const runtime = readJson(WATCHER_RUNTIME_PATH, null);
  if (!runtime || !processAlive(runtime.pid)) {
    removeFile(WATCHER_RUNTIME_PATH);
    return { running: false, log: tailText(WATCHER_LOG_PATH) };
  }
  try {
    await watcherRequest(runtime, 'POST', '/stop');
  } catch (error) {
    throw new Error(`Watcher did not accept a graceful stop: ${error.message}`);
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && processAlive(runtime.pid)) sleep(100);
  if (!processAlive(runtime.pid)) removeFile(WATCHER_RUNTIME_PATH);
  return watcherStatus();
}

async function runWatcherProcess() {
  const watcher = startPostmanPoolWatcher({ forceEnabled: true });
  if (!watcher.enabled) throw new Error('Postman watcher config is incomplete');
  const token = randomBytes(24).toString('hex');
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ running: true, pid: process.pid, startedAt, logFile: WATCHER_LOG_PATH }));
      return;
    }
    if (req.method === 'POST' && req.url === '/stop') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setImmediate(shutdown);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  const startedAt = new Date().toISOString();
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    watcher.close();
    removeFile(WATCHER_RUNTIME_PATH);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => watcher.close());
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    writeJsonAtomic(WATCHER_RUNTIME_PATH, {
      pid: process.pid,
      port: address.port,
      token,
      startedAt,
      logFile: WATCHER_LOG_PATH,
    });
    console.log(`[postman-pool-control] watcher ready pid=${process.pid}`);
  });
}

function joinPaths() {
  return {
    resultFile: path.join(USER_DIR, 'postman-pool-join-result.json'),
    logFile: path.join(USER_DIR, 'postman-pool-join.log'),
  };
}

export function normalizeManualInvite(value) {
  const raw = String(value || '').trim().replace(/^['\"]|['\"]$/g, '');
  const normalized = normalizeInviteUrl(raw);
  if (normalized) return normalized;
  if (/^[A-Za-z0-9_-]{16,128}$/.test(raw)) return `https://app.getpostman.com/join-team?invite_code=${encodeURIComponent(raw)}`;
  return null;
}

function processJobStatus(runtimePath, emptyStatus, exitedMessage) {
  const runtime = readJson(runtimePath, null);
  if (!runtime) return emptyStatus;
  const result = readJson(runtime.resultFile, null);
  const alive = processAlive(runtime.pid);
  const log = tailText(runtime.logFile);
  const status = {
    running: alive,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    resultFile: runtime.resultFile,
    logFile: runtime.logFile,
    result,
    events: parseWorkerEvents(log),
    log,
  };
  if (!alive && !result) status.error = exitedMessage;
  return status;
}

export async function sendJoinCompletionReport(result, { configPath = POSTMAN_POOL_CONFIG_PATH, reportFile = JOIN_REPORT_STATE_PATH, jobError = null, fetchImpl = fetch } = {}) {
  const credentials = resolveReportCredentials(configPath);
  const saveReport = (report) => {
    const state = { ...report, jobError, updatedAt: Date.now() };
    writeJsonAtomic(reportFile, state);
    return state;
  };
  saveReport({ status: 'sending' });
  try {
    if (!credentials.reportBotToken || !credentials.reportChatId) throw new Error('Complete Report Bot Token and Report Chat ID in Settings.');
    const text = jobError ? `Postman pool: automation failed · ${jobError}` : formatPostmanPoolReport(result);
    const telegramResult = await sendPostmanPoolReportMessage(credentials, text, fetchImpl);
    return saveReport({ status: 'sent', messageId: telegramResult?.message_id ?? null });
  } catch (error) {
    let message = String(error?.message || error);
    if (credentials.reportBotToken) message = message.split(credentials.reportBotToken).join('[redacted]');
    message = message.replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').slice(0, 180);
    return saveReport({ status: 'failed', error: message });
  }
}

export async function runManualJoin({ inviteUrl, configPath = POSTMAN_POOL_CONFIG_PATH, resultFile, reportFile = JOIN_REPORT_STATE_PATH }, { spawnImpl = spawn, fetchImpl = fetch } = {}) {
  let result = null;
  let jobError = null;
  try {
    const config = readBrowserConfig(configPath);
    const command = buildJoinWorkerInvocation(config, resultFile);
    await new Promise((resolve, reject) => {
      const child = spawnImpl(command.file, command.args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Join worker exited (${code ?? 'signal'})`)));
      child.stdin.on('error', reject);
      child.stdin.end(`${JSON.stringify({ inviteUrl })}\n`);
    });
    result = readJson(resultFile, null);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Join worker did not write a valid result');
  } catch (error) {
    jobError = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').slice(0, 180);
  }
  const report = await sendJoinCompletionReport(result, { configPath, reportFile, jobError, fetchImpl });
  console.log(`[postman-pool:report] ${report.status}${report.error ? `: ${report.error}` : ''}`);
  return report;
}

function stopProcessTree(pid) {
  if (!processAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-Number(pid), 'SIGTERM'); } catch { try { process.kill(Number(pid), 'SIGTERM'); } catch {} }
  }
  sleep(150);
}

export function joinStatus() {
  const status = processJobStatus(JOIN_RUNTIME_PATH, { running: false, events: [], log: '' }, 'Join process exited before writing a result');
  const runtime = readJson(JOIN_RUNTIME_PATH, null);
  if (runtime?.reportFile) {
    status.report = readJson(runtime.reportFile, { status: 'pending' });
    if (status.report.jobError) status.error = status.report.jobError;
    if (!status.running && ['pending', 'sending'].includes(status.report.status)) status.report = { status: 'failed', error: 'Report process exited before confirming delivery.' };
  }
  if (status.result) status.summary = formatPostmanPoolReport(status.result);
  return status;
}

export function startJoin(inviteUrl, configPath = POSTMAN_POOL_CONFIG_PATH) {
  const normalized = normalizeManualInvite(inviteUrl);
  if (!normalized) throw new Error('Not a recognized Postman invite URL');
  const current = joinStatus();
  if (current.running) throw new Error(`A join is already running (pid ${current.pid})`);
  readBrowserConfig(configPath);
  const { resultFile, logFile } = joinPaths();
  removeFile(resultFile);
  removeFile(logFile);
  writeJsonAtomic(JOIN_REPORT_STATE_PATH, { status: 'pending' });
  const logFd = openSync(logFile, 'w');
  const child = spawn(process.execPath, [SELF_PATH, '--run-join'], {
    detached: true,
    stdio: ['pipe', logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd);
  child.stdin.end(`${JSON.stringify({ inviteUrl: normalized, configPath, resultFile, reportFile: JOIN_REPORT_STATE_PATH })}\n`);
  child.unref();
  const startedAt = new Date().toISOString();
  const runtime = { pid: child.pid, startedAt, resultFile, logFile, reportFile: JOIN_REPORT_STATE_PATH };
  writeJsonAtomic(JOIN_RUNTIME_PATH, runtime);
  return { running: true, ...runtime, events: [], log: '' };
}

export function stopJoin() {
  const runtime = readJson(JOIN_RUNTIME_PATH, null);
  if (!runtime || !processAlive(runtime.pid)) return joinStatus();
  const before = joinStatus();
  stopProcessTree(runtime.pid);
  removeFile(JOIN_RUNTIME_PATH);
  return { ...before, running: false, cancelled: true, error: null };
}

function verifyPaths() {
  return {
    resultFile: path.join(USER_DIR, 'postman-pool-verify-result.json'),
    logFile: path.join(USER_DIR, 'postman-pool-verify.log'),
  };
}

export function verifyStatus() {
  return processJobStatus(VERIFY_RUNTIME_PATH, { running: false, events: [], log: '' }, 'Verify process exited before writing a result');
}

export function startVerify(configPath = POSTMAN_POOL_CONFIG_PATH) {
  const current = verifyStatus();
  if (current.running) throw new Error(`A profile verification is already running (pid ${current.pid})`);
  const config = readBrowserConfig(configPath);
  const { resultFile, logFile } = verifyPaths();
  removeFile(resultFile);
  removeFile(logFile);
  const command = buildVerifyWorkerInvocation(config, resultFile);
  const logFd = openSync(logFile, 'w');
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env, MOZ_HEADLESS: '1' },
  });
  closeSync(logFd);
  child.unref();
  const runtime = { pid: child.pid, startedAt: new Date().toISOString(), resultFile, logFile };
  writeJsonAtomic(VERIFY_RUNTIME_PATH, runtime);
  return { running: true, ...runtime, events: [], log: '' };
}

export function stopVerify() {
  const runtime = readJson(VERIFY_RUNTIME_PATH, null);
  if (!runtime || !processAlive(runtime.pid)) return verifyStatus();
  const before = verifyStatus();
  stopProcessTree(runtime.pid);
  removeFile(VERIFY_RUNTIME_PATH);
  return { ...before, running: false, cancelled: true, error: null };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdinJson() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--run-watcher')) {
    await runWatcherProcess();
    return;
  }
  if (args.includes('--watcher-status-json')) return printJson(await watcherStatus());
  if (args.includes('--watcher-start-json')) return printJson(await startWatcher());
  if (args.includes('--watcher-stop-json')) return printJson(await stopWatcher());
  if (args.includes('--profiles-scan-json')) return printJson(scanProfiles());
  if (args.includes('--verify-status-json')) return printJson(verifyStatus());
  if (args.includes('--verify-start-json')) return printJson(startVerify());
  if (args.includes('--verify-stop-json')) return printJson(stopVerify());
  if (args.includes('--run-join')) return runManualJoin(await readStdinJson());
  if (args.includes('--join-status-json')) return printJson(joinStatus());
  if (args.includes('--join-stop-json')) return printJson(stopJoin());
  if (args.includes('--join-start-json')) {
    const input = await readStdinJson();
    return printJson(startJoin(input.inviteUrl));
  }
  throw new Error('Expected a Postman pool control command');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF_PATH)) {
  main().catch((error) => {
    printJson({ ok: false, error: error?.message || String(error) });
    process.exitCode = 1;
  });
}
