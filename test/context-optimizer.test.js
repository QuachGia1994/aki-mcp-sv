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
      stable: { goal: ['Ship guarded executor'], constraints: ['Free workers first'], decisions: ['Astra judges only'], architecture: ['Scoped Aki writes'], acceptance: ['Tests green'] },
      dynamic: { evidence: ['write boundary is project-scoped'], changes: [], tests: [], blockers: [], risks: [] },
      classify: { keep: [], stale: [], wasted: [] },
    }, 12000);
    if (call === 2) return workerResult({
      stable: { goal: ['THIS MUST NOT REPLACE HOT PREFIX'], constraints: [], decisions: [], architecture: [], acceptance: [] },
      dynamic: { evidence: ['new evidence'], changes: ['one change'], tests: ['focused test green'], blockers: [], risks: [] },
      classify: { keep: ['Ship guarded executor'], stale: ['write boundary is project-scoped'], wasted: ['old tool dump'] },
    }, 9000);
    return workerResult({
      stable: { goal: ['Rebuilt goal after cold boundary'], constraints: ['Free workers first'], decisions: [], architecture: [], acceptance: ['New acceptance'] },
      dynamic: { evidence: ['cold evidence'], changes: [], tests: [], blockers: [], risks: [] },
      classify: { keep: [], stale: ['Ship guarded executor'], wasted: [] },
    }, 8000);
  };
  const checkpoints = [];
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
    checkpointSave: (entry) => { checkpoints.push(entry); return entry; },
    recordSavings: () => {},
  };
  const cwd = 'D:\\LacViet\\aki-mcp-sv';
  const first = await runContextPacket({ prompt: 'first', cwd, taskKey: 'task-1' }, deps);
  assert.match(resultText(first), /Aki Context COLD · stable rebuilt/);
  const firstEntry = Object.values(state.entries)[0];
  const firstPrefix = firstEntry.stableText;
  assert.equal(firstEntry.stats.workerProviderTokens, 12000);
  assert.equal(firstEntry.stats.sourceUsageAuthoritative, false);
  assert.equal(firstPrefix, renderStablePrefix(firstEntry.stable));

  now += 60_000;
  const second = await runContextPacket({ prompt: 'follow-up', cwd, taskKey: 'task-1' }, deps);
  assert.match(resultText(second), /Aki Context HOT · stable reused/);
  const secondEntry = Object.values(state.entries)[0];
  assert.equal(secondEntry.stableText, firstPrefix);
  assert.equal(secondEntry.stable.goal[0], 'Ship guarded executor');
  assert.equal(secondEntry.stats.staleCount, 1);
  assert.equal(secondEntry.stats.wastedCount, 1);
  assert.equal('lastGreen' in checkpoints.at(-1), false);

  now += 31 * 60_000;
  const third = await runContextPacket({ prompt: 'after idle', cwd, taskKey: 'task-1' }, deps);
  assert.match(resultText(third), /Aki Context COLD · stable rebuilt/);
  const thirdEntry = Object.values(state.entries)[0];
  assert.notEqual(thirdEntry.stableText, firstPrefix);
  assert.equal(thirdEntry.stable.goal[0], 'Rebuilt goal after cold boundary');
  assert.deepEqual({ attempts: state.activity.attempts, successes: state.activity.successes, failures: state.activity.failures, reused: state.activity.reused }, { attempts: 3, successes: 3, failures: 0, reused: 1 });
});

