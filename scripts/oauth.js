#!/usr/bin/env node
// Minimal OAuth 2.1 authorization server, DCR skipped via pre-registered client — rationale: docs/ref/security-model.md
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CLIENT_PATH as CLIENT_FILE, PASSPHRASE_PATH as PASSPHRASE_FILE, TOKENS_PATH as TOKENS_FILE } from './userdata.js';

const CALLBACK_URI = 'https://claude.ai/api/mcp/auth_callback';
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 365 * 24 * 3600;
// no 0/o/1/l/i — avoid visual ambiguity when typing; 32 chars = power of 2, unbiased byte%32
const PASSPHRASE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASSPHRASE_LENGTH = 10; // 32^10 = 2^50 — brute-force still infeasible over network

const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

// Tokens survive restarts: the connector is a long-lived file-access grant, and losing it on every
// `npm start` forces a full re-authorize (passphrase) instead of the silent refresh the flow supports.
function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
    for (const [token, entry] of Object.entries(saved.access ?? {})) accessTokens.set(token, entry);
    for (const [token, entry] of Object.entries(saved.refresh ?? {})) refreshTokens.set(token, entry);
  } catch (e) {
    console.error(`[oauth] bỏ qua ${TOKENS_FILE} không đọc được (${e.message}) — sẽ cần authorize lại`);
  }
}

function saveTokens() {
  const now = Date.now();
  for (const [token, entry] of accessTokens) if (entry.expires < now) accessTokens.delete(token);
  const body = { access: Object.fromEntries(accessTokens), refresh: Object.fromEntries(refreshTokens) };
  writeFileSync(TOKENS_FILE, JSON.stringify(body), { mode: 0o600 });
}

loadTokens();

export function loadOrCreateClient() {
  if (existsSync(CLIENT_FILE)) return JSON.parse(readFileSync(CLIENT_FILE, 'utf8'));
  const creds = { clientId: randomBytes(16).toString('hex'), clientSecret: randomBytes(32).toString('hex') };
  writeFileSync(CLIENT_FILE, JSON.stringify(creds), { mode: 0o600 });
  return creds;
}

export function loadOrCreatePassphrase() {
  if (existsSync(PASSPHRASE_FILE)) return readFileSync(PASSPHRASE_FILE, 'utf8').trim();
  const bytes = randomBytes(PASSPHRASE_LENGTH);
  const p = Array.from(bytes, (b) => PASSPHRASE_ALPHABET[b % PASSPHRASE_ALPHABET.length]).join('');
  writeFileSync(PASSPHRASE_FILE, p, { mode: 0o600 });
  return p;
}

function safeEqual(a, b) {
  const ab = Buffer.from(a ?? '');
  const bb = Buffer.from(b ?? '');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function metadataHandlers(origin) {
  return {
    protectedResource(req, res) {
      json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    },
    authorizationServer(req, res) {
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        authorization_response_iss_parameter_supported: true,
      });
    },
  };
}

export async function handleAuthorize(req, res, client, passphrase, origin) {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://internal');
  const q = req.method === 'GET' ? url.searchParams : new URLSearchParams(await readBody(req));
  const redirectUri = q.get('redirect_uri');
  const clientId = q.get('client_id');
  const codeChallenge = q.get('code_challenge');
  const codeChallengeMethod = q.get('code_challenge_method');
  const state = q.get('state') || '';

  if (clientId !== client.clientId || redirectUri !== CALLBACK_URI || codeChallengeMethod !== 'S256' || !codeChallenge) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid authorize request');
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Xác nhận kết nối MCP</title><link rel="icon" href="/favicon/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/favicon/icon-192.png"><link rel="apple-touch-icon" href="/favicon/apple-touch-icon.png"><link rel="manifest" href="/favicon/manifest.json"><meta name="theme-color" content="#ff4800">
<style>
:root { color-scheme: light dark; --bg:#faf9f7; --card:#fff; --line:#e5e2dc; --fg:#1a1a1a; --muted:#6b6b6b; --accent:#ff4800; }
@media (prefers-color-scheme: dark) { :root { --bg:#1a1817; --card:#232120; --line:#38352f; --fg:#ececec; --muted:#9a948c; } }
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
form { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; width: 100%; max-width: 360px; }
h1 { font-size: 16px; margin: 0 0 4px; }
p { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
input { width: 100%; padding: 9px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; color: var(--fg); font-size: 14px; }
input:focus { outline: none; border-color: var(--accent); }
button { width: 100%; margin-top: 10px; padding: 9px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: #fff; font-size: 14px; cursor: pointer; }
button[disabled] { opacity: .6; cursor: progress; }
</style></head><body>
<form method="POST" onsubmit="this.btn.disabled=true;this.btn.textContent='Đang xác nhận…'">
<h1>Xác nhận kết nối MCP</h1>
<p>Nhập passphrase trong <code>${PASSPHRASE_FILE}</code> để cấp quyền cho connector.</p>
<input type="hidden" name="redirect_uri" value="${redirectUri}">
<input type="hidden" name="client_id" value="${clientId}">
<input type="hidden" name="code_challenge" value="${codeChallenge}">
<input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
<input type="hidden" name="state" value="${state}">
<input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password">
<button type="submit" name="btn">Approve</button>
</form>
</body></html>`);
    return;
  }

  if (!safeEqual(q.get('passphrase'), passphrase)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('sai passphrase');
    return;
  }
  const code = randomBytes(24).toString('hex');
  authCodes.set(code, { clientId, redirectUri, codeChallenge, expires: Date.now() + CODE_TTL_MS });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('iss', origin);
  if (state) redirect.searchParams.set('state', state);
  res.writeHead(302, { Location: redirect.toString() });
  res.end();
}

export async function handleToken(req, res, client) {
  res.setHeader('Cache-Control', 'no-store');
  const body = new URLSearchParams(await readBody(req));
  const grantType = body.get('grant_type');

  if (!safeEqual(body.get('client_id'), client.clientId) || !safeEqual(body.get('client_secret'), client.clientSecret)) {
    return json(res, 401, { error: 'invalid_client' });
  }

  if (grantType === 'authorization_code') {
    const code = body.get('code');
    const entry = authCodes.get(code);
    if (!entry || entry.expires < Date.now()) return json(res, 400, { error: 'invalid_grant' });
    authCodes.delete(code);
    if (entry.redirectUri !== body.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
    const computed = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
    if (computed !== entry.codeChallenge) return json(res, 400, { error: 'invalid_grant' });
    return issueTokens(res, entry.clientId);
  }

  if (grantType === 'refresh_token') {
    const entry = refreshTokens.get(body.get('refresh_token'));
    if (!entry) return json(res, 400, { error: 'invalid_grant' });
    return issueTokens(res, entry.clientId, body.get('refresh_token'));
  }

  return json(res, 400, { error: 'unsupported_grant_type' });
}

function issueTokens(res, clientId, existingRefresh) {
  const accessToken = randomBytes(32).toString('hex');
  accessTokens.set(accessToken, { expires: Date.now() + ACCESS_TTL_S * 1000 });
  const refreshToken = existingRefresh || randomBytes(32).toString('hex');
  refreshTokens.set(refreshToken, { clientId });
  saveTokens();
  json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refreshToken });
}

export function verifyBearer(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const entry = accessTokens.get(authHeader.slice(7));
  if (!entry) return false;
  if (entry.expires < Date.now()) return false;
  return true;
}
