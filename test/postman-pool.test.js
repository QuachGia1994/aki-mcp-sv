#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  extractPostmanInviteUrl,
  formatManualAcceptReport,
  formatManualVerificationReport,
  formatPostmanPoolReport,
  getPostmanPoolConfigStatus,
  isAuthorizedTelegramMessage,
  loadPostmanPoolConfig,
  normalizeInviteUrl,
  parsePostmanPoolWorkerEvent,
  postmanPoolResultIsRetryable,
  resolveReportCredentials,
  sendPostmanPoolReportMessage,
  startPostmanPoolWatcher,
} from '../scripts/postman-pool.js';

const invite = 'https://app.getpostman.com/join-team?invite_code=abc123&ws=deadbeef';
assert.equal(extractPostmanInviteUrl(`pool mới ${invite}`), invite);
assert.equal(extractPostmanInviteUrl('https://example.com/invite?invite_code=abc123'), null);
assert.equal(extractPostmanInviteUrl('https://www.postman.com/explore'), null);
assert.equal(normalizeInviteUrl(`${invite}#ignored`), invite);

const config = { sourceChatId: '-100123', adminUserIds: ['42', '84'] };
assert.equal(isAuthorizedTelegramMessage({ chat: { id: -100123 }, from: { id: 42 } }, config), true);
assert.equal(isAuthorizedTelegramMessage({ chat: { id: -100999 }, from: { id: 42 } }, config), false);
assert.equal(isAuthorizedTelegramMessage({ chat: { id: -100123 }, from: { id: 7 } }, config), false);

const report = formatPostmanPoolReport({
  joined: [
    { profile: 'Hồ sơ 1', email: 'one@example.com', status: 'joined' },
    { profile: 'Hồ sơ 2', email: 'two@example.com', status: 'already_joined' },
  ],
  manualAccept: [{ profile: 'Hồ sơ 5', email: 'five@example.com', status: 'manual_accept_required' }],
  skipped: [{ profile: 'Hồ sơ 3', email: null, status: 'locked' }],
  failed: [{ profile: 'Hồ sơ 4', email: 'four@example.com', status: 'failed', error: `failed at ${invite}` }],
});
assert.match(report, /2 joined\/already joined/);
assert.match(report, /one@example\.com/);
assert.match(report, /two@example\.com/);
assert.match(report, /1 manual accept/);
assert.match(report, /five@example\.com/);
assert.match(report, /manual accept required/i);
assert.match(report, /1 skipped/);
assert.match(report, /1 failed/);
assert.doesNotMatch(report, /invite_code=/, 'Telegram report must never echo the invite bearer URL');

const manualAcceptReport = formatManualAcceptReport({ type: 'manual_accept_required', profile: 'Hồ sơ 6', email: 'six@example.com' });
assert.match(manualAcceptReport, /manual accept required/i);
assert.match(manualAcceptReport, /six@example\.com/);
assert.match(manualAcceptReport, /normal browser/);
assert.doesNotMatch(manualAcceptReport, /invite_code=/, 'manual accept report must never echo the invite bearer URL');

const verificationEvent = parsePostmanPoolWorkerEvent('[postman-pool:event] {"type":"manual_verification_required","profile":"Hồ sơ 5","email":"five@example.com"}');
assert.deepEqual(verificationEvent, { type: 'manual_verification_required', profile: 'Hồ sơ 5', email: 'five@example.com' });
assert.equal(parsePostmanPoolWorkerEvent('[postman-pool] normal log'), null);
assert.match(formatManualVerificationReport(verificationEvent), /five@example\.com/);
assert.match(formatManualVerificationReport(verificationEvent), /open LibreWolf window/);
assert.doesNotMatch(formatManualVerificationReport(verificationEvent), /invite_code=/);
assert.equal(postmanPoolResultIsRetryable({ failed: [{ status: 'manual_verification_timeout' }] }), true);
assert.equal(postmanPoolResultIsRetryable({ failed: [{ status: 'failed' }] }), false);

assert.deepEqual(loadPostmanPoolConfig('/definitely/missing/postman-pool.json'), { enabled: false });

const poolSource = readFileSync(new URL('../scripts/postman-pool.js', import.meta.url), 'utf8');
assert.doesNotMatch(poolSource, /\b(?:getUpdates|deleteWebhook|setWebhook)\b/, 'pool automation must never take ownership of bot inbound updates/webhook');

