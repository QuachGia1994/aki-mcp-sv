import { z } from 'zod';
import { buildAgyArgs, runAgy } from './agy-mcp.js';
import { runXKiroRead, isXKiroConfigured } from './xkiro-mcp.js';
import { resolveOrFail } from './roots.js';
import { err } from './mcp-tool.js';
import { runBudgetedRead } from './budget-router.js';
import { readContextOptimizerConfig, runContextPacket } from './context-optimizer.js';

const COOLDOWN_MS = 60_000;
const unhealthyUntil = new Map();

function textOf(result) {
  return result?.content?.find((item) => item.type === 'text')?.text || 'unknown error';
}

export function scopeWorkerPrompt(prompt, dir) {
  return `[AKI_SCOPE]\nAllowed root: ${dir}\nUse only files physically under this absolute root. Ignore workspace/index results outside it. Resolve every relative path against this root. Never answer from a similarly named file elsewhere.\n[REQUEST]\n${prompt}`;
}

export function buildDefaultAgentProviders(scopedPrompt, dir) {
  return [
    ...(isXKiroConfigured() ? [['xkiro', () => runXKiroRead({ prompt: scopedPrompt, cwd: dir, reasoning: 'none' })]] : []),
    ['agy', () => runAgy(buildAgyArgs({ prompt: scopedPrompt, mode: 'plan', model: 'gemini-3.7-flash-high', effort: 'low', outputFormat: 'text' }), dir)],
  ];
}

export async function runAgentFallback(
  { prompt, cwd, taskKey, forceCold = false, budgetTokens },
  { providers, health = unhealthyUntil, now = Date.now, optimizer = runContextPacket, optimizerConfig = readContextOptimizerConfig, optimize = true } = {},
) {
  const r = resolveOrFail(cwd);
  if (!r.ok) return err(`rejected: ${r.error.message}`);
  const dir = r.dir;
  if (optimize) {
    const config = optimizerConfig();
    if (config.enabled) {
      const hasTaskKey = typeof taskKey === 'string' && taskKey.trim().length > 0;
      const optimized = await optimizer({
        prompt,
        cwd: dir,
        ...(hasTaskKey ? { taskKey: taskKey.trim().slice(0, 120) } : {}),
        forceCold,
        budgetTokens: budgetTokens === undefined ? Math.min(4000, config.budgetTokens) : budgetTokens,
        ephemeral: !hasTaskKey,
      });
      if (!optimized?.isError) return optimized;
      return err(`context optimizer failed — ${textOf(optimized).trim().split('\n')[0] || 'unknown error'}`);
    }
  }
  if (!providers) return runBudgetedRead({ prompt, cwd: dir, taskType: 'deep_retrieval' });
  const scopedPrompt = scopeWorkerPrompt(prompt, dir);
  const chain = providers ?? buildDefaultAgentProviders(scopedPrompt, dir);
  const failures = [];
  for (const [name, invoke] of chain) {
    if ((health.get(name) ?? 0) > now()) {
      failures.push(`${name}: cooldown`);
      continue;
    }
    const result = await invoke();
    if (!result?.isError) {
      health.delete(name);
      return result;
    }
    failures.push(`${name}: ${textOf(result).trim().split('\n')[0]}`);
    health.set(name, now() + COOLDOWN_MS);
  }
  return err(`all read workers unavailable — ${failures.join(' | ')}`);
}

export function register(server) {
  server.registerTool(
    'agent_read',
    {
      title: 'Aki One-Call Read Worker',
      description: 'Preferred for broad semantic repo/codebase/research tasks after one repo_snapshot. When enabled, Aki first asks a free worker for a bounded context packet and returns it directly; disabled mode preserves ordinary worker retrieval. Send the complete task plus cwd once, with taskKey for stable reuse across follow-ups. Use granular find/search/read only when this worker fails or exact file-level retrieval is requested.',
      inputSchema: {
        prompt: z.string(),
        cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
        taskKey: z.string().max(120).optional().describe('shared plan/task id; enables stable packet reuse across follow-ups'),
        forceCold: z.boolean().optional().default(false).describe('rebuild the stable packet before this read'),
        budgetTokens: z.number().int().min(2000).max(32000).optional().describe('automatic packet budget; defaults to the panel budget capped at 4000, explicit overrides may use up to 32000'),
      },
    },
    runAgentFallback,
  );
}
