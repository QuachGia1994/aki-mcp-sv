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
  for (const id of ['researchGitHubBeforePlan', 'sharedLivePlan', 'realRepoOnly', 'triggerBuildOnly', 'nativeVisualTools', 'leanContextPolicy']) {
    assert.match(html, new RegExp(`id="${id}" checked disabled`));
  }
  assert.match(html, /Research relevant GitHub repo before creating live plan .*custom/);
  assert.match(html, /One shared live plan across all AI agents; report completion back into the same file .*custom/);
  assert.match(html, /Work directly in the user-specified real repo; no sandbox\/virtual-copy edits .*custom/);
  assert.match(html, /Build\/CI: trigger only; do not wait or monitor unless asked .*custom/);
  assert.match(html, /Aki Skills: Browser\/ImageGen \+ Ponytail\/Anti-Vibe \+ Mobile Native \+ Icon Silhouette \+ Strix \+ Postman Remote .*custom/);
  assert.match(html, /Lean context: reuse confirmed facts; proportional verification; AGENTS\/HANDOFF stay thin .*custom/);
  const source = readFileSync(new URL('../scripts/config-page.js', import.meta.url), 'utf8');
  assert.match(source, /const LOCKED_RULES = \['index\.md', 'RULE-agent-behavior\.md', 'RULE-coding\.md', 'RULE-pattern-core\.md'\];/);
  assert.doesNotMatch(source, /const LOCKED_RULES = \[[^\]]*RULE-agent-engineering\.md/);
  assert.match(html, /Contextual rules stay routed through <span class="mono">akirule<\/span> instead of consuming every session/);
});

test('Postman prompt uses the same durable long-chat protocol as the controller', () => {
  const html = render();
  const source = readFileSync(new URL('../scripts/config-page.js', import.meta.url), 'utf8');
  const instruction = readFileSync(new URL('../scripts/aki-pmcontrol/data/aki-postman-instruction.md', import.meta.url), 'utf8');
  assert.match(source, /aki-pmcontrol\/data\/aki-postman-instruction\.md/);
  assert.match(instruction, /ONE shared plan \+ stable taskKey/);
  assert.match(instruction, /context_packet/);
  assert.match(instruction, /task_checkpoint_save\/recover/);
  assert.match(instruction, /task_checkpoint_recover first/);
  assert.match(instruction, /never store transcripts/);
  assert.match(instruction, /SUMMARY CURRENT SESSION AS PROMPT TO COPY INTO NEW CHAT/);
  assert.match(instruction, /treat it exactly as HANDOFF/);
  assert.match(instruction, /target 30–100 lines, never exceed 100/);
  assert.match(instruction, /AGENTS\.md as a thin project map \(normally 30–100 lines\)/);
  assert.match(instruction, /verification depth follows risk/);
  assert.match(instruction, /images=image_inbox/);
  assert.match(instruction, /xem ảnh mới nhất/);
  assert.match(instruction, /Do not OCR unless explicitly asked/);
  assert.match(html, /ONE shared plan \+ stable taskKey/);
  assert.match(html, /task_checkpoint_save\/recover/);
});