function waitFor(predicate, message, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(message));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; return true; };
  return child;
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'aki-postman-pool-test-'));
const configPath = path.join(tempDir, 'postman-pool.json');
writeFileSync(configPath, JSON.stringify({
  enabled: true,
  telegramApiId: 12345,
  telegramApiHash: 'not-a-real-secret',
  telegramSessionPath: path.join(tempDir, 'telegram-session'),
  sourceChatId: '-100123',
  adminUserIds: ['42'],
  reportBotToken: 'not-a-real-bot-token',
  reportChatId: '42',
  chromeBinary: 'legacy-chrome.exe',
  chromeUserDataRoot: 'legacy-user-data',
  chromeProfileDirectories: ['Default'],
}));
const defaultPoolConfig = loadPostmanPoolConfig(configPath);
assert.deepEqual(defaultPoolConfig.profileDirectories, [], 'no profileDirectories configured -> discover all');
assert.equal(defaultPoolConfig.librewolfBinary, null);
assert.equal(defaultPoolConfig.profilesRoot, null);
assert.equal(defaultPoolConfig.headless, false);
assert.equal('chromeBinary' in defaultPoolConfig, false, 'legacy Chrome keys must be dropped');
assert.equal('chromeUserDataRoot' in defaultPoolConfig, false);
assert.equal('chromeProfileDirectories' in defaultPoolConfig, false);
const spawns = [];
const fakeSpawn = (file, args) => {
  const child = fakeChild();
  spawns.push({ file, args, child });
  return child;
};
let fetchCalls = 0;
const watcher = startPostmanPoolWatcher({
  configPath,
  statePath: path.join(tempDir, 'idle-state.json'),
  spawnImpl: fakeSpawn,
  fetchImpl: async () => { fetchCalls += 1; throw new Error('unexpected Bot API polling'); },
});
assert.equal(watcher.enabled, true);
assert.equal(spawns.length, 1, 'enabling the watcher should start only the Telethon transport child');
assert.match(spawns[0].args.join(' '), /postman-pool-telegram\.py --json-lines/);
assert.equal(fetchCalls, 0, 'source listening must not call Telegram Bot API/getUpdates');
watcher.close();
assert.equal(spawns[0].child.killed, true);

const integrationSpawns = [];
const joinInputs = [];
const integrationSpawn = (file, args) => {
  const child = fakeChild();
  const row = { file, args, child };
  integrationSpawns.push(row);
  if (args.includes('--json-stdin')) {
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk.toString(); });
    child.stdin.on('end', () => { joinInputs.push(input); });
  }
  return child;
};
const reportCalls = [];
const integrationWatcher = startPostmanPoolWatcher({
  configPath,
  statePath: path.join(tempDir, 'integration-state.json'),
  spawnImpl: integrationSpawn,
  fetchImpl: async (url, options) => {
    reportCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  },
});
const listener = integrationSpawns[0].child;
const emitMessage = (message) => listener.stdout.write(`${JSON.stringify(message)}\n`);
const entityInvite = 'https://app.getpostman.com/join-team?invite_code=entity-secret';
const secondInvite = 'https://app.getpostman.com/join-team?invite_code=second-secret';

emitMessage({ chat: { id: -100999 }, from: { id: 42 }, text: entityInvite });
emitMessage({ chat: { id: -100123 }, from: { id: 7 }, text: entityInvite });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(integrationSpawns.length, 1, 'unauthorized chat/sender must not start a join worker');

emitMessage({ chat: { id: -100123 }, from: { id: 42 }, text: 'pool link', entities: [{ type: 'text_link', url: entityInvite }] });
await waitFor(() => integrationSpawns.length === 2, 'authorized text_link invite did not start a join worker');
assert.doesNotMatch(integrationSpawns[1].args.join(' '), /invite_code=/, 'invite bearer must not appear in worker argv');
await waitFor(() => joinInputs.length === 1, 'first join worker did not receive stdin input');
assert.equal(JSON.parse(joinInputs[0]).inviteUrl, entityInvite);
assert.match(integrationSpawns[1].args.join(' '), /--manual-verification-timeout 300/);
assert.doesNotMatch(integrationSpawns[1].args.join(' '), /--chrome-binary|--chrome-user-data-root|--chrome-profile-directory/, 'Chrome/CDP flags must never be passed to the worker');
integrationSpawns[1].child.stderr.write('[postman-pool:event] {"type":"manual_verification_required","profile":"Hồ sơ 1","email":"one@example.com"}\n');
await waitFor(() => reportCalls.length === 1, 'manual verification progress was not reported while the worker remained open');
const verificationReportBody = JSON.parse(reportCalls[0].options.body);
assert.match(verificationReportBody.text, /Cloudflare verification required/);
assert.match(verificationReportBody.text, /one@example\.com/);

emitMessage({ chat: { id: -100123 }, from: { id: 42 }, text: secondInvite });
emitMessage({ chat: { id: -100123 }, from: { id: 42 }, text: entityInvite });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(integrationSpawns.length, 2, 'queue must not overlap join workers');

