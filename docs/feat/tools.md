# Tools — the local capability suite (anchored)

> updated 2026-09-05 · v1.14.0

The product's single purpose: give a remote web AI (claude.ai / ChatGPT / Grok / Gemini / Postman) a set of **local capabilities** on the owner's machine — a pair of hands reaching from the browser into the local filesystem, shell, and local agents. Every tool below exists to serve that anchor. This doc records **why each one is here** so a later subtraction audit does not mistake an anchored capability for redundant code and propose removing it.

## The suite

| Tool (MCP `name`) | Tools exposed | What it does | Who drives it |
|---|---|---|---|
| `filesystem` (native, `scripts/filesystem-mcp.js`) | `read_text_file`, `write_file`, `edit_file`, `create_directory`, `move_file`, `get_file_info`, `list_allowed_directories` | Read/write/edit files under the allowed roots, symlink-safe | The remote model, directly |
| `search` | `find_path`, `search_content` | Fast index-backed path + content lookup (no per-call `find`/`grep` spawn) | The remote model, directly |
> The third-party `@modelcontextprotocol/server-filesystem` package this replaced also exposed `list_directory`/`directory_tree`/`search_files`/`read_multiple_files`/`read_media_file` — dropped outright rather than prompt-banned, since `find_path`/`search_content` already supersede the listing/search family in practice and the rest had no evidence of real use (`docs/plan/done/2.0.0-improve.md` §7). Cheap to re-add if a real need shows up.
| `shell` | `run_cmd` | Run an allowlisted command as the user; read-only by default, write commands opt-in (`docs/plan/done/shell-allowlist.md`) | The remote model, directly |
| `agy` | `agy_run` | Delegate a whole task to a **local Antigravity CLI agent** — default mode `plan` (read-only by mechanism), default model `gemini-3.7-flash-high` (fast, wide-context discovery tier) | The remote model delegates; a local agent reasons |
| `kiro` | `kiro_read` | Delegate a whole read-only task to a **local Kiro CLI agent**, hard-locked to `claude-sonnet-4.5`, `--trust-tools=fs_read` | The remote model delegates; a local agent reasons |
| `xkiro` | `xkiro_read`, `xkiro_status` | Use xKiro's free-tier API as a bounded read-only worker. The remote xKiro model receives only five scoped Aki read primitives inside the requested `cwd`; model selection is checked against the live catalog and must remain `access_tier=free`. | The remote model delegates; xKiro reasons and calls Aki's read-only primitives |
| `postman` (`scripts/postman-mcp.js`) | `postman_status` | Reports whether the `scripts/aki-pmcontrol/` daemon is running (own child or lab-started pid at `~/.aki/cdp-postman/daemon.pid`) and its `data.json`. Origin is the private lab `aiobox/labs/aki-pmcontrol`; this tree holds the finished copy (except `package.json`, a `{"type":"commonjs"}` shim). Launch is a panel action (`POST /api/postman-launch`), not this tool and not boot. | The remote model, directly — read-only, no CDP in the tool |

## Native host skills — browser and ImageGen

`skills/browser/SKILL.md` and `skills/imagegen/SKILL.md` are routing skills, not MCP tools. The panel's default Instructions tell every connected AI to load them when the task needs live web evidence or visual generation/editing. Browser work prefers the current host's native web/browser capability; ImageGen work prefers the current host's native image-generation/editing capability. Aki MCP remains responsible for local repo/files/shell context, so these skills compose host-native capabilities with Aki rather than pretending Aki exposes another provider's browser or image engine.

For a live-site-to-concept workflow, the order is fixed: inspect the live/current target with the browser skill, read the local implementation through Aki MCP, then use the ImageGen skill for the requested concept/artwork. If a host lacks the needed native capability, the skill reports the limitation instead of inventing a tool or substituting unrelated web images. The `skills/` directory is included in standalone payloads so the same routing works from source and packaged installs.

