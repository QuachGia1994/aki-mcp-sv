import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { browserArgs, buildJoinWorkerInvocation, normalizeManualInvite, parseWorkerEvents } from '../scripts/postman-pool-control.js';

test('GUI join worker keeps invite data out of argv and preserves browser config', () => {
  const config = {
    librewolfBinary: 'C:\\LibreWolf\\librewolf.exe',
    profilesRoot: 'C:\\Profiles',
    profileDirectories: ['Hồ sơ 1', 'Hồ sơ 2'],
    scratchRoot: 'D:\\scratch',
    headless: false,
    timeoutSeconds: 45,
    manualVerificationSeconds: 300,
  };
  const args = browserArgs(config);
  assert.deepEqual(args.slice(0, 4), ['--librewolf-binary', config.librewolfBinary, '--profiles-root', config.profilesRoot]);
  const invocation = buildJoinWorkerInvocation(config, 'D:\\result.json');
  const joined = invocation.args.join(' ');
  assert.match(joined, /--json-stdin/);
  assert.match(joined, /--result-file/);
  assert.doesNotMatch(joined, /invite_code|postman\.com\/join|https:\/\//i);
});

test('GUI accepts a full invite URL or raw invite code without changing the worker boundary', () => {
  const url = 'https://app.getpostman.com/join-team?invite_code=abcdefghijklmnop';
  assert.equal(normalizeManualInvite(url), url);
  assert.equal(normalizeManualInvite('abcdefghijklmnop'), url);
  assert.equal(normalizeManualInvite('not a code'), null);
});

test('GUI progress parser recovers account and verification events from mixed worker log', () => {
  const log = [
    '[postman-pool] plain log',
    '[postman-pool:event] {"type":"account_start","profile":"Hồ sơ 1","index":1,"total":2}',
    'noise',
    '[postman-pool:event] {"type":"manual_verification_required","profile":"Hồ sơ 1"}',
    '[postman-pool:event] {"type":"account_done","profile":"Hồ sơ 1","status":"joined","index":1,"total":2}',
    '[postman-pool:event] {"type":"verify_start","profile":"Hồ sơ 2","index":2,"total":2}',
    '[postman-pool:event] {"type":"verify_done","profile":"Hồ sơ 2","authState":"authenticated","index":2,"total":2}',
  ].join('\n');
  assert.deepEqual(parseWorkerEvents(log).map((event) => event.type), ['account_start', 'manual_verification_required', 'account_done', 'verify_start', 'verify_done']);
});

test('Aki main process no longer owns the Postman pool watcher lifecycle', () => {
  const startSource = readFileSync(new URL('../scripts/start.js', import.meta.url), 'utf8');
  assert.doesNotMatch(startSource, /startPostmanPoolWatcher/);
  assert.doesNotMatch(startSource, /postmanPool\?\.close/);
});

test('Aki Watch bundle ships its complete runtime dependency set and enables CSP', () => {
  const config = JSON.parse(readFileSync(new URL('../apps/aki-watch/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const resources = config.bundle?.resources || {};
  for (const name of ['postman-pool-control.js', 'postman-pool.js', 'postman-pool-setup.js', 'postman-pool-join.py', 'postman-pool-telegram.py', 'userdata.js']) {
    assert.equal(resources[`../../../scripts/${name}`], `aki-watch-runtime/scripts/${name}`);
  }
  const rustSource = readFileSync(new URL('../apps/aki-watch/src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(rustSource, /postman-pool-control\.js/);
  assert.match(rustSource, /postman-pool\.js/);
  assert.match(rustSource, /userdata\.js/);
  assert.match(rustSource, /cfg\(not\(debug_assertions\)\)/);
  assert.ok(config.app?.security?.csp);
  assert.match(config.app.security.csp['connect-src'], /ipc:/);
});

test('profile verification blocks headless mode on every control path', () => {
  const controlSource = readFileSync(new URL('../scripts/postman-pool-control.js', import.meta.url), 'utf8');
  const guards = controlSource.match(/Headless mode is blocked because profile verification may require a visible LibreWolf window/g) || [];
  assert.equal(guards.length, 2);
  assert.match(controlSource, /A profile verification is already running/);
});
