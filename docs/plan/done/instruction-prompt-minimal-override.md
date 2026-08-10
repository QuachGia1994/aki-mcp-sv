# Instruction prompt — minimal override (density + residuals only)

## Goal
Rewrite `buildPrompt()` so the pasteable instruction contains **only** what the force-loaded akidevrule core cannot guarantee: density residual-force, core force-load reminder, scope gate, MCP tool selection, and state/boundary rules. Stay under ChatGPT's 1500-char cap. Do not restate design/coding laws already present in the four core files.

Research basis: `docs/research/instruction-prompt-first-principles.md`.

## Problem — measured against current code
`scripts/config-page.js` `buildPrompt()` (≈L346) still emits a 7-line shape from the 1.2.0 plan. Two gaps relative to the research conclusion:
1. **Duplication of core** — line 1 restates “Never speculate or invent…” which is already agent.B2; no residual keyword for YAPPING.
2. **No explicit override philosophy** — the generator does not encode “only residuals”; future edits risk re-bloating with design/coding restatements.

The 1500-char counter and hoisted rules-dir from 1.2.0 remain correct and stay.

## Decisions

| Issue | Decision | Why |
|---|---|---|
| What belongs in the prompt | Only the five roots from the research: density force, force-load core, scope gate, tool selection, state+boundary | First-principles: everything else is already force-loaded; restating it costs chars and dilutes force |
| Density residual | Lead with `ALWAYS short dense on-point. DON'T YAPPING. Claim=evidence; search=citation.` | `DON'T YAPPING` is the observed high-frequency residual activator; longer agent.A4 citation does not stop padding as reliably |
| Core load line | Keep one line naming MCP, `CLAUDE.md`, the four bare filenames under `RULES_DIR`, and the router path | Web clients have no harness `@` import; unread core = null rules |
| Scope + state | One line: confirm-before-edit + `working.md` path | One-way-door protection + cross-session resume; already introduced in 1.2.0, keep |
| Tool + boundary | Two lines: find_path/search_content/run_cmd+cwd contract; repo path + sandbox/read-back | MCP-specific; absent from akidevrule |
| Variable rules list | Unchanged: only when checkbox on; bare filenames; dir hoisted once | design.A1 + 1.2.0 decision still holds |
| Cap behavior | Unchanged: live count + warn when >1500; never silent truncate | Observable guarantee |

## Target prompt shape

Order in `lines` (template vars filled at runtime):

1. `ALWAYS short dense on-point. DON'T YAPPING. Claim=evidence; search=citation.`
2. *(only if rules ticked)* `Session start MCP "<MCP_NAME>": read <CLAUDE_DIR>/CLAUDE.md + these under <RULES_DIR>: <bare, comma-joined filenames>; follow all session. Router: <CLAUDE_DIR>/skills/akirule/SKILL.md.`
3. `Every task: confirm scope with me before edit; plan $HOME/.aki/mcpsv/task/<id>/working.md (update live). <id>=short slug.`
4. `Files: always find_path (1 call, whole tree ~0.2s) — never list_directory nor search_files. Text→search_content. git/ls/grep: run_cmd cwd=absolute under <DATA_DIR> — never cd/-C.`
5. `Repo: <REPO_ROOT> — edit there. Sandbox tools write throwaway only; paths under <DATA_DIR> use MCP FS only; after write, read back via MCP before done.`

Default (4 rules ticked) target: **< 1200 chars**. Mandatory lines 1,3–5 must remain under budget even with zero rules.

## Execution checklist — done 2026-08-10
- [x] `buildPrompt()` rewritten to the five-line residual-only shape; char counter + over-1500 warning kept.
- [x] Measured with real path constants: **959 chars** default (4 rules), **674** with zero rules, both well under 1200/1500 (down from the 7-line ~1309).
- [x] All-rules-ticked still copies: there is no truncation path in code (only the red over-1500 warning), so the full textarea value always copies. Verified by reading `buildPrompt`.
- [x] `node --check scripts/config-page.js` passes.
- [x] `docs/index.md` entry repointed to `done/`.
- [x] `CHANGELOG.md` [Unreleased] Changed entry added.

**Deviation from the target shape:** the drafted lines 4 and 5 used `—`/`→`; these were emitted as plain punctuation (commas, colons) instead, per the akidevrule content rule that bans em-dashes in panel-rendered text (the prompt shows in the section-6 textarea). Wording and density are otherwise as specified.

## Non-goals
- Do not re-introduce design-core or coding rule text into the prompt.
- Do not change the rules checkbox UI or `DEFAULT_RULES` set.
- Do not alter the working.md path convention or the MCP tool names.

## Cross-references
- `docs/research/instruction-prompt-first-principles.md` — the five roots and critique this plan executes.
- `docs/plan/done/instruction-prompt-improve.md` — predecessor (1.2.0); this plan supersedes its *wording*, not its structural decisions (hoist, counter, working.md).
- `scripts/config-page.js` — `buildPrompt()`, `DEFAULT_RULES`, section 6 UI.