On Windows, both arms resolve their native per-user executables instead of relying only on the parent process PATH. `agy` plan mode also auto-approves CLI confirmation prompts because `--mode plan` remains the read-only enforcement boundary; non-plan modes do not receive that bypass. Kiro CLI 2.x is natively supported on Windows and the standard MSI installs per-user under `%LOCALAPPDATA%\\Kiro-Cli`.

## Web transports without custom MCP

Kimi Web and Qwen Coder Web can reach the same capability suite through the optional Cloudflare D1 mailbox. D1 is only asynchronous transport: each row names an existing MCP tool and JSON arguments, `scripts/d1-bridge.js` verifies the name against live `tools/list`, then calls it through the same shared in-process tools session as `/mcp`. It does not add a second shell/file policy or bypass the existing one.

Kimi Web K3 and Qwen Coder Web (`coder.qwen.ai`) are both live-verified through the narrow `cloudflare/qwen-bridge-worker` ingress and shared D1 mailbox. Kimi uses the custom domain `aki-bridge.oakgatekeeper.uk` plus its own `AKI_KIMI_SECRET` because its sandbox timed out on `*.workers.dev`; Qwen Coder retains `AKI_BRIDGE_SECRET`. The 1.10 canonical file-read name is `local__read_text_file`; `filesystem__read_text_file` remains as a compatibility alias for existing bridge prompts, and `local__run_cmd` is unchanged. Qwen Chat (`chat.qwen.ai`) is not equivalent: its Python sandbox returned `[Errno 101] Network is unreachable`, and its web extractor could only GET the Worker, not POST tasks. Setup: `docs/ref/kimi-web-d1-bridge.md` and `docs/ref/qwen-web-worker-bridge.md`.

## Two classes — and why the second is not redundant

**Direct primitives** (`filesystem`, `search`, `shell`) — the remote model calls them and does the reasoning itself.

**Agent arms / "hands"** (`xkiro`, `agy`, `kiro`) — the remote model hands off a *whole task* to another model/agent that reasons and uses a tightly scoped tool surface, then returns a conclusion. `xkiro` is the network/free-quota arm; `agy` and `kiro` remain local CLI arms.

An audit that only pattern-matches capabilities will call `kiro_read` "redundant — the model already has `find_path`/`search_content`/`run_cmd`." **That is a misclassification and the arms must not be removed on that basis.** An arm is not a file-reader; it is agent delegation, and it buys three things a direct primitive cannot:

- **Offload multi-step repository work** — a delegated model/agent runs the investigate/read/synthesize loop against scoped local evidence and returns a conclusion, instead of the calling model paying round-trips and context for every intermediate read.
- **Local trust scoping by mechanism** — the arm runs under its own locked tool set (`kiro` → `fs_read` only; `agy` → `plan` mode only), a boundary the remote model cannot widen from a prompt.
- **Model/tier choice per task** — `xkiro` consumes a free xKiro model only, `agy` reaches a wide-context discovery tier, and `kiro` is pinned to a specific Sonnet id for cost/behavior determinism.

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

`xkiro`, `agy`, and `kiro` are anchored owner worker requirements. They are **load-bearing** in the subtraction-audit sense: they carry real behavior (free-quota or local agent delegation) that direct primitives do not provide. Any future audit finding proposing their removal is rejected unless the owner re-decides the anchor. `xkiro` must remain free-only by default; the model lock on `kiro` (`claude-sonnet-4.5`) remains a hard requirement.

## History

- `kiro_write` was removed 2026-08-10 — it duplicated the `filesystem` arm's `write_file`/`edit_file` (a genuine primitive-vs-primitive duplication, unlike `kiro_read`). `docs/plan/done/remove-kiro-write.md`.
- Arm CLI facts (flags, model ids, effort enums) by evidence tier: `docs/ref/harness-fact.md`.
- Integration: `docs/plan/done/integrate-kiro-cli.md`, `docs/plan/done/integrate-gemini-grok.md`.
