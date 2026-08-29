import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgyArgs, resolveAgyExecutable } from '../scripts/agy-mcp.js';
import { resolveOpenCodeExecutable } from '../scripts/opencode-mcp.js';
import { classifyKiroOutput, resolveKiroExecutable, stripAnsi } from '../scripts/kiro-mcp.js';

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
  assert.deepEqual(args.slice(-2), ['-p', 'inspect']);
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

test('agy resolves the native Windows installation before PATH fallback', () => {
  const expected = String.raw`C:\Users\User\AppData\Local\agy\bin\agy.exe`;
  const resolved = resolveAgyExecutable({
    platform: 'win32',
    env: { LOCALAPPDATA: String.raw`C:\Users\User\AppData\Local` },
    exists: (path) => path === expected,
  });
  assert.equal(resolved, expected);
});

test('kiro resolves the per-user native Windows MSI installation', () => {
  const expected = String.raw`C:\Users\User\AppData\Local\Kiro-Cli\kiro-cli.exe`;
  const resolved = resolveKiroExecutable({
    platform: 'win32',
    env: {
      LOCALAPPDATA: String.raw`C:\Users\User\AppData\Local`,
      ProgramFiles: String.raw`C:\Program Files`,
    },
    exists: (path) => path === expected,
  });
  assert.equal(resolved, expected);
});

test('kiro supports an explicit executable override and portable fallback', () => {
  assert.equal(resolveKiroExecutable({ platform: 'win32', env: { KIRO_CLI_PATH: 'X:\\kiro.exe' }, exists: () => false }), 'X:\\kiro.exe');
  assert.equal(resolveKiroExecutable({ platform: 'linux', env: {}, exists: () => false }), 'kiro-cli');
});

test('kiro output strips ANSI control sequences before returning through MCP', () => {
  assert.equal(stripAnsi('\u001b[38;5;141mname=mcp-local\u001b[0m'), 'name=mcp-local');
});

test('kiro preserves stderr failures even when the CLI exits zero with empty stdout', () => {
  const result = classifyKiroOutput(null, '', '\u001b[38;5;11mMonthly request limit reached\u001b[0m');
  assert.deepEqual(result, { ok: false, text: 'Monthly request limit reached' });
});

test('opencode resolves the per-user Bun executable before PATH fallback', () => {
  const expected = String.raw`C:\Users\User\.bun\bin\opencode.exe`;
  const resolved = resolveOpenCodeExecutable({
    platform: 'win32',
    home: String.raw`C:\Users\User`,
    env: {},
    exists: (candidate) => candidate === expected,
  });
  assert.equal(resolved, expected);
});
