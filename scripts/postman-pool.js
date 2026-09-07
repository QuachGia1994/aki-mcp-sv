import { createHash } from 'node:crypto';
import cp from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_DIR } from './userdata.js';

export const POSTMAN_POOL_CONFIG_PATH = path.join(USER_DIR, 'postman-pool.json');
const POSTMAN_POOL_STATE_PATH = path.join(USER_DIR, 'postman-pool-state.json');
const JOIN_WORKER_PATH = fileURLToPath(new URL('./postman-pool-join.py', import.meta.url));
const TELEGRAM_LISTENER_PATH = fileURLToPath(new URL('./postman-pool-telegram.py', import.meta.url));
const POSTMAN_HOST_SUFFIXES = ['postman.com', 'getpostman.com', 'postman.co'];
const MAX_SEEN = 100;

function allowedPostmanHost(hostname) {
  const host = hostname.toLowerCase();
  return POSTMAN_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function inviteSignal(url) {
  const pathName = url.pathname.toLowerCase();
  return url.searchParams.has('invite_code') || url.searchParams.has('inviteCode') || pathName.includes('join-team') || pathName.includes('team-invite') || /(^|\/)invite(?:\/|$)/.test(pathName);
}

export function normalizeInviteUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'https:' || !allowedPostmanHost(url.hostname) || !inviteSignal(url)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function textUrls(text) {
  if (!text) return [];
  return String(text).match(/https:\/\/[^\s<>"']+/gi) ?? [];
}

export function extractPostmanInviteUrl(text) {
  for (const raw of textUrls(text)) {
    const normalized = normalizeInviteUrl(raw.replace(/[),.;!?]+$/, ''));
    if (normalized) return normalized;
  }
  return null;
}

function messageEntityUrls(message) {
  const urls = [];
  for (const group of [message.entities, message.caption_entities]) {
    if (!Array.isArray(group)) continue;
    for (const entity of group) if (entity?.type === 'text_link' && entity.url) urls.push(entity.url);
  }
  return urls;
}

function inviteFromMessage(message) {
  const fromText = extractPostmanInviteUrl(message?.text) || extractPostmanInviteUrl(message?.caption);
  if (fromText) return fromText;
  for (const raw of messageEntityUrls(message ?? {})) {
    const normalized = normalizeInviteUrl(raw);
    if (normalized) return normalized;
  }
  return null;
}

export function isAuthorizedTelegramMessage(message, config) {
  if (!message?.chat?.id || !message?.from?.id) return false;
  if (String(message.chat.id) !== String(config.sourceChatId)) return false;
  const allowed = new Set((config.adminUserIds ?? []).map(String));
  return allowed.has(String(message.from.id));
}

function redactInviteUrls(value) {
  return String(value || '').replace(/https:\/\/[^\s<>"']+/gi, '[invite-url]');
}

function shortError(value) {
  return redactInviteUrls(value || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function formatPostmanPoolReport(result) {
  const joined = Array.isArray(result?.joined) ? result.joined : [];
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  const lines = [`Postman pool: ${joined.length} joined/already joined · ${skipped.length} skipped · ${failed.length} failed`];
  for (const row of joined) lines.push(`✓ ${row.email || row.profile || 'unknown account'}${row.profile && row.email ? ` (${row.profile})` : ''}`);
  for (const row of skipped) lines.push(`- ${row.email || row.profile || 'unknown account'}: ${shortError(row.status || row.error || 'skipped')}`);
  for (const row of failed) lines.push(`✗ ${row.email || row.profile || 'unknown account'}: ${shortError(row.error || row.status || 'failed')}`);
  return lines.join('\n');
}

function readJson(pathName, fallback) {
  if (!existsSync(pathName)) return fallback;
  try { return JSON.parse(readFileSync(pathName, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(pathName, value) {
  const tmp = `${pathName}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, pathName);
}

export function loadPostmanPoolConfig(configPath = POSTMAN_POOL_CONFIG_PATH) {
  const raw = readJson(configPath, null);
  if (!raw?.enabled) return { enabled: false };
  const telegramApiId = Number(process.env.AKI_POSTMAN_POOL_TELEGRAM_API_ID || raw.telegramApiId);
  const telegramApiHash = process.env.AKI_POSTMAN_POOL_TELEGRAM_API_HASH || raw.telegramApiHash;
  const reportBotToken = process.env.AKI_POSTMAN_POOL_REPORT_BOT_TOKEN || raw.reportBotToken || raw.botToken;
  const adminUserIds = Array.isArray(raw.adminUserIds) ? raw.adminUserIds.map(String).filter(Boolean) : [];
  if (!Number.isSafeInteger(telegramApiId) || telegramApiId <= 0 || !telegramApiHash || !raw.sourceChatId || adminUserIds.length === 0) {
    throw new Error('postman-pool.json enabled but telegramApiId/telegramApiHash/sourceChatId/adminUserIds is incomplete');
  }
  if (!reportBotToken || !raw.reportChatId) throw new Error('postman-pool.json enabled but reportBotToken/reportChatId is incomplete');
  return {
    enabled: true,
    telegramApiId,
    telegramApiHash,
    telegramSessionPath: raw.telegramSessionPath || path.join(USER_DIR, 'postman-pool-telegram'),
    sourceChatId: String(raw.sourceChatId),
    reportBotToken,
    reportChatId: String(raw.reportChatId),
    adminUserIds,
    profileRoot: raw.profileRoot || null,
    librewolfBinary: raw.librewolfBinary || null,
    scratchRoot: raw.scratchRoot || null,
    timeoutSeconds: Number.isFinite(Number(raw.timeoutSeconds)) ? Math.max(10, Math.min(120, Number(raw.timeoutSeconds))) : 45,
  };
}

function fingerprint(url) {
  return createHash('sha256').update(url).digest('hex');
}

function pythonCommand(scriptPath, extraArgs = []) {
  return process.platform === 'win32' ? { file: 'py', args: ['-3', scriptPath, ...extraArgs] } : { file: 'python3', args: [scriptPath, ...extraArgs] };
}

function runJoinWorker(inviteUrl, config, spawnImpl = cp.spawn) {
  return new Promise((resolve, reject) => {
    const command = pythonCommand(JOIN_WORKER_PATH, ['--json-stdin']);
    const args = [...command.args];
    if (config.profileRoot) args.push('--profile-root', config.profileRoot);
    if (config.librewolfBinary) args.push('--librewolf-binary', config.librewolfBinary);
    if (config.scratchRoot) args.push('--scratch-root', config.scratchRoot);
    args.push('--timeout', String(config.timeoutSeconds));
    const child = spawnImpl(command.file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(shortError(stderr || `join worker exited ${code}`)));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`join worker returned invalid JSON: ${shortError(stdout || stderr)}`)); }
    });
    child.stdin?.end(`${JSON.stringify({ inviteUrl })}\n`);
  });
}

async function telegramBotCall(config, method, body, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${config.reportBotToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed (${response.status})`);
  return data.result;
}

export function resolveReportCredentials(configPath = POSTMAN_POOL_CONFIG_PATH) {
  const raw = readJson(configPath, null) || {};
  const envToken = process.env.AKI_POSTMAN_POOL_REPORT_BOT_TOKEN;
  const reportBotToken = envToken || raw.reportBotToken || raw.botToken || '';
  const reportChatId = raw.reportChatId ? String(raw.reportChatId) : '';
  const tokenSource = envToken ? 'env' : raw.reportBotToken || raw.botToken ? 'config' : 'none';
  return { reportBotToken, reportChatId, tokenSource };
}

export async function sendPostmanPoolReportMessage(credentials, text, fetchImpl = fetch) {
  return telegramBotCall({ reportBotToken: credentials.reportBotToken }, 'sendMessage', { chat_id: credentials.reportChatId, text }, fetchImpl);
}

function startTelegramUserListener(config, onMessage, spawnImpl = cp.spawn) {
  const command = pythonCommand(TELEGRAM_LISTENER_PATH, ['--json-lines']);
  const child = spawnImpl(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch (error) { console.error(`[postman-pool] listener output error: ${shortError(error.message)}`); }
    }
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
    const lines = stderr.split(/\r?\n/);
    stderr = lines.pop() || '';
    for (const line of lines) if (line.trim()) console.error(`[postman-pool] listener: ${shortError(line)}`);
  });
  child.on('error', (error) => console.error(`[postman-pool] Telegram user listener failed: ${shortError(error.message)}`));
  child.on('exit', (code) => {
    if (code !== 0) console.error(`[postman-pool] Telegram user listener exited (${code})${stderr.trim() ? `: ${shortError(stderr)}` : ''}`);
  });
  child.stdin?.end(`${JSON.stringify({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    sessionPath: config.telegramSessionPath,
    sourceChatId: config.sourceChatId,
  })}\n`);
  return child;
}

export function startPostmanPoolWatcher({ configPath = POSTMAN_POOL_CONFIG_PATH, statePath = POSTMAN_POOL_STATE_PATH, fetchImpl = fetch, spawnImpl = cp.spawn } = {}) {
  let config;
  try { config = loadPostmanPoolConfig(configPath); } catch (error) {
    console.error(`[postman-pool] disabled: ${error.message}`);
    return { enabled: false, close() {} };
  }
  if (!config.enabled) return { enabled: false, close() {} };

  const state = readJson(statePath, { seen: [] });
  const seen = new Set(Array.isArray(state.seen) ? state.seen.slice(-MAX_SEEN) : []);
  let stopped = false;
  let queue = Promise.resolve();
  const persist = () => writeJsonAtomic(statePath, { seen: [...seen].slice(-MAX_SEEN) });
  const remember = (hash) => {
    seen.add(hash);
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    persist();
  };
  const report = async (text) => telegramBotCall(config, 'sendMessage', { chat_id: config.reportChatId, text }, fetchImpl);

  const handle = async (message) => {
    if (!isAuthorizedTelegramMessage(message, config)) return;
    const inviteUrl = inviteFromMessage(message);
    if (!inviteUrl) return;
    const hash = fingerprint(inviteUrl);
    if (seen.has(hash)) return;
    try {
      const result = await runJoinWorker(inviteUrl, config, spawnImpl);
      remember(hash);
      await report(formatPostmanPoolReport(result));
    } catch (error) {
      remember(hash);
      await report(`Postman pool: automation failed · ${shortError(error.message)}`);
    }
  };

  const listener = startTelegramUserListener(config, (message) => {
    if (stopped) return;
    queue = queue.then(() => handle(message)).catch((error) => console.error(`[postman-pool] queue error: ${shortError(error.message)}`));
  }, spawnImpl);
  console.log(`[postman-pool] Telegram user-session watcher active for chat ${config.sourceChatId}; invite URLs are never logged`);
  return {
    enabled: true,
    close() {
      stopped = true;
      if (listener.exitCode === null && !listener.killed) listener.kill();
    },
  };
}
