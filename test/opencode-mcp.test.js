import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildOpenCodeExecPrompt, buildOpenCodePromptBody, buildOpenCodeServerLaunch, chooseOpenCodeModel, DEFAULT_OPENCODE_MODEL, extractOpenCodeText, getOpenCodeStatus, isFreeOpenCodeModel, listFreeOpenCodeModels, parseOpenCodeVerboseModels, resolveOpenCodeExecutable, validateOpenCodeExecRequest } from '../scripts/opencode-mcp.js';

test('OpenCode prompt body is locked to the read-only agent and selected Zen model', () => {
  assert.deepEqual(buildOpenCodePromptBody('inspect'), {
    model: { providerID: 'opencode', modelID: 'muse-spark-1.3-contributor-free' },
    agent: 'Aki-readonly',
    parts: [{ type: 'text', text: 'inspect' }],
  });
  assert.deepEqual(buildOpenCodePromptBody('inspect', 'opencode/nemotron-3-ultra-free').model, { providerID: 'opencode', modelID: 'nemotron-3-ultra-free' });
  assert.equal(buildOpenCodePromptBody('implement', DEFAULT_OPENCODE_MODEL, 'Aki-exec').agent, 'Aki-exec');
});

test('OpenCode exec gate is opt-in and keeps task instructions compact', () => {
  assert.match(validateOpenCodeExecRequest({ prompt: 'implement', config: { execEnabled: false } }).error, /disabled/);
  assert.match(validateOpenCodeExecRequest({ prompt: '   ', config: { execEnabled: true } }).error, /non-empty/);
  assert.equal(validateOpenCodeExecRequest({ prompt: '  implement  ', config: { execEnabled: true } }).task, 'implement');
  assert.match(validateOpenCodeExecRequest({ prompt: 'x'.repeat(20_001), config: { execEnabled: true } }).error, /too large/);
});