integrationSpawns[1].child.stdout.write(JSON.stringify({ joined: [{ profile: 'Hồ sơ 1', email: 'one@example.com', status: 'joined' }], skipped: [], failed: [] }));
integrationSpawns[1].child.exitCode = 0;
integrationSpawns[1].child.emit('exit', 0);
await waitFor(() => reportCalls.length === 2 && integrationSpawns.length === 3, 'second invite did not run after first completed');
await waitFor(() => joinInputs.length === 2, 'second join worker did not receive stdin input');
assert.equal(JSON.parse(joinInputs[1]).inviteUrl, secondInvite);

integrationSpawns[2].child.stdout.write(JSON.stringify({ joined: [], skipped: [], failed: [{ profile: 'Hồ sơ 2', error: `failed at ${secondInvite}` }] }));
integrationSpawns[2].child.exitCode = 0;
integrationSpawns[2].child.emit('exit', 0);
await waitFor(() => reportCalls.length === 3, 'second report was not sent');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(integrationSpawns.length, 3, 'duplicate invite must be deduplicated after the first run');
for (const call of reportCalls) {
  assert.match(call.url, /\/sendMessage$/);
  assert.doesNotMatch(call.url, /getUpdates|setWebhook|deleteWebhook/);
  assert.doesNotMatch(String(call.options?.body || ''), /invite_code=/, 'Telegram report must redact invite bearer URLs');
}
integrationWatcher.close();
assert.equal(listener.killed, true);

// A worker crash after manual verification begins must remain retryable instead of poisoning dedupe state.
const retrySpawns = [];
const retryReports = [];
const retrySpawn = (file, args) => {
  const child = fakeChild();
  retrySpawns.push({ file, args, child });
  return child;
};
const retryWatcher = startPostmanPoolWatcher({
  configPath,
  statePath: path.join(tempDir, 'manual-retry-state.json'),
  spawnImpl: retrySpawn,
  fetchImpl: async (url, options) => {
    retryReports.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  },
});
const retryListener = retrySpawns[0].child;
retryListener.stdout.write(`${JSON.stringify({ chat: { id: -100123 }, from: { id: 42 }, text: entityInvite })}\n`);
await waitFor(() => retrySpawns.length === 2, 'retry test did not start first join worker');
retrySpawns[1].child.stderr.write('[postman-pool:event] {"type":"manual_verification_required","profile":"Hồ sơ 1"}\n');
await waitFor(() => retryReports.length === 1, 'retry test did not forward manual verification event');
retrySpawns[1].child.exitCode = 1;
retrySpawns[1].child.emit('exit', 1);
await waitFor(() => retryReports.length === 2, 'retry test did not report worker failure');
retryListener.stdout.write(`${JSON.stringify({ chat: { id: -100123 }, from: { id: 42 }, text: entityInvite })}\n`);
await waitFor(() => retrySpawns.length === 3, 'invite was incorrectly deduped after worker crashed during manual verification');
retryWatcher.close();

// resolveReportCredentials + sendPostmanPoolReportMessage: outbound sendMessage-only report path.
const credConfigPath = path.join(tempDir, 'creds.json');
writeFileSync(credConfigPath, JSON.stringify({ enabled: false, reportBotToken: 'config-token', reportChatId: '279000740' }));
delete process.env.AKI_POSTMAN_POOL_REPORT_BOT_TOKEN;
let creds = resolveReportCredentials(credConfigPath);
assert.equal(creds.reportBotToken, 'config-token', 'disabled config still exposes the report token for a manual test');
assert.equal(creds.reportChatId, '279000740');
assert.equal(creds.tokenSource, 'config');
process.env.AKI_POSTMAN_POOL_REPORT_BOT_TOKEN = 'env-token';
creds = resolveReportCredentials(credConfigPath);
assert.equal(creds.reportBotToken, 'env-token', 'env token overrides config token');
assert.equal(creds.tokenSource, 'env');
delete process.env.AKI_POSTMAN_POOL_REPORT_BOT_TOKEN;

const sendCalls = [];
const sendResult = await sendPostmanPoolReportMessage(
  { reportBotToken: 'config-token', reportChatId: '279000740' },
  'aki outbound test',
  async (url, options) => {
    sendCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  },
);
assert.equal(sendCalls.length, 1);
assert.match(sendCalls[0].url, /\/sendMessage$/, 'report test must call sendMessage only');
assert.doesNotMatch(sendCalls[0].url, /getUpdates|setWebhook|deleteWebhook/, 'report test must never touch inbound routing');
const sentBody = JSON.parse(sendCalls[0].options.body);
assert.equal(sentBody.chat_id, '279000740');
assert.equal(sentBody.text, 'aki outbound test');
assert.equal(sendResult.message_id, 7);

