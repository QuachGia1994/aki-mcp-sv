import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startPanel } from '../scripts/panel.js';

test('panel rejects oversized authenticated API bodies before route execution', async () => {
  const token = 'panel-security-token';
  const server = startPanel({ port: 0, token, origin: 'https://example.invalid', ingress: {}, client: {}, passphrase: 'unused', updateInfo: {} });
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/doctor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-token': token },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /exceeds 1048576 bytes/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
