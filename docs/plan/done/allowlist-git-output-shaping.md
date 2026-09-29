# Allowlist read forms, one git tool, output shaping

> DONE 2026-09-29 (v2.1.0). Owner decisions and reasoning: `docs/ref/security-model.md` § Design stance, `docs/feat/tools.md` § When a tool earns its place / § Output shaping, `docs/research/token-saving-rtk.md`.

## Problem
- The default shell allowlist checked only `bin + subcommand`, so `git branch -D`, `git tag -d`, `git remote set-url` and `git diff --output=<file>` passed although the copy said "read-only".
- Three separate git tools existed, none could list a remote's tags, and a refused command said only "not in the allowlist".
- `run_cmd` returned up to 1 MB of raw stdout to the model, lost the whole result above 1 MB, and on a non-zero exit returned only stderr.
- Nothing told the owner or the model which limit binds which tool.

## Decisions
- Convenience first, guardrail second; the guardrail exists for weak or overeager models. No path scoping of arguments, no read/write tool split, no second permission layer.
- A dedicated tool beside `run_cmd` must save tokens or provide behavior `run_cmd` cannot.
- Token saving follows one principle: nothing is destroyed that cannot be recovered verbatim; a cut is announced on line 1.

## Checklist
- [x] Pin the stance in `security-model.md` (root), README, panel section 6, `tools.md`
- [x] Read forms only for a listed `git branch`/`tag`/`remote`, and `--output`; bare `git` still means everything (`scripts/shell-mcp.js`, test in `test/shell-mcp.test.js`)
- [x] Refusals say why and where to fix it (panel section 6); the `ls-remote` refusal points to the git tool
- [x] `aki__git_status/diff/log` merged into read-only `aki__git` (`op` status|diff|log|tags), 39 to 37 tools (`scripts/git-mcp.js`, `test/git-mcp.test.js` against a temp repo and a bare remote)
- [x] `run_cmd` output shaped (`scripts/output-shape.js`, `test/output-shape.test.js`): lossless cleaning, cut with raw saved to `~/.aki/mcpsv/out/`, failure keeps stdout/stderr/exit code, capture limit 32 MB
- [x] Research doc on rtk with measurements and rejected alternatives
- [x] Panel: hover on the `git` row, one sentence in section 6, "What each limit covers" line
- [x] Stale "read-only by default" claims corrected (README x4, `security-model.md`, `tools.md`, `run_cmd` description); "guardrail" as the single term, no dashes in the new panel copy (`content.A3`, `content.B2`)
- [x] Full `npm test` green; end to end through the MCP server: `cat CHANGELOG.md` 98,266 to 19,901 chars, raw recovered with `read_text_file tail` and `search_content`

## Open, not done
- `gh` is not in the defaults: the allowlist matches only the first subcommand, so `gh release delete` would pass beside `gh release list`. Revisit only if the allowlist learns second-level subcommands.
- Client-side tool caches: claude.ai and IDE clients may keep the old `aki__git_status/diff/log` names until the connector is reconnected.
