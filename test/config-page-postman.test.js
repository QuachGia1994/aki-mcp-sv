import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPanel } from '../scripts/config-page.js';

function render() {
  return renderPanel({
    origin: 'https://aki.example.test',
    client: { clientId: 'client-id', clientSecret: 'client-secret' },
    passphrase: 'passphrase',
    token: 'panel-token',
    accessToken: 'a'.repeat(64),
    repoRoot: 'D:\\repo',
    rulesDir: 'C:\\Users\\User\\.aki\\akidevrule',
    userDir: 'C:\\Users\\User\\.aki\\mcpsv',
    updateInfo: {},
  });
}

test('Postman panel prefills a real Bearer token and keeps the tested MCP Request -> Agent Mode flow', () => {
  const html = render();
  assert.match(html, new RegExp(`Bearer ${'a'.repeat(64)}`));
  assert.match(html, /ready-to-copy value below is already complete/);
  assert.match(html, /MCP Request/);
  assert.match(html, /Streamable HTTP/);
  assert.match(html, /Generate Config .* Agent Mode .* Add to Agent Mode/);
  assert.match(html, /known HTTP-MCP reconnect bug/);
  assert.match(html, /Manual Agent Mode JSON is fallback only/);
  assert.match(html, /command.*args/);
  assert.doesNotMatch(html, /PASTE_ACCESS_TOKEN_HERE/);
  assert.match(html, /Enable Developer mode/);
  assert.match(html, /#settings\/Security/);
});
