# improve-instructions-1.3.1 — prompt, tool surface, roots naming

**Start:** 2026-08-10  
**Predecessor:** `docs/plan/done/instruction-prompt-minimal-override.md` (1.2.x residual-only prompt)  
**Scope:** four owner asks (lock index + auto-install rules; remove `search_files` from model surface; sandbox/DATA_DIR/prompt boundary; tool naming/grouping). Research-first; this plan is the decision record before code.

---

## 1. Lock `index.md` + auto-install when rules missing

### Facts
- `DEFAULT_RULES = ['index.md', 'RULE-agent-behavior.md', 'RULE-coding.md', 'RULE-design-core.md']` — index already first.
- Section 6 UI: every rule checkbox is free to uncheck; only folder paths (RULES_DIR/CLAUDE_DIR/AKI_DIR) are 🔒.
- Panel already has `POST /api/install-rules` → clone/pull `akidevrule` + `install.sh` (`scripts/panel.js`).
- Web clients have no harness `@` import; unread core = null rules.

### Decisions
| Item | Decision |
|---|---|
| Lock target | **Only `index.md`**: always first in checklist + always first in prompt list; checkbox disabled / non-uncheckable when rules load is on |
| Other three core | Remain optional checkboxes (owner may slim) |
| Missing install | When `loadRules` on and RULES_DIR has no `index.md`: prompt gains one short fallback line instructing the model to fetch+install (or tell user to press panel §5). Prefer ~1 line, ≤80 chars |
| Install wording (draft) | `If ~/.aki/akidevrule/index.md missing: run panel Install/update or: curl -fsSL https://raw.githubusercontent.com/lacvietanh/akidevrule/master/install.sh \| bash` |
| Cap | Keep ≤1500; measure after add |

### Non-goals
- Do not lock all four core (owner asked only index).
- Do not auto-run install from the model without user/panel path — curl line is guidance, not silent mutation.

---

## 2. Remove `search_files` from the model surface; keep `list_directory`

### Facts
- `search_files` lives in official npm package `@modelcontextprotocol/server-filesystem` (hub launches via `npx -y …`). Not source in this repo.
- Our `search` server already supersedes it: `find_path` (files+dirs, ~0.2s) + `search_content`.
- `list_directory` / `list_directory_with_sizes` stay — useful for known-dir metadata.
- **mcp-hub 4.2.1 has no tool filter** (README + no `filterTools`/`excludeTools`/`disabledTools` in `dist/cli.js`). Gatekeeper/bridge also do not filter `tools/list`.
- Prompt-only ban is a patch: model still *sees* the tool and may call it.

### Decisions (prefer subtract over patch)
| Option | Verdict |
|---|---|
| Fork official filesystem | **Out** — maintenance cost |
| mcp-hub native filter | **Impossible** on 4.2.1 |
| stdio filter proxy in front of filesystem | **Out** — researched, then dropped: a passthrough that only touches `tools/list`/`tools/call` still owns stdio JSON-RPC framing, id/notification passthrough, shutdown, and — decisively — it changes the shape of `filesystem.args`, which `filesystemPaths()` (`args.slice(2)`) and `setFilesystemPaths()` (`[flag, pkg, ...paths]`) parse **by fixed position** to build the directory allowlist. That is the filesystem security boundary; a proxy insertion breaks both parsers. Cost/risk not worth it for a tool the model rarely reaches for. |
| **Prompt ban (MVP)** | **Ship** — the pasteable instruction already says `never … search_files`; keep it. The residual tool stays listed but the model is told not to call it. |

**MVP rationale (owner, 2026-08-10):** "chọn prompt ban cho gọn nhẹ" — accept that a banned-but-listed tool is a soft boundary, in exchange for zero new code/process and no risk to the args-position allowlist parsers. `find_path` already supersedes `search_files`, so a stray call is a mild inefficiency, not a security or correctness failure — proportionate to keep it a prompt rule, not a proxy.

**Client-side limit, classified honestly:** a prompt ban is guidance the model *sees the tool and could still call*. It is not enforcement (`proportion` — client-side limits are UX, never a trust boundary). The only mechanism that would truly hide `search_files` is the proxy above, which we rejected on cost. If a hard removal is ever required, reopen this with the proxy + the two-parser fix as the known price.

`docs/feat/tools.md`: note `search_files` exists in the upstream `filesystem` surface but is prompt-banned in favor of `find_path`; no proxy.

---

## 3. Sandbox nature · DATA_DIR · prompt boundary

### 3a. Sandbox (verified)

Claude.ai **code execution / file-creation tools** run in an **Anthropic-managed ephemeral gVisor container on Anthropic infrastructure**, not on the user's machine.

Evidence:
- Anthropic engineering: "Pattern 1: The ephemeral container (claude.ai code execution)" — agent entirely server-side; filesystem ephemeral per session; no local FS.
- Support: "private computing environment directly in claude.ai"; isolated from user systems.
- Artifacts: sandboxed iframe / VM execution; no bridge to local machine except explicit connectors.

**Implication:** the only path from claude.ai → local disk/shell is **this MCP connector**. Native/sandbox tools writing "files" never touch the owner's machine. Prompt rule "sandbox = throwaway cloud; local = MCP only" is mechanistically correct.

(Claude Code / Cowork are different products with local reach; this MCP targets the **web connector** path.)

### 3b. Is `DATA_DIR` legacy trash?

