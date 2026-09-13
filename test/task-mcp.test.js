import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aki-task-test-'));
const settingsPath = path.join(dataDir, 'setting.json');
process.env.AKI_MCP_DATA_DIR = dataDir;
process.env.AKI_DATA_DIR = dataDir;

function writeSettings(allowAll) {
  fs.writeFileSync(settingsPath, JSON.stringify({ folders: [process.cwd()], shell: { allowAll, allowlistDirs: [] } }, null, 2));
}

writeSettings(false);
const taskModule = await import(`../scripts/task-mcp.js?test=${Date.now()}`);
const {
  register,
  taskStart,
  taskManage,
  isProcessAlive,
  getProcessIdentity,
  taskIdentityMatches,
  readLogTail,
  loadTasks,
  saveTasks,
} = taskModule;

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('task tools register and basic helpers are bounded', () => {
  const server = new McpServer({ name: 'test-tasks', version: '1.0.0' });
  register(server);
  assert.ok(server._registeredTools.task_start);
  assert.ok(server._registeredTools.task_manage);
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999), false);

  const log = path.join(dataDir, 'tail.log');
  fs.writeFileSync(log, 'line1\nline2\nline3\n');
  assert.equal(readLogTail(log, 1024, 2), 'line2\nline3\n');
});

test('task_start reuses shell policy and rejects chaining/path traversal', async () => {
  await assert.rejects(() => taskStart({ command: 'unauthorized_test_cmd --flag', cwd: process.cwd() }), /not in the allowlist/);
  await assert.rejects(() => taskStart({ command: 'git status; whoami', cwd: process.cwd() }), /command chaining/);
  await assert.rejects(() => taskStart({ command: 'git status', cwd: process.cwd(), taskId: '../../evil' }), /taskId must only contain/);
});

test('short background commands cannot miss their exit event', async () => {
  const taskId = `short_${Date.now()}`;
  const started = await taskStart({ command: 'git status --short', cwd: process.cwd(), taskId });
  assert.equal(started.taskId, taskId);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await taskManage({ action: 'status', taskId });
    if (status.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = await taskManage({ action: 'status', taskId });
  assert.ok(['completed', 'exited'].includes(status.status));
  await taskManage({ action: 'delete', taskId });
});

test('stop fails closed when a live PID no longer matches the captured identity', async () => {
  writeSettings(true);
  const sleeper = path.join(dataDir, 'sleeper.mjs');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 15000);\n');
  const taskId = `identity_${Date.now()}`;
  const started = await taskStart({ command: `node ${sleeper}`, cwd: process.cwd(), taskId });
  assert.ok(started.pid > 0);

  let tasks = loadTasks();
  const originalIdentity = tasks[taskId].processIdentity;
  assert.ok(originalIdentity?.startedAt, 'live task must capture a process start identity');
  assert.ok(getProcessIdentity(started.pid));
  assert.equal(taskIdentityMatches(tasks[taskId]), true);

  tasks[taskId].processIdentity = { ...originalIdentity, startedAt: 'recycled-pid-marker' };
  saveTasks(tasks);
  await assert.rejects(() => taskManage({ action: 'stop', taskId }), /no longer matches/);
  assert.equal(isProcessAlive(started.pid), true, 'mismatched identity must not kill the live process');

  tasks = loadTasks();
  tasks[taskId].processIdentity = originalIdentity;
  saveTasks(tasks);
  const stopped = await taskManage({ action: 'stop', taskId });
  assert.equal(stopped.stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await taskManage({ action: 'delete', taskId });
  writeSettings(false);
});
