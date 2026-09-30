# Security

> updated 2026-09-30 · v2.1.0

The one place for akimcp's whole security picture: stance, every surface and its gate, the connection limits, what each secret on disk unlocks and how to revoke it. README carries a summary and points here. Planned changes (client activity, security-only log, provisional registrations): `docs/plan/client-activity-and-security-log.md`.

## Design stance — convenience first, guardrail second

The root the rest of this doc, the README Security section, panel section 6 and `feat/tools.md` defer to. Owner decision, 2026-09-29.

- **Priority order:** (1) convenient use, (2) safety. The guardrail exists so that convenience is not paid for with accidents; it never outranks convenience.
- **Owners allow everything in practice.** Clients such as Claude Code already have an auto mode that permits every command, and a deny rule leaves no reason to use akimcp at all. So akimcp is not a fortress and does not add another permission layer for the owner to configure.
- **What the guardrail is for:** stopping "weak" models — less safe than Claude, or overeager and not yet safe to trust — from doing damage. Such models (the `agy` ones) make per-call approval prompts unbearable, which is why the guardrail is a fixed allowlist rather than a question asked on every call.
- **What the guardrail must be:** clearly delimited (the line between what runs freely and what needs the owner is explicit), principled and professional, balanced between convenience and security, and free of nuisance. A rule that is complex, intrusive or hard to explain fails this bar even when it is safer.
- **Durability is part of the bar:** akimcp is meant to run for weeks unattended. Every security mechanism keeps bounded memory, writes to disk only on rare events (a registration, an approval, a token grant, a settings save), and logs only what changes the security state.

Consequences already decided:
- The shell allowlist is the guardrail. Commands the owner adds are the owner's responsibility.
- Command arguments are not path-scoped (only `cwd` is): too complex and intrusive for the gain.
- Tools are not split into read/write variants to carry permissions: clients differ, and the owner allows everything anyway. What needs safety goes back to the allowlist.
- A dedicated tool beside `run_cmd` earns its place only by saving tokens (compact output for reads); otherwise `run_cmd` covers it, and its description steers the model to the tool that does it cheaper.

## Surfaces at a glance

| Surface | Who can reach it | Gate | Code |
|---|---|---|---|
| OAuth endpoints (`/.well-known/*`, `/register`, `/authorize`, `/token`) | anyone who learns the public hostname (`503` when no ingress) | redirect allowlist, passphrase, PKCE S256, client secret for Claude; connection limits | `scripts/oauth.js`, `scripts/gatekeeper.js` |
| `/mcp` over the ingress | same | Bearer access token | `scripts/gatekeeper.js` |
| `/mcp` on `127.0.0.1:9999` | processes on this machine, including browser pages | Bearer access token (never skipped on loopback) | `scripts/gatekeeper.js` |
| Control panel `127.0.0.1:9998` | processes on this machine | per-start panel token in URL and `x-panel-token` header; never exposed through the ingress | `scripts/panel.js` |
| Tools (files, search, git, shell) | whoever holds a valid access token | folder scope, shell allowlist, trusted script zones | `scripts/roots.js`, `scripts/allowlist.js`, `scripts/shell-mcp.js` |

## Remote auth — minimal OAuth 2.1

```
claude.ai / ChatGPT / Grok / Gemini
   │  GET /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
   │      (/.well-known/openid-configuration is an alias of the latter, so ChatGPT can auto-discover registration_endpoint)
   │  ChatGPT, Grok, Gemini (and optionally Claude): POST /register  (DCR)
   ▼
gatekeeper.js  ── /register  → RFC 7591, redirect URI must be allowlisted
               ── /authorize → confirmation page, requires the passphrase
               ── /token     → PKCE S256; confidential clients need client_secret, DCR public clients use none
               ── /mcp       → Bearer access token required, else 401 + WWW-Authenticate → tools server (in-process)
```

- **Claude (pre-registered):** Client ID/Secret from `oauth-client.json`, shown in panel section 1, pasted into claude.ai's advanced settings. Redirect fixed to `https://claude.ai/api/mcp/auth_callback`, auth method `client_secret_post`.
- **ChatGPT, Grok, Gemini (DCR):** the provider calls `POST /register`; each connector instance becomes one entry in `oauth-dcr-clients.json`. Auth method `none` (PKCE only). Redirect allowlist (`isAllowedRedirect`): the Claude callback, `chatgpt.com/connector/oauth/*` and the legacy ChatGPT callback, `grok.com/connectors-oauth-exchange-code/*`, `oauth-redirect.googleusercontent.com/r/*`. Registration is open by design: a registered client still has to pass the passphrase.

