#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  extractPostmanInviteUrl,
  formatPostmanPoolReport,
  isAuthorizedTelegramMessage,
  loadPostmanPoolConfig,
  normalizeInviteUrl,
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
  skipped: [{ profile: 'Hồ sơ 3', email: null, status: 'locked' }],
  failed: [{ profile: 'Hồ sơ 4', email: 'four@example.com', status: 'failed', error: `failed at ${invite}` }],
});
assert.match(report, /2 joined\/already joined/);
assert.match(report, /one@example\.com/);
assert.match(report, /two@example\.com/);
assert.match(report, /1 skipped/);
assert.match(report, /1 failed/);
assert.doesNotMatch(report, /invite_code=/, 'Telegram report must never echo the invite bearer URL');

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
}));
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

emitMessage({ chat: { id: -100123 }, from: { id: 42 }, text: secondInvite });
emitMessage({ chat: { id: -100123 }, from: { id: 42 }, text: entityInvite });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(integrationSpawns.length, 2, 'queue must not overlap join workers');

integrationSpawns[1].child.stdout.write(JSON.stringify({ joined: [{ profile: 'Hồ sơ 1', email: 'one@example.com', status: 'joined' }], skipped: [], failed: [] }));
integrationSpawns[1].child.exitCode = 0;
integrationSpawns[1].child.emit('exit', 0);
await waitFor(() => reportCalls.length === 1 && integrationSpawns.length === 3, 'second invite did not run after first completed');
await waitFor(() => joinInputs.length === 2, 'second join worker did not receive stdin input');
assert.equal(JSON.parse(joinInputs[1]).inviteUrl, secondInvite);

integrationSpawns[2].child.stdout.write(JSON.stringify({ joined: [], skipped: [], failed: [{ profile: 'Hồ sơ 2', error: `failed at ${secondInvite}` }] }));
integrationSpawns[2].child.exitCode = 0;
integrationSpawns[2].child.emit('exit', 0);
await waitFor(() => reportCalls.length === 2, 'second report was not sent');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(integrationSpawns.length, 3, 'duplicate invite must be deduplicated after the first run');
for (const call of reportCalls) {
  assert.match(call.url, /\/sendMessage$/);
  assert.doesNotMatch(call.url, /getUpdates|setWebhook|deleteWebhook/);
  assert.doesNotMatch(String(call.options?.body || ''), /invite_code=/, 'Telegram report must redact invite bearer URLs');
}
integrationWatcher.close();
assert.equal(listener.killed, true);

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

rmSync(tempDir, { recursive: true, force: true });

console.log('postman-pool.test.js: ok');
