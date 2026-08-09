# claude.ai — Add custom connector (dialog fields)

Recorded because it decides which auth mechanism this server has to use.

## Fields available
- **Name** — display name in the connector list.
- **Remote MCP server URL** — required, shape `https://mcp.example.com/mcp`.
- **Advanced settings** (optional):
  - **OAuth Client ID**
  - **OAuth Client Secret**
- **Request headers** (beta, not guaranteed available for personal accounts) — enter `Authorization: Bearer <token>` directly, no OAuth needed. See `docs/ref/oauth-research-2026-08-07.md`.

## Consequence — changed since the first read

The first read of this dialog (before 2026-08-07) assumed "no header field → the token has to go in the URL." **Wrong in practice**: even with OAuth Client ID/Secret left blank, claude.ai still automatically attempts Dynamic Client Registration (DCR) before connecting, and fails immediately if the server doesn't answer the OAuth handshake correctly — token-in-URL doesn't dodge this step. Confirmed with a real test plus Anthropic's public GitHub issue (`anthropics/claude-ai-mcp#457`) — full detail: `docs/ref/oauth-research-2026-08-07.md`.

**Current decision**: use self-issued OAuth Client ID/Secret (a field that's already available, no beta needed) + a minimal self-hosted authorization server, skipping DCR by not advertising `registration_endpoint`. See `scripts/oauth.js`, `docs/ref/security-model.md`.

## Cross-references
- `docs/ref/oauth-research-2026-08-07.md` — full research, dates, sources
- `docs/ref/security-model.md` — current OAuth security model
- `docs/plan/done/init.md` — architecture decisions