test('HOT contradiction of a stable fact forces an immediate COLD rebuild', async () => {
  let state = { version: 1, entries: {} };
  let now = 2_000_000;
  let calls = 0;
  const worker = async ({ cold }) => {
    calls++;
    if (calls === 1) return workerResult({ stable: { goal: ['Old goal'] }, dynamic: {}, classify: {} }, 1000);
    if (!cold) return workerResult({ stable: {}, dynamic: { evidence: ['goal changed'] }, classify: { stale: ['Old goal'] } }, 900);
    return workerResult({ stable: { goal: ['New goal'] }, dynamic: { evidence: ['rebuilt'] }, classify: {} }, 800);
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
  await runContextPacket({ prompt: 'first', cwd, taskKey: 'contradiction' }, deps);
  now += 60_000;
  const result = await runContextPacket({ prompt: 'changed', cwd, taskKey: 'contradiction' }, deps);
  assert.equal(calls, 3);
  assert.match(resultText(result), /Aki Context COLD · stable rebuilt/);
  assert.equal(Object.values(state.entries)[0].stable.goal[0], 'New goal');
});

test('disabled optimizer fails closed before invoking a worker', async () => {
  let called = false;
  let state = { version: 1, entries: {} };
  const result = await runContextPacket(
    { prompt: 'task', cwd: 'D:\\LacViet\\aki-mcp-sv' },
    { worker: async () => { called = true; return workerResult({}); }, config: { ...config, enabled: false }, loadState: () => state, saveState: (next) => { state = structuredClone(next); }, checkpointSave: () => {}, recordSavings: () => {} },
  );
  assert.equal(result.isError, true);
  assert.match(resultText(result), /disabled/);
  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.deepEqual({ attempts: state.activity.attempts, skipped: state.activity.skipped, outcome: state.activity.lastOutcome }, { attempts: 1, skipped: 1, outcome: 'skipped' });
});

test('activity telemetry migrates legacy state and records invalid packet failures', async () => {
  let state = { version: 1, entries: {} };
  const result = await runContextPacket(
    { prompt: 'bad packet', cwd: 'D:\\LacViet\\aki-mcp-sv', taskKey: 'activity-test' },
    {
      config,
      loadState: () => state,
      saveState: (next) => { state = structuredClone(next); },
      worker: async () => workerResult({ error: 'not a packet' }),
      recoverCheckpoint: () => ({ recovered: false, contextText: '' }),
      graphStatus: () => ({ currentProject: { lastIndexed: Date.now() } }),
      graphQuery: () => ({ content: [{ type: 'text', text: '[]' }] }),
      checkpointSave: () => ({}),
      recordSavings: () => {},
    },
  );
  assert.equal(result.isError, true);
  assert.equal(state.version, 2);
  assert.deepEqual({ attempts: state.activity.attempts, successes: state.activity.successes, failures: state.activity.failures }, { attempts: 1, successes: 0, failures: 1 });
  assert.equal(state.activity.lastTaskKey, 'activity-test');
  assert.match(state.activity.lastError, /incomplete JSON packet/);
});

test('concurrent task completions preserve distinct entries and activity counters', async () => {
  let state = { version: 1, entries: {} };
  const started = [];
  const cwd = process.cwd();
  const deps = {
    config,
    now: () => 3_000_000,
    loadState: () => state,
    saveState: (next) => { state = structuredClone(next); },
    worker: ({ prompt }) => new Promise((resolve) => {
      const goal = prompt.includes('REQUEST=one') ? 'one' : 'two';
      started.push({ goal, resolve: () => resolve(workerResult({ stable: { goal: [goal] }, dynamic: { evidence: [`evidence for ${goal}`] }, classify: {} })) });
      if (started.length === 2) {
        started.find((item) => item.goal === 'two').resolve();
        started.find((item) => item.goal === 'one').resolve();
      }
    }),
    recoverCheckpoint: () => ({ recovered: false, contextText: '' }),
    graphStatus: () => ({ currentProject: { lastIndexed: 3_000_000 } }),
    graphQuery: () => ({ content: [{ type: 'text', text: '[]' }] }),
    checkpointSave: () => ({}),
    recordSavings: () => {},
  };
  await Promise.all([
    runContextPacket({ prompt: 'one', cwd, taskKey: 'task-one' }, deps),
    runContextPacket({ prompt: 'two', cwd, taskKey: 'task-two' }, deps),
  ]);
  assert.equal(Object.keys(state.entries).length, 2);
  assert.equal(state.activity.attempts, 2);
  assert.equal(state.activity.successes, 2);
  assert.equal(state.activity.failures, 0);
});

test('ephemeral automatic reads do not reuse a default task packet', async () => {
  let state = { version: 1, entries: {} };
  const modes = [];
  const cwd = process.cwd();
  const deps = {
    config,
    now: () => 4_000_000,
    loadState: () => state,
    saveState: (next) => { state = structuredClone(next); },
    worker: async ({ cold }) => { modes.push(cold); return workerResult({ stable: { goal: ['request-specific'] }, dynamic: {}, classify: {} }); },
    recoverCheckpoint: () => ({ recovered: false, contextText: '' }),
    graphStatus: () => ({ currentProject: { lastIndexed: 4_000_000 } }),
    graphQuery: () => ({ content: [{ type: 'text', text: '[]' }] }),
    checkpointSave: () => ({}),
    recordSavings: () => {},
  };
  await runContextPacket({ prompt: 'same old client request', cwd, ephemeral: true }, deps);
  await runContextPacket({ prompt: 'same old client request', cwd, ephemeral: true }, deps);
  assert.deepEqual(modes, [true, true]);
  assert.equal(Object.keys(state.entries).length, 0);
  assert.equal(state.activity.attempts, 2);
  assert.equal(state.activity.successes, 2);
});

test('overbudget packets keep critical constraints, acceptance, evidence, and blockers', () => {
  const fitted = fitPacketToBudget(
    { goal: ['goal'], constraints: ['constraint '.repeat(500)], decisions: ['decision '.repeat(500)], architecture: ['architecture '.repeat(500)], acceptance: ['acceptance '.repeat(500)] },
    { evidence: ['evidence '.repeat(500)], changes: ['change '.repeat(500)], tests: ['test '.repeat(500)], blockers: ['blocker '.repeat(500), 'second blocker '.repeat(500)], risks: ['risk '.repeat(500)] },
    2000,
  );
  assert.equal(fitted.stable.constraints.length, 1);
  assert.equal(fitted.stable.acceptance.length, 1);
  assert.equal(fitted.dynamic.evidence.length, 1);
  assert.equal(fitted.dynamic.blockers.length, 2);
  assert.equal(fitted.truncated, true);
});

test('overbudget run fails visibly and records the failure instead of returning an oversized packet', async () => {
  let state = { version: 1, entries: {} };
  const result = await runContextPacket(
    { prompt: 'essential context', cwd: process.cwd(), taskKey: 'overbudget' },
    {
      config,
      loadState: () => state,
      saveState: (next) => { state = structuredClone(next); },
      worker: async () => workerResult({
        stable: { goal: ['goal'], constraints: Array.from({ length: 6 }, (_, i) => `constraint ${i} `.repeat(500)), acceptance: Array.from({ length: 6 }, (_, i) => `acceptance ${i} `.repeat(500)) },
        dynamic: { evidence: Array.from({ length: 6 }, (_, i) => `evidence ${i} `.repeat(500)), blockers: Array.from({ length: 6 }, (_, i) => `blocker ${i} `.repeat(500)) },
        classify: {},
      }),
      recoverCheckpoint: () => ({ recovered: false, contextText: '' }),
      graphStatus: () => ({ currentProject: { lastIndexed: Date.now() } }),
      graphQuery: () => ({ content: [{ type: 'text', text: '[]' }] }),
      checkpointSave: () => ({}),
      recordSavings: () => {},
    },
  );
  assert.equal(result.isError, true);
  assert.match(resultText(result), /essential context exceeds budget/);
  assert.equal(state.entries && Object.keys(state.entries).length, 0);
  assert.deepEqual({ attempts: state.activity.attempts, failures: state.activity.failures }, { attempts: 1, failures: 1 });
});
