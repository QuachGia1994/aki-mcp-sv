# aki-mcp-sv — project guidance

Give claude.ai a local MCP server (filesystem/search/shell/agy) over Tailscale Funnel + OAuth 2.1. Entry: `npm start` → `scripts/start.js` (foreground, manual stop/start). Rule loader: the `akirule` skill (see `~/.claude/skills/akirule/SKILL.md`).

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

Re-probe until the public edge returns 200. Full history and evidence: `docs/ref/oauth-research-2026-08-07.md` (rounds 5 and 8).

## Session lifecycle

`scripts/streamable-bridge.js` holds **one** internal hub session for the whole process; every external claude.ai client multiplexes onto it via JSON-RPC id remapping, and each `initialize` is answered locally from the cached hub result (docs/plan/bridge-session-churn.md, Option B). The hub therefore logs one connect at boot and one disconnect at shutdown, no matter how often claude.ai re-initializes — do not reintroduce a per-client session Map or an `MCP_MAX_SESSIONS` cap. The shared session re-boots transparently if its upstream SSE dies (hub restart). Per-request timeout only (`MCP_REQUEST_TIMEOUT_MS`, default 10 min). Tokens survive restarts via `scripts/oauth.js` (persisted); the funnel does not, per RECURRING #1.
