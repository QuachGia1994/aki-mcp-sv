#!/usr/bin/env node
// Public entry: minimal OAuth AS (DCR skipped) + reverse-proxy to mcp-hub — rationale: docs/ref/security-model.md
import http from 'node:http';
import { loadOrCreateClient, loadOrCreatePassphrase, metadataHandlers, handleAuthorize, handleToken, verifyBearer } from './oauth.js';
import { handleStreamableMcp, terminateSession } from './streamable-bridge.js';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const PUBLIC_PORT = Number(process.env.GATEKEEPER_PORT || 9999);
const UPSTREAM_PORT = Number(process.env.MCP_HUB_PORT || 19999);
const ORIGIN = process.env.PUBLIC_ORIGIN;

if (!ORIGIN) {
  console.error('[gatekeeper] PUBLIC_ORIGIN is not set — refusing to start.');
  process.exit(1);
}

const client = loadOrCreateClient();
const passphrase = loadOrCreatePassphrase();
const meta = metadataHandlers(ORIGIN);

function forwardToHub(req, res) {
  const proxyReq = http.request(
    { host: '127.0.0.1', port: UPSTREAM_PORT, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`upstream error: ${e.message}`);
  });
  req.pipe(proxyReq);
}

const PUBLIC_DIR = join(process.cwd(), 'public');
const STATIC_ALIASES = { '/favicon.ico': '/favicon/favicon.ico' };
const MIME = {
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  const rel = normalize(STATIC_ALIASES[urlPath] || urlPath).replace(/^([/\\.]+)/, '');
  const file = join(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];
  res.on('finish', () => console.log(`[gatekeeper] ${req.method} ${req.url} -> ${res.statusCode}`));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if ((path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') && req.method === 'GET') return meta.protectedResource(req, res);
  if ((path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp') && req.method === 'GET') return meta.authorizationServer(req, res);
  if (path === '/authorize' && (req.method === 'GET' || req.method === 'POST')) return handleAuthorize(req, res, client, passphrase, ORIGIN);
  if (path === '/token' && req.method === 'POST') return handleToken(req, res, client);

  if (path === '/mcp' || path === '/messages') {
    if (!verifyBearer(req.headers.authorization)) {
      res.writeHead(401, {
        'Content-Type': 'text/plain',
        'WWW-Authenticate': `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end('unauthorized');
      return;
    }
    if (path === '/mcp' && req.method === 'POST') return handleStreamableMcp(req, res);
    if (path === '/mcp' && req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid) terminateSession(sid);
      res.writeHead(204);
      return res.end();
    }
    if (path === '/mcp' && req.method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST, DELETE' });
      return res.end('server push not supported');
    }
    return forwardToHub(req, res);
  }

  if (req.method === 'GET' && await serveStatic(res, path)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('error', (e) => {
  console.error(`[gatekeeper] failed to listen on :${PUBLIC_PORT}: ${e.message}`);
  process.exit(1);
});
server.listen(PUBLIC_PORT, () => {
  console.log(`[gatekeeper] listening on :${PUBLIC_PORT} -> 127.0.0.1:${UPSTREAM_PORT} (OAuth-protected /mcp)`);
});
