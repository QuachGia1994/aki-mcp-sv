#!/usr/bin/env node
// Streamable HTTP shim: bridges POST /mcp to mcp-hub's legacy SSE transport that modern clients (claude.ai) can't drive — rationale: docs/research/claude-ai-oauth-connector.md "Debug round 7".
// One shared hub session for the whole process — rationale in docs/plan/bridge-session-churn.md (Option B) and CLAUDE.md § Session lifecycle.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { log } from './log.js';
import { readBody, json as jsonResponse } from './http.js';

const UPSTREAM_PORT = Number(process.env.MCP_HUB_PORT || 19999);
// Per-request response timeout only — how long we wait for the upstream to answer one JSON-RPC call.
// Long tool runs (shell) legitimately exceed the old 30s; default generous, override via env.
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 10 * 60 * 1000);

// The single internal hub session; null until the first external `initialize` boots it, and reset to null if its upstream SSE dies (hub restart) so the next request transparently re-boots it.
let shared = null;
let sharedBoot = null; // in-flight boot promise — collapses concurrent first-initializes onto one hub session
let nextUpstreamId = 1; // globally-unique id per forwarded request; the remap that lets clients share one session
const externalIds = new Set(); // minted external session ids, for protocol-correct 404-on-stale (re-init is now cheap)

function parseSseChunk(session, chunk) {
  session.buffer += chunk;
  const blocks = session.buffer.split('\n\n');
  session.buffer = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event === 'endpoint') {
      const match = data.match(/sessionId=([a-f0-9-]+)/);
      if (match) session.onEndpoint?.(match[1]);
    } else if (event === 'message') {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        continue;
      }
      const pending = session.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        session.pending.delete(msg.id);
        pending.resolve(msg);
      }
    }
  }
}

function closeSession(session, reason = 'unspecified') {
  for (const { reject, timer } of session.pending.values()) {
    clearTimeout(timer);
    reject(new Error('upstream session closed'));
  }
  session.pending.clear();
  session.sseReq?.destroy();
  if (shared?.session === session) {
    shared = null;
    externalIds.clear();
  }
  log(`[bridge] shared hub session closed (${reason})`);
}

function openInternalSession() {
  return new Promise((resolve, reject) => {
    const session = { internalSessionId: null, pending: new Map(), buffer: '', sseReq: null, onEndpoint: null };
    const req = http.request(
      { host: '127.0.0.1', port: UPSTREAM_PORT, path: '/mcp', method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => {
        res.setEncoding('utf8');
        session.onEndpoint = (id) => {
          session.internalSessionId = id;
          resolve(session);
        };
        res.on('data', (chunk) => parseSseChunk(session, chunk));
        res.on('end', () => closeSession(session, 'upstream SSE ended (hub closed/restarted)'));
        res.on('error', (e) => closeSession(session, `upstream SSE error: ${e.message}`));
      },
    );
    req.on('error', reject);
    req.end();
    session.sseReq = req;
  });
}

function postMessage(session, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: UPSTREAM_PORT,
        path: `/messages?sessionId=${session.internalSessionId}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// Forward one request over `session` and await its matching response by id. `message.id` must already be a unique upstream id. Resolves with the full JSON-RPC response object.
function requestUpstream(session, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(message.id);
      log(`[bridge] request timeout after ${REQUEST_TIMEOUT_MS}ms (method=${message.method ?? '?'}, id=${message.id})`);
      reject(new Error('upstream response timeout'));
    }, REQUEST_TIMEOUT_MS);
    session.pending.set(message.id, { resolve, reject, timer });
    postMessage(session, message).catch((e) => {
      clearTimeout(timer);
      session.pending.delete(message.id);
      reject(e);
    });
  });
}

// Boot the one shared hub session using the first client's initialize params (so the negotiated protocol version is whatever that real client asked for), then cache the hub's initialize result for every later client.
function ensureShared(initParams) {
  if (shared) return Promise.resolve(shared);
  if (sharedBoot) return sharedBoot;
  sharedBoot = (async () => {
    const session = await openInternalSession();
    const response = await requestUpstream(session, { jsonrpc: '2.0', id: nextUpstreamId++, method: 'initialize', params: initParams });
    await postMessage(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
    shared = { session, initResult: response.result };
    log('[bridge] shared hub session opened — all external clients multiplex onto it');
    return shared;
  })();
  return sharedBoot.finally(() => {
    sharedBoot = null;
  });
}

export async function handleStreamableMcp(req, res) {
  let message;
  try {
    message = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
  }

  const method = message.method;
  const hasId = message.id !== undefined && message.id !== null;

  // initialize → answered locally; the first one boots the shared hub session, the rest reuse its cached result.
  if (method === 'initialize') {
    let s;
    try {
      s = await ensureShared(message.params);
    } catch (e) {
      log(`[bridge] upstream unreachable booting shared session: ${e.message}`);
      return jsonResponse(res, 502, { jsonrpc: '2.0', error: { code: -32000, message: `upstream unreachable: ${e.message}` }, id: message.id ?? null });
    }
    const extId = randomBytes(16).toString('hex');
    externalIds.add(extId);
    res.setHeader('Mcp-Session-Id', extId);
    return jsonResponse(res, 200, { jsonrpc: '2.0', id: message.id, result: s.initResult });
  }

  // Every other request must carry a session id we minted, and the shared session must still be alive.
  const externalSessionId = req.headers['mcp-session-id'];
  if (!externalSessionId || !externalIds.has(externalSessionId) || !shared) {
    externalIds.delete(externalSessionId);
    log(`[bridge] 404 session not found (${(externalSessionId ?? 'none').slice(0, 8)}…, method=${method ?? '?'}) — client must re-initialize`);
    return jsonResponse(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
  }

  // The client's own `notifications/initialized` is redundant — the shared session was initialized once at boot.
  if (method === 'notifications/initialized') {
    res.writeHead(202);
    return res.end();
  }

  // Notifications (no id) are fire-and-forget over the shared session.
  if (!hasId) {
    postMessage(shared.session, message).catch((e) => log(`[bridge] notification forward failed (${method}): ${e.message}`));
    res.writeHead(202);
    return res.end();
  }

  // Real request: remap id so concurrent clients never collide on one session, forward, restore the original id.
  const origId = message.id;
  try {
    const response = await requestUpstream(shared.session, { ...message, id: nextUpstreamId++ });
    response.id = origId;
    return jsonResponse(res, 200, response);
  } catch (e) {
    return jsonResponse(res, 504, { jsonrpc: '2.0', error: { code: -32000, message: e.message }, id: origId });
  }
}

export function terminateSession(externalSessionId) {
  // One client leaving never tears down the shared hub session — the others still multiplex onto it.
  externalIds.delete(externalSessionId);
}
