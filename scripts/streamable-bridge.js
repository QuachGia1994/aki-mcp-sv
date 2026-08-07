#!/usr/bin/env node
// Streamable HTTP shim: bridges POST /mcp to mcp-hub's legacy SSE transport that modern clients (claude.ai) can't drive — rationale: docs/ref/oauth-research-2026-08-07.md "Vòng debug 7".
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const UPSTREAM_PORT = Number(process.env.MCP_HUB_PORT || 19999);
const REQUEST_TIMEOUT_MS = 30000;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 64;

const sessions = new Map();

// Bound live upstream sessions (idle-close + hard cap); else they pile up all run and dump every disconnect line into the terminal at once on Ctrl+C.
function touch(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => closeSession(session), SESSION_IDLE_MS);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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

function closeSession(session) {
  clearTimeout(session.idleTimer);
  for (const { reject, timer } of session.pending.values()) {
    clearTimeout(timer);
    reject(new Error('upstream session closed'));
  }
  session.pending.clear();
  session.sseReq?.destroy();
  for (const [extId, s] of sessions) if (s === session) sessions.delete(extId);
}

function openInternalSession() {
  return new Promise((resolve, reject) => {
    const session = { internalSessionId: null, pending: new Map(), buffer: '', sseReq: null, onEndpoint: null, idleTimer: null };
    const req = http.request(
      { host: '127.0.0.1', port: UPSTREAM_PORT, path: '/mcp', method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => {
        res.setEncoding('utf8');
        session.onEndpoint = (id) => {
          session.internalSessionId = id;
          resolve(session);
        };
        res.on('data', (chunk) => parseSseChunk(session, chunk));
        res.on('end', () => closeSession(session));
        res.on('error', () => closeSession(session));
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

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleStreamableMcp(req, res) {
  let message;
  try {
    message = JSON.parse(await readBody(req));
  } catch {
    return jsonResponse(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
  }

  const externalSessionId = req.headers['mcp-session-id'];
  let session;
  let newExternalId;

  if (externalSessionId) {
    session = sessions.get(externalSessionId);
    if (!session) return jsonResponse(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
  } else {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.values().next().value;
      if (oldest) closeSession(oldest);
    }
    try {
      session = await openInternalSession();
    } catch (e) {
      return jsonResponse(res, 502, { jsonrpc: '2.0', error: { code: -32000, message: `upstream unreachable: ${e.message}` }, id: message.id ?? null });
    }
    newExternalId = randomBytes(16).toString('hex');
    sessions.set(newExternalId, session);
  }
  touch(session);

  const hasId = message.id !== undefined && message.id !== null;
  let waitForResponse;
  if (hasId) {
    waitForResponse = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(message.id);
        reject(new Error('upstream response timeout'));
      }, REQUEST_TIMEOUT_MS);
      session.pending.set(message.id, { resolve, reject, timer });
    });
  }

  try {
    await postMessage(session, message);
  } catch (e) {
    if (hasId) session.pending.delete(message.id);
    return jsonResponse(res, 502, { jsonrpc: '2.0', error: { code: -32000, message: `upstream error: ${e.message}` }, id: message.id ?? null });
  }

  if (newExternalId) res.setHeader('Mcp-Session-Id', newExternalId);

  if (!hasId) {
    res.writeHead(202);
    return res.end();
  }

  try {
    const result = await waitForResponse;
    jsonResponse(res, 200, result);
  } catch (e) {
    jsonResponse(res, 504, { jsonrpc: '2.0', error: { code: -32000, message: e.message }, id: message.id });
  }
}

export function terminateSession(externalSessionId) {
  const session = sessions.get(externalSessionId);
  if (session) closeSession(session);
}