The two layers that actually block access:
1. **Passphrase at `/authorize`** — 10 random characters from `abcdefghjkmnpqrstuvwxyz23456789` (32 symbols, 50 bits). Without it no authorization code is issued. Deliberately not a bare Approve button: `POST /authorize` is public, and a scripted request cannot be told apart from a click without a secret.
2. **PKCE S256** — a token is issued only to the client whose `code_verifier` matches the `code_challenge` of that authorization.

**Whoever knows the passphrase can get a token.** They can register their own client and read the code off the redirect. The passphrase is therefore the real key, and a leaked passphrase is handled as a leaked token (see When something leaks).

Tokens: there is exactly one access token, shared by every client, TTL 1 year (`getOrIssueAccessToken`, design: `docs/plan/single-access-token.md`). Refresh tokens are per authorization, bound to their client, and do not expire. Panel section 1 shows the token and offers *Roll token* (new access token, refresh kept: web AIs refresh silently, pasted local snippets must be re-pasted) and *Roll & sign out all clients* (also clears refresh tokens: every AI reconnects with the passphrase). Both files survive restarts: a connector is long-lived access, not a login session.

The ingress (Tailscale Funnel by default, a `PUBLIC_ORIGIN` edge, or a Cloudflare tunnel via `--tunnel`) only terminates TLS and forwards to the same loopback server; it never changes the trust boundary. Without an ingress, discovery, `/register`, `/authorize` and `/token` return `503` while local `/mcp` keeps serving; attaching one takes effect on restart.

## Loopback — zero trust on 127.0.0.1

The gatekeeper binds `127.0.0.1:9999` (`9997` in `--dev`) at startup, with or without an ingress, so local clients (Cursor, Claude Code, AGY, Codex, Postman) connect directly.

1. **Bind `127.0.0.1`, never `0.0.0.0`.** The kernel refuses packets from other machines, so nothing on the same Wi-Fi or LAN reaches the port.
2. **The Bearer token stays mandatory on loopback.** A browser on the same machine can run a hostile page that fires `fetch('http://127.0.0.1:9999/mcp')`; without a token that is remote code execution through `run_cmd`. The defense is token secrecy, not CORS: the gatekeeper answers `Access-Control-Allow-Origin: *`, so a page can send the request but cannot supply the token, and gets `401`.

Use the literal `127.0.0.1`, never `localhost`: on macOS `localhost` can resolve to `::1` while the server listens on IPv4 only.

## Connection limits

`scripts/rate-limit.js`, wired in `scripts/gatekeeper.js`, configured in panel section 7. Only **failures** count, so a caller with valid credentials is never counted or refused.

| Setting (`setting.json` → `rateLimit`) | Default | Meaning |
|---|---|---|
| `enabled` | `true` | off lifts every block at once |
| `failMax` / `failWindowSeconds` | 5 / 60 | rejected credentials allowed per caller in the window |
| `blockMinutes` | 15 | how long the caller is then refused (`429` with a counting-down `Retry-After`) |
| `registerMax` / `registerWindowMinutes` | 100 / 10 | `POST /register` per caller in the window (every attempt counts: it writes a file); the block lasts one window |
| `maxClients` | 500 | registered DCR clients stored; beyond it `/register` answers `429 too_many_clients` |

- **What counts as a failure:** `401` only — wrong passphrase at `/authorize`, wrong client secret at `/token`, invalid Bearer on `/mcp`. `400` and `404` never count: they happen during ordinary connects. Connecting many providers in a row is never blocked.
- **When a block ends:** by itself after `blockMinutes` (the counter restarts from zero), when the owner presses Release (one caller, or everyone) in panel section 7, when limits are turned off, or on restart. The panel lists every blocked caller with its remaining time.
- **Valid Bearer always passes:** a caller that is blocked but holds the real token keeps working, so an attacker's failures from a shared address never cut an existing connection.
- **Settings are read on every request**: a save applies at once. A missing or malformed value falls back to its default (`LIMIT_DEFAULTS`).
- **Caller key:** the socket address; when the peer is loopback (tunnelled traffic), `CF-Connecting-IP`, else the last `X-Forwarded-For` entry, else the single bucket `loopback`. Headers are read only from a loopback peer, and the key is cut to 64 characters.
- **Footprint:** in memory only, at most 10,000 caller keys per limiter, a few timestamps each.

Verdict record (`proportion.C1`):

| Measure | Value |
|---|---|
| Reach | anyone who learns the public hostname (estimated: Funnel hostnames appear in certificate transparency logs, so scanners find them) |
| Capability | plain HTTP requests (estimated: lowest rung) |
| Motive | shell and file access on the owner's machine (estimated: high) |
| Blast radius | brute force cannot succeed (50-bit passphrase, 256-bit token; at 1,000 guesses per second the passphrase takes about 35,000 years, calculated; at the default 5 per minute per address, far longer); the reachable harm is a disk and CPU flood through unauthenticated `/register` and log noise, recoverable |
| Rung | 2: enforced once at the gatekeeper, the trust boundary that already exists |

