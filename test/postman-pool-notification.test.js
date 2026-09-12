import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runManualJoin } from '../scripts/postman-pool-control.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aki-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ reportBotToken: 'test-secret', reportChatId: '123', timeoutSeconds: 45 }));
  return { configPath, resultFile: path.join(dir, 'result.json'), reportFile: path.join(dir, 'report.json'), inviteUrl: 'https://app.getpostman.com/join-team?invite_code=test' };
}

function worker(job, result, code = 0) {
  return (file, args, options) => {
    assert.ok(!args.some((arg) => arg.includes('invite_code')));
    assert.equal(options.detached, undefined);
    const child = new EventEmitter();
    child.stdin = { on() {}, end(input) {
      assert.equal(JSON.parse(input).inviteUrl, job.inviteUrl);
      queueMicrotask(() => {
        if (result) writeFileSync(job.resultFile, JSON.stringify(result));
        child.emit('close', code);
      });
    } };
    return child;
  };
}

test('manual Join sends completion without status polling and waits until delivery settles', async (t) => {
  const job = fixture(t);
  const result = { poolName: 'Pool', accounts: [{ email: 'one@example.com', status: 'joined' }], joined: [{}], failed: [] };
  let release;
  let calls = 0;
  let settled = false;
  const sent = runManualJoin(job, { spawnImpl: worker(job, result), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).chat_id, '123');
    assert.match(JSON.parse(options.body).text, /one@example.com/);
    assert.ok(options.signal);
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
  } }).then((value) => { settled = true; return value; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(JSON.parse(readFileSync(job.reportFile)).status, 'sending');
  release();
  assert.equal((await sent).status, 'sent');
  assert.equal(JSON.parse(readFileSync(job.reportFile)).messageId, 42);
  assert.equal(calls, 1);
});

test('delivery failure preserves Join result and hides credentials in persisted diagnostics', async (t) => {
  const job = fixture(t);
  const result = { joined: [{}], failed: [{}] };
  const report = await runManualJoin(job, { spawnImpl: worker(job, result), fetchImpl: async () => { throw new Error('request https://api.telegram.org/bottest-secret/sendMessage failed test-secret'); } });
  assert.equal(report.status, 'failed');
  assert.deepEqual(JSON.parse(readFileSync(job.resultFile)), result);
  assert.doesNotMatch(readFileSync(job.reportFile, 'utf8'), /test-secret|api\.telegram/);
});

test('worker failure reports failure immediately without waiting for another run result', async (t) => {
  const job = fixture(t);
  let text;
  const report = await runManualJoin(job, { spawnImpl: worker(job, null, 1), fetchImpl: async (url, options) => {
    text = JSON.parse(options.body).text;
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  } });
  assert.match(text, /automation failed/);
  assert.match(report.jobError, /exited/);
  assert.equal(report.status, 'sent');
});

test('missing report configuration remains an explicit failure without contacting Telegram', async (t) => {
  const job = fixture(t);
  writeFileSync(job.configPath, '{}');
  let calls = 0;
  const report = await runManualJoin(job, { spawnImpl: worker(job, { joined: [], failed: [] }), fetchImpl: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(report.status, 'failed');
  assert.match(report.error, /Settings/);
});

test('Telegram rejection retains the API explanation for the user', async (t) => {
  const job = fixture(t);
  const report = await runManualJoin(job, { spawnImpl: worker(job, { joined: [], failed: [] }), fetchImpl: async () => ({
    ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }),
  }) });
  assert.equal(report.status, 'failed');
  assert.match(report.error, /403.*bot was blocked/);
});

test('worker success without a result sends an automation failure, not a completion report', async (t) => {
  const job = fixture(t);
  let text;
  const report = await runManualJoin(job, { spawnImpl: worker(job, null), fetchImpl: async (url, options) => {
    text = JSON.parse(options.body).text;
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 8 } }) };
  } });
  assert.match(text, /automation failed.*valid result/);
  assert.match(report.jobError, /valid result/);
});
