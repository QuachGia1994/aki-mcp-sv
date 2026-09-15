import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildWorkflow, buildDebugWorkflow, buildReviewWorkflow, register } from '../scripts/workflow-mcp.js';

const parse = (result) => JSON.parse(result.content[0].text);

test('pure builders normalize inputs', () => {
  const workflow = buildWorkflow({ phase: 'plan', goal: ' ship ', constraints: [' offline ', ''], context: ' repo ' });
  assert.equal(workflow.goal, 'ship'); assert.deepEqual(workflow.constraints, ['offline']); assert.equal(workflow.context, 'repo'); assert.ok(workflow.checklist.length >= 4);
  const debug = buildDebugWorkflow({ symptom: ' crash ', expected: ' stable ', observations: [' stack '], hypotheses: [' race '] });
  assert.match(debug.goal, /crash/); assert.deepEqual(debug.evidence, ['stack']); assert.equal(debug.hypotheses[0].hypothesis, 'race'); assert.match(debug.nextExperiment, /experiment/i);
  const review = buildReviewWorkflow({ goal: ' feature ', risks: [' safe '], verification: [' unit '] });
  assert.equal(review.goal, 'feature'); assert.deepEqual(review.constraints, ['safe']); assert.deepEqual(review.evidence, ['unit']); assert.ok(review.checklist.length >= 4);
});

test('in-memory MCP listing, calls, validation, and annotations', async () => {
  const server = new McpServer({ name: 'workflow-test', version: '1.0.0' }); register(server);
  const client = new Client({ name: 'workflow-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const listed = await client.listTools(); assert.deepEqual(listed.tools.map(t => t.name).sort(), ['debug_workflow', 'review_workflow', 'workflow_guide']);
    for (const tool of listed.tools) assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(parse(await client.callTool({ name: 'workflow_guide', arguments: { phase: 'verify', goal: 'release' } })).goal, 'release');
    assert.equal(parse(await client.callTool({ name: 'debug_workflow', arguments: { symptom: 'timeout', expected: 'response' } })).goal, 'Find and verify the root cause of: timeout');
    assert.equal(parse(await client.callTool({ name: 'review_workflow', arguments: { goal: 'tools' } })).goal, 'tools');
    await assert.rejects(client.callTool({ name: 'workflow_guide', arguments: { phase: 'invalid', goal: 'x' } }));
    await assert.rejects(client.callTool({ name: 'debug_workflow', arguments: {} })); await assert.rejects(client.callTool({ name: 'review_workflow', arguments: {} }));
  } finally { await client.close(); await server.close(); }
});

