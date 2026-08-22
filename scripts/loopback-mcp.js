import http from 'node:http';
import { handleStreamableMcp, terminateSession } from './streamable-bridge.js';
import { log, logErr } from './log.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 19999;

export function startLoopbackMcp({ port = Number(process.env.LOOPBACK_MCP_PORT || DEFAULT_PORT), onError } = {}) {
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    const t0 = Date.now();
    res.on('finish', () => log(`[loopback-mcp] ${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms`));

    if (path !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }

    if (req.headers.origin) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('browser-origin requests are not allowed');
    }

    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'text/plain' });
        return res.end('application/json required');
      }
      return handleStreamableMcp(req, res);
    }
    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid) terminateSession(sid);
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST, DELETE' });
    return res.end('server push not supported');
  });

  server.on('error', (error) => {
    logErr(`[loopback-mcp] failed to listen on ${HOST}:${port}: ${error.message}`);
    onError?.(error);
  });
  server.listen(port, HOST, () => {
    const address = server.address();
    log(`[loopback-mcp] listening on http://${HOST}:${address.port}/mcp (local only, no OAuth)`);
  });
  return server;
}
