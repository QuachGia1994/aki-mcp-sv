# Security model — minimal OAuth 2.1 (Claude + ChatGPT)

updated 2026-09-29 · v2.1.0 — Claude keeps a pre-issued confidential client; ChatGPT uses RFC 7591 DCR on the same server.

## Design stance — convenience first, guardrail second

The root the rest of this doc, the README Security section, panel section 6 and `feat/tools.md` defer to. Owner decision, 2026-09-29.

- **Priority order:** (1) convenient use, (2) safety. The guardrail exists so that convenience is not paid for with accidents; it never outranks convenience.
- **Owners allow everything in practice.** Clients such as Claude Code already have an auto mode that permits every command, and a deny rule leaves no reason to use akimcp at all. So akimcp is not a fortress and does not add another permission layer for the owner to configure.
- **What the guardrail is for:** stopping "weak" models — less safe than Claude, or overeager and not yet safe to trust — from doing damage. Such models (the `agy` ones) make per-call approval prompts unbearable, which is why the guardrail is a fixed allowlist rather than a question asked on every call.
- **What the guardrail must be:** clearly delimited (the line between what runs freely and what needs the owner is explicit), principled and professional, balanced between convenience and security, and free of nuisance. A rule that is complex, intrusive or hard to explain fails this bar even when it is safer.

Consequences already decided:
- The shell allowlist is the guardrail. Commands the owner adds are the owner's responsibility.
- Command arguments are not path-scoped (only `cwd` is): too complex and intrusive for the gain.
- Tools are not split into read/write variants to carry permissions: clients differ, and the owner allows everything anyway. What needs safety goes back to the allowlist.
- A dedicated tool beside `run_cmd` earns its place only by saving tokens (compact output for reads); otherwise `run_cmd` covers it, and its description steers the model to the tool that does it cheaper.

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

Pre-issued Claude credentials live in `~/.aki/mcpsv/oauth-client.json`. DCR clients (ChatGPT) persist in `~/.aki/mcpsv/oauth-dcr-clients.json`. Access/refresh tokens persist in `~/.aki/mcpsv/tokens.json`. There is exactly one access token, shared by every client (`getOrIssueAccessToken`, `scripts/oauth.js`); refresh tokens are per authorization. Rolling: panel Section 1 → *Roll token* (new access token, refresh kept — clients refresh silently, pasted local snippets must be re-pasted) or *Roll & sign out all clients* (also clears refresh — use when a token may have leaked, since a soft roll does not evict a holder of a refresh token). Design: `docs/plan/single-access-token.md`.

## Client registration

- **Claude (pre-registered)**: Client ID/Secret printed by `npm start`, pasted into Advanced settings. Redirect URI fixed to `https://claude.ai/api/mcp/auth_callback`. Auth method: `client_secret_post`.
- **ChatGPT (DCR)**: ChatGPT calls `POST /register` with its `https://chatgpt.com/connector/oauth/{id}` redirect URI. Auth method: `none` (PKCE only). Only Claude/ChatGPT redirect URI patterns are accepted — arbitrary third-party redirects are rejected.

## The 2 layers that actually block unauthorized access

1. **Passphrase at `/authorize`** (`~/.aki/mcpsv/passphrase.txt`, 10 random characters from a 32-character unambiguous alphabet — `abcdefghjkmnpqrstuvwxyz23456789`, ~50-bit entropy) — anyone who doesn't know the passphrase can't get past the consent step, so no auth code is ever issued. **Deliberately not a bare Approve button with no passphrase**: `POST /authorize` is public via Funnel; a simulated request can't be distinguished from a button click without a secret.
2. **PKCE S256** — an access token is only issued to the exact client whose `code_challenge` matches the `code_verifier` sent to `/token`.

Ingress edge does not change the trust boundary. Public reachability can come from Tailscale Funnel (default), a `PUBLIC_ORIGIN` edge you run, or a Cloudflare named tunnel (`--tunnel`) — these terminate TLS at different edges but all forward to the same loopback server, and the OAuth gate in `scripts/oauth.js` (passphrase at `/authorize` + PKCE S256 at `/token`) stays the only auth layer regardless of which one is used.

## Localhost security model (zero-trust loopback)

Local-First (2.x): the Gatekeeper binds `127.0.0.1:9999` (`9997` in `--dev`) unconditionally at startup, so local clients (Postman Desktop, Cursor, Claude Code, AGY, Codex) connect straight to the loopback engine — with or without a public ingress. Two rules keep that loopback surface safe:

1. **Bind `127.0.0.1`, never `0.0.0.0`.** `server.listen(port, '127.0.0.1', …)` makes the kernel refuse any packet that did not originate on this machine, so nothing else on the same Wi-Fi/LAN (a café, an office) can reach the port. Binding `0.0.0.0` would expose the whole tool surface to the local network.
2. **The Bearer token stays mandatory even on loopback.** "It's local, so skip auth" is a real vulnerability: a browser (Chrome/Safari) runs on the same machine, and a malicious page can fire `fetch('http://127.0.0.1:9999/mcp', …)` in the background. Without a required token that would be RCE via `local__run_cmd` or theft of local files (drive-by CSRF / DNS-rebinding). AKIMCP keeps requiring `Authorization: Bearer <token>` on loopback: the long-lived local token is issued by `getOrIssueAccessToken()` and stored under `~/.aki/mcpsv/`, and a request without a valid token gets `401`. The real defense is **token secrecy** — a web page can neither read the token off disk nor guess it. Do **not** rely on CORS here: the gatekeeper returns `Access-Control-Allow-Origin: *` and allows the `Authorization` header, so a malicious page can still *issue* the request — it simply can't supply a valid token, so it gets `401`.

