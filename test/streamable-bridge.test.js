#!/usr/bin/env node
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { handleStreamableMcp } from '../scripts/streamable-bridge.js';

const originalConsoleLog = console.log;
const bridgeLogs = [];
console.log = (...args) => {
  bridgeLogs.push(args.map(String).join(' '));
  originalConsoleLog(...args);
};

const server = http.createServer((req, res) => {
  handleStreamableMcp(req, res).catch((error) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });
});

function initialize(baseUrl, id) {
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'streamable-bridge-regression', version: '1.0.0' },
      },
    }),
  });
}

function stateless2025Initialize(baseUrl, id) {
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'postman-stateless-regression', version: '1.0.0' },
      },
    }),
  });
}

function modernRequest(baseUrl, id, method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  return fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'postman-modern-regression', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  try {
    const statelessInit = await stateless2025Initialize(baseUrl, 'stateless-init');
    assert.equal(statelessInit.status, 200);
    assert.equal(statelessInit.headers.get('MCP-Session-Id'), null);
    const statelessInitBody = await statelessInit.json();
    assert.equal(statelessInitBody.result?.protocolVersion, '2025-06-18');

    const statelessTools = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'stateless-tools', method: 'tools/list', params: {} }),
    });
    assert.equal(statelessTools.status, 200);
    assert.equal(statelessTools.headers.get('MCP-Session-Id'), null);
    const statelessToolsBody = await statelessTools.json();
    assert.ok(Array.isArray(statelessToolsBody.result?.tools));
    assert.ok(statelessToolsBody.result.tools.length > 0);

    const modernDiscover = await modernRequest(baseUrl, 'discover-1', 'server/discover');
    assert.equal(modernDiscover.status, 200);
    assert.equal(modernDiscover.headers.get('MCP-Session-Id'), null);
    const discoverBody = await modernDiscover.json();
    assert.deepEqual(discoverBody.result?.supportedVersions, ['2026-07-28']);
    assert.equal(discoverBody.result?.resultType, 'complete');
    assert.equal(discoverBody.result?.ttlMs, 0);
    assert.equal(discoverBody.result?.cacheScope, 'private');
    assert.ok(discoverBody.result?.capabilities?.tools);

    const modernTools = await modernRequest(baseUrl, 'tools-1', 'tools/list');
    assert.equal(modernTools.status, 200);
    assert.equal(modernTools.headers.get('MCP-Session-Id'), null);
    const modernToolsBody = await modernTools.json();
    assert.equal(modernToolsBody.result?.resultType, 'complete');
    assert.equal(modernToolsBody.result?.ttlMs, 0);
    assert.equal(modernToolsBody.result?.cacheScope, 'private');
    assert.ok(Array.isArray(modernToolsBody.result?.tools));
    assert.ok(modernToolsBody.result.tools.length > 0);

    const modernCall = await modernRequest(baseUrl, 'call-1', 'tools/call', {
      name: 'local__list_allowed_directories',
      arguments: {},
    });
    assert.equal(modernCall.status, 200);
    assert.equal(modernCall.headers.get('MCP-Session-Id'), null);
    const modernCallBody = await modernCall.json();
    assert.equal(modernCallBody.result?.resultType, 'complete');
    assert.ok(Array.isArray(modernCallBody.result?.content));

    const firstInitialize = await initialize(baseUrl, 1);
    assert.equal(firstInitialize.status, 200);
    const firstSessionId = firstInitialize.headers.get('MCP-Session-Id');
    assert.match(firstSessionId, /^[0-9a-f]{32}$/);
    assert.equal((await firstInitialize.json()).id, 1);

    const secondInitialize = await initialize(baseUrl, 2);
    assert.equal(secondInitialize.status, 200);
    const secondSessionId = secondInitialize.headers.get('MCP-Session-Id');
    assert.match(secondSessionId, /^[0-9a-f]{32}$/);
    assert.notEqual(secondSessionId, firstSessionId);
    assert.equal((await secondInitialize.json()).id, 2);

    const sharedSessionOpenLogs = bridgeLogs.filter((line) =>
      line.includes('shared tools-server session opened'),
    );
    assert.equal(
      sharedSessionOpenLogs.length,
      1,
      'repeated initialize requests must reuse exactly one internal tools-server session',
    );

    const toolsList = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Deliberately mixed case: Node must normalize it for the bridge's lowercase lookup.
        'mCp-SeSsIoN-iD': secondSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    assert.equal(toolsList.status, 200);
    const response = await toolsList.json();
    assert.equal(response.id, 3);
    assert.ok(Array.isArray(response.result?.tools));
    assert.ok(response.result.tools.length > 0);
    originalConsoleLog(
      `PASS: repeated initialize reused one internal session and tools/list accepted MCP-Session-Id (${response.result.tools.length} tools)`,
    );
  } finally {
    console.log = originalConsoleLog;
    server.close();
    await once(server, 'close');
  }
}

// The bridge intentionally owns a process-lifetime shared InMemoryTransport, so a standalone test exits explicitly after reporting the result instead of changing that production architecture.
run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
