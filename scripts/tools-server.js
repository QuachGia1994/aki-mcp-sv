// Factory for the one shared McpServer hosting every in-process tool domain (shell, agy, kiro,
// search, claude-mem read access, filesystem). It replaces local-tools-mcp.js's separately spawned
// stdio child now that mcp-hub is gone (docs/plan/done/2.0.0-improve.md #7, Stage 2 phase 2). Each domain's logic stays in
// its own register(server) module behind a stable contract, unchanged from Stage 1.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { register as registerShell } from './shell-mcp.js';
import { register as registerAgy } from './agy-mcp.js';
import { register as registerKiro } from './kiro-mcp.js';
import { register as registerOpenCode } from './opencode-mcp.js';
import { register as registerAgent } from './agent-mcp.js';
import { register as registerSearch } from './search-mcp.js';
import { register as registerRepoSnapshot } from './repo-snapshot-mcp.js';
import { register as registerClaudeMem } from './claude-mem-mcp.js';
import { register as registerFilesystem } from './filesystem-mcp.js';
import { register as registerPostman } from './postman-mcp.js';
import { register as registerXKiro } from './xkiro-mcp.js';
import { register as registerContextOptimizer } from './context-optimizer.js';
import { register as registerBudgetRouter } from './budget-router.js';
import { register as registerProjectGraph } from './project-graph.js';
import { register as registerTaskCheckpoint } from './task-checkpoint.js';
import { register as registerAkiDoctor } from './aki-doctor.js';

const SERVER_INSTRUCTIONS = [
  'Gemini Spark confirms every MCP tools/call client-side.',
  'For broad local repo/codebase analysis, call local__repo_snapshot exactly once with the project path; it returns a bounded tree plus prioritized source/config/docs in one local read pass and is designed to finish within short client deadlines.',
  'Use local__agent_read only for semantic/cross-source retrieval after repo_snapshot is insufficient; do not decompose broad analysis into list_allowed_directories/find_path/search_content/read_text_file unless the one-call paths fail or the user requests granular reads.',
  'For multi-step/deep work, call local__context_packet with the shared plan/task id before expensive lead/Astra reasoning; it recovers the task checkpoint, searches compact durable project knowledge, then uses the Budget Router so raw retrieval/compression stays in the cheapest healthy eligible worker. Reuse the same taskKey on follow-ups; force a cold rebuild only when stable assumptions changed.',
  'Use local__budget_router_read instead of choosing xKiro/OpenCode/agy/Kiro manually; its ledger keeps actual provider tokens, estimates, avoided lead context, and reported cache hits as separate metrics.',
  'Use local__task_checkpoint_recover after compaction/restart/account handoff, local__graph_query for durable project decisions/facts, and local__aki_doctor for unified read-only health diagnosis.',
  'For implementation, prefer local__opencode_exec when its write-worker toggle is enabled and the task has a settled scope/plan; run verification separately with local__run_cmd, then review only risky diffs or unresolved items. Fall back to normal write tools when the free executor is disabled/unavailable or the task is high-risk.',
].join(' ');

const LOCAL_READ_ONLY_TOOLS = new Set([
  'read_text_file',
  'get_file_info',
  'list_allowed_directories',
  'find_path',
  'search_content',
  'repo_snapshot',
  'claude_mem_search',
  'claude_mem_timeline',
  'claude_mem_get_observations',
  'postman_status',
  'context_optimizer_status',
  'graph_query',
  'graph_status',
  'task_checkpoint_get',
  'task_checkpoint_list',
  'task_checkpoint_recover',
]);

const REMOTE_READ_ONLY_TOOLS = new Set(['kiro_read', 'opencode_read', 'opencode_status', 'xkiro_read', 'xkiro_status', 'agent_read', 'budget_router_status', 'aki_doctor']);

const MUTATING_TOOL_ANNOTATIONS = new Map([
  ['write_file', { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }],
  ['edit_file', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ['create_directory', { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['move_file', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  // Both are configurable execution surfaces, so keep their static hints conservative even though the
  // default policy is read-only/plan-mode. A future wider allowlist must not inherit a false safety claim.
  ['run_cmd', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
  ['agy_run', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
  ['opencode_exec', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
  ['budget_router_read', { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
  ['context_packet', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
  ['graph_sync', { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['task_checkpoint_save', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
]);

function annotationsForTool(name) {
  if (LOCAL_READ_ONLY_TOOLS.has(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (REMOTE_READ_ONLY_TOOLS.has(name)) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  return MUTATING_TOOL_ANNOTATIONS.get(name) ?? null;
}

// mcp-hub used to prefix every tool from this server's config entry (key "local") with
// `local__` when aggregating backends. Now that the bridge talks to this server directly, that
// prefixing layer is gone — reproduce it here as the one place doing it, so served tool names
// (local__run_cmd, local__find_path, …) stay exactly what README.md and CLAUDE.md already tell
// every connected AI to call. This seam also centralizes MCP ToolAnnotations; Spark still confirms
// every call today, but accurate hints help other clients and future trust policies classify tools.
function prefixedServer(server, prefix) {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name, config, callback) => {
        const defaults = annotationsForTool(name);
        const annotatedConfig = defaults
          ? { ...config, annotations: { ...defaults, ...(config?.annotations ?? {}) } }
          : config;
        return target.registerTool(`${prefix}${name}`, annotatedConfig, callback);
      };
    },
  });
}

export function createToolsServer() {
  const server = new McpServer(
    { name: 'local', version: '1.0.0', title: 'Local Tools' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const local = prefixedServer(server, 'local__');
  for (const register of [registerShell, registerAgy, registerKiro, registerOpenCode, registerXKiro, registerBudgetRouter, registerAgent, registerProjectGraph, registerTaskCheckpoint, registerContextOptimizer, registerAkiDoctor, registerSearch, registerRepoSnapshot, registerClaudeMem, registerFilesystem, registerPostman]) register(local);

  // Compatibility for pre-1.10 installs where mcp-hub exposed the separate filesystem backend as
  // `filesystem__*`. Qwen/Kimi bridge prompts in the wild use these names. Both namespaces land on
  // the same native implementation and roots policy; this is an alias, not a second filesystem arm.
  registerFilesystem(prefixedServer(server, 'filesystem__'));
  return server;
}
