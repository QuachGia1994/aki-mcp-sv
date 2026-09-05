# aki-mcp-sv — project guidance

Local MCP server (filesystem, search, shell, agy/Kiro, optional xKiro free-tier read worker, optional read-only claude-mem lookup, and read-only Postman control status) for Claude/ChatGPT/Grok/Gemini over HTTPS + OAuth 2.1, local desktop clients over loopback-only Streamable HTTP (`127.0.0.1:19999/mcp`), plus opt-in Kimi Web K3 and Qwen Coder Web transports through a shared Cloudflare Worker + D1 mailbox. Kimi reaches the Worker through `aki-bridge.oakgatekeeper.uk`; Qwen Coder uses the same `cloudflare/qwen-bridge-worker`. Client secrets are separate, and task creation is retry-safe through required `Idempotency-Key`. Entry: `npm start` → `scripts/start.js` (foreground, manual stop/start). Rule loader: `akirule` skill.

## RECURRING #1 — "Couldn't connect" / no `POST /token`: Tailscale Funnel desync, NOT the code

Signature: `npm start` is healthy, funnel status says "on", but client reports "Couldn't connect" and gatekeeper stops at `POST /authorize -> 302` with **no `POST /token`**. The local serve-config did not sync to Tailscale's public edge; external calls fail at the TLS layer.

- **Do not debug `scripts/oauth.js` or `scripts/gatekeeper.js`** — OAuth & bridge code are correct.
- **Do not trust local `curl https://$HOST`** — macOS WireGuard mesh (`100.100.100.100`) returns a false 200. Always probe the public IP via `--resolve`:
  ```bash
  HOST=$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//'); PUB=$(dig @8.8.8.8 $HOST +short | head -1)
  curl --resolve $HOST:443:$PUB https://$HOST/.well-known/oauth-authorization-server   # exit 35 / 000 = desync
  ```
- **Reset cycle**:
  ```bash
  tailscale funnel --https=443 off && tailscale serve reset && tailscale funnel --bg 9999
  ```
- **Bypass / Ingress precedence**: `--tunnel <cred.json>` (Cloudflare) > `PUBLIC_ORIGIN` > Tailscale Funnel.

## Two client paths, one OAuth server

`scripts/oauth.js` serves both without handler-level branching:
- **Claude**: Pre-registered confidential client in `oauth-client.json` (`client_secret_post`).
- **ChatGPT**: Public client via RFC 7591 DCR (`POST /register`), PKCE only, stored in `oauth-dcr-clients.json`.
- **Invariants**: `resolveClient()` is the single SSoT lookup for both. Redirect URIs are strictly allowlisted in `isAllowedRedirect` (`claude.ai`, `chatgpt.com`, `googleusercontent.com`, `grok.com`). Auth codes and refresh tokens are bound to their issuing client ID.

## OS-agnostic by decision, not by accident

- **Data tables only**: Platform differences exist strictly as declarative maps indexed by `process.platform` (`LAUNCHER` in `open-browser.js`, `WIN_EXTRA` in `allowlist.js`). Never branch business logic (`if (win32)`).
- **Prerequisites over fallbacks**: Windows runs Unix binaries via Git for Windows (`grep`, `find`). Do not add pure-JS reimplementations.
- **Permanently removed**: `scripts/chrome.js` stays deleted (Chrome 136 blocks remote debugging on default profile) and native folder picker stays removed.

## Session lifecycle

- **Single shared session**: `scripts/streamable-bridge.js` maintains exactly **one** internal session for the process, held over an in-process `InMemoryTransport` pair (no child process, no SSE). OAuth-public `/mcp`, loopback-only `/mcp`, and D1 bridge calls all reuse the same tool registry/session policy; external HTTP clients multiplex onto it via JSON-RPC ID remapping and `initialize` is answered locally from cache.
- **No per-client session Map**: Never reintroduce per-client session tracking or an `MCP_MAX_SESSIONS` cap.
- **Timeouts & Persistence**: Per-request timeout only (`MCP_REQUEST_TIMEOUT_MS`, default 10m). Tokens persist in `scripts/oauth.js`; Funnel routing is ephemeral.

## Process topology (Stage 2 — single process)

The core Aki server stays 1 Node process. `start.js` orchestrates: in-process gatekeeper (OAuth + public `/mcp`), loopback-only Streamable HTTP MCP on `127.0.0.1:19999`, panel, optional `d1-bridge.js` polling, and a boot-time `warmToolsServer()` call. `scripts/tools-server.js` builds the one shared `McpServer`, mounting `shell`, `agy`, `kiro`, optional `xkiro_read`/`xkiro_status`, `search`, optional read-only `claude-mem`, native `filesystem`, and read-only `postman_status`. Both HTTP entry points and the optional D1 bridge call the same `streamable-bridge.js` shared session, so local desktop clients and Qwen/Kimi do not add a second policy surface. Canonical tool names are `local__*`; the native filesystem tools also keep `filesystem__*` compatibility aliases for pre-1.10 bridge prompts. Folder scope (`scripts/roots.js`) is read fresh from `setting.json` on every call — a panel save takes effect on the next tool call, no restart. Claude-mem is an HTTP client module only: it may expose `local__claude_mem_search`, `local__claude_mem_timeline`, and `local__claude_mem_get_observations`, never capture/write/delete tools. xKiro is also network-only: `scripts/xkiro-mcp.js` uses built-in `fetch`, must remain free-tier/read-only by default, and gives the remote model no write/shell tool. The Postman control daemon under `scripts/aki-pmcontrol/` is the only optional child process: it starts only from the panel's Postman Launch action, never at boot, and `scripts/postman-mcp.js` exposes status plus panel lifecycle helpers. There is no `mcp-hub` and no third-party filesystem child.

## Release process

Governed directly by `RULE-release.md` (`B4`, `B6`, `B7`). Repo-specific deltas:
- **No `releases.json`**: CLI/local app; `CHANGELOG.md` + GitHub Release are the only release artifacts.
- **Bare semver tags**: New git tags must be bare semver (`1.7.0`, not `v1.7.0`). Existing `v1.x.x` tags are immutable history. Display title may show `v{version}`.
- **Drift check**: Before committing, verify section numbers in `scripts/config-page.js`, `README.md`, and `docs/index.md`.
- **Immutability**: `done/` plan docs and released CHANGELOG blocks are read-only.
