#!/usr/bin/env node
// Minimal OAuth 2.1 authorization server.
// Claude: pre-registered confidential client (paste Client ID/Secret), or DCR if it self-registers.
// ChatGPT: RFC 7591 DCR + public client (token_endpoint_auth_method: none) + chatgpt.com redirect URIs.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CLIENT_PATH as CLIENT_FILE,
  DCR_CLIENTS_PATH as DCR_FILE,
  PASSPHRASE_PATH as PASSPHRASE_FILE,
  TOKENS_PATH as TOKENS_FILE,
} from './userdata.js';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_LEGACY_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_CALLBACK_PREFIX = 'https://chatgpt.com/connector/oauth/';
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 365 * 24 * 3600;
// no 0/o/1/l/i — avoid visual ambiguity when typing; 32 chars = power of 2, unbiased byte%32
const PASSPHRASE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASSPHRASE_LENGTH = 10; // 32^10 = 2^50 — brute-force still infeasible over network

const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

function isAllowedRedirect(uri) {
  if (typeof uri !== 'string' || !uri) return false;
  if (uri === CLAUDE_CALLBACK || uri === CHATGPT_LEGACY_CALLBACK) return true;
  return uri.startsWith(CHATGPT_CALLBACK_PREFIX);
}

// Tokens survive restarts: the connector is a long-lived file-access grant, and losing it on every
// `npm start` forces a full re-authorize (passphrase) instead of the silent refresh the flow supports.
function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
    for (const [token, entry] of Object.entries(saved.access ?? {})) accessTokens.set(token, entry);
    for (const [token, entry] of Object.entries(saved.refresh ?? {})) refreshTokens.set(token, entry);
  } catch (e) {
    console.error(`[oauth] skipping unreadable ${TOKENS_FILE} (${e.message}) — will need to authorize again`);
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

function loadDcrClients() {
  if (!existsSync(DCR_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DCR_FILE, 'utf8'));
  } catch (e) {
    console.error(`[oauth] ignoring malformed ${DCR_FILE}: ${e.message}`);
    return {};
  }
}

function saveDcrClients(map) {
  writeFileSync(DCR_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}

/** Static Claude client + any clients ChatGPT (or Claude) registered via /register. */
export function resolveClient(clientId) {
  if (!clientId) return null;
  const staticClient = loadOrCreateClient();
  if (clientId === staticClient.clientId) {
    return {
      clientId: staticClient.clientId,
      clientSecret: staticClient.clientSecret,
      redirectUris: [CLAUDE_CALLBACK],
      tokenEndpointAuthMethod: 'client_secret_post',
    };
  }
  const dcr = loadDcrClients()[clientId];
  return dcr || null;
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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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
        registration_endpoint: `${origin}/register`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        authorization_response_iss_parameter_supported: true,
      });
    },
  };
}

// RFC 7591 — ChatGPT calls this once per connector instance. Only Claude/ChatGPT redirect URIs are accepted.
export async function handleRegister(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch {
    return json(res, 400, { error: 'invalid_client_metadata' });
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.length || !redirectUris.every(isAllowedRedirect)) {
    return json(res, 400, { error: 'invalid_redirect_uri' });
  }
  const authMethod = body.token_endpoint_auth_method || 'none';
  if (authMethod !== 'none' && authMethod !== 'client_secret_post') {
    return json(res, 400, { error: 'invalid_client_metadata' });
  }

  const clientId = randomBytes(16).toString('hex');
  const clientSecret = authMethod === 'client_secret_post' ? randomBytes(32).toString('hex') : null;
  const entry = {
    clientId,
    clientSecret,
    redirectUris,
    tokenEndpointAuthMethod: authMethod,
    clientName: typeof body.client_name === 'string' ? body.client_name : 'MCP client',
  };
  const map = loadDcrClients();
  map[clientId] = entry;
  saveDcrClients(map);

  const resp = {
    client_id: clientId,
    client_name: entry.clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  if (clientSecret) resp.client_secret = clientSecret;
  return json(res, 201, resp);
}

export async function handleAuthorize(req, res, passphrase, origin) {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://internal');
  const q = req.method === 'GET' ? url.searchParams : new URLSearchParams(await readBody(req));
  const redirectUri = q.get('redirect_uri');
  const clientId = q.get('client_id');
  const codeChallenge = q.get('code_challenge');
  const codeChallengeMethod = q.get('code_challenge_method');
  const state = q.get('state') || '';
  const client = resolveClient(clientId);

  if (!client || !client.redirectUris.includes(redirectUri) || codeChallengeMethod !== 'S256' || !codeChallenge) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid authorize request');
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm MCP connection</title><link rel="icon" href="/favicon/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/favicon/icon-192.png"><link rel="apple-touch-icon" href="/favicon/apple-touch-icon.png"><link rel="manifest" href="/favicon/manifest.json"><meta name="theme-color" content="#ff4800">
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
<form method="POST" onsubmit="this.btn.disabled=true;this.btn.textContent='Confirming…'">
<h1>Confirm MCP connection</h1>
<p>Enter the passphrase from <code>${PASSPHRASE_FILE}</code> to grant access to the connector.</p>
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
    res.end('wrong passphrase');
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

function authenticateClient(body) {
  const client = resolveClient(body.get('client_id'));
  if (!client) return null;
  if (client.tokenEndpointAuthMethod === 'none') return client;
  if (!safeEqual(body.get('client_secret'), client.clientSecret || '')) return null;
  return client;
}

export async function handleToken(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const body = new URLSearchParams(await readBody(req));
  const grantType = body.get('grant_type');
  const client = authenticateClient(body);
  if (!client) return json(res, 401, { error: 'invalid_client' });

  if (grantType === 'authorization_code') {
    const code = body.get('code');
    const entry = authCodes.get(code);
    if (!entry || entry.expires < Date.now()) return json(res, 400, { error: 'invalid_grant' });
    authCodes.delete(code);
    if (entry.clientId !== client.clientId) return json(res, 400, { error: 'invalid_grant' });
    if (entry.redirectUri !== body.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
    const computed = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
    if (computed !== entry.codeChallenge) return json(res, 400, { error: 'invalid_grant' });
    return issueTokens(res, entry.clientId);
  }

  if (grantType === 'refresh_token') {
    const entry = refreshTokens.get(body.get('refresh_token'));
    if (!entry || entry.clientId !== client.clientId) return json(res, 400, { error: 'invalid_grant' });
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
