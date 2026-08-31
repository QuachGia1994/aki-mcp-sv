import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPanel } from '../scripts/config-page.js';

function render() {
  return renderPanel({
    origin: 'https://aki.example.test',
    client: { clientId: 'client-id', clientSecret: 'client-secret' },
    passphrase: 'passphrase',
    token: 'panel-token',
    repoRoot: 'D:\\repo',
    rulesDir: 'C:\\Users\\User\\.aki\\akidevrule',
    userDir: 'C:\\Users\\User\\.aki\\mcpsv',
    updateInfo: {},
  });
}

test('Postman panel requires Bearer auth and the tested MCP Request -> Agent Mode flow', () => {
  const html = render();
  assert.match(html, /Bearer PASTE_ACCESS_TOKEN_HERE/);
  assert.match(html, /raw 64-character token by itself is invalid and will return 401/);
  assert.match(html, /MCP Request/);
  assert.match(html, /Streamable HTTP/);
  assert.match(html, /Generate Config .* Agent Mode .* Add to Agent Mode/);
  assert.match(html, /known HTTP-MCP reconnect bug/);
  assert.match(html, /Manual Agent Mode JSON is fallback only/);
  assert.match(html, /command.*args/);
  assert.doesNotMatch(html, /Authorization(?:&quot;|")?:(?:&quot;|")?PASTE_ACCESS_TOKEN_HERE/);
});
