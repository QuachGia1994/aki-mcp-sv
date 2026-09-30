# Single shared access token + two-level roll

**Status:** IMPLEMENTED, unreleased (in `CHANGELOG.md` `[Unreleased]`; moves to `done/` at release) · 2026-09-25 · governing rules: `coding.C4`, `pattern.A1`, `release.B5` (persisted-state change)

## Problem (observed, `~/.aki/mcpsv/tokens.json`)
- 12 access + 12 refresh tokens accumulated; every `authorization_code` and every `refresh_token` grant minted a new access token and nothing removed the old ones before their 1-year expiry (`scripts/oauth.js` `mintTokens`).
- The entries carry only `expires`: no client, no origin. `verifyBearer` accepts any valid one, so all 12 have identical power and none can be revoked alone. The growth bought no capability.
- Rolling was impossible short of deleting the file, which also signs out every OAuth client.

## Decision
`Decided: one access token, two roll levels · because the tokens were already equivalent in power, so collapsing loses nothing and gives a single revocable thing · rejected: one token per client (DCR mints a new clientId per registration, so it still grows, and there is no second user to revoke separately) · reopen if the connector is ever shared with another person.`

| Piece | Behavior |
|---|---|
| `getOrIssueAccessToken(via)` | Returns the sole valid access token, or replaces the map with a fresh one when none is valid. Every grant and the panel call it, so `≤ 1` entry is an invariant of one function, not a rule to remember. |
| `expires_in` | Remaining lifetime of the shared token, not the full TTL (the token can be older than the request). |
| Refresh tokens | Unchanged: one per authorization, bound to `clientId`. Not pruned per client: the static client id is pasted into several providers (Claude, Gemini) and each holds its own refresh token, so pruning by client would sign one provider out when another re-authorizes. |
| `rotateAccessToken()` | Soft roll: new access token, refresh tokens kept. OAuth clients refresh silently; pasted bearer snippets (Postman, Codex, Cursor, Claude Code, AGY) get 401 until re-pasted. Does **not** evict a holder of a leaked refresh token. |
| `rotateAccessToken({ revokeRefresh: true })` | Hard roll: also clears refresh tokens. Every client re-authorizes with the passphrase. Use when compromise is suspected. |
| Panel | Section 1 shows the current access token and two buttons (`POST /api/roll-token`, `{ hard }`), each behind a `confirm()`; the page reloads so every snippet re-renders with the new token. |
| Migration | `loadTokens` keeps the first still-valid access token (the one the panel has been showing, so already-pasted snippets keep working) and drops the rest, then saves. |

## Migration doctrine (`release.B5`)
- Detector: shape of `tokens.json` is unchanged (`{access, refresh}`); only its content shrinks, at startup, in `loadTokens`. Treated as a migration in full.
- Rehearsal: run against a seeded previous-shape file with several access tokens (an expired one first) — `test/oauth-single-token.test.js`.
- Postconditions: exactly 1 access entry, refresh entries untouched, survivor is the first valid entry.
- Rollback / fix-forward: dropped access tokens are not needed to recover (OAuth clients re-derive the shared token by refresh; a lost pasted snippet is re-copied from the panel). There is no state to restore.

## Checklist
- [x] `scripts/oauth.js`: single-token invariant, collapse-on-load, `rotateAccessToken`, remaining-lifetime `expires_in`
- [x] `scripts/panel.js` route `POST /api/roll-token`; `scripts/config-page.js` token field + buttons; `public/panel-client.js` handlers
- [x] `test/oauth-single-token.test.js` in a temp `AKI_MCP_DATA_DIR`, added to `npm test`
- [x] `README.md`, `docs/feat/security.md`, `docs/index.md`, `CHANGELOG.md` `[Unreleased]`

## No action (deliberate)
- Refresh-token growth per authorization: see table row above; bounded by the number of real authorizations, cleared by a hard roll.
- `oauth-dcr-clients.json` (7.4K) holds one entry per ChatGPT connector registration and is never pruned: separate concern, no evidence yet of harm; reopen if it keeps growing.
