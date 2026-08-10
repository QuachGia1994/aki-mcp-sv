# Research — claude.ai OAuth custom connector (2026-08-07)

Real research, dated with full source links, no speculation.

## Triggering event

Ran `npm start` for real with the token-in-URL architecture, pasted the URL into claude.ai → error: "Couldn't register with sign-in service... If this persists, share this reference with support: ofid_60b6ac390c8c766a"

## Root cause — claude.ai always tries DCR first

claude.ai always attempts Dynamic Client Registration (DCR) automatically when adding a custom connector, even when the OAuth Client ID/Secret fields are left blank — there is no way to declare "this server doesn't use OAuth" through the normal UI. Confirmed via [anthropics/claude-ai-mcp#457](https://github.com/anthropics/claude-ai-mcp/issues/457), the exact same situation as this repo.

## 3 options found — chose minimal OAuth, skip DCR

Source: [claude.com/docs/connectors/building/authentication](https://claude.com/docs/connectors/building/authentication) (read 2026-08-07).

1. `static_headers` (Request headers, beta) — the best fit, but "being slowly rolled out to customers; contact Anthropic for early access", not guaranteed available immediately.
2. OAuth with a self-issued client ID/Secret, skipping DCR — quoted verbatim: "Supplying your own pre-registered client ID (and secret...) as static client credentials... avoids dynamic client registration entirely." The field already exists, no beta needed — **chosen**.
3. File a bug and wait for an Anthropic fix — ruled out, need to go live immediately.

## Required technical conditions

Same source page + [troubleshooting](https://claude.com/docs/connectors/building/troubleshooting) (read 2026-08-07):

- AS metadata must not carry `registration_endpoint`, must not set `client_id_metadata_document_supported: true` → signals no DCR/CIMD, forcing claude.ai to use a manually-pasted client ID/Secret.
- `code_challenge_methods_supported: ["S256"]` must be advertised, verified as `sha256(code_verifier)` base64url matching `code_challenge`.
- `401` (not `200`) with `WWW-Authenticate: Bearer resource_metadata="..."` when `/mcp` is missing/wrong bearer.
- `redirect_uri` must exactly match `https://claude.ai/api/mcp/auth_callback`.
- `/token` accepts `Content-Type: application/x-www-form-urlencoded`, not JSON.

## Architecture decision

Drop token-in-URL, build a minimal authorization server in `scripts/oauth.js`: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/authorize` (passphrase confirmation page, reusing `data/.token`), `/token` (PKCE S256, issues access + refresh tokens, no refresh rotation since this is a confidential client). No `/register` — uses a client ID/Secret generated once (`data/.oauth-client.json`), pasted manually into Advanced settings.

## Debug round 1 — missing `iss` (RFC 9207)

Real test: `/authorize` GET → 200, POST → 302 with `code` redirecting correctly — but the log shows no `POST /token`, claude.ai reports "Authorization with the MCP server failed".

Source: [modelcontextprotocol.io/specification/draft/basic/authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) (read 2026-08-07), section "Authorization Response Validation": an AS issuing `iss` in the authorization response must advertise `authorization_response_iss_parameter_supported: true` in its metadata (RFC 9207 §2.3).

Fix applied: `handleAuthorize` adds `iss=<origin>` to the redirect; AS metadata adds `authorization_response_iss_parameter_supported: true`.

**Retest — same failure** (`ofid_752081d484c32ef1`, then other `ofid_` values), log still shows no `POST /token`. Hypothesis that missing `iss` was the sole cause doesn't hold — needs further investigation, not settled yet.

## Debug round 2 — missing `/.well-known/oauth-protected-resource/mcp` route (RFC 9728 path-insertion)

Cross-checked against the official checklist in [troubleshooting](https://claude.com/docs/connectors/building/troubleshooting): "If your MCP endpoint includes a path component (such as `https://your-server.example.com/mcp`), append it to the well-known path: `/.well-known/oauth-protected-resource/mcp`." This server (`/mcp` has a path component) previously only served metadata at the root `/.well-known/oauth-protected-resource`, not at the path-appended form — non-compliant with RFC 9728 for a resource with a path component. A working connector example (Sentry) in [issue #215](https://github.com/anthropics/claude-ai-mcp/issues/215) also advertises both forms in `WWW-Authenticate`.

Fix applied in `scripts/gatekeeper.js`: serve `protectedResource`/`authorizationServer` at both the root route and the `/mcp`-appended route; `WWW-Authenticate` on `/mcp` points to the path-appended `resource_metadata`.

## Debug round 3 — missing CORS on `/authorize` and `/token`

Read the official MCP TypeScript SDK reference implementation source directly — `packages/server-legacy/src/auth/handlers/authorize.ts` and `handlers/token.ts` in [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) (read 2026-08-07, via `gh api`) — this is the code base the MCP connectors claude.ai supports are built on. Both handlers mount `router.use(cors())` (`Access-Control-Allow-Origin: *`) and `res.setHeader('Cache-Control', 'no-store')` before processing the request; the `/authorize` router declares `allowedMethods(['GET', 'POST'])`, the `/token` router declares `allowedMethods(['POST'])` — both go through CORS middleware and so also serve `OPTIONS` preflight. This server (`scripts/gatekeeper.js`) previously set no CORS headers at all on `/authorize`/`/token`/well-known, and didn't handle `OPTIONS` (fell into the generic 404 branch).

This matches exactly the mechanism behind the observed symptom: if claude.ai's client-side JS calls `/token` via `fetch()` from the browser, the browser itself blocks the request at the CORS layer before it ever reaches the network if `Access-Control-Allow-Origin` is missing — the real request never reaches `/token`, matching the gatekeeper log never recording `POST /token` even though `/authorize` runs correctly.

Fix applied: `scripts/gatekeeper.js` sets `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` and returns `204` for `OPTIONS` on `/token`, `/authorize`, and all 4 well-known routes; `scripts/oauth.js` adds `Cache-Control: no-store` to the responses of `handleAuthorize` and `handleToken`.

Not yet retested for real on claude.ai after this fix.

## Debug round 4 — CORS only applied to `/token`/`/authorize`, missing `/mcp` + `Access-Control-Expose-Headers`

New evidence from the user directly: clicking "Add custom connector", claude.ai immediately reports "Connection issue — Couldn't connect to the server" at the "checking connection..." step — **before even reaching `/authorize`**. Cross-checked further against `examples/oauth/server.ts` in [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) (read 2026-08-07, via `gh api`) — the sample app applies `cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate', 'Last-Event-Id', 'Mcp-Protocol-Version'] })` at the **whole-app level**, covering `/mcp` too, not just `/token`/`/authorize`. `exposedHeaders` is required because browsers block JS from reading response headers by default unless the server declares `Access-Control-Expose-Headers` — without it, claude.ai's client-side JS calling `/mcp` directly to read `WWW-Authenticate` (looking for `resource_metadata`) during the "checking connection" step reads nothing, producing exactly the generic "couldn't connect" error observed.

Fix applied: `scripts/gatekeeper.js` switches CORS from a specific path list to applying to **every** response (including `/mcp`), adds `Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version`.

In addition, the referrer URL the user provided (`claude.ai/new?error_code=mcp_token_exchange_failed`) confirms claude.ai **did** call `/token` server-to-server on one prior attempt — but the gatekeeper log stops at `POST /authorize -> 302` every time, with no `POST /token` line. Manual testing from the real internet (`curl`) confirms `/token`/`/.well-known/*` are reachable, TLS is valid, response format is correct — the network path and the `/token` code itself aren't wrong. This means the `/token` request is being blocked before it reaches the gatekeeper — consistent with the CORS/pre-check hypothesis above rather than a logic bug in `handleToken`.

Not yet retested for real on claude.ai after this fix (needs Ctrl+C + `npm start` again to load the new code).

## Debug round 5 — the real root cause: Tailscale Funnel desync with the control plane, not a code bug

Decisive evidence: every prior test ran `curl` **from the same Mac running `npm start`**. That machine is in the same tailnet, so the OS automatically uses Tailscale's internal resolver (`100.100.100.100`, confirmed via `scutil --dns`) — DNS returns an internal CGNAT-range IP (`100.72.70.62`), and all traffic goes straight through the WireGuard mesh, never touching the real public Funnel infrastructure. Every prior "successful" full round-trip test (`/authorize` → `/token`) took this shortcut — it didn't reflect claude.ai's real path (a client entirely outside the tailnet).

Resolving the domain via public DNS (`dig @8.8.8.8`) gives a completely different result: the real IPs are `103.84.155.217` / `103.84.155.153` — Tailscale Funnel's public edge routing. `curl --resolve` directly against these IPs (forcing the internal resolver to be bypassed, correctly simulating claude.ai's actual path) returns `SSL_ERROR_SYSCALL` — the TLS handshake dies mid-way, the request never reaches the code. This matches exactly "checking connection... Connection issue" — the very first thing claude.ai does, before OAuth even starts.

Cross-referenced with [tailscale/tailscale#19508](https://github.com/tailscale/tailscale/issues/19508) (read 2026-08-07): serve/funnel config can save correctly locally (`tailscale funnel status` reports "on") but **fail to sync to the control plane** — Tailscale's public anycast infrastructure never receives the state, so a real client on the open internet gets dropped at the TLS layer even though everything looks "on" from the host machine. This is exactly the failure class observed — not a bug in `scripts/oauth.js`/`gatekeeper.js`.

Fix applied: re-run `tailscale funnel --bg 9999` (forces the serve-config to re-push to the control plane) — not a code fix. Retested the full `/authorize` → `/token` round trip with `curl --resolve` directly against the public IP `103.84.155.217`: **full 200 OK**, `access_token` issued successfully over the real path.

**Lesson to avoid repeating this**: when debugging an architecture that uses Tailscale Funnel, always test with `curl --resolve <host>:443:<public-IP-from-dig-@8.8.8.8>` instead of a bare `curl https://<host>` — if the test machine is in the same tailnet as the server, internal DNS/routing will completely hide this control-plane desync. Tell-tale sign: `tailscale funnel status` says "on" but a real client on the open internet still can't connect — always suspect desync first, don't jump to an OAuth/code bug.

## Debug round 6 — after OAuth works: missing `/messages` proxy route (mcp-hub's legacy SSE transport)

After the Funnel fix, the log shows `POST /token -> 200` for the first time — OAuth completes correctly. Next error: `POST /mcp -> 404`, then the client falls back to `POST /messages?sessionId=... -> 404`.

Checked `mcp-hub` directly (the real upstream, `npm ls mcp-hub` → version `4.2.1`) with `curl`, bypassing the gatekeeper: `GET http://127.0.0.1:19999/mcp` returns an SSE stream with `event: endpoint, data: /messages?sessionId=...` — confirming this version of `mcp-hub` implements the **legacy HTTP+SSE transport** (pre-2025-03-26 MCP spec), not modern Streamable HTTP. Under this transport, `POST /mcp` is never a valid route — the client must POST JSON-RPC to `/messages?sessionId=...`, obtained from the `endpoint` event on the SSE stream.

`scripts/gatekeeper.js` previously only proxied the exact path `/mcp` (the original intent: keep `mcp-hub`'s unauthenticated `/api/*` off the internet — see `docs/plan/done/init.md`), which incidentally also blocked `/messages` — unintended collateral damage.

Fix applied: the route filter in `scripts/gatekeeper.js` now also allows `path === '/messages'` (same bearer-gate, same `forwardToHub`), still blocking every other path including `/api/*`. Verified locally through the real gatekeeper (not a mock): got a real access token via the full OAuth flow → opened SSE `/mcp` to get a `sessionId` → POSTed `/messages?sessionId=...` through the gatekeeper → **202 Accepted**, the correct SSE-transport behavior (the JSON-RPC result comes back over the stream, not in the POST response).

## Debug round 7 — after `/messages` opened up: claude.ai still shows "no tools available" because it doesn't use the old SSE dance

After the round-6 fix, the connector went from "Connection issue" to connecting but reporting "This connector has no tools available." The full gatekeeper log from `npm start` to the UI reporting empty tools shows: **no `GET /mcp` line at all** — claude.ai never opens an SSE connection to get the `endpoint` event. Instead it POSTs `/mcp` directly (404, since `mcp-hub` has no such route), occasionally manages to open `/messages?sessionId=...` (202, just enough to send `initialize`), then goes back to repeatedly POSTing `/mcp` — never reaching the `tools/list` step.

Cross-checked against the official MCP TypeScript SDK reference implementation (`examples/client/streamableHttpWithSseFallbackClient.ts`, package `@modelcontextprotocol/sdk@1.30.0` on npm, read 2026-08-07): the standard pattern is "learn the `endpoint` URL exactly once from SSE, then reuse that same `_endpoint` for **every** subsequent message" (`packages/client/src/client/sse.ts`, function `_send`). claude.ai's real logged behavior doesn't match this pattern — it retries `POST /mcp` (Streamable HTTP) at every step instead of sticking with the `/messages` channel it already learned. This isn't a claude.ai bug to shrug off (that direction of speculation is off-limits) — it's evidence that `mcp-hub` (which only speaks the legacy HTTP+SSE transport, pre-2025-03-26) isn't compatible enough with how a real modern client actually operates, and the gap is on our server side.

**Real root cause + fix:** instead of continuing to depend on the client falling back correctly on its own, hand-write a **Streamable HTTP shim** directly in the gatekeeper (`scripts/streamable-bridge.js`) — it accepts `POST /mcp` (JSON-RPC, real modern spec, a single endpoint), internally bridges to `mcp-hub`'s legacy transport (opens `GET /mcp` to get an internal `sessionId`, POSTs `/messages?sessionId=...`, matches the response by JSON-RPC `id` over SSE), and returns JSON directly to the client along with the gatekeeper's own `Mcp-Session-Id` header. From claude.ai's point of view, `/mcp` is now real Streamable HTTP — no longer dependent on whether the client falls back correctly the way `mcp-hub` requires.

Verified locally: stood up a separate test gatekeeper on another port (`19998`, pointed at the real running `mcp-hub` on `19999`, without touching the user's real `npm start` process), got a real access token via the full OAuth flow, then simulated **exactly** claude.ai's real request pattern (`POST /mcp` initialize → use the returned `Mcp-Session-Id` for `notifications/initialized` and `tools/list`, never opening `GET /mcp`) → `tools/list` returned all **15 tools** with the correct names. `scripts/gatekeeper.js`'s `/mcp` route: `POST` → shim, `DELETE` → close session, `GET` → `405` (no server-push support, acceptable per spec — `tools/list` doesn't need that channel).

## Confirmed success — MVP complete end-to-end

Retested for real on claude.ai after the round-7 fix (restarted `npm start`, reconnected the connector): the tools list shows all 15 tools (14 `filesystem__*` + `shell__execute`), tool calls work normally. The full chain — OAuth → Streamable HTTP shim → mcp-hub → filesystem/shell MCP server — works as designed. Full checklist: `docs/plan/done/init.md`.

## Debug round 8 (2026-08-08) — the Funnel desync RECURS, and a bare re-push is no longer enough

The round-5 failure came back in normal use: connector had worked, then after the machine ran a while every reconnect died at "Couldn't connect to the server", gatekeeper log stopping at `POST /authorize -> 302` with no `POST /token` — the round-5 signature exactly.

Re-confirmed it is the same control-plane desync, not code:
- `dig @8.8.8.8 aki-mba16.tailf23d51.ts.net` → public edge `103.84.155.153/.217`; the tailnet resolver returns the internal `100.72.70.62`. Any bare `curl https://<host>` from this Mac takes the internal WireGuard path and gives a **false 200** — always test the real path with `curl --resolve <host>:443:<public-IP>`.
- `curl --resolve` against the public IP returned **exit 35 / http 000** (TLS handshake dies mid-way) while the internal path was 200 — desync confirmed.

**What differs from round 5:** the round-5 fix (`tailscale funnel --bg 9999` to re-push) did **not** clear it this time — polled the public edge for 30s, still `000`. The reliable fix was the full reset cycle:

```
tailscale funnel --https=443 off
tailscale serve reset
tailscale funnel --bg 9999
```

After that cycle the public edge came up within 5s (`--resolve` → 200; `POST /token` via the public IP → 401 `invalid_client`, i.e. reached our code). So the round-5 lesson stands but the remedy is upgraded: **re-push first, and if the public `--resolve` probe is still `000` after ~30s, do the off → `serve reset` → re-enable cycle.**

This is a **recurring operational failure of Tailscale Funnel on this host**, not a code regression — the OAuth server, the Streamable HTTP shim, and the session bridge are all correct. Session-lifecycle hardening done the same day (removed the 5-min idle auto-close in `scripts/streamable-bridge.js`, raised the per-request timeout, added timestamped logging in `scripts/log.js` + gatekeeper/oauth/bridge) is a separate, independent improvement — it does not fix and is not related to this desync.

**Diagnostic playbook for next time (the signature is identical every time):**
1. Symptom: `npm start` healthy, `tailscale funnel status` says "on", but claude.ai says "Couldn't connect" and the gatekeeper log stops at `POST /authorize -> 302` with no `POST /token`.
2. Confirm with the real path, never a bare curl: `curl --resolve <host>:443:$(dig @8.8.8.8 <host> +short|head -1) https://<host>/.well-known/oauth-authorization-server` → `000`/exit 35 means desync.
3. Fix: re-push; if still `000` after ~30s, run the off → `serve reset` → re-enable cycle above; re-probe until 200.

## Known tradeoffs, accepted for a single-user MVP

- Access/refresh tokens are only stored in-memory in the gatekeeper process — restarting `npm start` loses every issued session, claude.ai needs to "Connect" again. Acceptable since it runs in the foreground, actively started/stopped by design.
- No rate-limiting on `/authorize` — acceptable because of the 256-bit passphrase, making brute-force infeasible.

## Cross-references
- `docs/ref/security-model.md` — security model updated for this OAuth architecture
- `docs/plan/done/init.md` — architecture decision table
- `scripts/oauth.js`, `scripts/gatekeeper.js` — the real implementation
