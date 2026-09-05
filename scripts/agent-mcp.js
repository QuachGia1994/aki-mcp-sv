import { z } from 'zod';
import { buildAgyArgs, runAgy } from './agy-mcp.js';
import { runKiroRead } from './kiro-mcp.js';
import { runOpenCodeRead } from './opencode-mcp.js';
import { runXKiroRead, isXKiroConfigured } from './xkiro-mcp.js';
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

export function buildDefaultAgentProviders(scopedPrompt, dir) {
  return [
    ...(isXKiroConfigured() ? [['xkiro', () => runXKiroRead({ prompt: scopedPrompt, cwd: dir, reasoning: 'none' })]] : []),
    ['agy', () => runAgy(buildAgyArgs({ prompt: scopedPrompt, mode: 'plan', model: 'gemini-3.7-flash-high', effort: 'low', outputFormat: 'text' }), dir)],
    ['kiro', () => runKiroRead({ prompt: scopedPrompt, effort: 'low', cwd: dir })],
    ['opencode', () => runOpenCodeRead({ prompt: scopedPrompt, cwd: dir })],
  ];
}

export async function runAgentFallback({ prompt, cwd }, { providers, health = unhealthyUntil, now = Date.now } = {}) {
  const r = resolveOrFail(cwd);
  if (!r.ok) return err(`rejected: ${r.error.message}`);
  const dir = r.dir;
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
      description: 'Preferred for broad read-only repo/codebase/research tasks, especially in Gemini Spark where every MCP tool call needs a user click. Send the complete task plus cwd once; Aki performs multi-step retrieval server-side through xKiro free first when configured, then agy -> Kiro -> OpenCode. Use granular find/search/read tools only when this worker fails or the user asks for exact file-level retrieval.',
      inputSchema: {
        prompt: z.string(),
        cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
      },
    },
    runAgentFallback,
  );
}
