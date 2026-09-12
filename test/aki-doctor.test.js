import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diagnoseMcpTransport, diagnoseSubsystems, renderDoctorMarkdown, runAkiDoctor } from '../scripts/aki-doctor.js';

test('Doctor distinguishes enabled configuration from successful optimizer activity', async () => {
  assert.equal((await diagnoseSubsystems({ contextOptimizer: { enabled: true } })).status, 'WARN');
  assert.equal((await diagnoseSubsystems({ contextOptimizer: { enabled: true, activity: { successes: 1, lastSuccessAt: 10, lastFailureAt: 20 } } })).status, 'FAIL');
  assert.equal((await diagnoseSubsystems({ contextOptimizer: { enabled: true, activity: { successes: 2, lastSuccessAt: 30, lastFailureAt: 20 } } })).status, 'PASS');
});

test('Doctor probes the ports used by the running server configuration', async () => {
  const ports = [];
  const report = await diagnoseMcpTransport({ env: { LOOPBACK_MCP_PORT: '20001', PANEL_PORT: '10001', AKI_LOCAL_MCP_PORT: '30001', AKI_PANEL_PORT: '30002' }, connect: async (port) => { ports.push(port); return true; } });
  assert.deepEqual(ports, [20001, 10001]);
  assert.equal(report.loopbackMcp, true);
  assert.equal(report.panel, true);
});

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
