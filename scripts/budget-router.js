import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { USER_DIR } from './userdata.js';
import { resolveOrFail } from './roots.js';
import { readJsonObject, writeJsonAtomic } from './user-state.js';
import { getXKiroUsage, runXKiroRead } from './xkiro-mcp.js';
import { getOpenCodeStatus, runOpenCodeRead } from './opencode-mcp.js';
import { buildAgyArgs, resolveAgyExecutable, runAgy } from './agy-mcp.js';
import { resolveKiroExecutable, runKiroRead } from './kiro-mcp.js';
import { ok, err } from './mcp-tool.js';
import { observeProviderResult, quotaAvailability, readProviderStatuses } from './quota-status.js';

export const COST_LEDGER_PATH = path.join(USER_DIR, 'cost-ledger.json');
export const DEFAULT_BUDGET_ROUTER_CONFIG = Object.freeze({ cooldownMs: 60_000, maxLedgerEntries: 1000, ttlDays: 30 });
const AGY_MODEL = 'gemini-3.7-flash-high';
const KIRO_MODEL = 'claude-sonnet-4.5';
const unhealthyUntil = new Map();
let statusCache = { at: 0, value: null };
const STATUS_CACHE_MS = 30_000;

function textOf(result) {
  return result?.content?.find((item) => item.type === 'text')?.text || '';
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3);
}

