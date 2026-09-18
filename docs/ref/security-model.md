# Security model — minimal OAuth 2.1 (Claude + ChatGPT)

Updated 2026-08-21 — Claude keeps a pre-issued confidential client; ChatGPT uses RFC 7591 DCR on the same server.

## Current auth architecture

```
claude.ai / ChatGPT
   │  GET /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
   │      (/.well-known/openid-configuration is served as an alias of the latter, so ChatGPT can auto-discover registration_endpoint)
   │  ChatGPT (and optionally Claude): POST /register  (DCR)
   ▼
gatekeeper.js  ── /register  → RFC 7591 (redirect URIs: Claude callback + chatgpt.com/connector/oauth/*)
               ── /authorize → confirmation page, requires passphrase (~/.aki/mcpsv/passphrase.txt)
               ── /token     → PKCE S256; confidential clients need client_secret, DCR public clients use none
               ── /mcp       → Bearer access token required, else 401 + WWW-Authenticate → tools server (in-process)
```

Pre-issued Claude credentials live in `~/.aki/mcpsv/oauth-client.json`. DCR clients (ChatGPT) persist in `~/.aki/mcpsv/oauth-dcr-clients.json`. Access/refresh tokens persist in `~/.aki/mcpsv/tokens.json`.

## Client registration

- **Claude (pre-registered)**: Client ID/Secret printed by `npm start`, pasted into Advanced settings. Redirect URI fixed to `https://claude.ai/api/mcp/auth_callback`. Auth method: `client_secret_post`.
- **ChatGPT (DCR)**: ChatGPT calls `POST /register` with its `https://chatgpt.com/connector/oauth/{id}` redirect URI. Auth method: `none` (PKCE only). Only Claude/ChatGPT redirect URI patterns are accepted — arbitrary third-party redirects are rejected.

## The 2 layers that actually block unauthorized access

1. **Passphrase at `/authorize`** (`~/.aki/mcpsv/passphrase.txt`, 10 random characters from a 32-character unambiguous alphabet — `abcdefghjkmnpqrstuvwxyz23456789`, ~50-bit entropy) — anyone who doesn't know the passphrase can't get past the consent step, so no auth code is ever issued. **Deliberately not a bare Approve button with no passphrase**: `POST /authorize` is public via Funnel; a simulated request can't be distinguished from a button click without a secret.
2. **PKCE S256** — an access token is only issued to the exact client whose `code_challenge` matches the `code_verifier` sent to `/token`.

Ingress edge does not change the trust boundary. Public reachability can come from Tailscale Funnel (default), a `PUBLIC_ORIGIN` edge you run, or a Cloudflare named tunnel (`--tunnel`) — these terminate TLS at different edges but all forward to the same loopback server, and the OAuth gate in `scripts/oauth.js` (passphrase at `/authorize` + PKCE S256 at `/token`) stays the only auth layer regardless of which one is used.

## Localhost security model (zero-trust loopback)

Local-First (2.x): the Gatekeeper binds `127.0.0.1:9999` unconditionally at startup, so local clients (Postman Desktop, Cursor, Claude Code, AGY, Codex) connect straight to the loopback engine — with or without a public ingress. Two rules keep that loopback surface safe:

1. **Bind `127.0.0.1`, never `0.0.0.0`.** `server.listen(port, '127.0.0.1', …)` makes the kernel refuse any packet that did not originate on this machine, so nothing else on the same Wi-Fi/LAN (a café, an office) can reach the port. Binding `0.0.0.0` would expose the whole tool surface to the local network.
2. **The Bearer token stays mandatory even on loopback.** "It's local, so skip auth" is a real vulnerability: a browser (Chrome/Safari) runs on the same machine, and a malicious page can fire `fetch('http://127.0.0.1:9999/mcp', …)` in the background. Without a required token that would be RCE via `local__run_cmd` or theft of local files (drive-by CSRF / DNS-rebinding). AKIMCP keeps requiring `Authorization: Bearer <token>` on loopback: the long-lived local token is issued by `getOrIssueAccessToken()` and stored under `~/.aki/mcpsv/`, and a request without a valid token gets `401`. The real defense is **token secrecy** — a web page can neither read the token off disk nor guess it. Do **not** rely on CORS here: the gatekeeper returns `Access-Control-Allow-Origin: *` and allows the `Authorization` header, so a malicious page can still *issue* the request — it simply can't supply a valid token, so it gets `401`.

Prefer the literal `127.0.0.1` over `localhost` everywhere (config, docs, snippets): on macOS `localhost` can resolve to IPv6 `::1` while the server listens on IPv4 only.

When no ingress is attached, the OAuth discovery and `/authorize` endpoints return `503` while local `/mcp` keeps serving normally; the `server.setPublicOrigin()` hook can turn them on in-process, but the current panel save-ingress flow applies a newly-picked ingress on restart (the hook is not yet wired to it).

## Real limitations

- **No refresh token rotation** for the pre-registered confidential Claude client (spec rotation rule targets public clients).
- **No rate-limiting on `/authorize`** — acceptable because the 50-bit passphrase makes brute-forcing infeasible.
- **DCR creates one stored client per ChatGPT connector instance** — delete `oauth-dcr-clients.json` (and restart) to revoke those registrations.

## Cross-references
- `docs/research/claude-ai-oauth-connector.md` — research that drove the Claude pre-registered path
- `docs/ref/claude-connector.md` — fields on claude.ai's dialog
- `docs/plan/done/init.md` — original architecture decisions
- OpenAI Apps SDK auth: https://developers.openai.com/apps-sdk/build/auth
