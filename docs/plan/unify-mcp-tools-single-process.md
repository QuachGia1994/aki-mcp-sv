# Plan: Unify MCP tool servers into a single Node.js process (Stage 2 — deferred)

## Status
Deferred. This is the endgame that follows `docs/plan/consolidate-mcp-tool-processes.md` (Stage 1, which reduces 8 → 4 processes at low risk). Stage 2 removes the last two processes but crosses two risk boundaries, so it is sized as its own run and not started with Stage 1.

## Goal
From the 4-process baseline Stage 1 leaves, reach a **single Node.js process** by removing the two remaining external processes (`mcp-hub` and the `npx` filesystem server), cutting baseline RAM toward ~40MB.

## Why it is separate from Stage 1
Both remaining removals replace **external** code and touch a documented, runtime-only-verifiable boundary:

1. **Drop `mcp-hub`.** mcp-hub is what `/mcp` reaches through `streamable-bridge.js`. Removing it means rewiring the bridge to talk to the in-process `McpServer` (SDK `InMemoryTransport`, or replacing the bridge with the SDK's `StreamableHTTPServerTransport`). Either way it changes the claude.ai session-multiplexing logic that CLAUDE.md § Session lifecycle and `docs/plan/done/bridge-session-churn.md` (Option B) call out as correct and hard-won — verifiable only against a live claude.ai client.

2. **Replace `npx @modelcontextprotocol/server-filesystem`.** It is not a project dependency; mcp-hub spawns it via `npx -y` and it ships only as a CLI (no importable server factory). Going in-process means reimplementing its ~14 tools (`read_file`, `write_file`, `edit_file`, `directory_tree`, `search_files`, `get_file_info`, …) natively. Path validation must route through the existing `scripts/roots.js` boundary — a security-sensitive surface, so it needs its own review.

## Prerequisite
Stage 1 complete: the four in-house tool servers already merged into `scripts/local-tools-mcp.js` behind a `register(server)` interface, and `gatekeeper` folded into `start.js`. Stage 2 reuses that same `register()` pattern to mount the tools on the in-memory server.

## Sketch (to be detailed when this run is sized)
1. Build `scripts/unified-server.js`: one `McpServer`, mount all `register()` tool modules plus a native filesystem module.
2. Wire `/mcp` to it — decide `InMemoryTransport` + keep bridge, vs. SDK `StreamableHTTPServerTransport` replacing the bridge.
3. Native filesystem module reusing `roots.js`, at parity with the current tool surface.
4. Remove `mcp-hub` dependency, `mcp-hub.config.json`, and port `19999`.
5. Verify against a live claude.ai + ChatGPT connector, and measure RAM before/after.

## Cross-references
- `docs/plan/consolidate-mcp-tool-processes.md` — Stage 1 (the low-risk 8 → 4 reduction), prerequisite.
- `docs/plan/done/bridge-session-churn.md` — session logic that Stage 2 must preserve when dropping mcp-hub.
- `docs/plan/done/init.md` — original multi-process architecture decision.
