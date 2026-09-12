import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentFallback, scopeWorkerPrompt } from '../scripts/agent-mcp.js';

const ok = (text) => ({ content: [{ type: 'text', text }] });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

test('agent router binds worker prompts to the resolved absolute cwd', () => {
  const dir = process.cwd();
  const prompt = scopeWorkerPrompt('read package.json', dir);
  assert.match(prompt, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /Ignore workspace\/index results outside it/);
  assert.match(prompt, /read package\.json/);
});

test('agent router stops at the first healthy provider', async () => {
  const calls = [];
  const result = await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd() },
    {
      health: new Map(),
      optimize: false,
      providers: [
        ['agy', async () => { calls.push('agy'); return ok('found'); }],
        ['backup', async () => { calls.push('backup'); return ok('unused'); }],
      ],
    },
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'found');
  assert.deepEqual(calls, ['agy']);
});

test('agent router falls back and cools down failed providers', async () => {
  const health = new Map();
  const calls = [];
  const result = await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd() },
    {
      health,
      now: () => 1000,
      optimize: false,
      providers: [
        ['agy', async () => { calls.push('agy'); return err('quota exceeded'); }],
        ['backup', async () => { calls.push('backup'); return ok('fallback'); }],
      ],
    },
  );
  assert.equal(result.content[0].text, 'fallback');
  assert.deepEqual(calls, ['agy', 'backup']);
  assert.equal(health.get('agy'), 61000);
});

test('agent router reports compact provider failures', async () => {
  const result = await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd() },
    {
      health: new Map(),
      now: () => 1000,
      optimize: false,
      providers: [
        ['agy', async () => err('quota exceeded\nmore detail')],
        ['backup', async () => err('login required')],
      ],
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /agy: quota exceeded/);
  assert.match(result.content[0].text, /backup: login required/);
});

test('agent_read automatically returns the optimizer packet and does not retrieve twice', async () => {
  const calls = [];
  const result = await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd() },
    {
      optimizerConfig: () => ({ enabled: true, budgetTokens: 12000 }),
      optimizer: async (args) => { calls.push(args); return ok('[Aki Context COLD] compact packet'); },
      providers: [['agy', async () => { throw new Error('must not run'); }]],
    },
  );
  assert.equal(result.content[0].text, '[Aki Context COLD] compact packet');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ephemeral, true);
  assert.equal(calls[0].budgetTokens, 4000);
});

test('agent_read passes explicit task and budget options to the optimizer', async () => {
  let received;
  await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd(), taskKey: 'plan-1', forceCold: true, budgetTokens: 12000 },
    {
      optimizerConfig: () => ({ enabled: true, budgetTokens: 6000 }),
      optimizer: async (args) => { received = args; return ok('packet'); },
    },
  );
  assert.equal(received.taskKey, 'plan-1');
  assert.equal(received.forceCold, true);
  assert.equal(received.budgetTokens, 12000);
  assert.equal(received.ephemeral, false);
});

test('disabled optimizer preserves ordinary provider retrieval', async () => {
  let optimized = false;
  const result = await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd() },
    {
      optimizerConfig: () => ({ enabled: false }),
      optimizer: async () => { optimized = true; return ok('wrong'); },
      providers: [['agy', async () => ok('ordinary retrieval')]],
    },
  );
  assert.equal(result.content[0].text, 'ordinary retrieval');
  assert.equal(optimized, false);
});

test('optimizer failure is observable and does not hide a giant raw fallback', async () => {
  let fallbackCalled = false;
  const result = await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd() },
    {
      optimizerConfig: () => ({ enabled: true, budgetTokens: 4000 }),
      optimizer: async () => err('context worker packet must include a nonempty stable goal on COLD rebuild'),
      providers: [['agy', async () => { fallbackCalled = true; return ok('raw'); }]],
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /context optimizer failed/);
  assert.equal(fallbackCalled, false);
});