| Layer | Role |
|---|---|
| `process.env.MCP_DATA_DIR` (start.js default `os.homedir()`) | Seed / placeholder `${MCP_DATA_DIR}` in hub template |
| `filesystem.args` (after package name) | **Authoritative multi-root allowlist** edited by panel §3 |
| `search`/`shell` `.env.MCP_DATA_DIR` | Comma-joined copy via `setFilesystemPaths` (today) |
| `agy`/`kiro` `.env.MCP_DATA_DIR` | Present in template; **not** rewritten by `setFilesystemPaths` today (drift risk — see footnote) |
| `roots.js` `ROOTS` | Parses the comma env for containment |
| Panel `dataDir` → prompt `DATA_DIR` | **Singular** value — **misleading in prompt** |

**Verdict:** multi-root allowlist is load-bearing, not trash. Only the **singular `DATA_DIR` string in the prompt** is residual. Keep internal env name `MCP_DATA_DIR`; stop saying "paths under DATA_DIR" in the prompt.

**Footnote (out of 1.3.1 unless owner expands scope):** `setFilesystemPaths` updates `search`+`shell` only; `agy`/`kiro` can keep stale roots after panel folder edits. Fix later if desired — not READ-grouping, pure containment sync.

### 3c. Prompt boundary — chốt

> All local paths: prefer Aki MCP FS/search/shell. Claude sandbox tools write throwaway cloud only. After any local write, read back via MCP before done.

`run_cmd cwd=` → "absolute under an allowed root", not `under ${DATA_DIR}`.

---

## 4. Tool naming / grouping

### Facts
- Exposed names: `filesystem__read_file`, `search__find_path`, `shell__run_cmd` — hub/client `serverName__toolName` disambiguation (MCP multi-server pattern). Not a bug.
- `search__search_content` looks odd only because server id = `search` and tool = `search_content`.
- Client UI buckets ("read" vs "others") are **client-controlled**; server cannot force group membership.

### Two capability classes (do not conflate)
| Class | Servers / tools | Grouping |
|---|---|---|
| **Direct primitives** | `filesystem` (read/write/list…), `search` (`find_path`/`search_content`), `shell` (`run_cmd`) | Read-ish tools may land in client "read"; writes/shell elsewhere — not our control |
| **Agent arms** | `agy`, `kiro` — delegate a whole task to a **local CLI agent** | **Not READ.** Multipurpose hands; must not be classified or documented as file-read primitives (`docs/feat/tools.md`) |

### Decisions
| Issue | Decision |
|---|---|
| Double underscore | **Keep** |
| Rename server `search` → `index` | Optional later; not 1.3.1 |
| Force client "read" group | **Out of scope** |
| `agy` / `kiro` as READ | **No** — arms, not primitives |
| Prompt tool names | Short forms (`find_path`, …) |

---

## Target prompt shape (1.3.1)

1. Density force (unchanged).
2. Session start + rules: `index.md` always first when rules on; locked in UI.
3. Optional install fallback if rules missing.
4. Scope + working.md (unchanged).
5. Tools: prefer `find_path` / `search_content`; **keep `never … search_files`** (prompt-ban MVP — no proxy). `run_cmd cwd=absolute under allowed root`.
6. Boundary: all local paths → Aki MCP priority; sandbox = cloud throwaway; read-back after write.
7. Repo line (unchanged).

Measure ≤1500 chars with default 4 rules + install fallback.

---

## Execution checklist (when approved)

**All four parts resolved 2026-08-10** (`scripts/config-page.js`, `scripts/panel.js`). Part 2 landed as the **prompt-ban MVP**, not the filter proxy — owner chose "gọn nhẹ" over a proxy that would have to re-own stdio framing and the args-position allowlist parsers.

- [x] UI: lock `index.md` checkbox (disabled + checked, `🔒`); sorted first in `#ruleChecks` (`renderRuleChecks`).
- [x] `buildPrompt()`: index first; boundary wording ("under an allowed root", "all local paths use Aki MCP FS"); dropped singular `DATA_DIR` (client const + `renderPanel` param + caller arg removed as dead); install fallback line when `loadRules` on but `index.md` not installed.
- [x] **Part 2 (prompt-ban MVP)** — keep `never … search_files` in `buildPrompt()`; no proxy, no `mcp-hub.config.json` change. Filter proxy rejected (breaks the `filesystemPaths`/`setFilesystemPaths` args-position parsers). Recorded as a soft/UX boundary, reopen trigger noted.
- [x] **Part 2** — `docs/feat/tools.md`: `search_files` documented as prompt-banned in favor of `find_path`.
- [x] Section 7 (Utilities): added Grok Usage Watch extension; repointed Claude image to `/extension-claude-usage.png`, added `/extension-grok-usage.png`.
- [x] Char count: default 4-rule prompt now 833 chars (< 1500). CHANGELOG `[Unreleased]` updated.
- [x] `node --check` on `config-page.js` + `panel.js` — pass.

## Non-goals
- Fork `@modelcontextprotocol/server-filesystem`.
- Build a stdio filter proxy to hard-remove `search_files` (rejected — cost + breaks the args-position allowlist parsers; prompt-ban chosen instead).
- Rename internal `MCP_DATA_DIR` across the stack.
- Change client UI grouping / force READ buckets.
- Classify `agy`/`kiro` as READ tools.
- Auto-install rules beyond prompt guidance.
- Fix agy/kiro root-env drift (footnote only) unless scope expanded.

## Cross-references
- `docs/research/instruction-prompt-first-principles.md`
- `docs/plan/done/instruction-prompt-minimal-override.md`
- `docs/feat/tools.md` — primitives vs arms
- `scripts/config-page.js` `buildPrompt`, `DEFAULT_RULES`
- `scripts/roots.js`, `scripts/panel.js` `setFilesystemPaths`
- `mcp-hub.config.json`
- mcp-hub 4.2.1 — no native tool exclude
- Anthropic: "How we contain Claude" — ephemeral container for claude.ai