**Reopen when** the ingress is confirmed to forward no client address (then per-caller keys need another source or a global cap), a second user or a shared host is added, or the passphrase becomes user-chosen.

## Tool reach — folders, shell allowlist, trusted zones

- **Folders:** every file, search and git tool, and every shell `cwd`, is confined to the folders in `setting.json` → `folders` (default `$MCP_DATA_DIR`, i.e. `$HOME`, plus `~/.aki` and `~/.claude`), read fresh on every call. `~/.claude` is reachable at folder level, so session tokens and chat history inside it are in reach; the panel row is locked, edit `setting.json` to remove it.
- **Shell allowlist:** `run_cmd` uses `execFile`, never a shell, and refuses `; & | \``. A binary runs only if it is on the allowlist (inspection-first by default: reads plus a few dev and media helpers; flag-rich binaries that escape read-only, such as `find` and `sort`, are kept out; `git branch`/`tag`/`remote` pass in their read forms only). Bare `git` on the list means every git command. Edited in panel section 6; any command the owner adds is the owner's responsibility.
- **Trusted script zones:** a script under `shell.allowlistDirs` (default `~/.claude/skills`, `~/.aki/akidevrule`, the folders the akidevrule installer writes) runs without an allowlist row. The check resolves symlinks on both sides, lets `node`/`python3`/… through only with a script path (so `node -e` stays blocked), and excludes shells. Write and run cannot chain: the file tools refuse any path inside a zone (`scripts/roots.js:resolveRealWritable`). Shell commands the owner opts into that write files (`cp`, `git checkout`, …) are outside that guarantee.

## Secrets on disk

All under the data dir (`~/.aki/mcpsv/` by default), mode `0600`, never inside the repo.

| File | Holds | Leaked alone means | Revoke |
|---|---|---|---|
| `passphrase.txt` | consent secret for `/authorize` | anyone can obtain a token | panel section 1: Roll passphrase, then Roll & sign out all clients |
| `tokens.json` | the shared access token and every refresh token | full tool access | Roll & sign out all clients (or delete the file and restart) |
| `oauth-client.json` | Claude's Client ID/Secret | nothing without the passphrase | delete and restart, paste the new pair into claude.ai |
| `oauth-dcr-clients.json` | registered public clients (no secret) | nothing | delete and restart; every DCR connector reconnects |
| `setting.json` | folders, allowlist, trusted zones, limits | not secret, but a write widens access | only the local owner writes it (panel or editor) |

The panel token lives only in memory and changes on every start.

## When something leaks

| Suspicion | Do | Why that is enough |
|---|---|---|
| Passphrase seen by someone | Roll passphrase, then Roll & sign out all clients | the new passphrase stops new authorizations; the hard roll evicts any token already obtained |
| Access token seen (screenshot, pasted snippet) | Roll & sign out all clients | a soft roll leaves refresh tokens, which a holder could use to get the new token |
| Unknown client in the list, or a caller you do not recognize using the token | both rolls, as for the passphrase | a client can only have been authorized with the passphrase |
| A flood of failed attempts | nothing; the limits handle it | brute force is infeasible; Release in panel section 7 if your own address got blocked |

## What is logged

Console only (`scripts/log.js`, timestamped), no log file. Today every request prints one gatekeeper line, plus OAuth events (registration rejected, wrong passphrase, approval, token grant, bearer failure) and one line when a caller gets blocked. The planned change to log only security events is in the plan named at the top.

## Real limitations

- **One shared access token, no per-client revocation:** a leak is a leak for all; roll instead of revoking one client. It also means `/mcp` traffic cannot be attributed to a client, only to a caller address.
- **No refresh token rotation** for the pre-registered Claude client (the spec's rotation rule targets public clients).
- **The limiter is in memory and keyed per caller:** a restart clears it, a caller who can forge the forwarding headers picks its own key, and an ingress that forwards no address puts every remote caller in one bucket.
- **DCR stores one client per connector instance** and nothing prunes them yet; `maxClients` bounds the file.

## Cross-references
- `docs/plan/client-activity-and-security-log.md` — planned: client activity, live callers, security-only log, provisional registrations
- `docs/plan/single-access-token.md` — why one shared access token
- `docs/research/claude-ai-oauth-connector.md` — research that drove the Claude pre-registered path
- `docs/ref/claude-connector.md`, `docs/ref/chatgpt-connector.md` — connector dialogs
- OpenAI Apps SDK auth: https://developers.openai.com/apps-sdk/build/auth
