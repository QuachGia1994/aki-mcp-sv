import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolsServer } from '../scripts/tools-server.js';

async function withClient(run) {
  const server = createToolsServer();
  const client = new Client({ name: 'claude-mem-tools-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test('single-process tools server exposes read-only claude-mem workflow', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const claudeMemTools = [...names].filter((name) => name.startsWith('local__claude_mem_')).sort();
    assert.deepEqual(claudeMemTools, [
      'local__claude_mem_get_observations',
      'local__claude_mem_search',
      'local__claude_mem_timeline',
    ]);
    assert.equal(names.has('local__run_cmd'), true);
    assert.equal(names.has('local__find_path'), true);
    assert.equal(names.has('filesystem__read_text_file'), true);
    assert.equal(names.has('filesystem__write_file'), true);
  });
});

test('claude-mem tools honor worker env overrides and upstream routes', async () => {
  const requests = [];
  const worker = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const port = worker.address().port;
  const previous = {
    host: process.env.CLAUDE_MEM_WORKER_HOST,
    port: process.env.CLAUDE_MEM_WORKER_PORT,
    timeout: process.env.CLAUDE_MEM_API_TIMEOUT_MS,
  };
  process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  process.env.CLAUDE_MEM_WORKER_PORT = String(port);
  process.env.CLAUDE_MEM_API_TIMEOUT_MS = '1000';

  try {
    await withClient(async (client) => {
      assert.equal((await client.callTool({ name: 'local__claude_mem_search', arguments: { query: 'auth' } })).isError, undefined);
      assert.equal((await client.callTool({ name: 'local__claude_mem_timeline', arguments: { anchor: 42 } })).isError, undefined);
      assert.equal((await client.callTool({ name: 'local__claude_mem_get_observations', arguments: { ids: [42] } })).isError, undefined);
    });
    assert.match(requests[0].url, /^\/api\/search\?query=auth/);
    assert.match(requests[1].url, /^\/api\/timeline\?anchor=42/);
    assert.equal(requests[2].url, '/api/observations/batch');
    assert.equal(requests[2].method, 'POST');
    assert.deepEqual(JSON.parse(requests[2].body), { ids: [42] });
  } finally {
    if (previous.host === undefined) delete process.env.CLAUDE_MEM_WORKER_HOST; else process.env.CLAUDE_MEM_WORKER_HOST = previous.host;
    if (previous.port === undefined) delete process.env.CLAUDE_MEM_WORKER_PORT; else process.env.CLAUDE_MEM_WORKER_PORT = previous.port;
    if (previous.timeout === undefined) delete process.env.CLAUDE_MEM_API_TIMEOUT_MS; else process.env.CLAUDE_MEM_API_TIMEOUT_MS = previous.timeout;
    await new Promise((resolve) => worker.close(resolve));
  }
});
