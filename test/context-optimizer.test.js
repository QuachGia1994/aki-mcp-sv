import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPacketToBudget, normalizeContextOptimizerConfig, normalizeWorkerPacket, renderStablePrefix, runContextPacket } from '../scripts/context-optimizer.js';

function resultText(result) {
  return result?.content?.find((part) => part.type === 'text')?.text || '';
}

function workerResult(packet, tokens = 10000) {
  return {
    provider: 'xKiro',
    result: {
      content: [{ type: 'text', text: `${JSON.stringify(packet)}\n\n[xKiro qwen/free · ${tokens} tokens · 2 tool calls]` }],
    },
  };
}

const config = { enabled: true, budgetTokens: 2000, hotWindowMinutes: 30, maxEntries: 16, ttlHours: 168 };

test('context optimizer config is bounded and enabled by default', () => {
  assert.deepEqual(normalizeContextOptimizerConfig({}), { enabled: true, budgetTokens: 12000, hotWindowMinutes: 30, maxEntries: 16, ttlHours: 168 });
  assert.deepEqual(normalizeContextOptimizerConfig({ enabled: false, budgetTokens: 999999, hotWindowMinutes: 1, maxEntries: 1, ttlHours: 9999 }), { enabled: false, budgetTokens: 32000, hotWindowMinutes: 5, maxEntries: 4, ttlHours: 720 });
});

test('worker packet normalization deduplicates and bounds items', () => {
  const packet = normalizeWorkerPacket({ stable: { goal: [' one ', 'one', 'two'] }, dynamic: { evidence: [' a  b '] }, classify: { keep: ['x', 'x'], stale: ['y'], wasted: ['z'] } });
  assert.deepEqual(packet.stable.goal, ['one', 'two']);
  assert.deepEqual(packet.dynamic.evidence, ['a b']);
  assert.deepEqual(packet.classify, { keep: ['x'], stale: ['y'], wasted: ['z'] });
});

test('packet budget trims dynamic detail before load-bearing stable goal', () => {
  const stable = { goal: ['Keep this goal'], constraints: [], decisions: [], architecture: [], acceptance: [] };
  const dynamic = { evidence: Array.from({ length: 24 }, (_, i) => `evidence-${i} ${'x'.repeat(900)}`), changes: [], tests: [], blockers: [], risks: [] };
  const fitted = fitPacketToBudget(stable, dynamic, 2000);
  assert.equal(fitted.stable.goal[0], 'Keep this goal');
  assert.ok(fitted.dynamic.evidence.length < 24);
});

test('hot refresh preserves stable prefix byte-for-byte and cold refresh rebuilds it', async () => {
  let state = { version: 1, entries: {} };
  let now = 1_000_000;
  let call = 0;
  const worker = async () => {
    call++;
    if (call === 1) return workerResult({
      stable: { goal: ['Ship guarded executor'], constraints: ['Free workers first'], decisions: ['Astra judges only'], architecture: ['OpenCode exec writes'], acceptance: ['Tests green'] },
      dynamic: { evidence: ['scripts/opencode-mcp.js owns exec'], changes: [], tests: [], blockers: [], risks: [] },
      classify: { keep: [], stale: [], wasted: [] },
    }, 12000);
    if (call === 2) return workerResult({
      stable: { goal: ['THIS MUST NOT REPLACE HOT PREFIX'], constraints: [], decisions: [], architecture: [], acceptance: [] },
      dynamic: { evidence: ['new evidence'], changes: ['one change'], tests: ['focused test green'], blockers: [], risks: [] },
      classify: { keep: ['Ship guarded executor'], stale: ['scripts/opencode-mcp.js owns exec'], wasted: ['old tool dump'] },
    }, 9000);
    return workerResult({
      stable: { goal: ['Rebuilt goal after cold boundary'], constraints: ['Free workers first'], decisions: [], architecture: [], acceptance: ['New acceptance'] },
      dynamic: { evidence: ['cold evidence'], changes: [], tests: [], blockers: [], risks: [] },
      classify: { keep: [], stale: ['Ship guarded executor'], wasted: [] },
    }, 8000);
  };
  const deps = {
    worker,
    now: () => now,
    config,
    loadState: () => state,
    saveState: (next) => { state = structuredClone(next); },
    recoverCheckpoint: () => ({ recovered: false, contextText: '' }),
    graphStatus: () => ({ currentProject: { lastIndexed: now } }),
    graphSync: () => ({}),
    graphQuery: () => ({ content: [{ type: 'text', text: '[]' }] }),
    checkpointSave: () => ({}),
    recordSavings: () => {},
  };
  const cwd = 'D:\\LacViet\\aki-mcp-sv';
  const first = await runContextPacket({ prompt: 'first', cwd, taskKey: 'task-1' }, deps);
  assert.match(resultText(first), /Aki Context COLD · stable rebuilt/);
  const firstEntry = Object.values(state.entries)[0];
  const firstPrefix = firstEntry.stableText;
  assert.equal(firstPrefix, renderStablePrefix(firstEntry.stable));

  now += 60_000;
  const second = await runContextPacket({ prompt: 'follow-up', cwd, taskKey: 'task-1' }, deps);
  assert.match(resultText(second), /Aki Context HOT · stable reused/);
  const secondEntry = Object.values(state.entries)[0];
  assert.equal(secondEntry.stableText, firstPrefix);
  assert.equal(secondEntry.stable.goal[0], 'Ship guarded executor');
  assert.equal(secondEntry.stats.staleCount, 1);
  assert.equal(secondEntry.stats.wastedCount, 1);

  now += 31 * 60_000;
  const third = await runContextPacket({ prompt: 'after idle', cwd, taskKey: 'task-1' }, deps);
  assert.match(resultText(third), /Aki Context COLD · stable rebuilt/);
  const thirdEntry = Object.values(state.entries)[0];
  assert.notEqual(thirdEntry.stableText, firstPrefix);
  assert.equal(thirdEntry.stable.goal[0], 'Rebuilt goal after cold boundary');
});

test('disabled optimizer fails closed before invoking a worker', async () => {
  let called = false;
  const result = await runContextPacket(
    { prompt: 'task', cwd: 'D:\\LacViet\\aki-mcp-sv' },
    { worker: async () => { called = true; return workerResult({}); }, config: { ...config, enabled: false }, loadState: () => ({ version: 1, entries: {} }), saveState: () => {}, checkpointSave: () => {}, recordSavings: () => {} },
  );
  assert.equal(result.isError, true);
  assert.match(resultText(result), /disabled/);
  assert.equal(called, false);
});