test('xKiro panel config is local-only and never renders a saved secret', () => {
  const html = render();
  assert.match(html, /id="tab-xkiro"/);
  assert.match(html, /type="password" id="xkiroKey"/);
  assert.match(html, /local__agent_read/);
  assert.match(html, /5M free-model tokens\/day/);
  assert.doesNotMatch(html, /value="sk-xt-/);
});

test('OpenCode panel reuses CLI auth and exposes only free-model controls', () => {
  const html = render();
  const client = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  assert.match(html, /id="tab-opencode"/);
  assert.match(html, /opencode auth login/);
  assert.match(html, /id="opencodeModel"/);
  assert.match(html, /id="opencodeExecEnabled"/);
  assert.match(html, /local__opencode_exec/);
  assert.match(html, /data-act="refreshOpenCode"/);
  assert.match(html, /data-act="testOpenCode"/);
  assert.doesNotMatch(html, /id="opencodeKey"/);
  assert.match(client, /\/api\/opencode-status/);
  assert.match(client, /\/api\/opencode-refresh/);
  assert.match(client, /\/api\/opencode-test/);
});

test('Context Optimizer panel exposes bounded lead-packet controls without claiming provider cache hits', () => {
  const html = render();
  const client = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  assert.match(html, /id="tab-context"/);
  assert.match(html, /id="contextOptimizerEnabled"/);
  assert.match(html, /id="contextBudgetTokens" min="2000" max="32000"/);
  assert.match(html, /id="contextHotWindow" min="5" max="120"/);
  assert.match(html, /data-act="saveContextOptimizer"/);
  assert.match(html, /does not claim or control ChatGPT\/Work provider cache hits/);
  assert.match(html, /Aki Free-first Orchestrator/);
  assert.match(html, /data-act="refreshFreeFirst"/);
  assert.match(html, /data-act="syncProjectGraph"/);
  assert.match(html, /data-act="runAkiDoctor"/);
  assert.match(html, /Provider-reported tokens, Aki estimates, avoided lead context, and cache hits stay separate metrics/);
  assert.match(client, /\/api\/context-optimizer-status/);
  assert.match(client, /\/api\/budget-router-status/);
  assert.match(client, /\/api\/project-graph-sync/);
  assert.match(client, /\/api\/doctor/);
  assert.match(client, /\/api\/context-optimizer-config/);
});

test('Gemini Spark panel documents one-call repo snapshot and unavoidable client-side approvals', () => {
  const html = render();
  assert.match(html, /Gemini custom MCP apps now run inside <strong>Gemini Spark<\/strong>/);
  assert.match(html, /approve every individual MCP tool call/);
  assert.match(html, /local__repo_snapshot<\/span> once with the project path/);
  assert.match(html, /avoiding the 60s <span class="mono">agent_read<\/span> timeout/);
  assert.match(html, /Write\/shell calls may still require separate Spark confirmation/);
});

test('generated workflow is lean, reuses evidence, and keeps routed context out of every session', () => {
  const client = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  const plan = client.indexOf('Plan: nontrivial=>research GitHub/upstream');
  const lean = client.indexOf('Lean: conclusion first');
  const context = client.indexOf('Context: AGENTS.md=thin map 30-100 lines');
  const realRepo = client.indexOf('Repo: Aki MCP real path');
  assert.ok(plan >= 0 && lean >= 0 && context >= 0 && realRepo >= 0);
  assert.ok(plan < lean && lean < context && context < realRepo);
  assert.match(client, /reuse confirmed facts unless stale\/ambiguous/);
  assert.match(client, /authorized scope=no reconfirm/);
  assert.match(client, /verify by risk/);
  assert.match(client, /subagent only if independent ROI>coordination/);
  assert.match(client, /AGENTS\.md=thin map 30-100 lines, no routed\/global rule duplication/);
  assert.match(client, /HANDOFF=30-100 lines state only/);
  assert.match(client, /no sandbox\/temp unless asked/);
  assert.match(client, /multi=context_packet;code=opencode_exec;tests=run_cmd cwd=repo/);
  assert.match(client, /deep=agent_read;code=opencode_exec;tests=run_cmd cwd=repo/);
  assert.match(client, /browser,imagegen,anti-vibecoding,mobile-native,postman-remote,strix/);
});

function promptForRuleSpec(ruleSpec) {
  return [
    "[akimcp 1.15.0 · akidevrule 2.8.0] SHORT+DENSE. DON'T YAPPING. Claim=evidence; search=citation.",
    'Session start MCP "Aki MCP Server from local Shell & FileSystem": read ~/.claude/CLAUDE.md + ~/.aki/akidevrule/{' + ruleSpec + '}; follow all. Router ~/.claude/skills/akirule/SKILL.md.',
    'Plan: nontrivial=>research GitHub/upstream; reuse confirmed facts unless stale/ambiguous; ONE plan=given path or ~/.aki/mcpsv/task/<id>/plan.md; resume checkpoint. Q&A:no plan.',
    'Lean: conclusion first; no restating request; stop when evidence suffices; authorized scope=no reconfirm; verify by risk; CI trigger/no poll unless asked; done=deliverable+checks+limits; subagent only if independent ROI>coordination.',
    'Context: AGENTS.md=thin map 30-100 lines, no routed/global rule duplication; HANDOFF=30-100 lines state only; detail=plan/checkpoint.',
    'Repo: Aki MCP real path; preserve dirty; no sandbox/temp unless asked; read back writes/diffs.',
    'Tools: unknown=find_path;text=search_content;multi=context_packet;code=opencode_exec;tests=run_cmd cwd=repo;risky=review;2 fails/high-risk=>escalate;no cd/-C.',
    'Skills D:\\LacViet\\aki-mcp-sv/skills: browser,imagegen,anti-vibecoding,mobile-native,postman-remote,strix; read target SKILL.md.',
    'First: intro.json absent=>read D:\\LacViet\\aki-mcp-sv/docs/ref/mcp-intro.md. Update mismatch=>tell user update panel+re-paste.',
  ].join('\n');
}

test('default locked prompt stays safely below ChatGPT 1500-character cap', () => {
  const ruleSpec = ['index.md', 'RULE-agent-behavior.md', 'RULE-coding.md', 'RULE-pattern-core.md'].join(',');
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
