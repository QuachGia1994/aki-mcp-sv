import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPanel } from '../scripts/panel.js';

function panelOptions(overrides = {}) {
  return {
    port: 0,
    token: 'instance-test-token',
    origin: 'https://example.test',
    ingress: 'public-origin',
    client: { clientId: 'test', clientSecret: 'test' },
    passphrase: 'test-pass',
    updateInfo: { mcp: {}, rule: {} },
    ...overrides,
  };
}

test('panel exposes authenticated instance identity and handoff callback', async () => {
  let requested = false;
  const instance = { instanceId: 'instance-a', pid: 1234, version: '1.15.0' };
  const server = startPanel(panelOptions({ instance, onInstanceHandoff: () => { requested = true; } }));
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/instance`, { headers: { 'x-panel-token': 'wrong' } });
    assert.equal(denied.status, 403);

    const info = await fetch(`${base}/api/instance`, { headers: { 'x-panel-token': 'instance-test-token' } });
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), instance);

    const handoff = await fetch(`${base}/api/instance-handoff`, {
      method: 'POST',
      headers: { 'x-panel-token': 'instance-test-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(handoff.status, 200);
    assert.equal(requested, true);
  } finally {
    server.close();
    if (server.listening) await once(server, 'close');
  }
});

test('panel advances to a free loopback port when its preferred port is occupied', async () => {
  const blocker = net.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const preferredPort = blocker.address().port;
  const server = startPanel(panelOptions({ port: preferredPort }));
  server.on('error', () => {});
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
    setTimeout(resolve, 150);
  });
  try {
    assert.equal(server.listening, true);
    assert.notEqual(server.address().port, preferredPort);
    assert.equal(server.actualPort, server.address().port);
  } finally {
    server.close();
    blocker.close();
  }
});

test('instance state probes and hands off only to the authenticated recorded owner', async () => {
  const lifecycle = await import('../scripts/instance-state.js');
  assert.equal(typeof lifecycle.probeLiveInstance, 'function');
  assert.equal(typeof lifecycle.requestInstanceHandoff, 'function');
  let requested = false;
  const instance = { instanceId: 'network-owner', pid: 4321, version: '1.15.0' };
  const token = 'network-owner-token';
  const server = startPanel(panelOptions({ token, instance, onInstanceHandoff: () => { requested = true; } }));
  if (!server.listening) await once(server, 'listening');
  const state = { ...instance, panelPort: server.address().port, token };
  try {
    assert.deepEqual(await lifecycle.probeLiveInstance(state), instance);
    assert.equal(await lifecycle.requestInstanceHandoff(state), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requested, true);
    assert.equal(await lifecycle.probeLiveInstance({ ...state, instanceId: 'stale-owner' }), null);
  } finally {
    server.close();
    if (server.listening) await once(server, 'close');
  }
});

test('existing instance decision reuses same version and hands off a different version', async () => {
  const lifecycle = await import('../scripts/instance-state.js');
  assert.equal(typeof lifecycle.prepareExistingInstance, 'function');
  const state = { instanceId: 'owner-a', panelPort: 9998, token: 'secret', version: '1.15.0', runtimeId: '1.15.0:old' };

  const reused = await lifecycle.prepareExistingInstance(state, '1.15.0:old', {
    probe: async () => ({ instanceId: 'owner-a', version: '1.15.0', runtimeId: '1.15.0:old' }),
    handoff: async () => false,
  });
  assert.equal(reused.action, 'reuse');

  let handedOff = 0;
  const replaced = await lifecycle.prepareExistingInstance(state, '1.15.0:new', {
    probe: async () => ({ instanceId: 'owner-a', version: '1.15.0', runtimeId: '1.15.0:old' }),
    handoff: async () => { handedOff += 1; return true; },
    wait: async () => true,
  });
  assert.equal(replaced.action, 'continue');
  assert.equal(handedOff, 1);

  const stale = await lifecycle.prepareExistingInstance(state, '1.15.0:new', {
    probe: async () => null,
  });
  assert.equal(stale.action, 'continue');
});

test('start lifecycle prepares an existing instance before binding and persists ownership before opening the panel URL', () => {
  const source = readFileSync(new URL('../scripts/start.js', import.meta.url), 'utf8');
  const prepareAt = source.indexOf('await prepareExistingInstance(');
  const startPanelAt = source.indexOf('startPanel({');
  const persistAt = source.indexOf('writeInstanceState({');
  const openPanelAt = source.lastIndexOf('await openBrowser(panelUrl)');
  assert.ok(prepareAt >= 0 && prepareAt < startPanelAt);
  assert.ok(persistAt >= 0 && persistAt < openPanelAt);
  assert.match(source, /onInstanceHandoff/);
});

test('reviewed upstream baseline advances to 2.0.3 with the selective port', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.aki.upstreamReviewed, '2.0.3');
});

test('instance state clears only when the caller owns the recorded instance id', async () => {
  const lifecycle = await import('../scripts/instance-state.js').catch(() => null);
  assert.ok(lifecycle, 'instance-state module should exist');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aki-instance-'));
  const file = path.join(dir, 'instance.json');
  const record = { instanceId: 'owner-a', pid: 10, panelPort: 9998, token: 'secret', version: '1.15.0' };

  lifecycle.writeInstanceState(record, file);
  assert.deepEqual(lifecycle.readInstanceState(file), record);
  assert.equal(lifecycle.clearInstanceState('owner-b', file), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record);
  assert.equal(lifecycle.clearInstanceState('owner-a', file), true);
  assert.equal(lifecycle.readInstanceState(file), null);
});
