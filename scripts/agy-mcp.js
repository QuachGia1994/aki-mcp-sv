// Dedicated MCP tools for the `agy` CLI: synchronous short reads plus background jobs for long repository audits. Prompts are passed as exec/spawn argv so no shell-tokenizing step can split them.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { win32 } from 'node:path';
import path from 'node:path';
import { z } from 'zod';
import { readSettings } from './allowlist.js';
import { resolveOrFail } from './roots.js';
import { USER_DIR } from './userdata.js';
import { ok, err, fail } from './mcp-tool.js';

const DEFAULT_MODES = ['plan'];
const DEFAULT_MODEL = 'gemini-3.7-flash-high';
const AGY_SYNC_PRINT_TIMEOUT = '85s';
const AGY_JOB_PRINT_TIMEOUT = '5m';
export const AGY_SYNC_PROCESS_TIMEOUT_MS = 100_000;
export const AGY_JOB_PROCESS_TIMEOUT_MS = 330_000;
const MAX_CONCURRENT_JOBS = 4;
const MAX_JOB_RESULT_BYTES = 4 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000;
const JOB_DIR = path.join(USER_DIR, 'agy-jobs');
const jobs = new Map();

function loadAllowedModes() {
  const configured = readSettings().agy?.allowedModes;
  return Array.isArray(configured) && configured.length ? configured : DEFAULT_MODES;
}

export function resolveAgyExecutable({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (env.AKI_AGY_PATH) return env.AKI_AGY_PATH;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const candidate = win32.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (exists(candidate)) return candidate;
  }
  return 'agy';
}

function modelEmbedsEffort(model) {
  return /-(?:low|medium|high)$/.test(model);
}

export function buildAgyArgs({ prompt, mode, model, effort, outputFormat, printTimeout = AGY_SYNC_PRINT_TIMEOUT }) {
  const args = [];
  if (mode === 'plan') args.push('--dangerously-skip-permissions');
  args.push('--mode', mode, '--model', model);
  if (effort && !modelEmbedsEffort(model)) args.push('--effort', effort);
  if (outputFormat) args.push('--output-format', outputFormat);
  args.push('--print-timeout', printTimeout);
  args.push('-p', prompt);
  return args;
}

function resolveRequest({ cwd, mode }) {
  const useMode = mode ?? 'plan';
  const allowed = loadAllowedModes();
  if (!allowed.includes(useMode)) return { error: `rejected: mode "${useMode}" is not allowlisted (allowed: ${allowed.join(', ')})` };
  const r = resolveOrFail(cwd);
  if (!r.ok) return { failure: r.error };
  return { mode: useMode, dir: r.dir };
}

export function runAgy(args, cwd, { run = execFile } = {}) {
  return new Promise((resolve) => {
    run(resolveAgyExecutable(), args, { cwd, timeout: AGY_SYNC_PROCESS_TIMEOUT_MS, maxBuffer: MAX_JOB_RESULT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(err(stdout || stderr || error.message));
      if (!stdout || !stdout.trim()) return resolve(err('agy returned no output — the call may have been silently denied rather than a clean empty result. Re-check the prompt/scope.'));
      resolve(ok(stdout));
    });
  });
}

function cleanupJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (!job.finishedAt || now - job.finishedAt <= JOB_TTL_MS) continue;
    for (const file of [job.stdoutPath, job.stderrPath]) {
      try { unlinkSync(file); } catch {}
    }
    jobs.delete(id);
  }
}

function safeStatSize(file) {
  try { return statSync(file).size; } catch { return 0; }
}

function readBounded(file) {
  const size = safeStatSize(file);
  if (size > MAX_JOB_RESULT_BYTES) throw new Error(`agy job output exceeds ${MAX_JOB_RESULT_BYTES} bytes`);
  return size ? readFileSync(file, 'utf8') : '';
}

