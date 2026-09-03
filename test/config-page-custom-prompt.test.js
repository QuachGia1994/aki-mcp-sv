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

test('fork workflow instructions are checked and locked in section 3', () => {
  const html = render();
  for (const id of ['researchGitHubBeforePlan', 'sharedLivePlan', 'realRepoOnly', 'triggerBuildOnly']) {
    assert.match(html, new RegExp(`id="${id}" checked disabled`));
  }
  assert.match(html, /Research relevant GitHub repo before creating live plan .*custom/);
  assert.match(html, /One shared live plan across all AI agents; report completion back into the same file .*custom/);
  assert.match(html, /Work directly in the user-specified real repo; no sandbox\/virtual-copy edits .*custom/);
  assert.match(html, /Build\/CI: trigger only; do not wait or monitor unless asked .*custom/);
});

test('generated workflow orders research before shared plan and encodes direct-repo/build handoff rules', () => {
  const client = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  const research = client.indexOf('Before plan: research relevant GitHub repo/upstream');
  const plan = client.indexOf('Mutate/multi-step: scope; ONE shared plan');
  const realRepo = client.indexOf('Real repo only via Aki MCP');
  const build = client.indexOf('Build/CI: trigger only');
  assert.ok(research >= 0 && plan >= 0 && realRepo >= 0 && build >= 0);
  assert.ok(research < plan, 'GitHub research must precede live-plan creation');
  assert.ok(plan < realRepo, 'shared-plan handoff must be established before execution location');
  assert.ok(realRepo < build, 'real-repo policy must precede build handoff');
  assert.match(client, /Given plan path=>use it/);
  assert.match(client, /done=>write outcome for next AI/);
  assert.match(client, /no sandbox\/virtual\/temp copies unless asked/);
  assert.match(client, /no wait\/poll\/monitor unless asked/);
});

function promptForRuleSpec(ruleSpec) {
  return [
    "[akimcp 1.12.0 · akidevrule 2.7.0] ALWAYS short dense on-point. DON'T YAPPING. Claim=evidence; search=citation.",
    'Session start MCP "Aki MCP Server from local Shell & FileSystem": read ~/.claude/CLAUDE.md + ~/.aki/akidevrule/{' + ruleSpec + '}; follow all. Router ~/.claude/skills/akirule/SKILL.md.',
    'Before plan: research relevant GitHub repo/upstream; use repo/docs/issues/releases evidence.',
    'Mutate/multi-step: scope; ONE shared plan. Given plan path=>use it; else ~/.aki/mcpsv/task/<id>/plan.md. Read on handoff/resume; update checklist/decisions/evidence; done=>write outcome for next AI. Reply path on create. Q&A: no plan.',
    'Real repo only via Aki MCP: use user-specified path; no sandbox/virtual/temp copies unless asked. Read back writes.',
    'Files: find_path first; text=search_content; git/ls/grep=run_cmd cwd=real repo; no cd/-C.',
    'Build/CI: trigger only; no wait/poll/monitor unless asked. User monitors; reported failure=>inspect/fix/retrigger.',
    'First session: if ~/.aki/mcpsv/intro.json absent, read D:\\LacViet\\aki-mcp-sv/docs/ref/mcp-intro.md; write {"seen":true}.',
    'Update: read ~/.aki/mcpsv/aki-mcp-status.json; mismatch/updateAvailable=>tell user update panel + re-paste Instructions to each AI.',
  ].join('\n');
}

test('default locked prompt stays safely below ChatGPT 1500-character cap', () => {
  const ruleSpec = ['index.md', 'RULE-agent-behavior.md', 'RULE-coding.md', 'RULE-pattern-core.md', 'RULE-agent-engineering.md', 'RULE-docs.md', 'RULE-release.md'].join(',');
  const prompt = promptForRuleSpec(ruleSpec);
  assert.ok(prompt.length <= 1400, `default prompt should leave safety margin under 1500, got ${prompt.length}`);
});

test('full-tick prompt compacts all rule files and stays below ChatGPT 1500-character cap', () => {
  const client = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  assert.match(client, /picked\.length === allRuleInputs\.length/);
  assert.match(client, /'index\.md,METHOD-\*\.md,RULE-\*\.md'/);
  assert.match(client, /: picked\.join\(','\)/, 'partial selections must still enumerate exactly the picked rules');
  const prompt = promptForRuleSpec('index.md,METHOD-*.md,RULE-*.md');
  assert.ok(prompt.length <= 1400, `full-tick prompt should leave safety margin under 1500, got ${prompt.length}`);
});
