#!/usr/bin/env node
// Streamable HTTP shim: bridges POST /mcp directly to the in-process tools McpServer over the SDK's
// InMemoryTransport — no more separate mcp-hub process or SSE handshake (docs/plan/2.0.0-improve.md
// #7, Stage 2 phase 2). One shared internal session for the whole process, same as before the
// collapse: rationale in docs/plan/done/bridge-session-churn.md (Option B) and CLAUDE.md § Session
// lifecycle — claude.ai re-sends `initialize` with no session id roughly every ~10s per conversation,
// so every external "session" multiplexes onto one real MCP session, answered from a local cache.
import { randomBytes } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { log } from './log.js';
import { readBody, json as jsonResponse } from './http.js';
import { createToolsServer } from './tools-server.js';

// The single internal session; null until the first external `initialize` boots it. Nothing in the
// new in-process transport can independently die the way an upstream SSE socket could, so this only
// ever resets via close()/onclose below — kept as defensive insurance, not an expected runtime path.
let shared = null;
let sharedBoot = null; // in-flight boot promise — collapses concurrent first-initializes onto one session
let nextUpstreamId = 1; // globally-unique id per forwarded request; the remap that lets clients share one session
const externalIds = new Set(); // minted external session ids, for protocol-correct 404-on-stale (re-init is now cheap)
const INTERNAL_INIT_PARAMS = {
  protocolVersion: DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'aki-internal-bridge', version: '1.0.0' },
};
const STATELESS_2025_PROTOCOL_VERSION = '2025-06-18';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const MODERN_PROTOCOL_META = 'io.modelcontextprotocol/protocolVersion';
const MODERN_SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';
const MODERN_CACHE_HINT = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' };

function negotiateExternalProtocolVersion(requestedVersion) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : LATEST_PROTOCOL_VERSION;
}

function withoutModernMeta(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const { _meta, ...rest } = params;
  return rest;
}

function isModernRequest(req, message) {
  return req.headers['mcp-protocol-version'] === MODERN_PROTOCOL_VERSION
    || message?.params?._meta?.[MODERN_PROTOCOL_META] === MODERN_PROTOCOL_VERSION
    || message?.method === 'server/discover';
}

function validateModernHeaders(req, message) {
  const headerVersion = req.headers['mcp-protocol-version'];
  const bodyVersion = message?.params?._meta?.[MODERN_PROTOCOL_META];
  if (headerVersion !== MODERN_PROTOCOL_VERSION || bodyVersion !== MODERN_PROTOCOL_VERSION) {
    return 'MCP-Protocol-Version must match params._meta protocolVersion';
  }
  if (req.headers['mcp-method'] !== message.method) {
    return 'Mcp-Method header must match the JSON-RPC method';
  }
  if (['tools/call', 'prompts/get', 'resources/read'].includes(message.method)) {
    const bodyName = message.params?.name ?? message.params?.uri;
    if (req.headers['mcp-name'] !== bodyName) return 'Mcp-Name header must match the request name/uri';
  }
  return null;
}

function modernResult(result, serverInfo, { cacheable = false } = {}) {
  return {
    ...(result ?? {}),
    resultType: 'complete',
    ...(cacheable ? MODERN_CACHE_HINT : {}),
    _meta: {
      ...(result?._meta ?? {}),
      [MODERN_SERVER_INFO_META]: serverInfo,
    },
  };
}

function routeResponse(session, message) {
  const pending = session.pending.get(message.id);
  if (pending) {
    clearTimeout(pending.timer);
    session.pending.delete(message.id);
    pending.resolve(message);
  }
}

function closeSession(session, reason = 'unspecified') {
  for (const { reject, timer } of session.pending.values()) {
    clearTimeout(timer);
    reject(new Error('tools server session closed'));
  }
  session.pending.clear();
  if (shared?.session === session) {
    shared = null;
    externalIds.clear();
  }
  log(`[bridge] shared tools-server session closed (${reason})`);
}

