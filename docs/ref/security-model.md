# Security model — minimal OAuth 2.1 (multi-client)

Updated 2026-09-07 — Claude keeps a pre-issued confidential client; public/DCR clients share one strict redirect allowlist and PKCE flow on the same in-process server; operator remote-desktop access is a separate Cloudflare One private-app plane.

## Current auth architecture

```
claude.ai / ChatGPT
   │  GET /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
   │      (/.well-known/openid-configuration is served as an alias of the latter, so ChatGPT can auto-discover registration_endpoint)
   │  ChatGPT (and optionally Claude): POST /register  (DCR)
   ▼
gatekeeper.js  ── /register  → RFC 7591 (strict allowlist: Claude, ChatGPT, Gemini proxy, Grok, Mistral callbacks)
               ── /authorize → confirmation page, requires passphrase (~/.aki/mcpsv/passphrase.txt)
               ── /token     → PKCE S256; confidential clients need client_secret, DCR public clients use none
               ── /mcp       → Bearer access token required, else 401 + WWW-Authenticate → tools server (in-process)
```

Pre-issued Claude credentials live in `~/.aki/mcpsv/oauth-client.json`. DCR clients (ChatGPT) persist in `~/.aki/mcpsv/oauth-dcr-clients.json`. Access/refresh tokens persist in `~/.aki/mcpsv/tokens.json`.

The local Streamable HTTP endpoint at `127.0.0.1:19999/mcp` does not run a browser OAuth flow, but it does require one of those issued Aki Bearer access tokens before POST/DELETE reaches `streamable-bridge.js`. It still binds only to loopback, rejects any request carrying `Origin`, emits no CORS headers, and requires `application/json` for POST. The panel's ready-to-copy Postman Authorization value is a valid local-client Bearer value too.

Fresh filesystem scope is narrow by default: with no saved `folders`, `scripts/roots.js` grants only `process.cwd()` (or explicit `MCP_DATA_DIR`) plus the specific Aki rule surfaces needed by the generated Instructions: `~/.aki/akidevrule`, `~/.claude/CLAUDE.md`, `~/.claude/CLAUDE.local.md`, and `~/.claude/skills/akirule` when present. It does not implicitly grant the whole home directory, `~/.aki`, or `~/.claude`; a panel-saved list is authoritative and every row is removable. Upgrades do not silently rewrite an existing saved list, so older installs that explicitly persisted broad roots must narrow them from panel section 5 if desired.

## Client registration

- **Claude (pre-registered)**: Client ID/Secret printed by `npm start`, pasted into Advanced settings. Redirect URI fixed to `https://claude.ai/api/mcp/auth_callback`. Auth method: `client_secret_post`.
- **DCR/public clients**: ChatGPT and Grok self-register through `POST /register`; the allowlist also accepts Google's Gemini OAuth proxy prefixes and Mistral's fixed integration callback. Auth method: `none` (PKCE only). Arbitrary third-party redirect URIs are rejected. OAuth request bodies are capped at 64 KiB, and persistent DCR storage is capped at 128 clients so unauthenticated registration cannot grow memory/disk without bound.

## The 2 layers that actually block unauthorized public OAuth access

1. **Passphrase at `/authorize`** (`~/.aki/mcpsv/passphrase.txt`, 10 random characters from a 32-character unambiguous alphabet — `abcdefghjkmnpqrstuvwxyz23456789`, ~50-bit entropy) — anyone who doesn't know the passphrase can't get past the consent step, so no auth code is ever issued. **Deliberately not a bare Approve button with no passphrase**: `POST /authorize` is public via Funnel; a simulated request can't be distinguished from a button click without a secret.
2. **PKCE S256** — an access token is only issued to the exact client whose `code_challenge` matches the `code_verifier` sent to `/token`.

Ingress edge does not change the trust boundary. Public reachability can come from Tailscale Funnel (default), a `PUBLIC_ORIGIN` edge you run, or a Cloudflare named tunnel (`--tunnel`) — these terminate TLS at different edges but all forward to the same loopback server, and the OAuth gate in `scripts/oauth.js` (passphrase at `/authorize` + PKCE S256 at `/token`) stays the only auth layer regardless of which one is used.

Operator remote-desktop access is deliberately a **different plane** from Aki's public MCP ingress. When an iPhone remotely controls the Windows machine, prefer Cloudflare One private-hostname RDP through the Cloudflare One Client/WARP plus an Access private application/MFA; do not publish TCP 3389 directly and do not reuse Aki bearer tokens, OAuth client credentials, or the Aki passphrase as Windows/Cloudflare remote-desktop credentials. The phone controls the existing Windows session while Postman Desktop, Aki MCP, repositories, shell, build, and tests stay on Windows. See `docs/ref/postman-desktop-remote.md`.

Postman pool auto-join is another opt-in local automation plane, not MCP authentication. When `~/.aki/mcpsv/postman-pool.json` is enabled, a Telethon user-session listener receives only the owner's source-group messages and `scripts/postman-pool.js` still requires both the exact source chat ID and an allowlisted sender user ID before it accepts an invite. The source group never needs the report bot. The bot is outbound-only (`sendMessage`); Aki never calls `getUpdates`, `setWebhook`, or `deleteWebhook`, so a pre-existing ROBOT SLTP webhook can keep exclusive inbound ownership of the same bot token. Telegram API credentials/session and the report bot token stay user-local; invite URLs are never logged and reach the transient Python worker through stdin. For each selected LibreWolf profile, the worker creates a scratch session copy containing only the allowlisted session files and Postman web-storage origins, drives that copy through Selenium/geckodriver, then removes it; the original profile remains untouched and may stay open. Human Verify remains a manual checkpoint: Aki detects the challenge and waits in the same visible browser context without interacting with challenge controls. See `docs/ref/postman-pool-autojoin.md`.

## Real limitations

- **No refresh token rotation** for the pre-registered confidential Claude client; DCR/public clients rotate their refresh token on every refresh grant.
- **No rate-limiting on `/authorize`** — acceptable because the 50-bit passphrase makes brute-forcing infeasible; request bodies are still bounded before passphrase validation.
- **DCR creates one stored client per connector instance, capped at 128** — delete `oauth-dcr-clients.json` (and restart) to revoke those registrations or clear the cap.

## Cross-references
- `docs/research/claude-ai-oauth-connector.md` — research that drove the Claude pre-registered path
- `docs/ref/claude-connector.md` — fields on claude.ai's dialog
- `docs/ref/postman-desktop-remote.md` — Cloudflare One private-RDP operator plane for iPhone → Windows → Postman Desktop → Aki
- `docs/ref/postman-pool-autojoin.md` — Telegram allowlist, invite handling, LibreWolf session-copy boundary, manual Human Verify checkpoint, and join/report behavior
- `docs/plan/done/init.md` — original architecture decisions
- OpenAI Apps SDK auth: https://developers.openai.com/apps-sdk/build/auth
