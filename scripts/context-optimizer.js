import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { USER_DIR } from './userdata.js';
import { clampInt, readJsonObject, writeJsonAtomic } from './user-state.js';
import { pathIdentity, resolveOrFail } from './roots.js';
import { runBudgetedRead, recordContextSavings } from './budget-router.js';
import { getProjectGraphStatus, runGraphQuery, syncProjectGraph } from './project-graph.js';
import { recoverTaskContext, saveTaskCheckpoint } from './task-checkpoint.js';
import { ok, err } from './mcp-tool.js';

export const CONTEXT_OPTIMIZER_CONFIG_PATH = path.join(USER_DIR, 'context-optimizer.json');
export const CONTEXT_OPTIMIZER_STATE_PATH = path.join(USER_DIR, 'context-optimizer-state.json');
export const DEFAULT_CONTEXT_OPTIMIZER_CONFIG = Object.freeze({ enabled: true, budgetTokens: 12000, hotWindowMinutes: 30, maxEntries: 16, ttlHours: 168 });
const CHARS_PER_TOKEN = 3;
const MAX_ITEM_CHARS = 1200;
const MAX_ITEMS_PER_SECTION = 24;
const STABLE_KEYS = ['goal', 'constraints', 'decisions', 'architecture', 'acceptance'];
const DYNAMIC_KEYS = ['evidence', 'changes', 'tests', 'blockers', 'risks'];

export function normalizeContextOptimizerConfig(value = {}) {
  return {
    enabled: value.enabled !== false,
    budgetTokens: clampInt(value.budgetTokens, DEFAULT_CONTEXT_OPTIMIZER_CONFIG.budgetTokens, 2000, 32000),
    hotWindowMinutes: clampInt(value.hotWindowMinutes, DEFAULT_CONTEXT_OPTIMIZER_CONFIG.hotWindowMinutes, 5, 120),
    maxEntries: clampInt(value.maxEntries, DEFAULT_CONTEXT_OPTIMIZER_CONFIG.maxEntries, 4, 64),
    ttlHours: clampInt(value.ttlHours, DEFAULT_CONTEXT_OPTIMIZER_CONFIG.ttlHours, 24, 720),
  };
}

export function readContextOptimizerConfig() {
  return normalizeContextOptimizerConfig(readJsonObject(CONTEXT_OPTIMIZER_CONFIG_PATH, {}));
}

export function writeContextOptimizerConfig(next = {}) {
  const config = normalizeContextOptimizerConfig({ ...readContextOptimizerConfig(), ...next });
  writeJsonAtomic(CONTEXT_OPTIMIZER_CONFIG_PATH, config);
  return config;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.slice(0, MAX_ITEM_CHARS));
    if (out.length >= MAX_ITEMS_PER_SECTION) break;
  }
  return out;
}

function normalizeSections(value, keys) {
  const out = {};
  for (const key of keys) out[key] = normalizeList(value?.[key]);
  return out;
}

export function normalizeWorkerPacket(value = {}) {
  return {
    stable: normalizeSections(value.stable, STABLE_KEYS),
    dynamic: normalizeSections(value.dynamic, DYNAMIC_KEYS),
    classify: {
      keep: normalizeList(value.classify?.keep),
      stale: normalizeList(value.classify?.stale),
      wasted: normalizeList(value.classify?.wasted),
    },
  };
}