Prefer the literal `127.0.0.1` over `localhost` everywhere (config, docs, snippets): on macOS `localhost` can resolve to IPv6 `::1` while the server listens on IPv4 only.

When no ingress is attached, the OAuth discovery and `/authorize` endpoints return `503` while local `/mcp` keeps serving normally; attaching an ingress (via the panel's Section 0 or the `--tunnel`/`PUBLIC_ORIGIN` flags) takes effect on restart, when `origin` is resolved at boot — there is intentionally no runtime attach-after-boot path yet.

## Rate limiting

`scripts/rate-limit.js`, wired in `scripts/gatekeeper.js`. It counts **failures only**, so a caller with valid credentials is never counted or refused (convenience first, see Design stance).
- **Failures**: a rejected credential only, i.e. `401` (wrong passphrase at `/authorize`, wrong client secret at `/token`, invalid Bearer on `/mcp`). `400` and `404` are never counted: they occur during ordinary connects. Default 5 in 60 seconds per caller, then the caller is **blocked for 15 minutes**: `429` with `Retry-After` counting down. A valid Bearer on `/mcp` skips the check entirely, so a banned caller with a real token still works.
- **Release**: a block ends when its time runs out (the counter then starts from zero), when the owner presses Release (one caller, or everyone) in panel section 7, or when akimcp restarts. Turning limits off also lifts every block.
- **Settings**: `rateLimit` in `setting.json` (`enabled`, `failMax`, `failWindowSeconds`, `blockMinutes`, `registerMax`, `registerWindowMinutes`, `maxClients`), edited in panel section 7, read on every request so a save applies at once. A missing or malformed value falls back to its default (`LIMIT_DEFAULTS` in `scripts/rate-limit.js`).
- **Registrations**: 100 `POST /register` per 10 minutes per caller (every attempt counts, it writes a file; a burst of connects to many providers stays far below it), and no new client is stored once 500 exist (`maxClients`, `429 too_many_clients`; the registration block lasts one window).
- **Caller key**: tunnel traffic arrives from loopback, so when the socket peer is loopback the key is `CF-Connecting-IP`, else the last `X-Forwarded-For` entry, else the single bucket `loopback`. Verified by test with these headers; **not verified** against a live Tailscale Funnel: whether Funnel sets `X-Forwarded-For` was not checked. If it does not, every Funnel caller shares one bucket, so an attacker's failures also refuse the owner's new connections (existing tokens keep working) until the block ends or the owner presses Release.

Verdict record (`proportion.C1`):

| Measure | Value |
|---|---|
| Reach | anyone who learns the public hostname (estimated: Funnel hostnames appear in certificate transparency logs, so scanners find them) |
| Capability | plain HTTP requests (estimated: lowest rung) |
| Motive | shell and file access on the owner's machine (estimated: high) |
| Blast radius | brute force cannot succeed (50-bit passphrase, 256-bit token; at 1,000 guesses per second the passphrase takes about 35,000 years, calculated); the reachable harm is a disk-growth and CPU flood through unauthenticated `/register` and log noise, recoverable |
| Rung | 2: enforced once at the gatekeeper, the trust boundary that already exists |

**Reopen when** Funnel is confirmed to forward no client address (then per-caller keys need another source or a global cap), a second user or a shared host is added, or the passphrase becomes user-chosen.

## Shell trust: names, and installer-owned script zones

`run_cmd` runs a command only if its binary is on the name allowlist (inspection-first by default — reads plus a few dev/media helpers, git write forms refused; edited in panel section 6) or it targets a script under a *trusted script directory* (`shell.allowlistDirs`, default `~/.claude/skills` and `~/.aki/akidevrule`, the folders the akidevrule installer writes). The zone check resolves symlinks on both sides, treats `node`/`python3`/… as interpreters (trust follows the script path, so `node -e` stays blocked), and excludes shells. Write + run cannot chain: the file tools (`write_file`, `edit_file`, `create_directory`, `move_file`) refuse any path inside a trusted zone (`scripts/roots.js:resolveRealWritable`), so a zone may sit inside a writable folder. Shell commands the user opts into that write files (`cp`, `git checkout`, …) are outside that guarantee, the same trade-off as any allowlisted write command.

## Real limitations

- **No refresh token rotation** for the pre-registered confidential Claude client (spec rotation rule targets public clients).
- **One shared access token, no per-client revocation** — every client holds the same bearer, so a leak of it is a leak for all; roll it instead of revoking one client.
- **The limiter is in memory and per caller key** — a restart clears it, and a caller who can forge the forwarding headers picks its own key (see Rate limiting).
- **DCR creates one stored client per ChatGPT connector instance** — delete `oauth-dcr-clients.json` (and restart) to revoke those registrations.

## Cross-references
- `docs/research/claude-ai-oauth-connector.md` — research that drove the Claude pre-registered path
- `docs/ref/claude-connector.md` — fields on claude.ai's dialog
- `docs/plan/done/init.md` — original architecture decisions
- OpenAI Apps SDK auth: https://developers.openai.com/apps-sdk/build/auth