function actualTokensFromResult(result) {
  const match = textOf(result).match(/\[xKiro [^\]]*?·\s*([\d,]+) tokens\s*·/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function executableObservable(executable) {
  if (path.isAbsolute(executable)) return existsSync(executable);
  return null;
}

function scopePrompt(prompt, cwd) {
  return `[AKI_SCOPE]\nAllowed root: ${cwd}\nUse only files physically under this absolute root. Resolve relative paths against it and ignore similarly named files elsewhere.\n[REQUEST]\n${prompt}`;
}

function normalizeLedgerEntry(value) {
  return {
    at: Number(value.at || Date.now()),
    kind: value.kind === 'context' ? 'context' : 'worker',
    provider: String(value.provider || 'unknown').slice(0, 80),
    model: String(value.model || '').slice(0, 160),
    costClass: ['free', 'quota', 'unknown'].includes(value.costClass) ? value.costClass : 'unknown',
    taskType: String(value.taskType || '').slice(0, 80),
    success: value.success !== false,
    durationMs: Number(value.durationMs || 0),
    actualProviderTokens: Number.isFinite(Number(value.actualProviderTokens)) ? Number(value.actualProviderTokens) : null,
    estimatedInputTokens: Number.isFinite(Number(value.estimatedInputTokens)) ? Number(value.estimatedInputTokens) : null,
    estimatedLeadContextAvoided: Number.isFinite(Number(value.estimatedLeadContextAvoided)) ? Number(value.estimatedLeadContextAvoided) : null,
    providerCacheHits: Number.isFinite(Number(value.providerCacheHits)) ? Number(value.providerCacheHits) : null,
    error: value.error ? String(value.error).slice(0, 500) : '',
  };
}

export function readCostLedger({ now = Date.now() } = {}) {
  const raw = readJsonObject(COST_LEDGER_PATH, { version: 1, entries: [] });
  const cutoff = now - DEFAULT_BUDGET_ROUTER_CONFIG.ttlDays * 24 * 60 * 60 * 1000;
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(normalizeLedgerEntry)
    .filter((entry) => entry.at >= cutoff)
    .sort((a, b) => b.at - a.at)
    .slice(0, DEFAULT_BUDGET_ROUTER_CONFIG.maxLedgerEntries);
  const totals = entries.reduce((acc, entry) => {
    acc.calls += entry.kind === 'worker' ? 1 : 0;
    acc.successes += entry.kind === 'worker' && entry.success ? 1 : 0;
    acc.failures += entry.kind === 'worker' && !entry.success ? 1 : 0;
    if (entry.actualProviderTokens !== null) acc.actualProviderTokens += entry.actualProviderTokens;
    if (entry.estimatedInputTokens !== null) acc.estimatedInputTokens += entry.estimatedInputTokens;
    if (entry.estimatedLeadContextAvoided !== null) acc.estimatedLeadContextAvoided += entry.estimatedLeadContextAvoided;
    if (entry.providerCacheHits !== null) acc.providerCacheHits += entry.providerCacheHits;
    return acc;
  }, { calls: 0, successes: 0, failures: 0, actualProviderTokens: 0, estimatedInputTokens: 0, estimatedLeadContextAvoided: 0, providerCacheHits: 0 });
  return { version: 1, entries, totals };
}

export function recordWorkerUsage(entry, { load = readCostLedger, save = (state) => writeJsonAtomic(COST_LEDGER_PATH, state) } = {}) {
  const state = load();
  state.entries.unshift(normalizeLedgerEntry({ ...entry, kind: 'worker', at: entry.at || Date.now() }));
  save({ version: 1, entries: state.entries.slice(0, DEFAULT_BUDGET_ROUTER_CONFIG.maxLedgerEntries) });
}

export function recordContextSavings(entry, { load = readCostLedger, save = (state) => writeJsonAtomic(COST_LEDGER_PATH, state) } = {}) {
  const state = load();
  state.entries.unshift(normalizeLedgerEntry({ ...entry, kind: 'context', at: entry.at || Date.now(), success: true }));
  save({ version: 1, entries: state.entries.slice(0, DEFAULT_BUDGET_ROUTER_CONFIG.maxLedgerEntries) });
}

export async function getWorkerHealthMatrix({ refresh = false, now = Date.now } = {}) {
  if (!refresh && statusCache.value && now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  const [xkiro, opencode] = await Promise.all([getXKiroUsage().catch((error) => ({ configured: false, error: error.message })), getOpenCodeStatus().catch((error) => ({ configured: false, error: error.message }))]);
  const observed = readProviderStatuses({ now: now() });
  const agyQuota = quotaAvailability(observed.providers.agy, { now: now() });
  const kiroQuota = quotaAvailability(observed.providers.kiro, { now: now() });
  const xRemaining = xkiro?.usage?.free_tokens?.remaining;
  const agyExecutable = resolveAgyExecutable();
  const kiroExecutable = resolveKiroExecutable();
  const matrix = {
    xkiro: {
      available: xkiro.configured === true && !xkiro.error && (xRemaining === undefined || xRemaining === null || Number(xRemaining) > 0),
      costClass: 'free', model: xkiro.effectiveModel || xkiro.model || '', freeRemaining: xRemaining ?? null,
      reason: xkiro.error || (xkiro.configured ? (Number(xRemaining) <= 0 ? 'free quota exhausted' : '') : 'not configured'),
    },
    opencode: {
      available: opencode.configured === true && Array.isArray(opencode.freeModels) && opencode.freeModels.length > 0,
      costClass: 'free', model: opencode.effectiveModel || '', reason: opencode.error || (opencode.configured ? '' : 'not authenticated'),
    },
    agy: { available: executableObservable(agyExecutable) !== false && !agyQuota.blocked, costClass: 'quota', model: AGY_MODEL, executable: agyExecutable, quota: agyQuota.quota, reason: executableObservable(agyExecutable) === false ? 'executable missing' : agyQuota.blocked ? 'quota exhausted' : '' },
    kiro: { available: executableObservable(kiroExecutable) !== false && !kiroQuota.blocked, costClass: 'quota', model: KIRO_MODEL, executable: kiroExecutable, quota: kiroQuota.quota, reason: executableObservable(kiroExecutable) === false ? 'executable missing' : kiroQuota.blocked ? 'quota exhausted' : '' },
  };
  for (const [name, info] of Object.entries(matrix)) {
    const cooldownUntil = unhealthyUntil.get(name) || 0;
    if (cooldownUntil > now()) {
      info.available = false;
      info.cooldownUntil = cooldownUntil;
      info.reason = 'cooldown after recent failure';
    }
  }
  statusCache = { at: now(), value: matrix };
  return matrix;
}

export async function rankReadWorkers({ prompt, cwd, taskType = 'deep_retrieval', freeOnly = false, refresh = false, healthOverride } = {}) {
  const health = healthOverride || await getWorkerHealthMatrix({ refresh });
  const scoped = scopePrompt(prompt, cwd);
  const candidates = [
    { name: 'xkiro', provider: 'xKiro', model: health.xkiro.model, costClass: 'free', score: 0, available: health.xkiro.available, invoke: () => runXKiroRead({ prompt: scoped, cwd, reasoning: 'none' }) },
    { name: 'opencode', provider: 'OpenCode Zen', model: health.opencode.model, costClass: 'free', score: 10, available: health.opencode.available, invoke: () => runOpenCodeRead({ prompt: scoped, cwd }) },
    { name: 'agy', provider: 'Antigravity', model: AGY_MODEL, costClass: 'quota', score: 20, available: health.agy.available, invoke: () => runAgy(buildAgyArgs({ prompt: scoped, mode: 'plan', model: AGY_MODEL, effort: 'low', outputFormat: 'text' }), cwd) },
    { name: 'kiro', provider: 'Kiro', model: KIRO_MODEL, costClass: 'quota', score: 30, available: health.kiro.available, invoke: () => runKiroRead({ prompt: scoped, effort: 'low', cwd }) },
  ];
  return candidates.filter((candidate) => candidate.available && (!freeOnly || candidate.costClass === 'free')).sort((a, b) => a.score - b.score);
}

export async function runBudgetedRead({ prompt, cwd, taskType = 'deep_retrieval', freeOnly = false }, { ranker = rankReadWorkers, recorder = recordWorkerUsage, now = Date.now } = {}) {
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) return err(`rejected: ${resolved.error.message}`);
  const dir = resolved.dir;
  const candidates = await ranker({ prompt, cwd: dir, taskType, freeOnly });
  if (!candidates.length) return err(`no ${freeOnly ? 'free ' : ''}read worker is currently eligible`);
  const failures = [];
  for (const candidate of candidates) {
    const started = now();
    let result;
    try { result = await candidate.invoke(); } catch (error) { result = err(error.message || String(error)); }
    const durationMs = Math.max(0, now() - started);
    const success = !result?.isError;
    const errorText = success ? '' : textOf(result).trim().split('\n')[0];
    if (!success && candidate.name === 'agy') observeProviderResult('agy', result, { now: now() });
    if (!success && candidate.name === 'kiro') observeProviderResult('kiro', result, { now: now() });
    recorder({ provider: candidate.provider, model: candidate.model, costClass: candidate.costClass, taskType, success, durationMs, actualProviderTokens: actualTokensFromResult(result), estimatedInputTokens: estimateTokens(prompt), error: errorText });
    if (success) {
      unhealthyUntil.delete(candidate.name);
      return result;
    }
    failures.push(`${candidate.name}: ${errorText || 'failed'}`);
    unhealthyUntil.set(candidate.name, now() + DEFAULT_BUDGET_ROUTER_CONFIG.cooldownMs);
    statusCache = { at: 0, value: null };
  }
  return err(`all eligible read workers failed — ${failures.join(' | ')}`);
}

export async function getBudgetRouterStatus({ refresh = false } = {}) {
  const ledger = readCostLedger();
  return { health: await getWorkerHealthMatrix({ refresh }), quotaProviders: readProviderStatuses().providers, totals: ledger.totals, recent: ledger.entries.slice(0, 20) };
}

export function register(server) {
  server.registerTool('budget_router_read', {
    title: 'Aki Budget Router Read',
    description: 'Run one scoped read-only task through the cheapest healthy eligible worker. Free xKiro/OpenCode are preferred; quota workers are fallback. Routing uses observable health/quota only and records a local cost/token ledger without prompts or secrets.',
    inputSchema: { prompt: z.string().min(1), cwd: z.string(), taskType: z.enum(['fast_scan', 'broad_retrieval', 'deep_retrieval', 'context_compress']).optional().default('deep_retrieval'), freeOnly: z.boolean().optional().default(false) },
  }, runBudgetedRead);
  server.registerTool('budget_router_status', { title: 'Aki Budget Router Status', description: 'Report observable worker health/free quota and the local token/context ledger. Actual provider tokens, estimates, and cache hits remain separate metrics.', inputSchema: { refresh: z.boolean().optional().default(false) } }, async ({ refresh }) => ok(JSON.stringify(await getBudgetRouterStatus({ refresh }), null, 2)));
}
