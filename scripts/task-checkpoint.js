import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { USER_DIR } from './userdata.js';
import { pathIdentity, resolveOrFail } from './roots.js';
import { clampInt, readJsonObject, writeJsonAtomic } from './user-state.js';
import { ok, err } from './mcp-tool.js';
import { recordProjectOutcome } from './project-graph.js';

export const TASK_CHECKPOINTS_PATH = path.join(USER_DIR, 'task-checkpoints.json');
export const DEFAULT_CHECKPOINT_CONFIG = Object.freeze({ maxEntries: 64, ttlHours: 24 * 30 });
const MAX_ITEM_CHARS = 1200;
const MAX_ITEMS = 32;

function normalizeText(value, max = MAX_ITEM_CHARS) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeText(item)).filter(Boolean))].slice(0, MAX_ITEMS);
}

function checkpointKey(cwd, taskKey) {
  return createHash('sha256').update(`${pathIdentity(cwd)}\n${taskKey}`).digest('hex').slice(0, 24);
}

function normalizeContext(value = {}) {
  const stableKeys = ['goal', 'constraints', 'decisions', 'architecture', 'acceptance'];
  const dynamicKeys = ['evidence', 'changes', 'tests', 'blockers', 'risks'];
  const out = { stable: {}, dynamic: {} };
  for (const key of stableKeys) out.stable[key] = normalizeList(value?.stable?.[key]);
  for (const key of dynamicKeys) out.dynamic[key] = normalizeList(value?.dynamic?.[key]);
  return out;
}

function normalizeEntry(value, now = Date.now()) {
  return {
    taskKey: normalizeText(value.taskKey, 120),
    cwd: path.resolve(value.cwd),
    status: ['active', 'paused', 'completed', 'failed'].includes(value.status) ? value.status : 'active',
    activeStep: normalizeText(value.activeStep),
    completedSteps: normalizeList(value.completedSteps),
    pendingSteps: normalizeList(value.pendingSteps),
    blockers: normalizeList(value.blockers),
    notes: normalizeText(value.notes, 4000),
    lastGreen: normalizeText(value.lastGreen, 2000),
    planPath: normalizeText(value.planPath, 1000),
    context: normalizeContext(value.context),
    updatedAt: Number(value.updatedAt || now),
    createdAt: Number(value.createdAt || now),
  };
}

export function readTaskCheckpoints({ now = Date.now(), maxEntries = DEFAULT_CHECKPOINT_CONFIG.maxEntries, ttlHours = DEFAULT_CHECKPOINT_CONFIG.ttlHours } = {}) {
  const stored = readJsonObject(TASK_CHECKPOINTS_PATH, { version: 1, entries: {} });
  const ttlMs = clampInt(ttlHours, DEFAULT_CHECKPOINT_CONFIG.ttlHours, 24, 24 * 365) * 60 * 60 * 1000;
  const entries = Object.entries(stored.entries || {})
    .map(([key, value]) => [key, normalizeEntry(value)])
    .filter(([, value]) => now - value.updatedAt <= ttlMs)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, clampInt(maxEntries, DEFAULT_CHECKPOINT_CONFIG.maxEntries, 8, 256));
  return { version: 1, entries: Object.fromEntries(entries) };
}

export function saveTaskCheckpoint(input, { now = Date.now(), load = readTaskCheckpoints, save = (state) => writeJsonAtomic(TASK_CHECKPOINTS_PATH, state) } = {}) {
  const resolved = resolveOrFail(input.cwd);
  if (!resolved.ok) throw resolved.error;
  const taskKey = normalizeText(input.taskKey, 120);
  if (!taskKey) throw new Error('task checkpoint requires a non-empty taskKey');
  const state = load();
  const key = checkpointKey(resolved.dir, taskKey);
  const previous = state.entries[key];
  const entry = normalizeEntry({ ...previous, ...input, taskKey, cwd: resolved.dir, createdAt: previous?.createdAt || now, updatedAt: now }, now);
  state.entries[key] = entry;
  const ordered = Object.entries(state.entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, DEFAULT_CHECKPOINT_CONFIG.maxEntries);
  save({ version: 1, entries: Object.fromEntries(ordered) });
  return entry;
}

export function getTaskCheckpoint(taskKey, cwd, { load = readTaskCheckpoints } = {}) {
  const task = normalizeText(taskKey, 120);
  if (!task || !cwd) return null;
  const state = load();
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) return null;
  return state.entries[checkpointKey(resolved.dir, task)] || null;
}

export function listTaskCheckpoints(cwd, { load = readTaskCheckpoints } = {}) {
  let root = null;
  if (cwd) {
    const resolved = resolveOrFail(cwd);
    if (!resolved.ok) return [];
    root = pathIdentity(resolved.dir);
  }
  return Object.values(load().entries)
    .filter((entry) => !root || pathIdentity(entry.cwd) === root)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((entry) => ({ taskKey: entry.taskKey, cwd: entry.cwd, status: entry.status, activeStep: entry.activeStep, updatedAt: entry.updatedAt, blockers: entry.blockers.length, pending: entry.pendingSteps.length }));
}