export function startAgyJob(args, cwd) {
  cleanupJobs();
  const running = [...jobs.values()].filter((job) => job.status === 'running').length;
  if (running >= MAX_CONCURRENT_JOBS) return { error: `too many running agy jobs (${running}/${MAX_CONCURRENT_JOBS})` };

  mkdirSync(JOB_DIR, { recursive: true });
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const stdoutPath = path.join(JOB_DIR, `${id}.stdout.txt`);
  const stderrPath = path.join(JOB_DIR, `${id}.stderr.txt`);
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  let child;
  try {
    child = spawn(resolveAgyExecutable(), args, { cwd, windowsHide: true, stdio: ['ignore', outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }

  const job = {
    id,
    pid: child.pid ?? null,
    status: 'running',
    cwd,
    stdoutPath,
    stderrPath,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
  };
  jobs.set(id, job);

  const timer = setTimeout(() => {
    if (job.status !== 'running') return;
    job.status = 'timed_out';
    job.error = `agy exceeded ${AGY_JOB_PROCESS_TIMEOUT_MS}ms background deadline`;
    try { child.kill(); } catch {}
  }, AGY_JOB_PROCESS_TIMEOUT_MS);
  timer.unref?.();

  child.once('error', (e) => {
    clearTimeout(timer);
    job.status = 'failed';
    job.error = e.message;
    job.finishedAt = Date.now();
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = Date.now();
    if (job.status === 'timed_out') return;
    job.status = code === 0 ? 'succeeded' : 'failed';
  });

  return { job };
}

function jobView(job) {
  return {
    id: job.id,
    status: job.status,
    pid: job.pid,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    stdoutBytes: safeStatSize(job.stdoutPath),
    stderrBytes: safeStatSize(job.stderrPath),
    error: job.error,
  };
}

function getJob(id) {
  cleanupJobs();
  return jobs.get(id) ?? null;
}

const modelDescription = `agy --model, defaults to "${DEFAULT_MODEL}". Current ids include gemini-3.8-flash-{low,medium,high}, gemini-3.7-flash-{low,medium,high}, gemini-3.6-flash-{low,medium,high}, gemini-3.1-pro-{low,high}, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium`;
const commonInputSchema = {
  prompt: z.string(),
  mode: z.string().optional().describe('agy --mode, defaults to "plan"'),
  model: z.string().optional().describe(modelDescription),
  effort: z.enum(['low', 'medium', 'high']).optional().describe('agy --effort, thinking budget'),
  outputFormat: z.enum(['text', 'json']).optional().describe('agy --output-format, use "json" when a program parses the result'),
  cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
};

export function register(server) {
  server.registerTool(
    'agy_run',
    {
      title: 'Antigravity CLI — short read',
      description:
        `Run one read-only agy retrieval with an ${AGY_SYNC_PRINT_TIMEOUT} CLI deadline so the MCP round-trip stays below connector timeouts. ` +
        'Use agy_start/status/result for repository-wide audits or any task likely to need longer. Modes remain allowlisted via setting.json.',
      inputSchema: commonInputSchema,
    },
    async ({ prompt, mode, model, effort, outputFormat, cwd }) => {
      const resolved = resolveRequest({ cwd, mode });
      if (resolved.error) return err(resolved.error);
      if (resolved.failure) return fail(resolved.failure);
      const args = buildAgyArgs({ prompt, mode: resolved.mode, model: model ?? DEFAULT_MODEL, effort, outputFormat });
      return runAgy(args, resolved.dir);
    },
  );

  server.registerTool(
    'agy_start',
    {
      title: 'Antigravity CLI — background audit',
      description:
        `Start a read-only agy job with a ${AGY_JOB_PRINT_TIMEOUT} CLI deadline and return immediately. Use for whole-repository audits so no single MCP request waits on the model. Poll agy_status, then fetch agy_result. Maximum ${MAX_CONCURRENT_JOBS} concurrent jobs.`,
      inputSchema: commonInputSchema,
    },
    async ({ prompt, mode, model, effort, outputFormat, cwd }) => {
      const resolved = resolveRequest({ cwd, mode });
      if (resolved.error) return err(resolved.error);
      if (resolved.failure) return fail(resolved.failure);
      const args = buildAgyArgs({ prompt, mode: resolved.mode, model: model ?? DEFAULT_MODEL, effort, outputFormat, printTimeout: AGY_JOB_PRINT_TIMEOUT });
      const started = startAgyJob(args, resolved.dir);
      if (started.error) return err(started.error);
      return ok(JSON.stringify(jobView(started.job)));
    },
  );

  server.registerTool(
    'agy_status',
    {
      title: 'Antigravity CLI — job status',
      description: 'Return compact status for one agy background job. This never waits for the model.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const job = getJob(id);
      if (!job) return err(`unknown or expired agy job: ${id}`);
      return ok(JSON.stringify(jobView(job)));
    },
  );

  server.registerTool(
    'agy_result',
    {
      title: 'Antigravity CLI — job result',
      description: 'Return stdout from a completed agy background job, or its stderr/error on failure. Running jobs are not waited on.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const job = getJob(id);
      if (!job) return err(`unknown or expired agy job: ${id}`);
      if (job.status === 'running') return err(`agy job ${id} is still running`);
      const stdout = readBounded(job.stdoutPath);
      const stderr = readBounded(job.stderrPath);
      if (job.status === 'succeeded') {
        if (!stdout.trim()) return err(`agy job ${id} succeeded with empty output; stderr: ${stderr || '(empty)'}`);
        return ok(stdout);
      }
      return err(stderr || job.error || `agy job ${id} failed with exit ${job.exitCode}`);
    },
  );
}
