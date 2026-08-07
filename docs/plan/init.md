# Init — opening MCP to AI outside the internet

## Ultimate goal
Open an MCP server so external AI services (first target: claude.ai) can interact with this Mac from outside the internet.

## Mandatory constraints
- **1 process, 1 single port** — no multiplexing several services, no added gateway/reverse-proxy.
- **Minimal** MCP tool set for interaction: file (read/write within one scoped directory, chosen at each launch) + bash (**READ-ONLY commands only**, whitelisted).

## Architecture decisions

| Issue | Decision | Why |
|---|---|---|
| Combining multiple child MCP servers | `mcp-hub` (internal, port `19999`, endpoint `/mcp`) | spawns child servers over stdio itself, folds their tools into one HTTP endpoint |
| Blocking mcp-hub's `/api/*` from the internet | `scripts/gatekeeper.js` (self-written, port `9999` — the REAL port the funnel points at) | **found:** `mcp-hub` has an admin REST API (`/api/*`: start/stop/reconfigure) with no auth at all, on the same port as `/mcp`. Forwarding the whole port through the funnel would expose admin control to the entire internet. The gatekeeper only forwards requests whose path is exactly `/mcp/<token>`; everything else (including `/api/*`) → 404 |
| Auth for `/mcp` | Minimal OAuth 2.1 (`scripts/oauth.js`), DCR skipped — self-issued Client ID/Secret, pasted by hand into Advanced settings | **Changed 2026-08-07**: token-in-URL hit a real claude.ai bug — it always attempts Dynamic Client Registration even with the OAuth field left blank, failing with "Couldn't register with sign-in service" (confirmed via public GitHub issue `anthropics/claude-ai-mcp#457`). Self-issued Client ID/Secret is the only way to skip DCR without a beta field. Detail: `docs/ref/oauth-research-2026-08-07.md` |
| Exposing to the internet | `tailscale funnel 9999` pointed at the **gatekeeper**, not directly at mcp-hub | the gatekeeper is the sole security choke point; mcp-hub (19999) only listens on loopback, never exposed directly |
| No nginx | dropped, replaced with a ~40-line Node script | same job (path-filter + token-check), stays consistent with the existing `shell-mcp.js`, no added system dependency |
| No `tailscale serve` | dropped | `serve` only publishes within the tailnet; claude.ai isn't part of this machine's tailnet so it can't reach it — `funnel` is required |
| No `shell-mcp` (the npm package) for the whitelist | dropped, replaced with the self-written `scripts/shell-mcp.js` | the real `shell-mcp` package on npm **has no whitelist** — just one `execute` tool that runs any command. The whitelist has to be enforced in code (`execFile`, no shell, blocking `; & \| ...`) |

## Funnel limitations to know about
- Free on every Tailscale plan.
- Only runs on one of 3 ports: `443` / `8443` / `10000` — an arbitrary port can't be published.
- Bandwidth is limited but Tailscale doesn't publish a specific number.
- Toggling funnel on/off repeatedly (re-issuing certs each time) can hit a Let's Encrypt rate limit — a ~34-hour lockout. Keep the funnel running steadily, avoid toggling.

## Permissions — decisions

