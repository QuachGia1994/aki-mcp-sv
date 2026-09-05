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
    accessToken: 'b'.repeat(64),
    repoRoot: 'D:\\repo',
    rulesDir: 'C:\\Users\\User\\.aki\\akidevrule',
    userDir: 'C:\\Users\\User\\.aki\\mcpsv',
    updateInfo: {},
  });
}

test('fork workflow instructions are checked and locked in section 3', () => {
  const html = render();
  for (const id of ['researchGitHubBeforePlan', 'sharedLivePlan', 'realRepoOnly', 'triggerBuildOnly', 'nativeVisualTools']) {
    assert.match(html, new RegExp(`id="${id}" checked disabled`));
  }
  assert.match(html, /Research relevant GitHub repo before creating live plan .*custom/);
  assert.match(html, /One shared live plan across all AI agents; report completion back into the same file .*custom/);
  assert.match(html, /Work directly in the user-specified real repo; no sandbox\/virtual-copy edits .*custom/);
  assert.match(html, /Build\/CI: trigger only; do not wait or monitor unless asked .*custom/);
  assert.match(html, /Native Browser\/ImageGen: auto-use host web \+ image tools when the task needs them .*custom/);
});

test('xKiro panel config is local-only and never renders a saved secret', () => {
  const html = render();
  assert.match(html, /id="tab-xkiro"/);
  assert.match(html, /type="password" id="xkiroKey"/);
  assert.match(html, /local__agent_read/);
  assert.match(html, /5M free-model tokens\/day/);
  assert.doesNotMatch(html, /value="sk-xt-/);
});

test('Gemini Spark panel documents one-call repo snapshot and unavoidable client-side approvals', () => {
  const html = render();
  assert.match(html, /Gemini custom MCP apps now run inside <strong>Gemini Spark<\/strong>/);
  assert.match(html, /approve every individual MCP tool call/);
  assert.match(html, /local__repo_snapshot<\/span> once with the project path/);
  assert.match(html, /avoiding the 60s <span class="mono">agent_read<\/span> timeout/);
  assert.match(html, /Write\/shell calls may still require separate Spark confirmation/);
});

test('generated workflow orders research before shared plan and encodes direct-repo/build handoff rules', () => {
  const client = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  const research = client.indexOf('Before plan: research GitHub repo/upstream');
  const plan = client.indexOf('Mutate/multi-step: ONE shared plan');
  const realRepo = client.indexOf('Real repo via Aki MCP only');
  const build = client.indexOf('Build/CI: trigger only');
  assert.ok(research >= 0 && plan >= 0 && realRepo >= 0 && build >= 0);
  assert.ok(research < plan, 'GitHub research must precede live-plan creation');
  assert.ok(plan < realRepo, 'shared-plan handoff must be established before execution location');
  assert.ok(realRepo < build, 'real-repo policy must precede build handoff');
  assert.match(client, /ONE shared plan at given path else/);
  assert.match(client, /checklist\/decisions\/evidence\/outcome current/);
  assert.match(client, /no sandbox\/temp copies unless asked/);
  assert.match(client, /don't poll unless asked/);
  assert.match(client, /Broad repo: repo_snapshot once; deep=>agent_read \(xKiro free first if set\); granular fallback/);
});

function promptForRuleSpec(ruleSpec) {
  return [
    "[akimcp 1.14.0 · akidevrule 2.7.0] ALWAYS short dense on-point. DON'T YAPPING. Claim=evidence; search=citation.",
    'Session start MCP "Aki MCP Server from local Shell & FileSystem": read ~/.claude/CLAUDE.md + ~/.aki/akidevrule/{' + ruleSpec + '}; follow all. Router ~/.claude/skills/akirule/SKILL.md.',
    'Before plan: research GitHub repo/upstream; cite repo/docs/issues/releases.',
    'Mutate/multi-step: ONE shared plan at given path else ~/.aki/mcpsv/task/<id>/plan.md; read on resume/handoff; keep checklist/decisions/evidence/outcome current; reply path on create. Q&A:no plan.',
    'Real repo via Aki MCP only; use user path; no sandbox/temp copies unless asked; read back writes.',
    'Files: find_path first; text=search_content; git/ls/grep=run_cmd cwd=real repo; no cd/-C.',
    'Broad repo: repo_snapshot once; deep=>agent_read (xKiro free first if set); granular fallback.',
    'Aki skills D:\\LacViet\\aki-mcp-sv/skills: web/live=>browser; visual/edit=>imagegen; read SKILL.md; use native tools.',
    "Build/CI: trigger only; don't poll unless asked; failure=>inspect/fix/retrigger.",
    'First session: if ~/.aki/mcpsv/intro.json absent, read D:\\LacViet\\aki-mcp-sv/docs/ref/mcp-intro.md; write {"seen":true}.',
    'Update: read ~/.aki/mcpsv/aki-mcp-status.json; mismatch/updateAvailable=>tell user update panel + re-paste Instructions.',
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
