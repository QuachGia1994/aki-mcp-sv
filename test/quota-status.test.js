import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuotaStatus, parseProviderQuotaText, quotaAvailability, recordProviderStatus } from '../scripts/quota-status.js';

test('quota parser records real exhausted signal and reset duration without inventing percentages', () => {
  const now = 1_000_000;
  const status = parseProviderQuotaText('RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h 30m', { now });
  assert.equal(status.state, 'exhausted');
  assert.equal(status.resetAt, now + 150 * 60_000);
  assert.equal(status.remaining, null);
  assert.equal(status.source, 'provider-output');
});

test('expired quota block becomes unknown and eligible again', () => {
  const now = 10_000;
  const normalized = normalizeQuotaStatus({ state: 'exhausted', resetAt: 9_000, remaining: 0, source: 'test' }, { now });
  assert.equal(normalized.state, 'unknown');
  assert.equal(normalized.resetAt, null);
  assert.equal(quotaAvailability(normalized, { now }).blocked, false);
});

test('quota exhaustion without a reset gets only a bounded cooldown instead of a permanent ban', () => {
  const status = normalizeQuotaStatus({ state: 'exhausted', observedAt: 1_000, source: 'provider-output' }, { now: 1_000 });
  assert.equal(quotaAvailability(status, { now: 1_000 + 60_000 }).blocked, true);
  assert.equal(quotaAvailability(status, { now: 1_000 + 6 * 60_000 }).blocked, false);
});

test('provider status storage stays generic for future Antigravity LS or Claude rate_limits collectors', () => {
  let state = { version: 1, providers: {} };
  const load = () => ({ version: 1, providers: { ...state.providers } });
  const save = (next) => { state = next; };
  const saved = recordProviderStatus('claude', { state: 'available', remaining: 42, limit: 100, resetAt: 50_000, source: 'rate_limits' }, { now: 10_000, load, save });
  assert.equal(saved.state, 'available');
  assert.equal(state.providers.claude.remaining, 42);
  assert.equal(state.providers.claude.source, 'rate_limits');
});
