# Security model — minimal OAuth 2.1 (DCR skipped)

Updated 2026-08-07 — replaces the earlier token-in-URL scheme, after token-in-URL was found to hit a claude.ai OAuth/DCR bug (detail + sources: `docs/ref/oauth-research-2026-08-07.md`).

## Current auth architecture

```
claude.ai
   │  GET /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
   │  (endpoint discovery, no registration needed — no /register)
   ▼
gatekeeper.js  ── /authorize  → confirmation page, requires the right passphrase (~/.aki/mcpsv/passphrase.txt)
               ── /token      → exchanges a code (PKCE S256) for access + refresh tokens
               ── /mcp        → requires a valid `Authorization: Bearer <access_token>`
                                  wrong/missing → 401 + WWW-Authenticate, correct → forward to mcp-hub
```

`scripts/oauth.js` keeps all state (auth codes, access tokens, refresh tokens) **in memory** — no DB, nothing persists across a restart.

## Why Dynamic Client Registration (DCR) is skipped

claude.ai defaults to attempting client self-registration (`POST /register`) before connecting — this server has no such endpoint, and `/.well-known/oauth-authorization-server` **deliberately** does not advertise `registration_endpoint`. Instead, `client_id`/`client_secret` are generated once (`~/.aki/mcpsv/oauth-client.json`), printed at `npm start`, and pasted by hand into the dialog's Advanced settings — exactly the "pre-registered client credentials" mechanism Anthropic's own docs recognize as a valid way to skip DCR entirely.

## The 2 layers that actually block unauthorized access

1. **Passphrase at `/authorize`** (`~/.aki/mcpsv/passphrase.txt`, 10 random characters from a 32-character unambiguous alphabet — `abcdefghjkmnpqrstuvwxyz23456789`, ~50-bit entropy) — anyone who doesn't know the passphrase can't get past the consent step, so no auth code is ever issued. Shortened from the original 256-bit hex on 2026-08-07 to be easier to type/copy by hand — 50-bit entropy still keeps the "no rate-limit needed" reasoning below intact. **Deliberately not a bare Approve button with no passphrase**: considered and rejected — `POST /authorize` is a public endpoint exposed through Funnel, and a simulated request (`curl`) can send the exact same fields a button click would, so the server can't tell them apart; a "button" with no accompanying secret provides no real protection.
2. **PKCE S256** — an access token is only issued to the exact client whose `code_challenge` matches the `code_verifier` sent to `/token`; this blocks anyone who intercepts the authorization code in transit (without the verifier, the code is useless).

The real `mcp-hub` still only listens on loopback `19999`, and `/api/*` is never forwarded — unchanged from the original design.

## Real limitations of this approach

- **No refresh token rotation** — acceptable because this is a confidential client (has a client_secret), not a public client under DCR/CIMD (the MCP spec's rotation rule only applies to public clients).
- **Restarting `npm start` loses every issued session** — access/refresh tokens live only in RAM. claude.ai will need to "Connect" again. An acceptable tradeoff for a single-user MVP run in the foreground on demand.
- **No rate-limiting on `/authorize`** — acceptable because the 50-bit passphrase makes brute-forcing infeasible, the same entropy reasoning previously applied to token-in-URL.

## Cross-references
- `docs/ref/oauth-research-2026-08-07.md` — full research behind this decision, sources
- `docs/ref/claude-connector.md` — the real fields on claude.ai's dialog
- `docs/plan/init.md` — original architecture decisions
- `scripts/oauth.js`, `scripts/gatekeeper.js` — actual implementation
