# Client activity, security-only log, provisional registrations

**Status:** DONE, unreleased (in `CHANGELOG.md` `[Unreleased]`) · 2026-09-30 · current state: `docs/feat/security.md` · governing rules: `coding.C4`, `proportion`, `pattern.A1`, `pattern.A8`

## Goal chain

Show the owner who holds access and who is using it → notice an intruder early enough to roll → keep akimcp usable and lean for weeks of unattended running.

The three forces, and where each wins:

| Force | Wins on | Gives way on |
|---|---|---|
| Convenience | no new prompt, setting or step for the owner; valid credentials never refused; nothing to maintain | — |
| Security | the one signal that matters is visible: a client or a caller the owner does not recognize | per-request tracking, alerts, per-client revocation (cost or contradict documented design) |
| Durability and lightness | memory bounded, disk written only on rare events, log lines only for security-state changes | anything that grows per request |

## Facts this plan rests on (read in code, 2026-09-30)

- **One shared access token** (`getOrIssueAccessToken`, `scripts/oauth.js`), so a `/mcp` request carries no client identity. Per-client "last activity" on `/mcp` is impossible without per-client tokens. Client identity exists only at `/register`, `/authorize` and `/token`.
- **Passphrase ⇒ token.** Whoever knows it can register a client and read the code off the redirect. So "a client was authorized that I do not recognize" is the intrusion signal. A registration alone is not: anyone can register.
- **No client carries any timestamp.** `oauth-dcr-clients.json` entries hold `clientId`, `clientSecret`, `redirectUris`, `tokenEndpointAuthMethod`, `clientName` (self-declared). `oauth-client.json` holds the Claude pair only.
- **Registrations can exhaust `maxClients`.** `/register` needs no secret. At the default 100 per 10 minutes per address, one address fills 500 slots in 50 minutes, after which the owner's next ChatGPT connector gets `429 too_many_clients`. That is a convenience denial reachable by a stranger.
- **Log volume is per request.** `gatekeeper.js` prints one line for every request, including every `/mcp` 2xx. claude.ai re-sends `initialize` about every 10 s per open conversation (`docs/research/claude-ai-mcp-session-reinit.md`), which is about 8,600 lines a day for one idle conversation before any tool call. Each refused `429` and each scanner `404` also print a line, so an attacker controls the log rate.
- **Two in-memory structures never shrink:** `authCodes` (an approved but never-exchanged code stays forever) and `refreshTokens` (one per authorization, no expiry, also persisted). Both grow only with passphrase-holder actions, so they grow slowly, but without bound over a long run.
- **The limiter is already bounded:** 10,000 keys per limiter, a few timestamps each, in memory.

## Decisions

### D1 — Client activity lives on the client record

`Decided: add firstSeenAt, approvedAt, tokenAt, lastAddress, lastAgent to each client record (DCR entries in oauth-dcr-clients.json, the Claude pair in oauth-client.json) · because the record already exists, pruning and display read one place, and the writes happen only on register, approve and token grant · rejected: a separate client-activity.json (a second store keyed by the same id drifts and leaves orphans), a lastSeen per /mcp request (impossible to attribute with one token, and a write per request) · reopen if per-client tokens ever exist.`

- `firstSeenAt`: set at registration (Claude pair: at first approval).
- `approvedAt`: last passphrase approval at `/authorize`.
- `tokenAt`: last successful `/token` grant, both `authorization_code` and `refresh_token`. This is the finest per-client activity available.
- `lastAddress` and `lastAgent`: caller key and `User-Agent` at the last approval or grant, each cut to 64 characters.
- Credential files are written atomically (temp file + rename), like `setting.json`, so a crash mid-write cannot lose the Claude secret.
- Existing entries without timestamps are shown as "before tracking" and never pruned.

### D2 — Live callers of `/mcp`, in memory

`Decided: a map keyed by caller key, holding firstSeen, lastSeen, request count and last User-Agent, capped at 64 entries (least recently seen evicted), memory only · because "who is using the token right now" is the signal the owner asked for, and it costs nothing on disk · rejected: persisting it (one write per request), parsing clientInfo from initialize (extra parsing for what User-Agent already says) · reopen if the owner needs history across restarts.`

