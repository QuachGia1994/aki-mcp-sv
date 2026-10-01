#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PostmanSession } = require('../postman-session.cjs');

function fakeCdp(liveBrowserId) {
  const calls = { connect: 0, closeBrowser: 0, closeClient: 0 };
  const cdp = async () => {
    calls.connect += 1;
    return {
      Browser: { close: async () => { calls.closeBrowser += 1; } },
      close: async () => { calls.closeClient += 1; },
    };
  };
  cdp.List = async () => [];
  cdp.Version = async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/browser/${liveBrowserId}` });
  return { cdp, calls };
}

const ownedSession = {
  launched: true,
  port: 9222,
  browserIdentity: { kind: 'browser-websocket', browserId: 'owned-browser' },
};

{
  const { cdp, calls } = fakeCdp('owned-browser');
  assert.equal(await PostmanSession.closeIfLaunched(ownedSession, { cdp }), true);
  assert.equal(calls.connect, 1);
  assert.equal(calls.closeBrowser, 1, 'owned Postman must receive Browser.close');
  assert.equal(calls.closeClient, 1);
}

{
  const { cdp, calls } = fakeCdp('owned-browser');
  assert.equal(await PostmanSession.closeIfLaunched({ ...ownedSession, launched: false }, { cdp }), false);
  assert.equal(calls.connect, 0, 'adopted Postman must never be closed by Aki shutdown');
  assert.equal(calls.closeBrowser, 0);
}

{
  const { cdp, calls } = fakeCdp('replacement-browser');
  assert.equal(await PostmanSession.closeIfLaunched(ownedSession, { cdp }), false);
  assert.equal(calls.connect, 0, 'a replacement browser on the same port must not be closed');
  assert.equal(calls.closeBrowser, 0);
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const startSrc = readFileSync(path.join(repoRoot, 'scripts/start.js'), 'utf8');
const daemonSrc = readFileSync(path.join(repoRoot, 'scripts/postman/postman-daemon.cjs'), 'utf8');
assert.match(startSrc, /async function shutdown\(code = 0\)[\s\S]*await killPostmanDaemon\(\)[\s\S]*process\.exit\(code\)/, 'Aki shutdown must await Postman daemon cleanup before exit');
assert.match(daemonSrc, /await PostmanSession\.closeIfLaunched\(controlSession\)/, 'daemon shutdown must close only the Postman session it launched');

console.log('postman-session-lifecycle.test.js: ok');
