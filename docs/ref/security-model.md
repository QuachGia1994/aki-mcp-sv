# Security model — minimal OAuth 2.1 (Claude + ChatGPT)

Updated 2026-08-08 — Claude keeps a pre-issued confidential client; ChatGPT uses RFC 7591 DCR on the same server.

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
               ── /mcp       → Bearer access token required, else 401 + WWW-Authenticate → mcp-hub
```

Pre-issued Claude credentials live in `~/.aki/mcpsv/oauth-client.json`. DCR clients (ChatGPT) persist in `~/.aki/mcpsv/oauth-dcr-clients.json`. Access/refresh tokens persist in `~/.aki/mcpsv/tokens.json`.

## Client registration

- **Claude (pre-registered)**: Client ID/Secret printed by `npm start`, pasted into Advanced settings. Redirect URI fixed to `https://claude.ai/api/mcp/auth_callback`. Auth method: `client_secret_post`.
- **ChatGPT (DCR)**: ChatGPT calls `POST /register` with its `https://chatgpt.com/connector/oauth/{id}` redirect URI. Auth method: `none` (PKCE only). Only Claude/ChatGPT redirect URI patterns are accepted — arbitrary third-party redirects are rejected.

## The 2 layers that actually block unauthorized access

1. **Passphrase at `/authorize`** (`~/.aki/mcpsv/passphrase.txt`, 10 random characters from a 32-character unambiguous alphabet — `abcdefghjkmnpqrstuvwxyz23456789`, ~50-bit entropy) — anyone who doesn't know the passphrase can't get past the consent step, so no auth code is ever issued. **Deliberately not a bare Approve button with no passphrase**: `POST /authorize` is public via Funnel; a simulated request can't be distinguished from a button click without a secret.
2. **PKCE S256** — an access token is only issued to the exact client whose `code_challenge` matches the `code_verifier` sent to `/token`.

The real `mcp-hub` still only listens on loopback `19999`, and `/api/*` is never forwarded.

## Real limitations

- **No refresh token rotation** for the pre-registered confidential Claude client (spec rotation rule targets public clients).
- **No rate-limiting on `/authorize`** — acceptable because the 50-bit passphrase makes brute-forcing infeasible.
- **DCR creates one stored client per ChatGPT connector instance** — delete `oauth-dcr-clients.json` (and restart) to revoke those registrations.

## Cross-references
- `docs/ref/oauth-research-2026-08-07.md` — research that drove the Claude pre-registered path
- `docs/ref/claude-connector.md` — fields on claude.ai's dialog
- `docs/plan/init.md` — original architecture decisions
- OpenAI Apps SDK auth: https://developers.openai.com/apps-sdk/build/auth
