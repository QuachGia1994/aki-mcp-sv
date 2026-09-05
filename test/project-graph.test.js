import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphSearchIndex, extractArtifactEntities, searchGraphIndex, recordProjectOutcome, syncProjectGraph } from '../scripts/project-graph.js';

test('Project Graph extracts durable package/docs facts with provenance and rejects secret-like artifacts', () => {
  const artifacts = [
    { path: 'package.json', fingerprint: 'pkg1', content: JSON.stringify({ name: 'aki-mcp-sv', version: '1.14.0', dependencies: { zod: '^4' } }) },
    { path: 'docs/arch/free-first.md', fingerprint: 'doc1', content: '# Architecture\n## Decision\n- Use free workers before Astra for implementation.\n## Outcome\n- Context Optimizer keeps the stable prefix hot.' },
    { path: '.env', fingerprint: 'secret1', content: 'API_KEY=do-not-index' },
    { path: 'docs/ref/credentials.md', fingerprint: 'secret2', content: '# Token\n- do-not-index' },
    { path: 'docs/arch/security.md', fingerprint: 'secret3', content: '# Security\n## Decision\n- API_KEY=super-secret-value-must-not-index' },
  ];
  const graph = extractArtifactEntities(process.cwd(), artifacts, { now: 123 });
  assert.ok(graph.entities.some((entity) => entity.type === 'project' && entity.label === 'aki-mcp-sv'));
  assert.ok(graph.entities.some((entity) => entity.type === 'decision' && /free workers/i.test(entity.label)));
  assert.ok(graph.entities.every((entity) => entity.source?.fingerprint && entity.lastVerified === 123));
  assert.equal(graph.entities.some((entity) => /do-not-index/i.test(entity.label)), false);
});

test('Project Graph hybrid retrieval handles exact lexical and trigram typo matches', () => {
  const entities = [
    { id: '1', type: 'architecture', label: 'Aki Context Optimizer', summary: 'Stable prefix and dynamic tail', keywords: ['context', 'cache'], source: { path: 'README.md', fingerprint: 'a' } },
    { id: '2', type: 'component', label: 'Budget Router', summary: 'Chooses cheapest healthy worker', keywords: ['quota', 'free'], source: { path: 'README.md', fingerprint: 'b' } },
  ];
  const index = buildGraphSearchIndex(entities);
  assert.equal(searchGraphIndex('Budget Router', index)[0].entity.id, '2');
  assert.equal(searchGraphIndex('contex optimizr', index)[0].entity.id, '1');
});

test('completed task outcome can be appended as compact graph knowledge without raw transcript', () => {
  let state = { version: 1, projects: {} };
  const load = () => structuredClone(state);
  const save = (next) => { state = next; };
  const result = recordProjectOutcome({ cwd: process.cwd(), taskKey: 'free-first-v1', summary: 'Free-first orchestrator shipped', decisions: ['Keep actual tokens separate from estimated savings'] }, { now: () => 456, load, save });
  assert.ok(result.entityCount >= 2);
  const project = Object.values(state.projects)[0];
  assert.ok(project.entities.some((entity) => entity.type === 'outcome'));
  assert.ok(project.entities.some((entity) => entity.type === 'decision'));
  assert.equal(project.entities.some((entity) => /transcript/i.test(entity.summary || '')), false);
});

test('graph sync reports bounded coverage instead of silently hiding truncation limits', () => {
  let state = { version: 1, projects: {} };
  const result = syncProjectGraph({ cwd: process.cwd() }, { now: () => 500, load: () => structuredClone(state), save: (next) => { state = next; } });
  assert.equal(result.coverage.maxFiles, 80);
  assert.equal(result.coverage.maxTotalChars, 500000);
  assert.equal(typeof result.coverage.fileCapTruncated, 'boolean');
  assert.equal(typeof result.coverage.charBudgetTruncated, 'boolean');
  assert.equal(result.coverage.sourceFiles, result.sourceCount);
});

test('task outcome ingestion drops common credential shapes before persistence', () => {
  let state = { version: 1, projects: {} };
  const load = () => structuredClone(state);
  const save = (next) => { state = next; };
  recordProjectOutcome({
    cwd: process.cwd(),
    taskKey: 'secret-filter',
    summary: 'shipped ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    decisions: ['keep normal decision', 'Bearer abcdefghijklmnopqrstuvwxyz123456'],
  }, { now: () => 789, load, save });
  const project = Object.values(state.projects)[0];
  const text = JSON.stringify(project);
  assert.doesNotMatch(text, /ghp_1234567890/);
  assert.doesNotMatch(text, /Bearer abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(text, /keep normal decision/);
  assert.match(text, /sensitive summary omitted/);
});