function sectionText(title, sections, keys) {
  const lines = [`[${title}]`];
  for (const key of keys) {
    lines.push(`${key.toUpperCase()}:`);
    const items = sections[key] || [];
    if (!items.length) lines.push('- none');
    else for (const item of items) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

export const renderStablePrefix = (stable) => sectionText('STABLE', stable, STABLE_KEYS);
export const renderDynamicTail = (dynamic) => sectionText('DYNAMIC', dynamic, DYNAMIC_KEYS);

function cloneSections(sections, keys) {
  return Object.fromEntries(keys.map((key) => [key, [...(sections[key] || [])]]));
}

export function fitPacketToBudget(stable, dynamic, budgetTokens) {
  const stableOut = cloneSections(stable, STABLE_KEYS);
  const dynamicOut = cloneSections(dynamic, DYNAMIC_KEYS);
  const maxChars = clampInt(budgetTokens, DEFAULT_CONTEXT_OPTIMIZER_CONFIG.budgetTokens, 2000, 32000) * CHARS_PER_TOKEN;
  const render = () => `${renderStablePrefix(stableOut)}\n${renderDynamicTail(dynamicOut)}`;
  const trimOrder = [
    ...DYNAMIC_KEYS.map((key) => ['dynamic', key]),
    ['stable', 'architecture'],
    ['stable', 'acceptance'],
    ['stable', 'constraints'],
    ['stable', 'decisions'],
    ['stable', 'goal'],
  ];
  let guard = 0;
  while (render().length > maxChars && guard++ < 500) {
    let removed = false;
    for (const [kind, key] of trimOrder) {
      const target = kind === 'dynamic' ? dynamicOut : stableOut;
      const min = kind === 'stable' && key === 'goal' ? 1 : 0;
      if (target[key].length > min) {
        target[key].pop();
        removed = true;
        break;
      }
    }
    if (!removed) break;
  }
  return { stable: stableOut, dynamic: dynamicOut, truncated: render().length > maxChars };
}

function extractText(result) {
  return result?.content?.filter((part) => part?.type === 'text').map((part) => part.text).join('\n').trim() || '';
}

function parseJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first < 0 || last <= first) continue;
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* try next shape */ }
  }
  throw new Error('context worker did not return a valid JSON packet');
}