test('OpenCode exec prompt carries shared plan and pre-existing worktree state without granting plan-file access', () => {
  const prompt = buildOpenCodeExecPrompt({ prompt: 'Implement stage 2', cwd: 'D:\\Repo', planText: '# Shared plan\n- stage 2', worktreeBefore: ' M src/a.js' });
  assert.match(prompt, /Project root: D:\\Repo/);
  assert.match(prompt, /\[WORKTREE_BEFORE\]\n M src\/a\.js/);
  assert.match(prompt, /\[SHARED_PLAN\]\n# Shared plan/);
  assert.match(prompt, /\[TASK\]\nImplement stage 2/);
  assert.doesNotMatch(prompt, /planPath/);
});

test('Aki-exec agent allows project edits but denies shell, external directories, self-edit, web, and delegation', () => {
  const agent = fs.readFileSync(new URL('../.opencode/agents/Aki-exec.md', import.meta.url), 'utf8');
  assert.match(agent, /edit:\n    "\*": allow/);
  assert.match(agent, /"\.opencode\/\*\*": deny/);
  assert.match(agent, /external_directory: deny/);
  assert.match(agent, /bash: deny/);
  assert.match(agent, /webfetch: deny/);
  assert.match(agent, /websearch: deny/);
  assert.match(agent, /task: deny/);
  assert.match(agent, /skill: deny/);
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

test('Windows OpenCode server launch uses WScript hidden launcher without changing serve contract', () => {
  const launch = buildOpenCodeServerLaunch({ executable: 'C:\\Users\\Tester\\.bun\\bin\\opencode.exe', cwd: 'D:\\Repo', port: 4098, platform: 'win32', env: { SystemRoot: 'C:\\Windows', KEEP_ME: 'yes' }, launcherPath: 'D:\\Aki\\scripts\\run-hidden-command.vbs', configDir: 'D:\\Aki\\.opencode' });
  assert.equal(launch.command, 'C:\\Windows\\System32\\wscript.exe');
  assert.deepEqual(launch.args, ['D:\\Aki\\scripts\\run-hidden-command.vbs', 'C:\\Users\\Tester\\.bun\\bin\\opencode.exe', 'serve', '--pure', '--hostname', '127.0.0.1', '--port', '4098']);
  assert.equal(launch.options.cwd, 'D:\\Repo');
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.stdio, 'ignore');
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.env.KEEP_ME, 'yes');
  assert.equal(launch.options.env.OPENCODE_CONFIG_DIR, 'D:\\Aki\\.opencode');
});

test('OpenCode verbose catalog parser keeps metadata and free policy requires zero cost plus tool calling', () => {
  const output = `opencode/muse-spark-1.3-contributor-free\n{\n  "id": "muse-spark-1.3-contributor-free",\n  "providerID": "opencode",\n  "name": "Muse Spark 1.3 Free",\n  "status": "active",\n  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },\n  "capabilities": { "toolcall": true },\n  "release_date": "2026-09-02"\n}\nopencode/gemini-3.8-flash\n{\n  "id": "gemini-3.8-flash",\n  "providerID": "opencode",\n  "name": "Gemini 3.8 Flash",\n  "status": "active",\n  "cost": { "input": 1.5, "output": 7.5 },\n  "capabilities": { "toolcall": true },\n  "release_date": "2026-09-02"\n}`;
  const models = parseOpenCodeVerboseModels(output);
  assert.equal(models.length, 2);
  assert.equal(isFreeOpenCodeModel(models[0]), true);
  assert.equal(isFreeOpenCodeModel(models[1]), false);
});

test('OpenCode refresh gets a longer timeout and falls back to the cached CLI catalog when live refresh fails', async () => {
  const calls = [];
  const freeCatalog = `opencode/muse-spark-1.3-contributor-free\n{\n  "id": "muse-spark-1.3-contributor-free",\n  "providerID": "opencode",\n  "name": "Muse Spark 1.3 Free",\n  "status": "active",\n  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },\n  "capabilities": { "toolcall": true },\n  "release_date": "2026-09-02"\n}`;
  const runner = async (args, options) => {
    calls.push({ args, options });
    if (args.includes('--refresh')) throw new Error('temporary models.dev refresh failure');
    return freeCatalog;
  };
  const models = await listFreeOpenCodeModels({ refresh: true, runner });
  assert.equal(models[0].id, DEFAULT_OPENCODE_MODEL);
  assert.deepEqual(calls[0].args, ['models', 'opencode', '--refresh', '--verbose']);
  assert.equal(calls[0].options.timeoutMs, 180_000);
  assert.deepEqual(calls[1].args, ['models', 'opencode', '--verbose']);
  assert.equal(calls[1].options.timeoutMs, 60_000);
});

test('OpenCode status exposes when a refresh used the local catalog fallback', async () => {
  const freeCatalog = `opencode/muse-spark-1.3-contributor-free\n{\n  "id": "muse-spark-1.3-contributor-free",\n  "providerID": "opencode",\n  "name": "Muse Spark 1.3 Free",\n  "status": "active",\n  "cost": { "input": 0, "output": 0 },\n  "capabilities": { "toolcall": true }\n}`;
  const runner = async (args) => {
    if (args[0] === 'auth') return 'OpenCode Zen api';
    if (args.includes('--refresh')) throw new Error('models.dev unavailable');
    return freeCatalog;
  };
  const status = await getOpenCodeStatus({ refresh: true, runner });
  assert.equal(status.configured, true);
  assert.equal(status.catalogSource, 'local-fallback');
  assert.match(status.refreshWarning, /models\.dev unavailable/);
  assert.equal(status.freeModels.length, 1);
});

test('OpenCode model choice stays on selected free model and falls back only within free catalog', () => {
  const models = [
    { id: 'opencode/nemotron-3.5-lightning-free' },
    { id: DEFAULT_OPENCODE_MODEL },
  ];
  assert.equal(chooseOpenCodeModel('opencode/nemotron-3.5-lightning-free', models), 'opencode/nemotron-3.5-lightning-free');
  assert.equal(chooseOpenCodeModel('opencode/removed-model', models), DEFAULT_OPENCODE_MODEL);
  assert.equal(chooseOpenCodeModel('opencode/removed-model', [{ id: 'opencode/nemotron-3-ultra-free' }]), 'opencode/nemotron-3-ultra-free');
  assert.throws(() => chooseOpenCodeModel('opencode/removed-model', []), /no active zero-cost/);
});

test('OpenCode tab uses the bundled official brand SVG with shared provider styling', () => {
  const panelSource = fs.readFileSync(new URL('../scripts/config-page.js', import.meta.url), 'utf8');
  const icon = fs.readFileSync(new URL('../public/img/providers/opencode.svg', import.meta.url), 'utf8');
  assert.match(panelSource, /data-tab="opencode"><img src="\/img\/providers\/opencode\.svg" class="provider-icon" alt="">OpenCode<\/button>/);
  assert.match(icon, /<svg[^>]+viewBox="0 0 24 24"/);
  assert.match(icon, /linearGradient/);
});

test('OpenCode status uses CLI credential presence and reports free fallback without exposing a key', async () => {
  const previous = process.env.AKI_OPENCODE_MODEL;
  process.env.AKI_OPENCODE_MODEL = 'opencode/removed-free';
  const runner = async (args) => {
    if (args[0] === 'auth') return 'OpenCode Zen api\nGitHub Copilot oauth';
    return `opencode/muse-spark-1.3-contributor-free\n{\n  "id": "muse-spark-1.3-contributor-free",\n  "providerID": "opencode",\n  "name": "Muse Spark 1.3 Free",\n  "status": "active",\n  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },\n  "capabilities": { "toolcall": true },\n  "release_date": "2026-09-02",\n  "limit": { "context": 1048576, "output": 131072 }\n}`;
  };
  try {
    const status = await getOpenCodeStatus({ runner });
    assert.equal(status.configured, true);
    assert.equal(status.selectedModel, 'opencode/removed-free');
    assert.equal(status.effectiveModel, DEFAULT_OPENCODE_MODEL);
    assert.equal(status.fallback, true);
    assert.equal(status.freeModels.length, 1);
    assert.equal('apiKey' in status, false);
  } finally {
    if (previous === undefined) delete process.env.AKI_OPENCODE_MODEL; else process.env.AKI_OPENCODE_MODEL = previous;
  }
});
