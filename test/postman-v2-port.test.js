import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownership = require('../scripts/aki-pmcontrol/scripts/postman-ownership.js');
const { PostmanSession, browserIdentity } = require('../scripts/aki-pmcontrol/scripts/postman-session.js');
const eligible = (url) => /^https:\/\/desktop\.postman\.com\//.test(url || '');

test('Postman ownership chooses one deterministic owner and opens exactly one created window', async () => {
  const initial = [
    { id: 'b', type: 'page', url: 'https://desktop.postman.com/two' },
    { id: 'a', type: 'page', url: 'https://desktop.postman.com/one' },
    { id: 'x', type: 'page', url: 'https://example.com/' },
  ];
  assert.deepEqual(ownership.attachmentTargets(initial, eligible).map((item) => item.id), ['a', 'b']);
  assert.equal(ownership.deterministicOwnerTargetId(initial, eligible), 'a');

  let evaluateCalls = 0;
  let listCalls = 0;
  const created = { id: 'c', type: 'page', url: 'https://desktop.postman.com/new' };
  const target = await ownership.openOwnedWindow({
    ownerClient: { Runtime: { evaluate: async () => { evaluateCalls += 1; } } },
    listTargets: async () => (++listCalls === 1 ? initial : [...initial, created]),
    isEligible: eligible,
    timeoutMs: 100,
    pollMs: 1,
  });
  assert.equal(evaluateCalls, 1);
  assert.equal(target.id, 'c');
});

test('Postman session returns the structured control contract expected by the ownership controller', async () => {
  const cdp = {
    List: async ({ port }) => [{ id: 'target-a', type: 'page', url: `https://desktop.postman.com/${port}` }],
    Version: async ({ port }) => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-a` }),
  };
  const session = await PostmanSession.ensureRunning({ port: 9333, cdp });
  assert.equal(session.port, 9333);
  assert.equal(session.launched, false);
  assert.equal(session.launchProcessPid, null);
  assert.equal(session.targets[0].id, 'target-a');
  assert.deepEqual(session.browserIdentity, { kind: 'browser-websocket', browserId: 'browser-a' });
  assert.deepEqual(browserIdentity(null, 9333), { kind: 'endpoint-fallback', endpoint: 'http://127.0.0.1:9333' });
});

test('Postman prompt is bundled SSoT and keeps OpenCode vision instructions', () => {
  const controller = fs.readFileSync(path.join(root, 'scripts/aki-pmcontrol/index.js'), 'utf8');
  const autoclicker = fs.readFileSync(path.join(root, 'scripts/aki-pmcontrol/scripts/cdp-autoclicker.js'), 'utf8');
  const prompt = fs.readFileSync(path.join(root, 'scripts/aki-pmcontrol/assets/prompts/postman.md'), 'utf8');
  assert.match(controller, /loadInstruction\(\[DEFAULT_PROMPT_PATH\]\)/);
  assert.doesNotMatch(controller, /USER_PROMPT_PATH|LEGACY_INSTRUCTION_PATH|LEGACY_REPO_INSTRUCTION_PATH|__cdpSaveInstruction/);
  assert.match(autoclicker, /aki-instruction-textarea[^>]*readonly/);
  assert.doesNotMatch(autoclicker, /__cdpSaveInstruction/);
  assert.match(prompt, /vision_analyze/);
});

test('CDP probe is read-only and contains no state-changing debug switches', () => {
  const probe = fs.readFileSync(path.join(root, 'scripts/aki-pmcontrol/scripts/cdp-probe.js'), 'utf8');
  assert.match(probe, /Runtime\.evaluate/);
  assert.doesNotMatch(probe, /\.click\(|localStorage\.setItem|--click|--apply|--prompt|--enable-mcp|Authorization\s*:/);
});

test('dev runtime is isolated from production data and ports', () => {
  const userdata = fs.readFileSync(path.join(root, 'scripts/userdata.js'), 'utf8');
  const start = fs.readFileSync(path.join(root, 'scripts/start.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(userdata, /IS_DEV/);
  assert.match(userdata, /mcpsv-dev/);
  assert.match(start, /IS_DEV \? '9997' : '9999'/);
  assert.match(start, /IS_DEV \? '9996' : '9998'/);
  assert.match(start, /IS_DEV \? '19998' : '19999'/);
  assert.equal(pkg.scripts.dev, 'node ./scripts/start.js --dev');
});
