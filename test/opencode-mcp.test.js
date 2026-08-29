import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCodePromptBody, extractOpenCodeText, resolveOpenCodeExecutable } from '../scripts/opencode-mcp.js';

test('OpenCode prompt body is locked to the read-only agent and model', () => {
  assert.deepEqual(buildOpenCodePromptBody('inspect'), {
    model: { providerID: 'opencode-go', modelID: 'muse-spark-1.2-contributor' },
    agent: 'Aki-readonly',
    parts: [{ type: 'text', text: 'inspect' }],
  });
});

test('OpenCode response extraction returns only text parts', () => {
  const text = extractOpenCodeText({ parts: [
    { type: 'step-start' },
    { type: 'text', text: 'first' },
    { type: 'reasoning', text: 'hidden' },
    { type: 'text', text: 'second' },
  ] });
  assert.equal(text, 'first\nsecond');
});

test('OpenCode executable supports explicit override and native Windows Bun path', () => {
  assert.equal(resolveOpenCodeExecutable({ env: { AKI_OPENCODE_PATH: 'X:\\opencode.exe' } }), 'X:\\opencode.exe');
  const expected = 'C:\\Users\\Tester\\.bun\\bin\\opencode.exe';
  assert.equal(resolveOpenCodeExecutable({ platform: 'win32', env: {}, home: 'C:\\Users\\Tester', exists: (candidate) => candidate === expected }), expected);
});