// getPostmanPoolConfigStatus: readiness summary that never surfaces secret values.
const statusConfigPath = path.join(tempDir, 'status.json');
delete process.env.AKI_POSTMAN_POOL_REPORT_BOT_TOKEN;
delete process.env.AKI_POSTMAN_POOL_TELEGRAM_API_ID;
delete process.env.AKI_POSTMAN_POOL_TELEGRAM_API_HASH;
writeFileSync(statusConfigPath, JSON.stringify({ enabled: false, telegramApiId: 0, telegramApiHash: '', sourceChatId: '', adminUserIds: [], reportBotToken: '', reportChatId: '' }));
let poolStatus = getPostmanPoolConfigStatus(statusConfigPath);
assert.equal(poolStatus.ready, false);
assert.deepEqual([...poolStatus.missing].sort(), ['adminUserIds', 'reportBotToken', 'reportChatId', 'sourceChatId', 'telegramApiHash', 'telegramApiId'].sort());
assert.ok(!('reportBotToken' in poolStatus) && !('telegramApiHash' in poolStatus), 'status never surfaces secret values');
writeFileSync(statusConfigPath, JSON.stringify({ enabled: true, telegramApiId: 12345, telegramApiHash: 'h', sourceChatId: '-100123', adminUserIds: [42], reportBotToken: 't', reportChatId: '279000740' }));
poolStatus = getPostmanPoolConfigStatus(statusConfigPath);
assert.equal(poolStatus.ready, true);
assert.deepEqual(poolStatus.missing, []);
assert.equal(poolStatus.enabled, true);
assert.equal(poolStatus.tokenSource, 'config');

const librewolfConfigPath = path.join(tempDir, 'librewolf-pool.json');
writeFileSync(librewolfConfigPath, JSON.stringify({
  enabled: true,
  telegramApiId: 12345,
  telegramApiHash: 'not-a-real-secret',
  telegramSessionPath: path.join(tempDir, 'telegram-session-lw'),
  sourceChatId: '-100123',
  adminUserIds: ['42'],
  reportBotToken: 'not-a-real-bot-token',
  reportChatId: '42',
  librewolfBinary: '/opt/librewolf/librewolf',
  profilesRoot: '/home/pool/librewolf/Profiles',
  profileDirectories: ['Hồ sơ 1', 'Hồ sơ 2'],
  headless: true,
}));
const loadedLibrewolfConfig = loadPostmanPoolConfig(librewolfConfigPath);
assert.equal('chromeBinary' in loadedLibrewolfConfig, false);
assert.equal(loadedLibrewolfConfig.librewolfBinary, '/opt/librewolf/librewolf');
assert.equal(loadedLibrewolfConfig.profilesRoot, '/home/pool/librewolf/Profiles');
assert.deepEqual(loadedLibrewolfConfig.profileDirectories, ['Hồ sơ 1', 'Hồ sơ 2']);
assert.equal(loadedLibrewolfConfig.headless, true);
const librewolfSpawns = [];
const librewolfReports = [];
const librewolfWatcher = startPostmanPoolWatcher({
  configPath: librewolfConfigPath,
  statePath: path.join(tempDir, 'librewolf-state.json'),
  spawnImpl: (file, args) => {
    const child = fakeChild();
    librewolfSpawns.push({ file, args, child });
    return child;
  },
  fetchImpl: async (url, options) => {
    librewolfReports.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  },
});
librewolfSpawns[0].child.stdout.write(`${JSON.stringify({ chat: { id: -100123 }, from: { id: 42 }, text: entityInvite })}\n`);
await waitFor(() => librewolfSpawns.length === 2, 'LibreWolf config did not start a join worker');
const librewolfWorkerArgs = librewolfSpawns[1].args.join(' ');
assert.doesNotMatch(librewolfWorkerArgs, /--chrome-binary|--chrome-user-data-root|--chrome-profile-directory/);
assert.match(librewolfWorkerArgs, /--librewolf-binary \/opt\/librewolf\/librewolf/);
assert.match(librewolfWorkerArgs, /--profiles-root \/home\/pool\/librewolf\/Profiles/);
assert.match(librewolfWorkerArgs, /--profile-directory Hồ sơ 1/);
assert.match(librewolfWorkerArgs, /--profile-directory Hồ sơ 2/);
assert.match(librewolfWorkerArgs, /--headless/);
assert.doesNotMatch(librewolfWorkerArgs, /not-a-real-secret|not-a-real-bot-token/);
librewolfSpawns[1].child.stdout.write(JSON.stringify({ joined: [], skipped: [], failed: [] }));
librewolfSpawns[1].child.exitCode = 0;
librewolfSpawns[1].child.emit('exit', 0);
await waitFor(() => librewolfReports.length === 1, 'LibreWolf worker completion was not reported');
librewolfWatcher.close();

rmSync(tempDir, { recursive: true, force: true });

console.log('postman-pool.test.js: ok');
