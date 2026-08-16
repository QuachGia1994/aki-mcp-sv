# Security model — minimal OAuth 2.1 (multi-client)

Updated 2026-08-16 — Claude keeps a pre-issued confidential client; public/DCR clients share one strict redirect allowlist and PKCE flow.

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
               ── /mcp       → Bearer access token required, else 401 + WWW-Authenticate → mcp-hub
```

Pre-issued Claude credentials live in `~/.aki/mcpsv/oauth-client.json`. DCR clients (ChatGPT) persist in `~/.aki/mcpsv/oauth-dcr-clients.json`. Access/refresh tokens persist in `~/.aki/mcpsv/tokens.json`.

## Client registration

- **Claude (pre-registered)**: Client ID/Secret printed by `npm start`, pasted into Advanced settings. Redirect URI fixed to `https://claude.ai/api/mcp/auth_callback`. Auth method: `client_secret_post`.
- **DCR/public clients**: ChatGPT and Grok self-register through `POST /register`; the allowlist also accepts Google's Gemini OAuth proxy prefixes and Mistral's fixed integration callback. Auth method: `none` (PKCE only). Arbitrary third-party redirect URIs are rejected.

## The 2 layers that actually block unauthorized access

1. **Passphrase at `/authorize`** (`~/.aki/mcpsv/passphrase.txt`, 10 random characters from a 32-character unambiguous alphabet — `abcdefghjkmnpqrstuvwxyz23456789`, ~50-bit entropy) — anyone who doesn't know the passphrase can't get past the consent step, so no auth code is ever issued. **Deliberately not a bare Approve button with no passphrase**: `POST /authorize` is public via Funnel; a simulated request can't be distinguished from a button click without a secret.
2. **PKCE S256** — an access token is only issued to the exact client whose `code_challenge` matches the `code_verifier` sent to `/token`.

The real `mcp-hub` still only listens on loopback `19999`, and `/api/*` is never forwarded.

Ingress edge does not change the trust boundary. Public reachability can come from Tailscale Funnel (default), a `PUBLIC_ORIGIN` edge you run, or a Cloudflare named tunnel (`--tunnel`) — these terminate TLS at different edges but all forward to the same loopback server, and the OAuth gate in `scripts/oauth.js` (passphrase at `/authorize` + PKCE S256 at `/token`) stays the only auth layer regardless of which one is used.

## Real limitations

- **No refresh token rotation** for the pre-registered confidential Claude client (spec rotation rule targets public clients).
- **No rate-limiting on `/authorize`** — acceptable because the 50-bit passphrase makes brute-forcing infeasible.
- **DCR creates one stored client per connector instance** — delete `oauth-dcr-clients.json` (and restart) to revoke those registrations.

## Cross-references
- `docs/research/claude-ai-oauth-connector.md` — research that drove the Claude pre-registered path
- `docs/ref/claude-connector.md` — fields on claude.ai's dialog
- `docs/plan/done/init.md` — original architecture decisions
- OpenAI Apps SDK auth: https://developers.openai.com/apps-sdk/build/auth
