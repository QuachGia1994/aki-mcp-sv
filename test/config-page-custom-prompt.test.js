import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('custom GitHub research instruction is checked, locked, and precedes live-plan creation', () => {
  const html = render();
  assert.match(html, /id="researchGitHubBeforePlan" checked disabled/);
  assert.match(html, /Research relevant GitHub repo before creating live plan .*custom/);

  const client = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  const research = client.indexOf('Before live plan: research the relevant GitHub repo/upstream first');
  const plan = client.indexOf('Task (mutate/multi-step): confirm scope; plan $HOME/.aki/mcpsv/task/<id>/plan.md');
  assert.ok(research >= 0, 'research instruction must be emitted into the generated prompt');
  assert.ok(plan >= 0, 'live-plan instruction must remain present');
  assert.ok(research < plan, 'GitHub research must happen before live-plan creation');
});
