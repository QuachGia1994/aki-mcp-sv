import path from 'node:path';
import { USER_DIR } from './userdata.js';
import { readJsonObject, writeJsonAtomic } from './user-state.js';

export const PROVIDER_STATUS_PATH = path.join(USER_DIR, 'provider-status.json');

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseResetDuration(text, now) {
  const match = String(text || '').match(/resets?\s+in\s+(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?/i);
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const durationMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
  return durationMs > 0 ? now + durationMs : null;
}

export function normalizeQuotaStatus(value, { now = Date.now() } = {}) {
  if (!value || typeof value !== 'object') return null;
  const resetAt = asFiniteNumber(value.resetAt ?? value.reset_at ?? value.resetsAt ?? value.resets_at);
  const remaining = asFiniteNumber(value.remaining ?? value.remainingTokens ?? value.remaining_tokens ?? value.remainingPercent ?? value.remaining_percent);
  const limit = asFiniteNumber(value.limit ?? value.limitTokens ?? value.limit_tokens);
  const exhausted = value.exhausted === true || value.state === 'exhausted' || (remaining !== null && remaining <= 0);
  const expired = resetAt !== null && resetAt <= now;
  return {
    state: expired ? 'unknown' : exhausted ? 'exhausted' : value.state === 'available' ? 'available' : 'unknown',
    remaining: expired ? null : remaining,
    limit: expired ? null : limit,
    resetAt: expired ? null : resetAt,
    source: String(value.source || 'observed').slice(0, 80),
    observedAt: asFiniteNumber(value.observedAt ?? value.observed_at) ?? now,
    detail: String(value.detail || value.reason || '').slice(0, 500),
  };
}

export function parseProviderQuotaText(text, { now = Date.now() } = {}) {
  const raw = String(text || '');
  if (!/(resource_exhausted|quota\s+(?:is\s+)?(?:reached|exhausted)|individual quota reached|rate.?limit)/i.test(raw)) return null;
  return normalizeQuotaStatus({ state: 'exhausted', resetAt: parseResetDuration(raw, now), source: 'provider-output', observedAt: now, detail: raw.trim().split('\n').find((line) => /(resource_exhausted|quota|rate.?limit)/i.test(line)) || 'quota exhausted' }, { now });
}

export function readProviderStatuses({ now = Date.now(), externalPath = process.env.AKI_PROVIDER_STATUS_FILE || '' } = {}) {
  const raw = readJsonObject(PROVIDER_STATUS_PATH, { version: 1, providers: {} });
  const external = externalPath ? readJsonObject(externalPath, { version: 1, providers: {} }) : { providers: {} };
  const providers = {};
  for (const [name, value] of Object.entries({ ...(raw.providers || {}), ...(external.providers || {}) })) {
    const normalized = normalizeQuotaStatus(value, { now });
    if (normalized) providers[name] = normalized;
  }
  return { version: 1, providers };
}

export function recordProviderStatus(provider, status, { now = Date.now(), load = readProviderStatuses, save = (state) => writeJsonAtomic(PROVIDER_STATUS_PATH, state) } = {}) {
  const name = String(provider || '').trim().toLowerCase();
  if (!name) return null;
  const normalized = normalizeQuotaStatus(status, { now });
  if (!normalized) return null;
  const state = load({ now });
  state.providers[name] = normalized;
  save({ version: 1, providers: state.providers });
  return normalized;
}

export function observeProviderResult(provider, result, { now = Date.now() } = {}) {
  const text = result?.content?.find((item) => item.type === 'text')?.text || '';
  const quota = parseProviderQuotaText(text, { now });
  return quota ? recordProviderStatus(provider, quota, { now }) : null;
}

export function quotaAvailability(status, { now = Date.now() } = {}) {
  const quota = normalizeQuotaStatus(status, { now });
  if (!quota) return { blocked: false, quota: null };
  return { blocked: quota.state === 'exhausted' && (quota.resetAt === null || quota.resetAt > now), quota };
}
