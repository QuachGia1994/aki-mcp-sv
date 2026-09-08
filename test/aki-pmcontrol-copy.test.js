#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpRoot = path.join(repoRoot, 'scripts/aki-pmcontrol');
const labRoot = path.resolve(repoRoot, '../aiobox/labs/aki-pmcontrol');
const COPIED = [
  'scripts/daemon-pid.js',
  'scripts/postman-paths.js',
  'scripts/postman-session.js',
  'scripts/update-check.js',
  'data/aki-postman-instruction.md',
];
if (existsSync(labRoot)) {
  for (const rel of COPIED) {
    const mcpSrc = readFileSync(path.join(mcpRoot, rel), 'utf8');
    const labSrc = readFileSync(path.join(labRoot, rel), 'utf8');
    assert.equal(mcpSrc, labSrc, `${rel} must stay byte-identical (lab origin)`);
  }
}

const require = createRequire(import.meta.url);
const { loadInstruction, saveInstruction, copyDefaultIfMissing } = require('../scripts/aki-pmcontrol/scripts/instruction-store.js');
const defaultPromptPath = path.join(mcpRoot, 'assets/prompts/postman.md');
const sharedPromptDefaultPath = path.join(mcpRoot, 'assets/prompts/aki-prompt-sum-to-new-chat.md');

