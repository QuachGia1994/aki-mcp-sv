# Integrate kiro-cli as a second "arm" + tune the agy tool

## Goal
Add Kiro CLI as a second delegated worker alongside `agy`, exposed as MCP tools so a connected chat (Claude/ChatGPT/…) can hand work to a Kiro session hard-locked to `claude-sonnet-4.5`. Two separate tools — one read-only, one write — so the MCP client can approve the **write** tool independently of the read one in its per-tool approval UI. Separately, correct the existing `agy` tool where it advertises capabilities its installed CLI does not have.

## Prerequisite / verification limit
`kiro-cli` is **not installed on this machine** (`which kiro` → not found). All Kiro facts below come from `~/.claude/skills/akiflow/references/harness-facts.md` § "Kiro CLI (`kiro-cli` 2.16.0)", verified there 2026-08-02 against the binary — **not re-verifiable here**. The code path lands and parses, but is **unverified at runtime** (`coding.B3`) until run on a machine with `kiro-cli` on `PATH`. The tool must fail loudly (a real error, never a mock) when the binary is absent — reuse the `agy-mcp.js` pattern where `execFile` failure returns `err(...)`.

## Kiro CLI facts this design rests on (harness-facts.md, [obs] 2026-08-02)
| Need | Flag | Note |
|---|---|---|
| Headless batch | `kiro-cli chat --no-interactive "<prompt>"` | positional prompt also accepted; same shape as `claude -p` |
| Read-only by mechanism | `--trust-tools=fs_read` | `--trust-tools=` (empty) blocks all; a named set restricts to it — read-only by mechanism, not by prompt wording |
| Write, still bounded | `--trust-tools=fs_read,fs_write` | grants file writes but nothing else (no shell/exec unless named) |
| Model lock | `--model claude-sonnet-4.5` | id verified in `--list-models` (1.3× tier). Hard-coded, not a tool parameter |
| Fail-loud | `--require-mcp-startup` | exit 3 if an MCP server it starts fails — keep so a broken worker fails visibly |
| Thinking budget | `--effort low\|medium\|high\|xhigh\|max` | operative on all Kiro tiers (unlike `claude`+haiku) |

## Decisions — Kiro tools

| Issue | Decision | Why |
|---|---|---|
| New file vs extend agy | New `scripts/kiro-mcp.js`, own entry in `mcp-hub.config.json` | One file per concern — matches `agy-mcp.js`/`shell-mcp.js`; a different CLI with a different trust model does not belong inside the agy wrapper (`design.A3`) |
| Two tools, not one with a mode flag | `kiro_read` (`--trust-tools=fs_read`) and `kiro_write` (`--trust-tools=fs_read,fs_write`) as **separate registered tools** | The connector's approval UI is per-tool; only separate tools let the owner approve write while leaving read open. A single tool with a `write:true` arg cannot be approved at that grain — this separation is the whole point of the request |
| Model | Hard-locked `claude-sonnet-4.5`, **not** a tool parameter | Owner requirement ("khóa cứng"); prevents a prompt from escalating to a pricier/other tier |
| Prompt passing | `prompt` as a separate `execFile` arg, never shell-joined | Same reason `agy-mcp.js` exists — no tokenizer can mis-split a multi-word prompt |
| cwd scoping | `resolveUnderRoot(cwd)` (shared with agy/search) | Reuse the one containment check (`roots.js`), never reimplement (`design.A6`) |
| effort | Optional tool arg, enum `low\|medium\|high\|xhigh\|max` | Kiro supports the full range per harness-facts |
| Absent-binary behaviour | `execFile` error → `err(...)`; empty-output guard like `agy-mcp.js` | Fail loud, never fabricate (`coding.C1`) |
| Write-tool safety copy | `kiro_write`'s description states plainly it can modify files under the allowed roots at sonnet-4.5, and is the tool to approve deliberately | Honest surface, same stance as the shell copy fix in the 1.1.0 audit |

## Decisions — agy tool tuning (`scripts/agy-mcp.js`)
| Issue | Decision | Why |
|---|---|---|
| effort enum over-advertises | Change `z.enum(['low','medium','high','xhigh','max'])` (`agy-mcp.js:53`) to `z.enum(['low','medium','high'])` | **Live `agy --help` on this machine lists only `low\|medium\|high`** — runtime output is the source of truth (`coding.A3`) and overrides the older harness-facts row; passing `xhigh`/`max` would be rejected by the CLI |
| model discovery | Add the valid agy model ids to the `model` param description: `gemini-3.6-flash-{low,medium,high}`, `gemini-3.5-flash-*`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` (from `agy models`) | So a caller picks a real id instead of guessing; keep the flash-medium default and the "retrieval-not-judgment" note already present |

## Out of scope
- Runtime verification of the Kiro tools — needs `kiro-cli` installed; land unverified, note it in CHANGELOG.
- Kiro's ACP server mode (`kiro-cli acp`), session resume (`--resume-id`), and custom agents — not needed for the read/write arm; add later if a use appears (YAGNI).
- Adding Kiro to the default allowlist / shell tool — Kiro is its own MCP server, not a shell binary.
- Exposing more of agy's flags (`--json-schema` beyond current, `--add-dir`) — not requested.

## Execution checklist
- [ ] New `scripts/kiro-mcp.js` — `kiro_read` + `kiro_write` tools, model hard-locked `claude-sonnet-4.5`, `--require-mcp-startup`, optional `effort`, `resolveUnderRoot(cwd)`, shared `ok`/`err`/`fail` from `mcp-tool.js`, empty-output guard.
- [ ] `mcp-hub.config.json` — add a `kiro` server entry mirroring the `agy` entry's env (`MCP_DATA_DIR` + `~/.aki`,`~/.claude`).
- [ ] `scripts/agy-mcp.js:53` — restrict effort enum to `['low','medium','high']`; add valid model ids to the `model` param description.
- [ ] `node --check scripts/kiro-mcp.js scripts/agy-mcp.js`.
- [ ] README — one line noting the Kiro arm (read + write tools, sonnet-4.5, requires `kiro-cli` on PATH) beside the agy tool.

## Cross-references
- `scripts/agy-mcp.js` — the wrapper pattern this mirrors, and the file being tuned
- `scripts/mcp-tool.js` / `scripts/roots.js` — shared `ok`/`err`/`fail` and `resolveUnderRoot` both new tools reuse
- `~/.claude/skills/akiflow/references/harness-facts.md` § Kiro CLI — the sole (unverifiable-here) source for every Kiro flag
- `mcp-hub.config.json` — where the new server is wired

## Decision
**Action** → build `scripts/kiro-mcp.js` (two tools, sonnet-4.5 locked), wire into `mcp-hub.config.json`, tune `agy-mcp.js`'s effort enum + model docs. Kiro tools ship **unverified** (binary absent here) per `coding.B3`; agy tuning is verified against live `agy --help`.
