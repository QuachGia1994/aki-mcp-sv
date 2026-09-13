import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpUpdateState } from '../scripts/update-check.js';
import { renderPanel } from '../scripts/config-page.js';

function panel(updateInfo) {
  return renderPanel({
    origin: 'https://aki.example.test',
    client: { clientId: 'client-id', clientSecret: 'client-secret' },
    passphrase: 'passphrase',
    token: 'panel-token',
    accessToken: 'b'.repeat(64),
    repoRoot: 'D:\\LacViet\\aki-mcp-sv',
    userDir: 'C:\\Users\\User\\.aki\\mcpsv',
    updateInfo,
    hasGit: true,
  });
}

test('selective upstream baseline suppresses an already-reviewed release', () => {
  const state = buildMcpUpdateState({ current: '1.15.0', upstreamReviewed: '2.0.0', updateMode: 'selective' }, '2.0.0');
  assert.equal(state.updateAvailable, false);
  assert.equal(state.current, '1.15.0');
  assert.equal(state.upstreamReviewed, '2.0.0');

  const html = panel({ mcp: state, rule: { current: '2.8.0', latest: '2.8.0', updateAvailable: false } });
  assert.match(html, /Fork upstream baseline: <span class="mono">selective 2\.0\.0<\/span>/);
  assert.doesNotMatch(html, /Pull &amp; restart/);
  assert.doesNotMatch(html, /1\.15\.0 → 2\.0\.0/);
});

test('selective fork warns again only when upstream moves past reviewed baseline', () => {
  const state = buildMcpUpdateState({ current: '1.15.0', upstreamReviewed: '2.0.0', updateMode: 'selective' }, '2.1.0');
  assert.equal(state.updateAvailable, true);
  const html = panel({ mcp: state, rule: { current: '2.8.0', latest: '2.8.0', updateAvailable: false } });
  assert.match(html, /selective 2\.0\.0 → upstream 2\.1\.0/);
  assert.match(html, /Review upstream ↗/);
  assert.doesNotMatch(html, /Pull &amp; restart/);
});

test('non-selective installs keep ordinary version comparison', () => {
  assert.equal(buildMcpUpdateState({ current: '1.15.0', upstreamReviewed: null, updateMode: null }, '2.0.0').updateAvailable, true);
  assert.equal(buildMcpUpdateState({ current: '2.0.0', upstreamReviewed: null, updateMode: null }, '2.0.0').updateAvailable, false);
});
