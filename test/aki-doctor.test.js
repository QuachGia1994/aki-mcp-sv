import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDoctorMarkdown, runAkiDoctor } from '../scripts/aki-doctor.js';

test('Aki Doctor module is read-only by construction', () => {
  const source = readFileSync(new URL('../scripts/aki-doctor.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeFile|renameSync|unlinkSync|rmSync|mkdirSync/);
  assert.doesNotMatch(source, /execFile|spawn\(/);
});

test('Aki Doctor static report covers transport, security, workers and free-first subsystems', async () => {
  const report = await runAkiDoctor({ deep: false });
  assert.ok(['PASS', 'WARN', 'FAIL'].includes(report.status));
  assert.ok(report.transport && report.security && report.workers && report.subsystems);
  assert.ok('contextOptimizer' in report.subsystems);
  assert.ok('budgetRouter' in report.subsystems);
  assert.ok('projectGraph' in report.subsystems);
  assert.ok('taskCheckpoint' in report.subsystems);
  const text = renderDoctorMarkdown(report);
  assert.match(text, /MCP transport:/);
  assert.match(text, /Roots\/rules:/);
  assert.match(text, /Workers:/);
  assert.match(text, /Free-first subsystems:/);
});
