import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startLoopbackMcp } from '../scripts/loopback-mcp.js';

async function request(port, { method = 'POST', sessionId, body }) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    body: text ? JSON.parse(text) : null,
    cors: response.headers.get('access-control-allow-origin'),
  };
}

test('loopback MCP binds only to 127.0.0.1 and serves Streamable HTTP without CORS', async (t) => {
  const server = startLoopbackMcp({ port: 0 });
  t.after(() => server.close());
  if (!server.listening) await once(server, 'listening');

  const address = server.address();
  assert.equal(address.address, '127.0.0.1');

  const initialized = await request(address.port, {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'loopback-test', version: '1.0.0' },
      },
    },
  });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.sessionId);
  assert.equal(initialized.cors, null);
  assert.equal(initialized.body?.result?.protocolVersion, '2025-06-18');

  const legacyInitialized = await request(address.port, {
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'legacy-loopback-test', version: '1.0.0' },
      },
    },
  });
  assert.equal(legacyInitialized.status, 200);
  assert.ok(legacyInitialized.sessionId);
  assert.equal(legacyInitialized.body?.result?.protocolVersion, '2025-03-26');

  const listed = await request(address.port, {
    sessionId: initialized.sessionId,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body?.result?.tools));
  assert.ok(listed.body.result.tools.length > 0);

  const deleted = await request(address.port, {
    method: 'DELETE',
    sessionId: initialized.sessionId,
  });
  assert.equal(deleted.status, 204);
});

test('loopback MCP does not expose unrelated routes or legacy SSE GET', async (t) => {
  const server = startLoopbackMcp({ port: 0 });
  t.after(() => server.close());
  if (!server.listening) await once(server, 'listening');
  const address = server.address();

  const missing = await fetch(`http://127.0.0.1:${address.port}/token`);
  assert.equal(missing.status, 404);

  const legacyGet = await fetch(`http://127.0.0.1:${address.port}/mcp`);
  assert.equal(legacyGet.status, 405);
  assert.equal(legacyGet.headers.get('allow'), 'POST, DELETE');
});

test('loopback MCP rejects browser-shaped and simple cross-origin POSTs', async (t) => {
  const server = startLoopbackMcp({ port: 0 });
  t.after(() => server.close());
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'browser-probe', version: '1.0.0' },
    },
  });

  const browserLike = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body,
  });
  assert.equal(browserLike.status, 403);
  assert.equal(browserLike.headers.get('access-control-allow-origin'), null);

  const simplePost = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  assert.equal(simplePost.status, 415);
});
