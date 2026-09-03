import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolsServer } from '../scripts/tools-server.js';

function byName(tools) {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

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
    assert.equal(names.has('local__repo_snapshot'), true);
    assert.equal(names.has('local__opencode_read'), true);
    const instructions = client.getInstructions();
    assert.match(instructions, /Gemini Spark confirms every MCP tools\/call client-side/);
    assert.match(instructions, /call local__repo_snapshot exactly once/);
    assert.match(instructions, /Use local__agent_read only for semantic\/cross-source retrieval after repo_snapshot is insufficient/);
    assert.match(instructions, /do not decompose broad analysis into list_allowed_directories\/find_path\/search_content\/read_text_file/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('tools/list advertises accurate MCP safety annotations for Gemini-style consent decisions', async () => {
  const server = createToolsServer();
  const client = new Client({ name: 'tool-annotations-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = byName((await client.listTools()).tools);

    const localRead = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    const remoteRead = { ...localRead, openWorldHint: true };

    assert.deepEqual(tools.get('local__list_allowed_directories')?.annotations, localRead);
    assert.deepEqual(tools.get('local__find_path')?.annotations, localRead);
    assert.deepEqual(tools.get('local__repo_snapshot')?.annotations, localRead);
    assert.deepEqual(tools.get('local__read_text_file')?.annotations, localRead);
    assert.deepEqual(tools.get('filesystem__read_text_file')?.annotations, localRead);
    assert.deepEqual(tools.get('local__agent_read')?.annotations, remoteRead);
    assert.deepEqual(tools.get('local__opencode_read')?.annotations, remoteRead);

    assert.deepEqual(tools.get('local__write_file')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(tools.get('local__create_directory')?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(tools.get('local__run_cmd')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.deepEqual(tools.get('local__agy_run')?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  } finally {
    await client.close();
    await server.close();
  }
});