function renderContext(context) {
  const lines = [];
  for (const [group, sections] of Object.entries(context || {})) {
    for (const [name, items] of Object.entries(sections || {})) {
      if (!items?.length) continue;
      lines.push(`${group.toUpperCase()}.${name.toUpperCase()}:`);
      for (const item of items) lines.push(`- ${item}`);
    }
  }
  return lines.join('\n');
}

export function recoverTaskContext({ taskKey, cwd }, deps = {}) {
  const checkpoint = getTaskCheckpoint(taskKey, cwd, deps);
  if (!checkpoint) return { recovered: false, contextText: '' };
  const lines = [
    `[AKI_CHECKPOINT task=${checkpoint.taskKey} status=${checkpoint.status}]`,
    `CWD: ${checkpoint.cwd}`,
    checkpoint.planPath ? `PLAN: ${checkpoint.planPath}` : '',
    checkpoint.activeStep ? `ACTIVE: ${checkpoint.activeStep}` : '',
    checkpoint.lastGreen ? `LAST_GREEN: ${checkpoint.lastGreen}` : '',
  ].filter(Boolean);
  if (checkpoint.completedSteps.length) lines.push('COMPLETED:', ...checkpoint.completedSteps.map((item) => `- ${item}`));
  if (checkpoint.pendingSteps.length) lines.push('PENDING:', ...checkpoint.pendingSteps.map((item) => `- ${item}`));
  if (checkpoint.blockers.length) lines.push('BLOCKERS:', ...checkpoint.blockers.map((item) => `- ${item}`));
  if (checkpoint.notes) lines.push(`NOTES: ${checkpoint.notes}`);
  const context = renderContext(checkpoint.context);
  if (context) lines.push(context);
  return { recovered: true, contextText: lines.join('\n'), checkpoint };
}

export function markTaskCheckpointCompleted(taskKey, cwd, summary = '') {
  const current = getTaskCheckpoint(taskKey, cwd);
  if (!current) throw new Error(`task checkpoint not found: ${taskKey}`);
  return saveTaskCheckpoint({ ...current, taskKey, cwd: current.cwd, status: 'completed', notes: summary || current.notes });
}

export function getTaskCheckpointStatus() {
  const entries = Object.values(readTaskCheckpoints().entries);
  return {
    entries: entries.length,
    active: entries.filter((entry) => entry.status === 'active').length,
    paused: entries.filter((entry) => entry.status === 'paused').length,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
    last: entries.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null,
  };
}

export function register(server) {
  server.registerTool('task_checkpoint_save', {
    title: 'Aki Task Checkpoint Save',
    description: 'Persist compact task execution state across chat compaction, account switching, or Aki restart. Stores task/plan state only under ~/.aki/mcpsv; never stores full chat transcripts.',
    inputSchema: {
      taskKey: z.string().min(1).max(120), cwd: z.string(),
      status: z.enum(['active', 'paused', 'completed', 'failed']).optional(),
      activeStep: z.string().optional(), completedSteps: z.array(z.string()).optional(), pendingSteps: z.array(z.string()).optional(), blockers: z.array(z.string()).optional(),
      notes: z.string().optional(), lastGreen: z.string().optional(), planPath: z.string().optional(),
    },
  }, async (args) => {
    try {
      const entry = saveTaskCheckpoint(args);
      if (entry.status === 'completed') recordProjectOutcome({ cwd: entry.cwd, taskKey: entry.taskKey, summary: entry.notes || entry.activeStep || entry.taskKey, decisions: entry.context?.stable?.decisions || [] });
      return ok(JSON.stringify(entry, null, 2));
    } catch (error) { return err(error.message || String(error)); }
  });
  server.registerTool('task_checkpoint_get', { title: 'Aki Task Checkpoint Get', description: 'Read one durable task checkpoint scoped to an explicit project root.', inputSchema: { taskKey: z.string().min(1).max(120), cwd: z.string() } }, async ({ taskKey, cwd }) => ok(JSON.stringify(getTaskCheckpoint(taskKey, cwd), null, 2)));
  server.registerTool('task_checkpoint_list', { title: 'Aki Task Checkpoint List', description: 'List compact durable task checkpoints, optionally scoped to one project.', inputSchema: { cwd: z.string().optional() } }, async ({ cwd }) => ok(JSON.stringify(listTaskCheckpoints(cwd), null, 2)));
  server.registerTool('task_checkpoint_recover', { title: 'Aki Task Checkpoint Recover', description: 'Return the compact recovery packet for a task after context compaction/restart/account handoff, scoped to an explicit project root.', inputSchema: { taskKey: z.string().min(1).max(120), cwd: z.string() } }, async (args) => ok(recoverTaskContext(args).contextText || 'checkpoint not found'));
}
