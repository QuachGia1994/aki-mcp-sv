# Tools — the local capability suite (anchored)

> updated 2026-08-17 · v1.9.3

The product's single purpose: give a remote web AI (claude.ai / ChatGPT / Grok / Gemini) a set of **local capabilities** on the owner's machine — a pair of hands reaching from the browser into the local filesystem, shell, and local agents. Every tool below exists to serve that anchor. This doc records **why each one is here** so a later subtraction audit does not mistake an anchored capability for redundant code and propose removing it.

## The suite

| Tool (MCP `name`) | Tools exposed | What it does | Who drives it |
|---|---|---|---|
| `filesystem` (official `@modelcontextprotocol/server-filesystem`) | `read_file`, `write_file`, `edit_file`, … | Read/write/edit files under the allowed roots | The remote model, directly |
| `search` | `find_path`, `search_content` | Fast index-backed path + content lookup (no per-call `find`/`grep` spawn) | The remote model, directly |
> The upstream `filesystem` server also exposes `search_files`, but `find_path` supersedes it (files+dirs, ~0.2s). It is **prompt-banned**, not removed: the pasteable instruction tells the model `never … search_files`. This is a soft/UX boundary — the tool is still listed. A hard removal would need a stdio filter proxy, which was rejected because it would break the args-position allowlist parsers in `scripts/panel.js` (`docs/plan/improve-instructions-1.3.1.md` §2).
| `shell` | `run_cmd` | Run an allowlisted command as the user; read-only by default, write commands opt-in (`docs/plan/done/shell-allowlist.md`) | The remote model, directly |
| `agy` | `agy` | Delegate a whole task to a **local Antigravity CLI agent** — default mode `plan` (read-only by mechanism), default model `gemini-3.6-flash-medium` (fast, wide-context discovery tier) | The remote model delegates; a local agent reasons |
| `kiro` | `kiro_read` | Delegate a whole read-only task to a **local Kiro CLI agent**, hard-locked to `claude-sonnet-4.5`, `--trust-tools=fs_read` | The remote model delegates; a local agent reasons |

## Web transports without custom MCP

Kimi Web and Qwen Coder Web can reach the same capability suite through the optional Cloudflare D1 mailbox. D1 is only asynchronous transport: each row names an existing MCP tool and JSON arguments, `scripts/d1-bridge.js` verifies the name against live `tools/list`, then calls it through the shared `mcp-hub` session. It does not add a second shell/file policy or bypass the existing one.

Kimi Web K3 and Qwen Coder Web (`coder.qwen.ai`) are both live-verified through the narrow `cloudflare/qwen-bridge-worker` ingress and shared D1 mailbox. Kimi uses the custom domain `aki-bridge.oakgatekeeper.uk` plus its own `AKI_KIMI_SECRET` because its sandbox timed out on `*.workers.dev`; Qwen Coder retains `AKI_BRIDGE_SECRET`. Both completed `filesystem__read_text_file` and `local__run_cmd` end to end. Qwen Chat (`chat.qwen.ai`) is not equivalent: its Python sandbox returned `[Errno 101] Network is unreachable`, and its web extractor could only GET the Worker, not POST tasks. Setup: `docs/ref/kimi-web-d1-bridge.md` and `docs/ref/qwen-web-worker-bridge.md`.

## Two classes — and why the second is not redundant

**Direct primitives** (`filesystem`, `search`, `shell`) — the remote model calls them and does the reasoning itself.

**Agent arms / "hands"** (`agy`, `kiro`) — the remote model hands off a *whole task* to a **local agent** that reasons and uses its own tools locally, then returns a conclusion.

An audit that only pattern-matches capabilities will call `kiro_read` "redundant — the model already has `find_path`/`search_content`/`run_cmd`." **That is a misclassification and the arms must not be removed on that basis.** An arm is not a file-reader; it is agent delegation, and it buys three things a direct primitive cannot:

- **Offload multi-step local work** — a local model runs the investigate/read/synthesize loop against local files and returns a conclusion, instead of the remote model paying round-trips and context for every intermediate read.
- **Local trust scoping by mechanism** — the arm runs under its own locked tool set (`kiro` → `fs_read` only; `agy` → `plan` mode only), a boundary the remote model cannot widen from a prompt.
- **Model/tier choice per task** — `agy` reaches a wide-context discovery tier; `kiro` is pinned to a specific Sonnet id for cost/behavior determinism.

## Search ladder — how the model should compose a hunt

`search_content` is case-insensitive extended regex by default (`grep -iE`), so multi-alias search is one call, not N. The order below is load-bearing (`docs/plan/done/smart-search-strategy.md`):

1. **Orient + expand signals** — turn the ask into 2–3 signals (literal keyword, EN+VI synonym/variant, likely path/filename). Run `find_path` with the tightest one; prefer `path=` when the tree is known.
2. **Content, simple** — `search_content` with one precise query + optional `glob` + scoped `path`. Prefer this over shell.
3. **Content, multi-alias / OR** — one `search_content` with all aliases in the query joined by `|` (`"funnel|ingress|thay.*funnel"`). Fall back to `run_cmd grep -rliE` only when the scope/exclude still does not fit one query.
4. **Follow the thread** — a hit is a new signal, not an endpoint: pull the next term it names (a called function, a referenced constant, an imported path) and repeat from step 2, scoped tighter. `concept → symbol → file → dependency` on grep-only tools.
5. **Progressive narrow** — if a step returns too much, tighten `path`/`glob` and re-call; return the conclusion, not full bodies.
6. **Verify closure** — before a conclusion that will be *acted on* (not a quick lookup), run one more search confirming no other reference remains and say so. Severity-gated; skip for simple lookups.
7. **Batch independent lookups** in one turn.

## Anchor — load-bearing, do not remove

`agy` and `kiro` are anchored owner requirements ("hands, bắt buộc phải có"). They are **load-bearing** in the subtraction-audit sense: they carry real behavior (agent delegation) that no other tool provides. Any future audit finding proposing their removal is **rejected by this doc** unless the owner re-decides the anchor. The model lock on `kiro` (`claude-sonnet-4.5`) is a hard requirement — the model is not a tool parameter, so no prompt can escalate the tier (`scripts/kiro-mcp.js`).

## History

- `kiro_write` was removed 2026-08-10 — it duplicated the `filesystem` arm's `write_file`/`edit_file` (a genuine primitive-vs-primitive duplication, unlike `kiro_read`). `docs/plan/done/remove-kiro-write.md`.
- Arm CLI facts (flags, model ids, effort enums) by evidence tier: `docs/ref/harness-fact.md`.
- Integration: `docs/plan/done/integrate-kiro-cli.md`, `docs/plan/done/integrate-gemini-grok.md`.
