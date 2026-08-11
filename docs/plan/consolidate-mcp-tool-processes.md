# Plan: Consolidate redundant MCP Node processes (Stage 1 — low risk)

## Status
Code complete, statically verified (`node --check` on all edited files, module imports resolve, `register` exports confirmed). Runtime verification (`npm start` + live client) is user-triggered — pending. Stage 1 of the process-reduction effort; Stage 2 (single process) is deferred to `docs/plan/unify-mcp-tools-single-process.md`.

## Goal
Cut redundant Node.js V8 runtimes from **8 processes to 4** without touching any runtime-risky boundary — no change to OAuth, the Streamable HTTP bridge, the claude.ai session lifecycle, or the filesystem tool. Every change here is on our own code, in-process, so it carries no protocol/session risk.

## Process inventory

| # | Process | Role | Owner | Stage 1 |
|---|---|---|---|---|
| 1 | `start.js` (+ panel :9998) | orchestrator, control panel | ours | keeps |
| 2 | `gatekeeper.js` :9999 | OAuth + HTTP `/mcp` | ours | **folded into `start.js`** |
| 3 | `mcp-hub` :19999 | aggregate + namespace tools | external | keeps (Stage 2) |
| 4 | `shell-mcp` | shell tool | ours | **merged → `local-tools-mcp`** |
| 5 | `agy-mcp` | agy tool | ours | **merged → `local-tools-mcp`** |
| 6 | `kiro-mcp` | kiro tool | ours | **merged → `local-tools-mcp`** |
| 7 | `search-mcp` | search tool | ours | **merged → `local-tools-mcp`** |
| 8 | `npx filesystem` | filesystem tool | external | keeps (Stage 2) |

Result: `start.js` (hosts gatekeeper + panel), `mcp-hub`, `local-tools-mcp`, `npx filesystem` = **4 processes**.

## Out of scope (deferred to Stage 2)
- Dropping `mcp-hub` — would rewire `/mcp` and touch the documented claude.ai session handling (CLAUDE.md § Session lifecycle, `docs/plan/bridge-session-churn.md`).
- Replacing `npx @modelcontextprotocol/server-filesystem` — the package ships only as a CLI (no importable server), so removing it means reimplementing ~14 filesystem tools by hand (security-sensitive path handling).

Both are the only paths below 4 processes, and both replace **external** code, so they belong in their own risk-sized run.

## Execution

### Part A — merge 4 tool servers into one process
- Convert `shell-mcp.js`, `agy-mcp.js`, `kiro-mcp.js`, `search-mcp.js` from standalone stdio entry scripts into modules exporting `register(server)`. Each domain's logic stays in its own file — we merge the *process*, not the *code* (SRP / module boundaries preserved).
- New `scripts/local-tools-mcp.js`: one `McpServer`, calls all four `register()` fns, connects a single `StdioServerTransport`.
- `mcp-hub.config.json`: replace the four `search`/`shell`/`agy`/`kiro` entries with one `local` entry → `node ./scripts/local-tools-mcp.js`. Keep `filesystem`.

**Consequence (accepted):** mcp-hub prefixes tool names with the config key, so the four tools move from `shell__run_cmd` / `agy__agy_run` / `kiro__kiro_read` / `search__find_path` / `search__search_content` to `local__*`. claude.ai and ChatGPT re-discover tools on reconnect — no data or capability is lost.

### Part B — fold gatekeeper into start.js
- `gatekeeper.js`: wrap its server setup in an exported `startGatekeeper(origin, onFatal)` that returns the `http.Server` (origin passed as an argument instead of read from `PUBLIC_ORIGIN`; fatal listen error calls `onFatal` instead of `process.exit`).
- `start.js`: call `startGatekeeper(origin, shutdown)` in-process instead of `spawnNode(['./scripts/gatekeeper.js'])`; close the returned server in `shutdown()`. `mcp-hub` is still a spawned child; `process.on('exit')` kills it as a safety net.

## Verification
- Static: `node --check` on every edited file.
- Runtime (user-triggered): `npm start`, then `ps` — confirm 4 process count; confirm all five tools (`local__run_cmd`, `local__agy_run`, `local__kiro_read`, `local__find_path`, `local__search_content`, plus `filesystem__*`) list and execute from a client.

## Cross-references
- `docs/plan/unify-mcp-tools-single-process.md` — Stage 2 endgame (single process), deferred; builds on this.
- `docs/plan/done/bridge-session-churn.md` — the session logic Stage 1 deliberately does not touch.
- `docs/plan/done/init.md` — original multi-process architecture decision.
