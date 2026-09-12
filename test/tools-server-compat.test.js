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
    assert.equal(names.has('local__opencode_read'), false);
    assert.equal(names.has('local__opencode_exec'), false);
    assert.equal(names.has('local__opencode_status'), false);
    assert.equal(names.has('local__kiro_read'), false);
    assert.equal(names.has('local__context_packet'), true);
    assert.equal(names.has('local__context_optimizer_status'), true);
    assert.equal(names.has('local__budget_router_read'), true);
    assert.equal(names.has('local__budget_router_status'), true);
    assert.equal(names.has('local__graph_query'), true);
    assert.equal(names.has('local__graph_sync'), true);
    assert.equal(names.has('local__graph_status'), true);
    assert.equal(names.has('local__task_checkpoint_save'), true);
    assert.equal(names.has('local__task_checkpoint_recover'), true);
    assert.equal(names.has('local__aki_doctor'), true);
    assert.equal(names.has('local__image_inbox'), true);
    const instructions = client.getInstructions();
    assert.match(instructions, /Gemini Spark confirms every MCP tools\/call client-side/);
    assert.match(instructions, /call local__repo_snapshot exactly once/);
    assert.match(instructions, /Use local__agent_read for semantic\/cross-source retrieval after repo_snapshot is insufficient/);
    assert.match(instructions, /automatically compresses the read and persists bounded activity\/checkpoint state/);
    assert.match(instructions, /do not decompose broad analysis into list_allowed_directories\/find_path\/search_content\/read_text_file/);
    assert.match(instructions, /pass the shared plan\/task id as taskKey to local__agent_read/);
    assert.match(instructions, /call local__context_packet explicitly when a durable packet is needed before expensive lead\/Astra reasoning/i);
    assert.match(instructions, /reuse the same taskKey on follow-ups/i);
    assert.match(instructions, /Use local__budget_router_read instead of choosing xKiro\/agy manually/);
    assert.match(instructions, /local__task_checkpoint_recover after compaction\/restart\/account handoff/);
    assert.match(instructions, /local__aki_doctor for unified read-only health diagnosis/);
    assert.match(instructions, /local__image_inbox with action=latest by default/);
    assert.match(instructions, /Astra 6 policy \(any variant or reasoning effort\).*gpt-5\.6-luna with reasoning_effort=high/);
    assert.match(instructions, /native Luna is unavailable, report that once.*without claiming Luna ran/);
    assert.match(instructions, /use the normal scoped write\/edit tools in the real worktree/);
    assert.match(instructions, /verify separately with local__run_cmd/);
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
    assert.deepEqual(tools.get('local__agent_read')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.equal(tools.has('local__opencode_read'), false);
    assert.equal(tools.has('local__opencode_status'), false);
    assert.equal(tools.has('local__kiro_read'), false);
    assert.deepEqual(tools.get('local__context_packet')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.deepEqual(tools.get('local__context_optimizer_status')?.annotations, localRead);
    assert.deepEqual(tools.get('local__graph_query')?.annotations, localRead);
    assert.deepEqual(tools.get('local__graph_status')?.annotations, localRead);
    assert.deepEqual(tools.get('local__task_checkpoint_get')?.annotations, localRead);
    assert.deepEqual(tools.get('local__task_checkpoint_recover')?.annotations, localRead);
    assert.deepEqual(tools.get('local__image_inbox')?.annotations, localRead);
    assert.deepEqual(tools.get('local__budget_router_status')?.annotations, remoteRead);
    assert.deepEqual(tools.get('local__aki_doctor')?.annotations, remoteRead);
    assert.deepEqual(tools.get('local__budget_router_read')?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    assert.deepEqual(tools.get('local__graph_sync')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(tools.get('local__task_checkpoint_save')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    assert.equal(tools.has('local__opencode_exec'), false);

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
