import { z } from 'zod';
import { buildAgyArgs, runAgy } from './agy-mcp.js';
import { runKiroRead } from './kiro-mcp.js';
import { runOpenCodeRead } from './opencode-mcp.js';
import { resolveOrFail } from './roots.js';
import { err } from './mcp-tool.js';

const COOLDOWN_MS = 60_000;
const unhealthyUntil = new Map();

function textOf(result) {
  return result?.content?.find((item) => item.type === 'text')?.text || 'unknown error';
}

export function scopeWorkerPrompt(prompt, dir) {
  return `[AKI_SCOPE]\nAllowed root: ${dir}\nUse only files physically under this absolute root. Ignore workspace/index results outside it. Resolve every relative path against this root. Never answer from a similarly named file elsewhere.\n[REQUEST]\n${prompt}`;
}

export async function runAgentFallback({ prompt, cwd }, { providers, health = unhealthyUntil, now = Date.now } = {}) {
  const r = resolveOrFail(cwd);
  if (!r.ok) return err(`rejected: ${r.error.message}`);
  const dir = r.dir;
  const scopedPrompt = scopeWorkerPrompt(prompt, dir);
  const chain = providers ?? [
    ['agy', () => runAgy(buildAgyArgs({ prompt: scopedPrompt, mode: 'plan', model: 'gemini-3.7-flash-high', effort: 'low', outputFormat: 'text' }), dir)],
    ['kiro', () => runKiroRead({ prompt: scopedPrompt, effort: 'low', cwd: dir })],
    ['opencode', () => runOpenCodeRead({ prompt: scopedPrompt, cwd: dir })],
  ];
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
      title: 'Aki Read Worker Router',
      description: 'Delegate one read-only retrieval task through a health-aware fallback chain: agy -> Kiro -> OpenCode. Failed providers enter a short cooldown so repeated conversations do not stall on the same quota/auth/bootstrap error.',
      inputSchema: {
        prompt: z.string(),
        cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
      },
    },
    runAgentFallback,
  );
}
