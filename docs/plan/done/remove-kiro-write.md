# Remove kiro_write

## Goal
Drop the `kiro_write` MCP tool (`scripts/kiro-mcp.js`). `kiro_read` is untouched — out of scope.

## Why
- `kiro_write` grants `fs_read,fs_write` (file writes only, no shell/exec — by design, see Cross-references). That capability is already covered directly by the `filesystem` MCP arm's `write_file`/`edit_file`, which every connected session already has. `kiro_write` is a second path to the same outcome, gated behind a hard-locked `claude-sonnet-4.5` worker instead of the session's own model.
- Owner decision (2026-08-10): consolidate file-write trust into the connected session's own model rather than provisioning a second fixed-model write worker.
- Does not touch the actual blocked need from this session (`git add/commit/push`): `kiro_write` was never a shell/exec path (confirmed live 2026-08-10 — `execute_bash forbidden in non-interactive mode` when asked to run git). That gap is `shell.allowlist` in `~/.aki/mcpsv/setting.json`, unaffected by this plan; owner will allowlist separately later.

## Change

| File | Change |
|---|---|
| `scripts/kiro-mcp.js` | Delete the `server.registerTool('kiro_write', …)` block (~lines 58–72). Keep `MODEL`, `run()`, `kiro_read` — `run()` is shared and still called by `kiro_read`. |
| `README.md:49` | `└─► MCP kiro server (kiro-mcp.js — Kiro arm: kiro_read + kiro_write, needs kiro-cli on PATH)` → `kiro_read (read-only)` |
| `README.md:87` | `# Kiro arm: kiro_read + kiro_write tools, sonnet-4.5 locked, needs kiro-cli on PATH` → `# Kiro arm: kiro_read (read-only) tool, sonnet-4.5 locked, needs kiro-cli on PATH` |
| `docs/ref/harness-fact.md` | kiro "Tool grants" row currently documents both `fs_read` and `fs_read,fs_write` across "two `registerTool`s" — update to the single `kiro_read` (`fs_read`) grant. |
| `docs/index.md` | Add this doc's entry. Leave the existing `integrate-kiro-cli.md` line as-is — historical record of what that plan shipped, not current state. |
| `CHANGELOG.md` | New `[Unreleased]` → `### Removed` entry: `kiro_write` dropped + reason, `kiro_read` retained. |
| `mcp-hub.config.json` | No change — the `kiro` server entry references the script file, not individual tools (verified: only `command`/`args` keys, no per-tool list). |
| `docs/plan/done/integrate-kiro-cli.md` | No change — historical decision record; this plan documents the reversal, not a rewrite of that doc. |

## Out of scope
- `kiro_read` — not requested, stays.
- Shell `git` write access — separate axis, owner allowlisting later.
- Uninstalling the `kiro-cli` binary — `kiro_read` still needs it on `PATH`.

## Execution checklist
- [x] `scripts/kiro-mcp.js` — remove `kiro_write` registerTool block
- [x] `node --check scripts/kiro-mcp.js`
- [x] `README.md` — both references (diagram + tree)
- [x] `docs/ref/harness-fact.md` — kiro tool-grants row
- [x] `docs/index.md` — add this doc's entry
- [x] `CHANGELOG.md` — `[Unreleased]` entry
- [x] Move this doc to `docs/plan/done/` once shipped

## Cross-references
- `docs/plan/done/integrate-kiro-cli.md` — original decision this plan partially reverses; its own framing already scoped `kiro_write` to file writes only ("no shell/exec"), consistent with why removing it doesn't recover git/shell access
- `docs/ref/harness-fact.md` § kiro — grants table to update
- `scripts/kiro-mcp.js` — file being changed

## Decision
**Action** → executed 2026-08-10. `scripts/kiro-mcp.js` verified with `node --check` (no output = pass) after the edit. All doc/changelog updates listed above shipped in the same pass.
