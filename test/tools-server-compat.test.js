import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolsServer } from '../scripts/tools-server.js';

test('single-process tools server keeps pre-1.10 filesystem aliases', async () => {
  const server = createToolsServer();
  const client = new Client({ name: 'tools-server-compat-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    assert.equal(names.has('local__read_text_file'), true);
    assert.equal(names.has('filesystem__read_text_file'), true);
    assert.equal(names.has('local__run_cmd'), true);
    assert.equal(names.has('local__agent_read'), true);
    assert.equal(names.has('local__opencode_read'), true);
  } finally {
    await client.close();
    await server.close();
  }
});
