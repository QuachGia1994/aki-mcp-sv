import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readBody } from '../scripts/http.js';
import { dcrRegistrationAvailable, handleRegister, shouldRotateRefresh, rotateRefreshGrant } from '../scripts/oauth.js';
import { trustedInterpreterScriptArg } from '../scripts/shell-mcp.js';

test('readBody rejects declared and streamed bodies above the configured cap', async () => {
  const declared = Readable.from(['small']);
  declared.headers = { 'content-length': '1000' };
  await assert.rejects(readBody(declared, 32), (error) => error?.code === 'BODY_TOO_LARGE' && error.limit === 32);

  const streamed = Readable.from([Buffer.alloc(20), Buffer.alloc(20)]);
  streamed.headers = {};
  await assert.rejects(readBody(streamed, 32), (error) => error?.code === 'BODY_TOO_LARGE' && error.limit === 32);
});

test('public OAuth registration applies the body cap before parsing or persistence', async () => {
  const req = Readable.from(['{}']);
  req.headers = { 'content-length': String(64 * 1024 + 1) };
  const res = {
    status: null,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
  await handleRegister(req, res);
  assert.equal(res.status, 413);
  assert.match(res.body, /invalid_client_metadata/);
});

test('trusted interpreter preallow only accepts a script as argv[0]', () => {
  const trusted = 'C:\\Users\\User\\.aki\\scripts\\safe.js';
  assert.equal(trustedInterpreterScriptArg('node', [trusted, '--flag']), trusted);
  assert.equal(trustedInterpreterScriptArg('node', ['--require', trusted, '-e', 'process.exit()']), null);
  assert.equal(trustedInterpreterScriptArg('python3', ['-c', 'print(1)']), null);
  assert.equal(trustedInterpreterScriptArg('bash', [trusted]), null);
});

test('DCR registration storage is bounded', () => {
  assert.equal(dcrRegistrationAvailable({}, 2), true);
  assert.equal(dcrRegistrationAvailable({ a: {}, b: {} }, 2), false);
});

test('public clients rotate refresh grants while confidential clients retain compatibility', () => {
  assert.equal(shouldRotateRefresh({ tokenEndpointAuthMethod: 'none' }), true);
  assert.equal(shouldRotateRefresh({ tokenEndpointAuthMethod: 'client_secret_post' }), false);

  const store = new Map([['old-refresh', { clientId: 'client-1' }]]);
  const next = rotateRefreshGrant(store, 'old-refresh', 'client-1', () => 'new-refresh');
  assert.equal(next, 'new-refresh');
  assert.equal(store.has('old-refresh'), false);
  assert.deepEqual(store.get('new-refresh'), { clientId: 'client-1' });
});
