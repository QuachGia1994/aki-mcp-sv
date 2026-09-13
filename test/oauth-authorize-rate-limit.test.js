#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationSource, createAuthorizeFailureLimiter } from '../scripts/oauth.js';

function request(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

test('authorization source trusts forwarded client IP only from a loopback ingress peer', () => {
  assert.equal(authorizationSource(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.10' })), '203.0.113.10');
  assert.equal(authorizationSource(request('::1', { 'x-forwarded-for': '198.51.100.7, 127.0.0.1' })), '198.51.100.7');
  assert.equal(authorizationSource(request('198.51.100.22', { 'x-forwarded-for': '203.0.113.99' })), '198.51.100.22');
});

test('authorize cooldown follows the real source across client ids and expires without global lockout', () => {
  let current = 10_000;
  const limiter = createAuthorizeFailureLimiter({ maxFailures: 3, windowMs: 1_000, cooldownMs: 5_000, now: () => current });
  const sourceAClientA = limiter.key(request('127.0.0.1', { 'x-forwarded-for': '198.51.100.10' }), 'client-a');
  const sourceAClientB = limiter.key(request('127.0.0.1', { 'x-forwarded-for': '198.51.100.10' }), 'client-b');
  const sourceBClientA = limiter.key(request('127.0.0.1', { 'x-forwarded-for': '198.51.100.11' }), 'client-a');

  assert.equal(sourceAClientB, sourceAClientA);
  assert.equal(limiter.check(sourceAClientA).allowed, true);
  assert.equal(limiter.failure(sourceAClientA).blocked, false);
  assert.equal(limiter.failure(sourceAClientA).blocked, false);
  assert.equal(limiter.failure(sourceAClientA).blocked, true);
  assert.equal(limiter.check(sourceAClientB).allowed, false);
  assert.equal(limiter.check(sourceBClientA).allowed, true);

  current += 5_001;
  assert.equal(limiter.check(sourceAClientA).allowed, true);
});

test('loopback fallback isolates clients when no proxy provides a real source address', () => {
  const limiter = createAuthorizeFailureLimiter();
  assert.notEqual(limiter.key(request('127.0.0.1'), 'client-a'), limiter.key(request('127.0.0.1'), 'client-b'));
});

test('successful authorization clears failures for only that source/client key', () => {
  const limiter = createAuthorizeFailureLimiter({ maxFailures: 2, windowMs: 10_000, cooldownMs: 10_000, now: () => 5_000 });
  const keyA = limiter.key(request('203.0.113.1'), 'client-a');
  const keyB = limiter.key(request('203.0.113.2'), 'client-a');

  limiter.failure(keyA);
  limiter.failure(keyB);
  limiter.success(keyA);

  assert.equal(limiter.failure(keyA).blocked, false);
  assert.equal(limiter.failure(keyB).blocked, true);
});
