import test from 'node:test';
import assert from 'node:assert/strict';
import { AGY_JOB_PROCESS_TIMEOUT_MS, AGY_SYNC_PROCESS_TIMEOUT_MS, buildAgyArgs, register as registerAgy, resolveAgyExecutable } from '../scripts/agy-mcp.js';

test('agy plan mode auto-approves confirmations while remaining plan-mode read-only', () => {
  const args = buildAgyArgs({
    prompt: 'inspect',
    mode: 'plan',
    model: 'gemini-3.7-flash-high',
    effort: 'low',
    outputFormat: 'json',
  });
  assert.equal(args[0], '--dangerously-skip-permissions');
  assert.deepEqual(args.slice(1, 5), ['--mode', 'plan', '--model', 'gemini-3.7-flash-high']);
  assert.equal(args.includes('--effort'), false, 'model already encodes the effort tier');
  assert.deepEqual(args.slice(-4), ['--print-timeout', '85s', '-p', 'inspect']);
  assert.equal(AGY_SYNC_PROCESS_TIMEOUT_MS, 100_000, 'synchronous agy must finish below the connector request deadline');
  assert.equal(AGY_JOB_PROCESS_TIMEOUT_MS, 330_000, 'background agy jobs may outlive one MCP round-trip');
});

test('agy non-plan modes do not bypass permission confirmation', () => {
  const args = buildAgyArgs({
    prompt: 'inspect',
    mode: 'default',
    model: 'claude-sonnet-4-6',
    effort: 'low',
  });
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(args.slice(0, 6), ['--mode', 'default', '--model', 'claude-sonnet-4-6', '--effort', 'low']);
});

test('agy background jobs can request the full five-minute print window without changing prompt position', () => {
  const args = buildAgyArgs({
    prompt: 'wide audit',
    mode: 'plan',
    model: 'gemini-3.7-flash-high',
    printTimeout: '5m',
  });
  assert.deepEqual(args.slice(-4), ['--print-timeout', '5m', '-p', 'wide audit']);
});

test('agy registers short and background job tools together', () => {
  const names = [];
  registerAgy({ registerTool: (name) => names.push(name) });
  assert.deepEqual(names, ['agy_run', 'agy_start', 'agy_status', 'agy_result']);
});

test('agy resolves the native Windows installation before PATH fallback', () => {
  const expected = String.raw`C:\Users\User\AppData\Local\agy\bin\agy.exe`;
  const resolved = resolveAgyExecutable({
    platform: 'win32',
    env: { LOCALAPPDATA: String.raw`C:\Users\User\AppData\Local` },
    exists: (path) => path === expected,
  });
  assert.equal(resolved, expected);
});