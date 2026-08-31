# ChatGPT — Add custom connector (real install flow)

The actual flow is simpler than the old panel suggested. No Developer mode toggle, no Advanced OAuth settings, no Registration URL to paste — ChatGPT auto-discovers everything from the server's `/.well-known/openid-configuration` endpoint.

## Install steps

1. Open [Create a connector ↗](https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins) (ChatGPT → Settings → Connectors → New connector).
2. **Icon** — optional. Use `<repo>/public/favicon/icon-48.png` or any image.
3. **Name** — your choice (e.g. `Aki MCP Server`).
4. **Description** — your choice (e.g. `Local file and shell access via MCP`).
5. **Connection → Server URL** — paste the **MCP URL** from the panel (e.g. `https://aki-mba16.tailf23d51.ts.net/mcp`).
6. Tick **I understand and want to continue**, then **Create**.
7. On connect, the browser opens the auth page — enter the **Passphrase** shown in the panel.

That's it. ChatGPT self-registers as an OAuth client via DCR (RFC 7591, PKCE, no secret) using the `registration_endpoint` it reads from `/.well-known/openid-configuration`. No Client ID or Secret to paste.

## What ChatGPT does under the hood

- Reads `/.well-known/openid-configuration` → gets `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.
- Calls `POST /register` with its own `redirect_uri` (`chatgpt.com/connector/oauth/…`) → server issues a fresh `client_id`.
- Runs a standard PKCE authorization-code flow → user enters Passphrase on the server's confirm page → tokens issued.

## Notes

- **Do not paste Claude's Client ID or Secret here.** Claude uses a pre-registered confidential client; ChatGPT uses DCR and gets its own client.
- **Write tools may be limited** depending on OpenAI's current policy for custom connectors.
- Requires a ChatGPT paid plan (Plus / Pro / Team / Enterprise).

## Cross-references

- `scripts/config-page.js` — panel ChatGPT tab (section 1)
- `scripts/oauth.js` — `handleRegister` (DCR endpoint), `metadataHandlers` (well-known)
- `scripts/gatekeeper.js` — routes `/.well-known/openid-configuration` → `authorizationServer`
- `docs/ref/security-model.md` — OAuth model (Claude pre-registered; ChatGPT DCR)
- `docs/plan/done/audit-1.1.0-todo.md` §A1–A2 — original DCR blocker and fix
- `docs/plan/done/merge-pr1-windows-chatgpt.md` — how ChatGPT DCR was merged
