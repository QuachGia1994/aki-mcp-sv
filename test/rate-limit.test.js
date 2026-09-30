#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// userdata.js reads AKI_MCP_DATA_DIR at import, so the env is set before the gatekeeper loads; the real ~/.aki/mcpsv is never touched.
const dir = mkdtempSync(path.join(os.tmpdir(), 'aki-ratelimit-test-'));
process.env.AKI_MCP_DATA_DIR = dir;
process.env.GATEKEEPER_PORT = String(39000 + Math.floor(Math.random() * 900));
const goodToken = 'a'.repeat(64);
writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ access: { [goodToken]: { expires: Date.now() + 3600_000 } }, refresh: {} }));

const { createLimiter, clientKey } = await import('../scripts/rate-limit.js');
const { startGatekeeper } = await import('../scripts/gatekeeper.js');

let clock = 0;
const limiter = createLimiter({ max: 3, windowMs: 1000, now: () => clock });
assert.equal(limiter.retryAfterSeconds('k'), 0);
assert.equal(limiter.record('k'), false);
assert.equal(limiter.record('k'), false);
assert.equal(limiter.record('k'), true);
assert.equal(limiter.retryAfterSeconds('k'), 1);
assert.equal(limiter.retryAfterSeconds('other'), 0);
clock = 1001;
assert.equal(limiter.retryAfterSeconds('k'), 0);

const fake = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
assert.equal(clientKey(fake('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' })), '203.0.113.9');
assert.equal(clientKey(fake('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
assert.equal(clientKey(fake('::1', { 'x-forwarded-for': 'spoofed, 198.51.100.8' })), '198.51.100.8');
assert.equal(clientKey(fake('::ffff:127.0.0.1')), 'loopback');

const server = startGatekeeper(null);
await new Promise((resolve) => server.once('listening', resolve));
const call = (pathname, headers) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: process.env.GATEKEEPER_PORT, path: pathname, headers }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] }));
  }).on('error', reject);
});

for (let i = 0; i < 10; i++) assert.equal((await call('/nope', { 'x-forwarded-for': '198.51.100.1' })).status, 404);
const blocked = await call('/nope', { 'x-forwarded-for': '198.51.100.1' });
assert.equal(blocked.status, 429);
assert.ok(Number(blocked.retryAfter) > 0);
assert.equal((await call('/nope', { 'x-forwarded-for': '198.51.100.2' })).status, 404, 'another caller is not affected');

for (let i = 0; i < 10; i++) assert.equal((await call('/mcp', { 'x-forwarded-for': '198.51.100.3', authorization: 'Bearer wrong' })).status, 401);
assert.equal((await call('/mcp', { 'x-forwarded-for': '198.51.100.3', authorization: 'Bearer wrong' })).status, 429);
assert.equal((await call('/mcp', { 'x-forwarded-for': '198.51.100.3', authorization: 'Bearer ' + goodToken })).status, 405, 'valid credentials are never refused');

server.close();

process.env.GATEKEEPER_PORT = String(Number(process.env.GATEKEEPER_PORT) + 1);
const withIngress = startGatekeeper('https://example.ts.net');
await new Promise((resolve) => withIngress.once('listening', resolve));
const register = (forwardedFor) => fetch(`http://127.0.0.1:${process.env.GATEKEEPER_PORT}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
  body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }),
}).then((res) => res.status);
for (let i = 0; i < 20; i++) assert.equal(await register('198.51.100.4'), 201);
assert.equal(await register('198.51.100.4'), 429, 'a caller registering in bulk is refused');
assert.equal(await register('198.51.100.5'), 201, 'another caller can still register');
withIngress.close();
rmSync(dir, { recursive: true, force: true });
console.log('rate-limit.test.js: ok');
process.exit(0);
