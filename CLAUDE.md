# aki-mcp-sv — project guidance

Give claude.ai and ChatGPT a local MCP server (filesystem/search/shell/agy) over Tailscale Funnel + OAuth 2.1. Entry: `npm start` → `scripts/start.js` (foreground, manual stop/start). Rule loader: the `akirule` skill (see `~/.claude/skills/akirule/SKILL.md`).

## RECURRING #1 — "Couldn't connect" / no `POST /token`: it's Tailscale Funnel desync, NOT the code

Signature (identical every time): `npm start` is healthy, `tailscale funnel status` says "on", but claude.ai reports "Couldn't connect to the server" and the gatekeeper log stops at `POST /authorize -> 302` with **no `POST /token` line**. The funnel serve-config saved locally but never synced to Tailscale's public edge, so a real client (Anthropic's backend calling `/token`) dies at the TLS layer.

**Do not debug `scripts/oauth.js` / `gatekeeper.js` first** — the OAuth server, the Streamable HTTP shim (`streamable-bridge.js`), and the session bridge are correct. Check the funnel edge:

```
HOST=aki-mba16.tailf23d51.ts.net; PUB=$(dig @8.8.8.8 $HOST +short | head -1)
curl --resolve $HOST:443:$PUB https://$HOST/.well-known/oauth-authorization-server   # 000/exit 35 = desync
```

A bare `curl https://$HOST` **from this Mac lies** — the tailnet resolver (`100.100.100.100`) sends it through the internal WireGuard mesh and returns a false 200. Always test the public path with `--resolve` against the `dig @8.8.8.8` IP.

Fix, in order: re-push `tailscale funnel --bg 9999`; if the `--resolve` probe is still `000` after ~30s, run the full reset cycle:

```
tailscale funnel --https=443 off && tailscale serve reset && tailscale funnel --bg 9999
```

Re-probe until the public edge returns 200. Full history and evidence: `docs/research/claude-ai-oauth-connector.md` (rounds 5 and 8).

The permanent way out of fighting Funnel desync is to bypass Funnel entirely: set `PUBLIC_ORIGIN` to a stable HTTPS edge you run, or launch a Cloudflare named tunnel with `npm start -- --tunnel <cred.json> --origin https://your-host` (precedence: `--tunnel` > `PUBLIC_ORIGIN` > Tailscale Funnel). Neither is measured to be more reliable than Funnel — they just move TLS termination off the Tailscale edge. Details: `docs/plan/cloudflare-tunnel-ingress.md`.

## Two client paths, one OAuth server

`scripts/oauth.js` serves both. Claude uses the **pre-registered** confidential client from `oauth-client.json` (ID/secret pasted into the connector dialog). ChatGPT **self-registers** through `POST /register` (RFC 7591) as a public client — no secret, PKCE only — and lands in `oauth-dcr-clients.json`. `resolveClient()` is the single lookup covering both, so never special-case one client inside a handler. Redirect URIs are allowlisted to `claude.ai` and `chatgpt.com` by `isAllowedRedirect`; widening that function is the one place a bad redirect could enter. Authorization codes and refresh tokens are bound to the client they were issued to.

## OS-agnostic by decision, not by accident

`docs/plan/unify-windows-linux.md` — per-OS difference is allowed as a **data table** selected by `process.platform` (the `LAUNCHER` map in `open-browser.js`, `WIN_EXTRA` in `allowlist.js`), never as a branch in business logic and never as a second implementation of an existing mechanism. Windows shells out to Unix binaries via Git for Windows; that prerequisite was chosen deliberately over a fallback implementation, so do not add a pure-JS reimplementation of `grep`/`find` when something is missing on Windows. `scripts/chrome.js` stays deleted (Chrome 136 refuses remote debugging on the default profile) and the native folder picker stays removed. Merge record: `docs/plan/merge-pr1-windows-chatgpt.md`.

## Session lifecycle

`scripts/streamable-bridge.js` holds **one** internal hub session for the whole process; every external claude.ai client multiplexes onto it via JSON-RPC id remapping, and each `initialize` is answered locally from the cached hub result (docs/plan/bridge-session-churn.md, Option B). The hub therefore logs one connect at boot and one disconnect at shutdown, no matter how often claude.ai re-initializes — do not reintroduce a per-client session Map or an `MCP_MAX_SESSIONS` cap. The shared session re-boots transparently if its upstream SSE dies (hub restart). Per-request timeout only (`MCP_REQUEST_TIMEOUT_MS`, default 10 min). Tokens survive restarts via `scripts/oauth.js` (persisted); the funnel does not, per RECURRING #1.

## Process topology (Stage 1 consolidation, docs/plan/consolidate-mcp-tool-processes.md)

Four Node processes, not the old eight. `start.js` runs the orchestrator **plus** the gatekeeper (OAuth + `/mcp`) and the panel in-process — `gatekeeper.js` is now `export startGatekeeper(origin, onFatal)`, not a spawned child, so a fatal listen error calls `shutdown` and `process.on('exit')` kills the hub as a safety net. The four in-house tool servers (`shell`/`agy`/`kiro`/`search`-mcp.js) are `register(server)` modules mounted onto one `McpServer` in `scripts/local-tools-mcp.js`, spawned by `mcp-hub` as the single `local` entry in `mcp-hub.config.json` (only `filesystem` + `local` remain). mcp-hub prefixes by config key, so those tools are `local__*` (`local__run_cmd`, `local__agy_run`, `local__kiro_read`, `local__find_path`, `local__search_content`). `mcp-hub` and the `npx filesystem` child are deliberately kept — dropping them is Stage 2 (`docs/plan/unify-mcp-tools-single-process.md`), which crosses the session/bridge and filesystem-reimpl boundaries.

## Release process

`RULE-release.md` governs this directly now (B4 covers GitHub Release creation, B6 the content discipline, B7 the pre-ship gate) — no local override needed. Do the whole sequence in one go, no waiting to be told. Repo-specific facts:

- No `releases.json` (CLI/local app, not a Nuxt web stack) — `CHANGELOG.md` + the GitHub Release are the only public artifacts (`release.C1` doesn't apply here).
- Existing tags (`v1.2.0`…`v1.6.0`) are `v`-prefixed, a historical drift from `release.A3`'s bare-semver rule. Per A3, correct the drift going forward rather than keep it as precedent: **new tags are bare semver** (`1.7.0`, not `v1.7.0`). Past tags stay untouched (immutable history, B3). The GitHub Release **title** may still show `v{version}` — A3 allows the `v` prefix at display time, only the stored tag/manifest value must be bare.
- Repoint drift before committing: any in-panel/README/`docs/index.md` "section N" reference the change moved — `scripts/config-page.js` section numbers are a recurring offender, verify against the code, not memory.
- GitHub Release title format: `v{version} — {2–5 word specific impact}`, no generic words. Body: same `#### Added/Changed/Fixed` sections as CHANGELOG but trimmed to one short sentence each — symptom first, no file paths, no internal jargon (`release.B4`). No em/en dash in the release note copy (`release.B6`); CHANGELOG.md itself keeps its existing style. Always end with the compare-link footer: `**Full Changelog**: <repo-url>/compare/<prev-tag>...<new-tag>`.

`done/` plan docs and already-released CHANGELOG blocks are immutable — never rewrite them; drift fixes go in living docs (`docs/index.md` one-liners, README) only.
