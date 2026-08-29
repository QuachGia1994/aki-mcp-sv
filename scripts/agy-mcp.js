// Dedicated MCP tool for the `agy` CLI: passes prompt/model/mode as separate execFile args so no shell-tokenizing step can mis-split a multi-word -p prompt (the reason it is not routed through the generic shell tool). Modes are allowlisted via allowlist.js.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { z } from 'zod';
import { readSettings } from './allowlist.js';
import { resolveOrFail } from './roots.js';
import { ok, err, fail } from './mcp-tool.js';

// 'plan' is agy's non-mutating mode — the only one enabled out of the box. Anything else must be explicitly opted into via setting.json -> { "agy": { "allowedModes": [...] } }.
const DEFAULT_MODES = ['plan'];
// Discovery-tier default per akiflow/harness-facts.md: fastest wide-context tier, generous quota.
const DEFAULT_MODEL = 'gemini-3.7-flash-high';

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

export function buildAgyArgs({ prompt, mode, model, effort, outputFormat }) {
  const args = [];
  if (mode === 'plan') args.push('--dangerously-skip-permissions');
  args.push('--mode', mode, '--model', model);
  if (effort && !modelEmbedsEffort(model)) args.push('--effort', effort);
  if (outputFormat) args.push('--output-format', outputFormat);
  args.push('-p', prompt);
  return args;
}

export function runAgy(args, cwd) {
  return new Promise((resolve) => {
    execFile(resolveAgyExecutable(), args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // agy writes its own errors to stdout, not stderr — check stdout first or real failures show up as Node's generic "Command failed: <cmd>" with no explanation (see shell-mcp.js's same bug).
        return resolve(err(stdout || stderr || error.message));
      }
      // agy headless can't prompt for permission: a denied action auto-fails but still exits 0 with an empty response (harness-facts.md § Cross-CLI worker). Treat empty stdout as inconclusive, not clean.
      if (!stdout || !stdout.trim()) {
        return resolve(err('agy returned no output — the call may have been silently denied rather than a clean empty result. Re-check the prompt/scope.'));
      }
      resolve(ok(stdout));
    });
  });
}

export function register(server) {
  server.registerTool(
    'agy_run',
    {
      title: 'Antigravity CLI',
      description:
        'Run the agy CLI for read-only retrieval, never judgment (akiflow/harness-facts.md § Model tiers). ' +
        `Defaults to mode "plan" (read-only by mechanism) and model "${DEFAULT_MODEL}" (fast, wide-context discovery tier). ` +
        'Other modes must be allowlisted in setting.json under agy.allowedModes before use. Name exact paths and the exact ' +
        "output shape in the prompt — agy's workspace index can resolve files outside cwd, so cwd is not a hard scope boundary. " +
        'prompt is passed straight to agy as one argument — no shell quoting, spaces/punctuation are safe as-is.',
      inputSchema: {
        prompt: z.string(),
        mode: z.string().optional().describe('agy --mode, defaults to "plan"'),
        model: z.string().optional().describe(`agy --model, defaults to "${DEFAULT_MODEL}". Valid ids: gemini-3.7-flash-{low,medium,high}, gemini-3.6-flash-{low,medium,high}, gemini-3.5-flash-{low,medium,high}, gemini-3.1-pro-{low,high}, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium`),
        effort: z.enum(['low', 'medium', 'high']).optional().describe('agy --effort, thinking budget'),
        outputFormat: z.enum(['text', 'json']).optional().describe('agy --output-format, use "json" when a program parses the result'),
        cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
      },
    },
    async ({ prompt, mode, model, effort, outputFormat, cwd }) => {
      const useMode = mode ?? 'plan';
      const allowed = loadAllowedModes();
      if (!allowed.includes(useMode)) {
        return err(`rejected: mode "${useMode}" is not allowlisted (allowed: ${allowed.join(', ')})`);
      }
      const r = resolveOrFail(cwd);
      if (!r.ok) return fail(r.error);
      const dir = r.dir;
      // -p takes the prompt as its value and must come last — anything after it is silently swallowed as part of the prompt, not parsed as a flag (harness-facts.md § Cross-CLI worker, the flag-order trap).
      const args = buildAgyArgs({
        prompt,
        mode: useMode,
        model: model ?? DEFAULT_MODEL,
        effort,
        outputFormat,
      });
      return runAgy(args, dir);
    },
  );
}
