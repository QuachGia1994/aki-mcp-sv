import test from 'node:test';
import assert from 'node:assert/strict';
import { rankReadWorkers, runBudgetedRead, recordWorkerUsage, recordContextSavings } from '../scripts/budget-router.js';

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

const health = {
  xkiro: { available: true, model: 'x/free', costClass: 'free' },
  opencode: { available: true, model: 'opencode/free', costClass: 'free' },
  agy: { available: true, model: 'gemini-flash', costClass: 'quota' },
  kiro: { available: true, model: 'sonnet', costClass: 'quota' },
};

test('Budget Router ranks zero-cost workers before quota workers and freeOnly excludes quota fallbacks', async () => {
  const all = await rankReadWorkers({ prompt: 'inspect', cwd: process.cwd(), healthOverride: health });
  assert.deepEqual(all.map((item) => item.name), ['xkiro', 'opencode', 'agy', 'kiro']);
  const free = await rankReadWorkers({ prompt: 'inspect', cwd: process.cwd(), healthOverride: health, freeOnly: true });
  assert.deepEqual(free.map((item) => item.name), ['xkiro', 'opencode']);
});

test('Budget Router records failed worker then returns first successful fallback', async () => {
  const recorded = [];
  const candidates = [
    { name: 'xkiro', provider: 'xKiro', model: 'x/free', costClass: 'free', invoke: async () => fail('quota exhausted') },
    { name: 'opencode', provider: 'OpenCode Zen', model: 'opencode/free', costClass: 'free', invoke: async () => ok('done') },
  ];
  const result = await runBudgetedRead(
    { prompt: 'inspect', cwd: process.cwd(), freeOnly: true },
    { ranker: async () => candidates, recorder: (entry) => recorded.push(entry), now: (() => { let n = 1000; return () => (n += 10); })() },
  );
  assert.equal(result.content[0].text, 'done');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].success, false);
  assert.equal(recorded[1].success, true);
  assert.equal(recorded[1].costClass, 'free');
});

test('Cost Ledger keeps provider usage, context avoidance, and cache hits as separate fields', () => {
  let state = { version: 1, entries: [], totals: {} };
  const load = () => ({ version: 1, entries: [...state.entries], totals: {} });
  const save = (next) => { state = next; };
  recordWorkerUsage({ provider: 'xKiro', model: 'free', costClass: 'free', success: true, actualProviderTokens: 1200, estimatedInputTokens: 800, providerCacheHits: 50 }, { load, save });
  recordContextSavings({ provider: 'xKiro', costClass: 'free', estimatedInputTokens: 300, estimatedLeadContextAvoided: 5000 }, { load, save });
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].estimatedLeadContextAvoided, 5000);
  assert.equal(state.entries[0].actualProviderTokens, null);
  assert.equal(state.entries[1].actualProviderTokens, 1200);
  assert.equal(state.entries[1].providerCacheHits, 50);
});
