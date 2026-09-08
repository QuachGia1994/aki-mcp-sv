import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleStreamableMcp } from '../scripts/streamable-bridge.js';

test('MCP rejects invalid JSON-RPC envelopes before session routing', async () => {
  for (const message of [null, [], true, 42, 'text', {}, { method: 'ping' }, { jsonrpc: '2.0', method: 42 }, { jsonrpc: '2.0', method: 'ping', params: null }, { jsonrpc: '2.0', method: 'ping', id: {} }]) {
    const req = Readable.from([Buffer.from(JSON.stringify(message))]);
    req.headers = {};
    const res = {
      status: null,
      body: '',
      writeHead(status) { this.status = status; },
      end(body = '') { this.body = body; },
    };
    await handleStreamableMcp(req, res);
    assert.equal(res.status, 400, JSON.stringify(message));
    assert.equal(JSON.parse(res.body).error.code, -32600);
    assert.equal(JSON.parse(res.body).id, null);
  }
});