async function openInternalSession() {
  const server = createToolsServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const session = { transport: clientTransport, pending: new Map() };
  clientTransport.onmessage = (message) => routeResponse(session, message);
  clientTransport.onclose = () => closeSession(session, 'transport closed');
  await server.connect(serverTransport);
  await clientTransport.start();
  return session;
}

function postMessage(session, message) {
  return session.transport.send(message);
}

// Forward one request over `session` and await its matching response by id. `message.id` must already be a unique upstream id. Resolves with the full JSON-RPC response object.
function requestUpstream(session, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(message.id);
      log(`[bridge] request timeout (method=${message.method ?? '?'}, id=${message.id})`);
      reject(new Error('tools server response timeout'));
    }, Number(process.env.MCP_REQUEST_TIMEOUT_MS || 10 * 60 * 1000));
    session.pending.set(message.id, { resolve, reject, timer });
    postMessage(session, message).catch((e) => {
      clearTimeout(timer);
      session.pending.delete(message.id);
      reject(e);
    });
  });
}

// Boot the one shared session using the first client's initialize params (so the negotiated protocol version is whatever that real client asked for), then cache the result for every later client.
function ensureShared(initParams) {
  if (shared) return Promise.resolve(shared);
  if (sharedBoot) return sharedBoot;
  sharedBoot = (async () => {
    const session = await openInternalSession();
    const response = await requestUpstream(session, { jsonrpc: '2.0', id: nextUpstreamId++, method: 'initialize', params: initParams });
    await postMessage(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
    shared = { session, initResult: response.result };
    log('[bridge] shared tools-server session opened — all external clients multiplex onto it');
    return shared;
  })();
  return sharedBoot.finally(() => {
    sharedBoot = null;
  });
}

async function requestShared(method, params = {}) {
  const s = await ensureShared(INTERNAL_INIT_PARAMS);
  const response = await requestUpstream(s.session, { jsonrpc: '2.0', id: nextUpstreamId++, method, params });
  if (response.error) throw new Error(response.error.message ?? `tools server ${method} failed`);
  return response.result;
}

// D1/Qwen/Kimi use the same in-process MCP session and tool registry as /mcp clients, so transport
// never creates a second filesystem/shell policy surface.
export async function callSharedTool(name, args = {}) {
  const listed = await requestShared('tools/list');
  if (!listed?.tools?.some((tool) => tool.name === name)) throw new Error(`tool "${name}" is not exposed by the tools server`);
  return requestShared('tools/call', { name, arguments: args });
}

// Called once at start.js boot: constructs a throwaway tools server so a registration-time crash
// (a bad tool schema, a broken import) surfaces immediately in the startup console, before any real
// client ever connects — the same "fail loud at boot" role mcp-hub's spawnHub() used to play.
export function warmToolsServer() {
  createToolsServer();
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

  // MCP 2026-07-28 is stateless: no initialize/session-id handshake. Translate its tool surface
  // onto the same shared legacy in-process tools session so old and new clients share one policy.
  if (isModernRequest(req, message)) {
    const mismatch = validateModernHeaders(req, message);
    if (mismatch) {
      return jsonResponse(res, 400, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32020, message: mismatch } });
    }

    let sharedState;
    try {
      sharedState = await ensureShared(INTERNAL_INIT_PARAMS);
    } catch (e) {
      return jsonResponse(res, 502, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: `tools server unreachable: ${e.message}` } });
    }
    const serverInfo = sharedState.initResult?.serverInfo ?? { name: 'local', version: '1.0.0' };

    if (method === 'server/discover') {
      return jsonResponse(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          ...MODERN_CACHE_HINT,
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          _meta: { [MODERN_SERVER_INFO_META]: serverInfo },
        },
      });
    }

    if (!hasId) {
      res.writeHead(202);
      return res.end();
    }

    if (method === 'tools/list') {
      try {
        const result = await requestShared('tools/list', withoutModernMeta(message.params));
        return jsonResponse(res, 200, { jsonrpc: '2.0', id: message.id, result: modernResult(result, serverInfo, { cacheable: true }) });
      } catch (e) {
        return jsonResponse(res, 504, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: e.message } });
      }
    }

    if (method === 'tools/call' || method === 'ping') {
      try {
        const result = await requestShared(method, withoutModernMeta(message.params));
        return jsonResponse(res, 200, { jsonrpc: '2.0', id: message.id, result: modernResult(result, serverInfo) });
      } catch (e) {
        return jsonResponse(res, 504, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: e.message } });
      }
    }

    return jsonResponse(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  // MCP 2025-06-18 may be served statelessly: Postman v12 explicitly auto-detects this mode.
  // We still keep 2025-03-26 and older clients on the external session-id path below.
  if (!req.akiLoopback && method === 'initialize' && message.params?.protocolVersion === STATELESS_2025_PROTOCOL_VERSION) {
    let s;
    try {
      s = await ensureShared(INTERNAL_INIT_PARAMS);
    } catch (e) {
      log(`[bridge] failed to boot shared tools-server session: ${e.message}`);
      return jsonResponse(res, 502, { jsonrpc: '2.0', error: { code: -32000, message: `tools server unreachable: ${e.message}` }, id: message.id ?? null });
    }
    return jsonResponse(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        ...s.initResult,
        protocolVersion: STATELESS_2025_PROTOCOL_VERSION,
      },
    });
  }

  const stateless2025Request = !req.akiLoopback
    && req.headers['mcp-protocol-version'] === STATELESS_2025_PROTOCOL_VERSION
    && !req.headers['mcp-session-id'];
  if (stateless2025Request) {
    let s;
    try {
      s = await ensureShared(INTERNAL_INIT_PARAMS);
    } catch (e) {
      return jsonResponse(res, 502, { jsonrpc: '2.0', error: { code: -32000, message: `tools server unreachable: ${e.message}` }, id: message.id ?? null });
    }

    if (method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }

    if (!hasId) {
      postMessage(s.session, message).catch((e) => log(`[bridge] stateless notification forward failed (${method}): ${e.message}`));
      res.writeHead(202);
      return res.end();
    }

    const origId = message.id;
    try {
      const response = await requestUpstream(s.session, { ...message, id: nextUpstreamId++ });
      response.id = origId;
      return jsonResponse(res, 200, response);
    } catch (e) {
      return jsonResponse(res, 504, { jsonrpc: '2.0', error: { code: -32000, message: e.message }, id: origId });
    }
  }

  // Stateful legacy initialize → answered locally; the first one boots the shared session, the rest reuse its cached result.
  if (method === 'initialize') {
    let s;
    try {
      s = await ensureShared(INTERNAL_INIT_PARAMS);
    } catch (e) {
      log(`[bridge] failed to boot shared tools-server session: ${e.message}`);
      return jsonResponse(res, 502, { jsonrpc: '2.0', error: { code: -32000, message: `tools server unreachable: ${e.message}` }, id: message.id ?? null });
    }
    const extId = randomBytes(16).toString('hex');
    externalIds.add(extId);
    const initResult = {
      ...s.initResult,
      protocolVersion: negotiateExternalProtocolVersion(message.params?.protocolVersion),
    };
    return jsonResponse(
      res,
      200,
      { jsonrpc: '2.0', id: message.id, result: initResult },
      { 'MCP-Session-Id': extId },
    );
  }

  // Every other request must carry a session id we minted, and the shared session must still be alive.
  // Node normalizes incoming header names to lowercase, so this accepts every wire casing while rejecting duplicate/ambiguous values before they reach the shared in-process transport.
  const rawExternalSessionId = req.headers['mcp-session-id'];
  const externalSessionId = typeof rawExternalSessionId === 'string' ? rawExternalSessionId : null;
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
  // One client leaving never tears down the shared session — the others still multiplex onto it.
  externalIds.delete(externalSessionId);
}