| Issue | Decision | Mechanism |
|---|---|---|
| Shell command whitelist | **READ-ONLY commands only**: `ls`, `cat`, `pwd`, `find`, `grep`, `head`, `tail`, `wc`, `file`, `stat`, `tree`, `git status/log/diff/show`, `ps`, `df`, `du`, `whoami`, `uname` — no write commands, no `env` | enforced in code in `scripts/shell-mcp.js`: `execFile` (no shell) + blocking chaining characters `; & \| \` $ < >` |
| Filesystem scope — chosen flexibly per session | **Choosable at process launch, NOT per prompt.** The MCP filesystem server locks its root path at start (this is MCP's own deliberate security boundary — if a client could pick the path on every tool call, the whitelist would be meaningless, since the AI could request any path). Made flexible via an environment variable instead: `MCP_DATA_DIR=/other/path npm start` — changes scope per launch, still fixed for the duration of that run. **Changed 2026-08-07**: default switched from `./data` to `$HOME` — the one directory guaranteed to exist on every machine and to hold the code a user actually wants Claude to reach; `./data` saw almost no real-world use. See `README.md`. `list_allowed_directories`/`directory_tree` (built-in filesystem MCP tools) act as an automatic "index" — Claude calls them itself to learn the scope and explore inside it, no separate index needed. **Revisited later**: `~/.claude` was granted access so claude.ai can read the native `CLAUDE.md`/skill router the same way Claude Code does; the consequences (tokens, chat history living in the same directory) are documented in `README.md` for the user to decide on | default `$HOME` is set in `package.json` (`start` script); `mcp-hub.config.json` reads only the bare `${MCP_DATA_DIR}`, with no fallback of its own |
| Running in the background | **No** — deliberately run `npm start` when needed (foreground, Ctrl+C to stop), no pm2/launchd | manual |
| Funnel enabled per project, no need to re-enable each time | **Automatic via `npm start`** (`tailscale funnel --bg 9999`, tailscaled's background mode) — the config is stored in `tailscaled`'s (the system daemon's) own state, surviving both closing the terminal and rebooting the machine. `start.js` checks `tailscale funnel status --json` first and only calls `--bg` when the port isn't already on (idempotent, avoiding repeated toggling that risks the Let's Encrypt rate limit). Fully disabled with `tailscale funnel 9999 off` | `scripts/start.js` calls the tailscale CLI |
| Passphrase/OAuth credentials for convenience | Passphrase (`~/.aki/mcpsv/passphrase.txt`) + OAuth client ID/Secret (`~/.aki/mcpsv/oauth-client.json`) auto-generated and saved on first run, read back on later runs | `scripts/start.js`, `scripts/oauth.js` |

## Execution checklist
- [x] `package.json` — deps `mcp-hub`, `@modelcontextprotocol/sdk`, `zod`; `start` script → `scripts/start.js`
- [x] `scripts/shell-mcp.js` — `run_cmd` tool, read-only whitelist
- [x] `scripts/oauth.js` — minimal authorization server (DCR skipped, PKCE S256)
- [x] `scripts/gatekeeper.js` — OAuth metadata/authorize/token + `/mcp` reverse-proxy (Bearer-gated)
- [x] `scripts/start.js` — orchestrates mcp-hub (internal 19999) + gatekeeper (public 9999), prints URL + client ID/secret
- [x] `mcp-hub.config.json`, `data/`
- [x] Local test (curl, no funnel): metadata 200, `/mcp` without bearer → 401, wrong path → 404, full authorize→token→bearer /mcp flow → auth passes (502 since mcp-hub wasn't wired up yet, as expected), wrong bearer → 401
- [x] Switched away from token-in-URL after hitting the real DCR bug testing against claude.ai — see `docs/ref/oauth-research-2026-08-07.md`
- [x] `npm start` (new OAuth version) — prints URL + client ID/secret
- [x] Add custom connector on claude.ai: paste URL + client ID/secret, Connect, approve with the passphrase — `/authorize` worked correctly (GET 200, POST 302 with a valid code)
- [x] Real root cause confirmed + fixed: **Tailscale Funnel desynced from the control plane** (serve-config showed "on" locally but hadn't propagated to public infrastructure) — not a code bug. Fix: `tailscale funnel --bg 9999` (forces a config re-push). Verified via `curl --resolve` directly against the public IP (`dig @8.8.8.8`) — full `/authorize` → `/token` round trip 200 OK over the real path. Full investigation history: `docs/ref/oauth-research-2026-08-07.md`
- [x] Full OAuth flow confirmed working on real claude.ai after the Funnel fix: `POST /token -> 200`
- [x] Next fix: `mcp-hub` (`4.2.1`) uses the legacy SSE transport (`GET /mcp` → sessionId → `POST /messages?sessionId=...`), and the gatekeeper previously only proxied `/mcp`, so it wrongly blocked `/messages`. Opened the route, verified locally with `202 Accepted`. Detail: `docs/ref/oauth-research-2026-08-07.md` "Debug round 6"
- [x] Next fix: real logs showed claude.ai never opens `GET /mcp` to fetch the SSE `endpoint`, it just POSTs straight to `/mcp` — never reaching `tools/list` ("no tools available"). Wrote `scripts/streamable-bridge.js`: a real Streamable HTTP shim at `POST /mcp`, bridging internally to mcp-hub's legacy transport. Verified locally by simulating claude.ai's exact request pattern → `tools/list` returned all 15 tools. Detail: `docs/ref/oauth-research-2026-08-07.md` "Debug round 7"
- [x] Real connection test from claude.ai (UI) after the Streamable HTTP shim fix — **confirmed working 2026-08-07**: connector connects, tool list shows the full set (14 `filesystem__*` + `shell__run_cmd`). MVP complete end to end.

## Cross-references
- `README.md` — setup and how to run
- `docs/ref/claude-connector.md` — the real fields on claude.ai's dialog
- `docs/ref/oauth-research-2026-08-07.md` — research behind the switch to OAuth, dates and sources
- `docs/ref/security-model.md` — current OAuth security model

## Decision
**Action** → `README.md` (setup steps already reflect this decision).
