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
      providers: [
        ['agy', async () => { calls.push('agy'); return ok('found'); }],
        ['kiro', async () => { calls.push('kiro'); return ok('unused'); }],
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
      providers: [
        ['agy', async () => { calls.push('agy'); return err('quota exceeded'); }],
        ['kiro', async () => { calls.push('kiro'); return ok('fallback'); }],
      ],
    },
  );
  assert.equal(result.content[0].text, 'fallback');
  assert.deepEqual(calls, ['agy', 'kiro']);
  assert.equal(health.get('agy'), 61000);
});

test('agent router reports compact provider failures', async () => {
  const result = await runAgentFallback(
    { prompt: 'inspect', cwd: process.cwd() },
    {
      health: new Map(),
      now: () => 1000,
      providers: [
        ['agy', async () => err('quota exceeded\nmore detail')],
        ['kiro', async () => err('login required')],
      ],
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /agy: quota exceeded/);
  assert.match(result.content[0].text, /kiro: login required/);
});
