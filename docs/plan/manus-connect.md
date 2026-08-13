# Manus custom-MCP connect

Manus's "Custom MCP → Import by JSON" panel has no OAuth step. Connecting it to this server needs a token minted once by hand (PKCE, no browser round-trip) and hardcoded into the JSON's `headers.Authorization`. **Unverified** — see Status.

Throughout, `<HOST>` is a placeholder for this server's public host — a Tailscale MagicDNS name (example: `myhost.tail0abc1.ts.net`) or a fixed domain. Substitute your own; never a hardcoded real host.

## Status
- No network path from the assistant's session to `<HOST>`: outside the assistant's sandbox network allowlist, and the Aki-MCP `run_cmd` tool has no network verb (`curl` etc.) in its read-only command allowlist. The steps below must be run by the owner locally.
- Manus's exact JSON key names (`type` vs `transport`, `streamable-http` vs `streamableHttp`) are inferred from third-party examples — `docs.manus.im/docs/integrations/custom-mcp` documents the UI form ("Server URL" / "Authentication: API key, Bearer token, or other credentials"), not the raw JSON schema. Confirm on first real import; if Manus rejects the shape, try `"type": "streamableHttp"` or `"transport": "streamable-http"` before suspecting the token.

## Why no static API key exists
`/mcp` accepts only a Bearer token issued by this server's own OAuth AS (`verifyBearer` in `scripts/oauth.js`, gated in `scripts/gatekeeper.js`) — full flow in `docs/ref/security-model.md`. There is no separate static-key mode.

## JSON to paste into Manus
```json
{
  "mcpServers": {
    "aki-mcp-sv": {
      "type": "streamable-http",
      "url": "https://<HOST>/mcp",
      "headers": {
        "Authorization": "Bearer <ACCESS_TOKEN>"
      }
    }
  }
}
```

## Minting `<ACCESS_TOKEN>` by hand (one-time, 365-day TTL — `ACCESS_TTL_S` in `oauth.js`)
The redirect URI never has to resolve — only the `code` on the `Location:` header of the `/authorize` response matters — so any callback already in `isAllowedRedirect` (`oauth.js`) works as a placeholder. Used below: the Claude callback.

1. PKCE pair
   ```bash
   V=$(openssl rand -base64 48 | tr -d '=+/' | cut -c1-64)
   C=$(printf %s "$V" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')
   ```
2. Register a public DCR client
   ```bash
   curl -s -X POST https://<HOST>/register \
     -H 'Content-Type: application/json' \
     -d '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none","client_name":"manus-manual"}'
   ```
3. Approve with the passphrase (`~/.aki/mcpsv/passphrase.txt`); read `code` off the `Location` header
   ```bash
   curl -si -X POST https://<HOST>/authorize \
     --data-urlencode "redirect_uri=https://claude.ai/api/mcp/auth_callback" \
     --data-urlencode "client_id=<CLIENT_ID>" \
     --data-urlencode "code_challenge=$C" \
     --data-urlencode "code_challenge_method=S256" \
     --data-urlencode "passphrase=<PASSPHRASE>"
   ```
4. Exchange for the token
   ```bash
   curl -s -X POST https://<HOST>/token \
     --data-urlencode grant_type=authorization_code \
     --data-urlencode code=<CODE> \
     --data-urlencode redirect_uri=https://claude.ai/api/mcp/auth_callback \
     --data-urlencode client_id=<CLIENT_ID> \
     --data-urlencode code_verifier="$V"
   ```
   `access_token` from the response goes into the JSON above.

## Risk: Manus's own OAuth fallback
Third-party reports describe `manus-mcp-cli` falling back to attempting OAuth when a static Bearer header fails to forward correctly (observed against Ahrefs' MCP server, which has no OAuth support — hence a bare 401 there). This server *does* advertise OAuth discovery (`/.well-known/oauth-protected-resource`), so the same fallback here would hit `POST /register` with a Manus redirect URI — currently rejected 400 by `isAllowedRedirect` (`oauth.js`), since Manus isn't in the allowlist (`CLAUDE_CALLBACK` / `CHATGPT_CALLBACK_PREFIX` / `GEMINI_CALLBACK_PREFIX` / `GROK_CALLBACK_PREFIX`). If a real Manus connect fails despite a valid token, check the gatekeeper log for a rejected `/register` first.
**Fix if hit**: add a `MANUS_CALLBACK_PREFIX` to `isAllowedRedirect` in `oauth.js`, once Manus's real redirect URI is observed from a live attempt — not done here, out of scope until confirmed necessary.

## Cross-references
- `docs/ref/security-model.md` — full OAuth 2.1 flow this depends on (note: written before Grok/Gemini were added to `isAllowedRedirect` per `CHANGELOG.md`; slightly stale on the client list, not on the mechanism)
- `docs/research/claude-ai-oauth-connector.md` — why OAuth, not a static token, was chosen originally

## Decision
No action yet — plan only, pending the owner running the steps above against a live Manus panel and reporting pass/fail.