- Updated only after the Bearer check passes, so strangers never enter it (they are the limiter's business).
- The first valid request from a caller key not seen since start logs one line: `[security] token used by new caller <key> (<agent>)`. After a restart every caller is new once. That is bounded by the number of distinct callers, not by requests.
- With an ingress that forwards no address, every remote caller shares the key `loopback`; the table then shows one row. That is recorded as a limitation in `docs/feat/security.md`, not solved here.

### D3 — Registrations are provisional until approved

`Decided: on each /register, drop DCR entries that were never approved and are older than 1 hour, before the maxClients check · because it makes the cap unreachable for a stranger (their entries expire before they can pile up) with no setting and no owner action · rejected: lowering registerMax (hurts the owner's bursts), authenticating /register (providers cannot send a secret there), a manual Remove button (owner work for a problem the flow can remove) · reopen if a provider is seen taking more than an hour between registration and approval.`

- Entries without `firstSeenAt` (registered before this change) are kept.
- Their refresh tokens go with them. None can exist for a never-approved client.

### D4 — The log records security events only

`Decided: keep lines for events that change or threaten the security state, drop per-request access lines that carry no security meaning · because the log is the owner's audit trail and must stay readable after weeks, and an attacker must not control its growth · rejected: a log file with rotation (console output is enough; the owner can redirect it), a verbosity setting (one more knob for no demonstrated need) · reopen if debugging needs the full access log again (then a --verbose flag, off by default).`

| Keep (one line each) | Drop |
|---|---|
| gatekeeper listening, ingress attached | `/mcp` 2xx and 202 access lines |
| discovery, `/authorize`, `/token` access lines (rare, and `CLAUDE.md` RECURRING #1 diagnoses from them) | `/register` 201 access line (D1 records it; the first approval is the event that matters) |
| registration rejected (redirect not allowlisted) | `429` access lines (the block-start line already says it) |
| wrong passphrase, client approved (name, redirect host, whether first approval), token granted (grant type, client) | `404` on unknown paths (scanner noise) |
| caller blocked (key, duration), caller released from the panel | bearer-failure detail lines duplicating the `/mcp` 401 line |
| token used by a new caller (D2) | |
| passphrase rolled, token rolled (soft or hard), limits saved | |
| every 5xx | |

Budget after the change: idle, 0 lines; a normal day, tens of lines; under attack, at most `failMax` failure lines plus one block line per address per `blockMinutes`, and registration attempts cut off at `registerMax` per window.

### D5 — Panel section 7 shows clients and live callers

`Decided: two read-only tables under Blocked right now, plus one sentence pointing at the roll buttons in section 1 · because the tables are useful only together with the response, and the response already exists · rejected: per-client revoke (with one shared token it would revoke nothing that matters), desktop notification on a new client (reopen trigger below) · reopen if the owner asks to be alerted.`

- **Clients:** name (labelled "self-declared"), kind (Claude pre-registered or DCR), redirect host (allowlisted, so meaningful), first seen, last approved, last token, last address and agent. Sorted by last activity; never-approved entries are greyed out and marked "pending approval — removed after 1 h".
- **Active now:** caller key, agent, first seen, last seen, requests; since last restart.
- Every value from outside (name, agent, key) is rendered with `textContent`, never markup.
- Text under the tables: "Don't recognize a client or a caller? Roll the passphrase and use Roll & sign out all clients in section 1."
- Data comes from `GET /api/rate-limit` (renamed, see Steps), refreshed by the existing Refresh button.

### D6 — Housekeeping for long runs

`Decided: sweep expired authCodes whenever a code is added; at token-file load, drop refresh tokens whose client no longer resolves · because both grow without bound today and the fix is a few lines on paths that already run · rejected: a periodic timer (a background job to maintain for work the existing paths can do) · reopen if the stored refresh token count is ever seen above a few hundred.`

## Steps

- [x] `scripts/oauth.js`: atomic write helper for the two client files; `firstSeenAt` on register; `approvedAt`, `tokenAt`, `lastAddress`, `lastAgent` on approve and grant (the caller key comes from `clientKey(req)`); D3 prune before the cap check; D6 authCodes sweep and refresh-token drop; export a `listClients()` that returns display fields only, never secrets.
- [x] `scripts/gatekeeper.js`: D2 live-caller map after the Bearer check; D4 access-line filter (one predicate beside the `finish` handler).
- [x] `scripts/rate-limit.js` or a new `scripts/activity.js`: only if the live-caller map does not fit cleanly in `gatekeeper.js` (decide by the "and" test).
- [x] `scripts/panel.js`: `GET /api/rate-limit` → `GET /api/security` returning `{ limits, defaults, blocked, clients, callers }`; log line on release and on limits save.
- [x] `scripts/config-page.js`, `public/panel-client.js`, `public/panel.css`: section 7 renamed "Security & connection limits" with the two tables and the roll pointer; step nav label updated.
- [x] Tests (`test/rate-limit.test.js`, or a new `test/security-activity.test.js` added to `npm test`): prune keeps approved and legacy entries and drops stale pending ones; `listClients()` never returns `clientSecret`; a valid Bearer from a new key adds one caller and logs once; the second request logs nothing; `404`, `429` and `/mcp` 2xx print no access line; the caller map never exceeds its cap.
- [x] Docs: `docs/feat/security.md` (What is logged, Surfaces, Real limitations, stamp), README Security summary, `CHANGELOG.md` `[Unreleased]`, `docs/index.md`; move this plan to `done/`.

## Verification

- Static and unit: `npm test`, `release_lint.py`.
- Runtime, owner (UX and a live provider, `coding.B3` rung 6): connect one web AI, confirm it appears in Clients with `approvedAt` and in Active now; restart and confirm Clients keeps it while Active now starts empty; watch the console for an hour of normal use and confirm only security events appear.