function parseWorkerTokens(text) {
  const match = text.match(/\[xKiro [^\]]*?·\s*([\d,]+) tokens\s*·/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function stateKey(dir, taskKey) {
  return createHash('sha256').update(`${pathIdentity(dir)}\n${taskKey}`).digest('hex').slice(0, 24);
}

function readState() {
  const state = readJsonObject(CONTEXT_OPTIMIZER_STATE_PATH, { version: 1, entries: {} });
  return { version: 1, entries: state.entries && typeof state.entries === 'object' && !Array.isArray(state.entries) ? state.entries : {} };
}

function pruneState(state, config, now) {
  const ttlMs = config.ttlHours * 60 * 60 * 1000;
  const entries = Object.entries(state.entries)
    .filter(([, entry]) => Number(entry?.lastTouched || 0) > 0 && now - Number(entry.lastTouched) <= ttlMs)
    .sort((a, b) => Number(b[1].lastTouched) - Number(a[1].lastTouched))
    .slice(0, config.maxEntries);
  return { version: 1, entries: Object.fromEntries(entries) };
}

function previousItems(entry) {
  if (!entry) return [];
  const sections = [entry.stable, entry.dynamic];
  return sections.flatMap((section) => Object.values(section || {}).flatMap((items) => Array.isArray(items) ? items : []));
}

function staleInvalidatesStable(previous, candidate) {
  if (!previous?.stable) return false;
  const stale = new Set(normalizeWorkerPacket(candidate).classify.stale);
  if (!stale.size) return false;
  return STABLE_KEYS.some((key) => (previous.stable[key] || []).some((item) => stale.has(item)));
}

export function buildOptimizerWorkerPrompt({ prompt, previous, cold, budgetTokens }) {
  const prior = previous ? JSON.stringify({ stable: previous.stable, dynamic: previous.dynamic }) : 'null';
  const mode = cold ? 'COLD' : 'HOT';
  return `You are Aki's free context compressor. Read the repository only for evidence needed by the request. Never inspect or include secrets, credentials, tokens, .env files, private keys, or unrelated personal data. Return one strict JSON object only, no markdown and no prose outside JSON. Mode=${mode}. Target lead budget=${budgetTokens} tokens. JSON shape: {"stable":{"goal":[],"constraints":[],"decisions":[],"architecture":[],"acceptance":[]},"dynamic":{"evidence":[],"changes":[],"tests":[],"blockers":[],"risks":[]},"classify":{"keep":[],"stale":[],"wasted":[]}}. Each item must be one dense standalone sentence, include concrete paths/symbols when evidence-based, and never exceed 220 words. classify must use exact strings from PRIOR when possible: keep=still load-bearing, stale=contradicted/changed, wasted=dead detail or tool round-trip no longer needed. In HOT mode the stable object is advisory only because Aki will preserve the prior stable prefix byte-for-byte; put all new information in dynamic. In COLD mode rebuild stable from current truth and omit stale/wasted prior items. PRIOR=${prior}\nREQUEST=${prompt}`;
}

function providerFromResult(result) {
  const text = extractText(result);
  if (/\[xKiro\s/i.test(text)) return 'xKiro';
  if (/\[OpenCode Zen/i.test(text)) return 'OpenCode';
  return 'BudgetRouter';
}

async function defaultFreeWorker({ prompt, cwd }) {
  const result = await runBudgetedRead({ prompt, cwd, taskType: 'context_compress', freeOnly: true });
  if (result?.isError) throw new Error(extractText(result).split('\n')[0] || 'free context workers unavailable');
  return { provider: providerFromResult(result), result };
}

function durableContextForTask({ prompt, taskKey, cwd, cold, now }, { recoverCheckpoint = recoverTaskContext, graphStatus = getProjectGraphStatus, graphSync = syncProjectGraph, graphQuery = runGraphQuery } = {}) {
  const parts = [];
  const recovered = recoverCheckpoint({ taskKey, cwd });
  if (recovered.recovered && recovered.contextText) parts.push(recovered.contextText);
  try {
    const status = graphStatus(cwd).currentProject;
    const stale = !status || now - Number(status.lastIndexed || 0) > 60 * 60 * 1000;
    if (cold && stale) graphSync({ cwd });
    const graph = graphQuery({ query: prompt, cwd, limit: 8 });
    if (!graph?.isError) {
      const text = extractText(graph);
      if (text && text !== '[]') parts.push(`[AKI_PROJECT_GRAPH]\n${text}`);
    }
  } catch { /* durable context is optional; free retrieval still proceeds */ }
  return parts.join('\n\n');
}

function packetText(stable, dynamic) {
  return `${renderStablePrefix(stable)}\n${renderDynamicTail(dynamic)}`;
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

function fitDynamicToLockedPrefix(stableText, dynamic, budgetTokens) {
  const dynamicOut = cloneSections(dynamic, DYNAMIC_KEYS);
  const maxChars = clampInt(budgetTokens, DEFAULT_CONTEXT_OPTIMIZER_CONFIG.budgetTokens, 2000, 32000) * CHARS_PER_TOKEN;
  let guard = 0;
  while (`${stableText}\n${renderDynamicTail(dynamicOut)}`.length > maxChars && guard++ < 500) {
    let removed = false;
    for (const key of DYNAMIC_KEYS) {
      if (dynamicOut[key].length) {
        dynamicOut[key].pop();
        removed = true;
        break;
      }
    }
    if (!removed) break;
  }
  return { dynamic: dynamicOut, truncated: `${stableText}\n${renderDynamicTail(dynamicOut)}`.length > maxChars };
}

export function applyWorkerPacket({ previous, candidate, cold, budgetTokens, workerText, sourceContextText = '', provider, now, taskKey, dir, config }) {
  const normalized = normalizeWorkerPacket(candidate);
  let stable;
  let dynamic;
  let stableText;
  let truncated;
  if (!cold && previous?.stableText) {
    stable = previous.stable;
    stableText = previous.stableText;
    const fittedDynamic = fitDynamicToLockedPrefix(stableText, normalized.dynamic, budgetTokens);
    dynamic = fittedDynamic.dynamic;
    truncated = fittedDynamic.truncated;
  } else {
    const fitted = fitPacketToBudget(normalized.stable, normalized.dynamic, budgetTokens);
    stable = fitted.stable;
    dynamic = fitted.dynamic;
    stableText = renderStablePrefix(stable);
    truncated = fitted.truncated;
  }
  const dynamicText = renderDynamicTail(dynamic);
  const rendered = `${stableText}\n${dynamicText}`;
  const workerTokens = parseWorkerTokens(workerText);
  const packetTokens = estimateTokens(rendered);
  const sourceTokens = estimateTokens(sourceContextText);
  const savedTokens = Math.max(0, sourceTokens - packetTokens);
  const savedPct = sourceTokens > 0 ? Math.round((savedTokens / sourceTokens) * 1000) / 10 : 0;
  const stats = {
    sourceTokensEstimated: sourceTokens,
    sourceUsageAuthoritative: false,
    workerProviderTokens: workerTokens,
    packetTokensEstimated: packetTokens,
    savedTokensEstimated: savedTokens,
    savedPctEstimated: savedPct,
    keepCount: normalized.classify.keep.length,
    staleCount: normalized.classify.stale.length,
    wastedCount: normalized.classify.wasted.length,
    stableReused: !cold && Boolean(previous?.stableText),
    coldBoundary: cold,
    provider,
    truncated,
  };
  return {
    taskKey,
    cwd: dir,
    stable,
    dynamic,
    stableText,
    dynamicText,
    priorItems: previousItems(previous).slice(0, 100),
    classifications: normalized.classify,
    stats,
    lastTouched: now,
    hotUntil: now + config.hotWindowMinutes * 60 * 1000,
  };
}

export async function runContextPacket(
  { prompt, cwd, taskKey = 'default', forceCold = false, budgetTokens },
  { worker = defaultFreeWorker, now = Date.now, config: configOverride, loadState = readState, saveState = (state) => writeJsonAtomic(CONTEXT_OPTIMIZER_STATE_PATH, state), recoverCheckpoint = recoverTaskContext, graphStatus = getProjectGraphStatus, graphSync = syncProjectGraph, graphQuery = runGraphQuery, checkpointSave = saveTaskCheckpoint, recordSavings = recordContextSavings } = {},
) {
  const config = normalizeContextOptimizerConfig(configOverride ?? readContextOptimizerConfig());
  if (!config.enabled) return err('Aki Context Optimizer is disabled in the local panel');
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) return err(`rejected: ${resolved.error.message}`);
  const dir = resolved.dir;
  const task = String(taskKey || 'default').trim().slice(0, 120) || 'default';
  const budget = clampInt(budgetTokens, config.budgetTokens, 2000, 32000);
  const currentTime = Number(now());
  let state = pruneState(loadState(), config, currentTime);
  const key = stateKey(dir, task);
  const previous = state.entries[key] || null;
  let cold = Boolean(forceCold || !previous || currentTime >= Number(previous.hotUntil || 0));
  const durable = task !== 'default' ? durableContextForTask({ prompt, taskKey: task, cwd: dir, cold, now: currentTime }, { recoverCheckpoint, graphStatus, graphSync, graphQuery }) : '';
  const request = durable ? `${durable}\n\n[CURRENT_REQUEST]\n${prompt}` : prompt;
  const workerPrompt = buildOptimizerWorkerPrompt({ prompt: request, previous, cold, budgetTokens: budget });
  try {
    let workerRun = await worker({ prompt: workerPrompt, cwd: dir, previous, cold, budgetTokens: budget });
    let workerText = extractText(workerRun.result);
    let candidate = parseJsonObject(workerText);
    if (!cold && staleInvalidatesStable(previous, candidate)) {
      cold = true;
      const rebuildPrompt = buildOptimizerWorkerPrompt({ prompt: request, previous, cold: true, budgetTokens: budget });
      workerRun = await worker({ prompt: rebuildPrompt, cwd: dir, previous, cold: true, budgetTokens: budget });
      workerText = extractText(workerRun.result);
      candidate = parseJsonObject(workerText);
    }
    const provider = workerRun.provider;
    const entry = applyWorkerPacket({ previous, candidate, cold, budgetTokens: budget, workerText, sourceContextText: request, provider, now: currentTime, taskKey: task, dir, config });
    state.entries[key] = entry;
    state = pruneState(state, config, currentTime);
    saveState(state);
    if (task !== 'default') {
      checkpointSave({
        taskKey: task,
        cwd: dir,
        status: 'active',
        activeStep: entry.dynamic.changes[0] || '',
        pendingSteps: entry.stable.acceptance,
        blockers: entry.dynamic.blockers,
        context: { stable: entry.stable, dynamic: entry.dynamic },
      });
    }
    recordSavings({ provider, costClass: 'free', taskType: 'context_compress', estimatedInputTokens: entry.stats.packetTokensEstimated, estimatedLeadContextAvoided: entry.stats.savedTokensEstimated });
    const mode = cold ? 'COLD' : 'HOT';
    const prefix = entry.stats.stableReused ? 'stable reused' : 'stable rebuilt';
    const savings = `${entry.stats.savedTokensEstimated.toLocaleString()} est tokens (${entry.stats.savedPctEstimated}%)`;
    return ok(`[Aki Context ${mode} · ${prefix} · ${provider} · saved ${savings}]\n${entry.stableText}\n${entry.dynamicText}`);
  } catch (e) {
    return err(e.message);
  }
}

export function getContextOptimizerStatus() {
  const config = readContextOptimizerConfig();
  const now = Date.now();
  const state = pruneState(readState(), config, now);
  const entries = Object.values(state.entries).sort((a, b) => Number(b.lastTouched) - Number(a.lastTouched));
  const last = entries[0] || null;
  const totals = entries.reduce((acc, entry) => {
    acc.savedTokensEstimated += Number(entry.stats?.savedTokensEstimated || 0);
    acc.packetTokensEstimated += Number(entry.stats?.packetTokensEstimated || 0);
    acc.sourceTokensEstimated += Number(entry.stats?.sourceTokensEstimated || 0);
    acc.coldBoundaries += entry.stats?.coldBoundary ? 1 : 0;
    acc.stableReused += entry.stats?.stableReused ? 1 : 0;
    return acc;
  }, { savedTokensEstimated: 0, packetTokensEstimated: 0, sourceTokensEstimated: 0, coldBoundaries: 0, stableReused: 0 });
  return {
    ...config,
    entries: entries.length,
    totals,
    last: last ? {
      taskKey: last.taskKey,
      cwd: last.cwd,
      lastTouched: last.lastTouched,
      hotUntil: last.hotUntil,
      stats: last.stats,
      counts: {
        stable: STABLE_KEYS.reduce((n, key) => n + (last.stable?.[key]?.length || 0), 0),
        dynamic: DYNAMIC_KEYS.reduce((n, key) => n + (last.dynamic?.[key]?.length || 0), 0),
      },
    } : null,
  };
}

export function register(server) {
  server.registerTool(
    'context_packet',
    {
      title: 'Aki Context Optimizer',
      description: 'Use before expensive lead/Astra reasoning on a multi-step repo task. Aki delegates raw retrieval/compression to free workers, stores compact optimizer/checkpoint state under ~/.aki/mcpsv, and preserves the stable prefix only while it remains uncontradicted. taskKey should be the shared plan/task id so follow-ups reuse the same packet. Does not control ChatGPT/Work provider caching.',
      inputSchema: {
        prompt: z.string().min(1),
        cwd: z.string().describe('absolute project/repo root under an allowed Aki folder'),
        taskKey: z.string().max(120).optional().default('default').describe('shared plan/task id; reuse it across follow-ups'),
        forceCold: z.boolean().optional().default(false).describe('rebuild the stable prefix now instead of preserving the current hot prefix'),
        budgetTokens: z.number().int().min(2000).max(32000).optional().describe('lead packet budget; defaults to panel config'),
      },
    },
    runContextPacket,
  );
  server.registerTool(
    'context_optimizer_status',
    {
      title: 'Aki Context Optimizer Status',
      description: 'Report local context-optimizer configuration and estimated savings statistics. Estimates describe Aki packet compression, not guaranteed ChatGPT/Work provider cache hits.',
      inputSchema: {},
    },
    async () => ok(JSON.stringify(getContextOptimizerStatus(), null, 2)),
  );
}