const defaultInstruction = loadInstruction([
  path.join(mcpRoot, 'missing-user-instruction.md'),
  path.join(mcpRoot, 'missing-legacy-instruction.md'),
  defaultPromptPath,
]);
assert.ok(defaultInstruction.trim(), 'a fresh clone must load a non-empty bundled Postman prompt');
const sharedSummaryPrompt = readFileSync(sharedPromptDefaultPath, 'utf8');
assert.ok(sharedSummaryPrompt.trim(), 'shared summarize-to-new-chat prompt must be bundled');
assert.match(sharedSummaryPrompt, /target 30–100 non-empty lines and never exceed 100 lines/);
assert.match(sharedSummaryPrompt, /do not pad/);
assert.match(sharedSummaryPrompt, /intentional dirty files/);
assert.match(sharedSummaryPrompt, /last-green verification/);
assert.equal(
  readFileSync(path.join(mcpRoot, 'assets/prompts/postman.md'), 'utf8'),
  readFileSync(path.join(mcpRoot, 'data/aki-postman-instruction.md'), 'utf8'),
  'bundled and panel Postman prompts must stay byte-identical',
);

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'aki-pmcontrol-instruction-'));
try {
  const userPath = path.join(tempRoot, 'missing', 'nested', 'postman.md');
  saveInstruction(userPath, 'saved user instruction');
  assert.equal(readFileSync(userPath, 'utf8'), 'saved user instruction');
  assert.equal(loadInstruction([userPath, defaultPromptPath]), 'saved user instruction');

  const freshCopyPath = path.join(tempRoot, 'prompts', 'aki-prompt-sum-to-new-chat.md');
  copyDefaultIfMissing(freshCopyPath, sharedPromptDefaultPath);
  assert.equal(readFileSync(freshCopyPath, 'utf8'), readFileSync(sharedPromptDefaultPath, 'utf8'));

  const editedUserPath = path.join(tempRoot, 'prompts', 'postman.md');
  saveInstruction(editedUserPath, 'user-edited, must survive');
  copyDefaultIfMissing(editedUserPath, defaultPromptPath);
  assert.equal(readFileSync(editedUserPath, 'utf8'), 'user-edited, must survive', 'copyDefaultIfMissing must never overwrite a non-empty user file');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const indexSrc = readFileSync(path.join(mcpRoot, 'index.js'), 'utf8');
assert.match(indexSrc, /const AKI_DATA_DIR = process\.env\.AKI_DATA_DIR \|\| path\.join\(os\.homedir\(\), '\.aki', 'mcpsv'\)/);
assert.match(indexSrc, /const PROMPTS_DIR = path\.join\(AKI_DATA_DIR, 'prompts'\)/);
assert.match(indexSrc, /const PROVIDER = 'postman'/);
assert.match(indexSrc, /function init\(\)/);
assert.match(indexSrc, /copyDefaultIfMissing/);
assert.match(indexSrc, /__cdpRequestSummarize/);
assert.match(indexSrc, /usage-turns\.jsonl/);
assert.match(indexSrc, /deltaMilli/);
assert.match(indexSrc, /resetAt/);
assert.doesNotMatch(indexSrc, /writeFileSync\([^;]*__dirname[^;]*'data'/);
assert.doesNotMatch(indexSrc, /writeFileSync\([^;]*__dirname[^;]*'assets'/);

const mcpSrc = readFileSync(path.join(mcpRoot, 'scripts/cdp-autoclicker.js'), 'utf8');

assert.match(mcpSrc, /const PERMISSION_CARD_ROOT = '\.tool-approval-wrapper, \.tool-approval-single-item'/);
assert.match(mcpSrc, /function tickPermissionCards/);
assert.match(mcpSrc, /function slotButton/);
assert.match(mcpSrc, /function press/);
assert.match(mcpSrc, /function creditArm/);
assert.match(mcpSrc, /tickPermissionCards\(config\)/);
assert.match(mcpSrc, /window\.__pmArmedCard/);
assert.match(mcpSrc, /permission card gone/);
assert.match(mcpSrc, /dataset\.akiPressed/);
assert.match(mcpSrc, /matchPrimary/);
assert.match(mcpSrc, /keywords: \['approve', 'allow'\]/);
assert.doesNotMatch(mcpSrc, /autoClicker\.tick\(/);
assert.doesNotMatch(mcpSrc, /dataset\.clicked/);
assert.doesNotMatch(mcpSrc, /acceptAllToolCall/);
assert.doesNotMatch(mcpSrc, /tickAutoAcceptToolCalls/);
assert.doesNotMatch(mcpSrc, /hasVisibleToolApproval/);
assert.doesNotMatch(mcpSrc, /Create workspace/);
assert.doesNotMatch(mcpSrc, /!card\.matches\(PERMISSION_CARD_ROOT\)/);

assert.match(mcpSrc, /const PM_EVENT_NEW_REQUESTER_WINDOW = 'newRequesterWindow'/);
assert.match(mcpSrc, /triggerPostman\(PM_EVENT_NEW_REQUESTER_WINDOW\)/);
assert.equal(
  (mcpSrc.match(/triggerPostman\(PM_EVENT_NEW_REQUESTER_WINDOW\)/g) || []).length,
  1,
  'New Window alone fires newRequesterWindow',
);
assert.match(mcpSrc, /function openNewBrowserTab/);
assert.match(mcpSrc, /build\.browser-tab/);

// Fork custom durable handoff must remain while upstream summarize-for-handoff is added separately.
assert.match(mcpSrc, /const HANDOFF_PROMPT =/);
assert.match(mcpSrc, /id="aki-btn-handoff"/);
assert.match(mcpSrc, /sendAiPrompt\(HANDOFF_PROMPT\)/);
assert.match(mcpSrc, /task_checkpoint_save/);
assert.match(mcpSrc, /task_checkpoint_recover/);
assert.match(mcpSrc, /context_packet/);
assert.match(mcpSrc, /For substantive work target 30–100 lines, never exceed 100/);
assert.match(mcpSrc, /intentional dirty files/);
assert.match(mcpSrc, /reuses confirmed plan\/checkpoint\/git facts without re-research unless stale or ambiguous/);
assert.match(mcpSrc, /function typeAndSubmitChat/);
assert.match(mcpSrc, /function sendSummarizePrompt/);
assert.match(mcpSrc, /aki-btn-summarize-chat/);
assert.match(mcpSrc, /window\.__cdpRequestSummarize/);
assert.match(mcpSrc, /window\.__pmDeliverSummarizePrompt/);
assert.match(mcpSrc, /function renderContextBar/);
assert.match(mcpSrc, /ctxCharAmber/);
assert.match(mcpSrc, /ctxCharRed/);
assert.match(mcpSrc, /function formatCreditReset/);
assert.match(mcpSrc, /function to24h/);

assert.match(mcpSrc, /openNewBrowserTab\(\)/);
assert.match(mcpSrc, /mod\.g\('about:blank', \{ forceNew: true \}\)/);

assert.doesNotMatch(mcpSrc, /structuralSelector/);
assert.doesNotMatch(mcpSrc, /no browser-tab mediator event found/);
assert.doesNotMatch(mcpSrc, /\/browser\/i/);
assert.doesNotMatch(mcpSrc, /rejectAllToolCall/);
assert.doesNotMatch(mcpSrc, /MCP_POSTMAN_CDP/);
assert.doesNotMatch(mcpSrc, /Input\.dispatchKeyEvent/);

const usageSrc = readFileSync(path.join(mcpRoot, 'scripts/cdp-usage.js'), 'utf8');
assert.match(usageSrc, /resetAt/);

console.log('aki-pmcontrol-copy.test.js: ok');
