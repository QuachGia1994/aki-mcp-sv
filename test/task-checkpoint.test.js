import test from 'node:test';
import assert from 'node:assert/strict';
import { getTaskCheckpoint, listTaskCheckpoints, recoverTaskContext, saveTaskCheckpoint } from '../scripts/task-checkpoint.js';

function memoryStore() {
  let state = { version: 1, entries: {} };
  return {
    load: () => structuredClone(state),
    save: (next) => { state = structuredClone(next); },
    state: () => structuredClone(state),
  };
}

test('Task Checkpoint survives a simulated restart and renders compact recovery state', () => {
  const store = memoryStore();
  saveTaskCheckpoint({
    taskKey: 'stage-20', cwd: process.cwd(), status: 'active', activeStep: 'Run focused tests',
    completedSteps: ['Implemented router'], pendingSteps: ['Run full regression'], blockers: ['none'], lastGreen: '15/15 focused PASS',
    context: { stable: { goal: ['Finish free-first orchestrator'], decisions: ['Use zero-cost workers first'] }, dynamic: { tests: ['15/15 focused PASS'] } },
  }, { now: () => 1000, load: store.load, save: store.save });

  const checkpoint = getTaskCheckpoint('stage-20', process.cwd(), { load: store.load });
  assert.equal(checkpoint.activeStep, 'Run focused tests');
  const recovered = recoverTaskContext({ taskKey: 'stage-20', cwd: process.cwd() }, { load: store.load });
  assert.equal(recovered.recovered, true);
  assert.match(recovered.contextText, /Finish free-first orchestrator/);
  assert.match(recovered.contextText, /LAST_GREEN: 15\/15 focused PASS/);
  assert.match(recovered.contextText, /PENDING:/);
});

test('Task Checkpoint update keeps one task identity and bounded normalized lists', () => {
  const store = memoryStore();
  saveTaskCheckpoint({ taskKey: 'same', cwd: process.cwd(), completedSteps: ['A', 'A'] }, { now: () => 100, load: store.load, save: store.save });
  saveTaskCheckpoint({ taskKey: 'same', cwd: process.cwd(), status: 'paused', pendingSteps: ['B'] }, { now: () => 200, load: store.load, save: store.save });
  const list = listTaskCheckpoints(process.cwd(), { load: store.load });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'paused');
  assert.equal(getTaskCheckpoint('same', process.cwd(), { load: store.load }).pendingSteps[0], 'B');
});
