# Audit TODO — v1.1.0 codebase (2026-08-08)

Read-only akiflow council audit (`agent.B5`) of the whole repo, plus a live ChatGPT connect failure reported by the owner. This file is the single actionable backlog; fixes are separate runs.

Guiding principle for every fix: **simplest thing that closes the hole, learn from Claude Code's model, no over-engineering.** Claude Code does not try to parse and sanitize shell semantics — it restricts to safe primitives and scopes access by path, and prompts a human for anything dangerous. We copy that stance: curate the surface, don't build clever sanitizers you have to out-smart forever.

Every claim below is verified against source at the cited `file:line`. Security reach/blast sizing is estimated, not measured.

---

## Owner rulings (doctrine — 2026-08-09, re-sizes everything under B and C)

1. **Threat model = single owner behind stacked outer layers.** Reaching any shell/fs/token surface already requires passing OAuth 2.1 + passphrase + the Tailscale Funnel edge; the only realistic actor left is the authenticated owner. Per `METHOD-proportionality`, hardening the internals against a fully-authenticated sole user is far-fetched strictness — **convenience wins over it.** The heavy hardening below (removing `find`/`sort`, a path-arg parser, short-lived tokens) is **accepted risk, not scheduled work.**
2. **The `~/.aki` grant is mandatory — do NOT narrow it.** The shell/fs tools need `~/.aki` (and `~/.claude`) reachable as trust zones (`docs/plan/shell-allowlist.md` → *Trusted-directory preallow*). C2's "narrow to `~/.aki/akidevrule`" is **rejected.**

What survives the rulings is only what is a defect *regardless* of proportionality: **UI copy that makes a false safety claim** ("read-only commands only", "fully off-limits"). Lying to the user about the boundary is a bug at any threat level, and correcting the words costs nothing and no convenience. Those copy fixes stay actionable; the hardening does not. Section A (ChatGPT) is unaffected — it is a real blocker, not a strictness item.

---

## Implementation status — shipped 2026-08-09

The scheduled backlog below is **implemented**; this doc is now a record, not open work. Verified by a mechanical gate (18 files parse, shared modules load, zero inline duplicates, no merge markers) plus a clean-context adversarial review (all functional claims CONFIRMED, incl. serveStatic traversal-safety and XSS-escape completeness).

| Item | Status |
|---|---|
| A1 · openid-configuration discovery alias | **DONE** (`gatekeeper.js`) — ChatGPT UI auto-fill still needs owner live retry (runtime, `coding.B3`) |
| A2 · panel ChatGPT walkthrough + `<origin>/register` copy field | **DONE** (`config-page.js`) |
| B1 · honest shell copy ("read-only only" / "fully off-limits") | **DONE** (`config-page.js`; README + shell-allowlist.md doc drift also corrected) |
| B2 · XSS escape of the 5 confirm-form fields | **DONE** (`html.js` `esc`, applied in `oauth.js`) |
| D · SSoT dedup → `http.js` (readBody/json/serveStatic/MIME), `mcp-tool.js` (ok/err/fail), `html.js` (esc); dropped dead `resolveClient` export | **DONE** (net −64 lines + 3 shared modules) |
| E · doc drift (index dead-link stale, DCR gloss) + 6 WRAP + 2 YAP | **DONE** |
| B/C hardening (find/sort removal, TTL, narrow `~/.aki`) | **NOT scheduled** — accepted risk per the owner rulings above |

---

## A · ChatGPT connector — BROKEN, owner is blocked (highest priority)

ChatGPT support shipped in 1.1.0 but does not actually complete auth, and the panel has no real ChatGPT walkthrough. Two issues.

### A1 · "invalid authorize request" — root cause: the Claude client_id was reused for ChatGPT

**Verified evidence.** The failing request:
```
GET /authorize?...&client_id=97a4a33fac29035c58a89ea54d5ba128
             &redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2FHIAOUyCgIr2Y&...
[oauth] authorize REJECTED (GET): clientId_ok=true redirect_ok=false method=S256 hasChallenge=true
```
- `97a4a33fac29035c58a89ea54d5ba128` **is the static Claude client** (`~/.aki/mcpsv/oauth-client.json`), NOT a DCR client.
- `~/.aki/mcpsv/oauth-dcr-clients.json` **does not exist** → ChatGPT never registered a client of its own.
- `resolveClient(clientId)` (`oauth.js:78-91`) returns the static Claude client with `redirectUris: [CLAUDE_CALLBACK]` — only `https://claude.ai/api/mcp/auth_callback`.
- `handleAuthorize` (`oauth.js:195`) then checks `client.redirectUris.includes('https://chatgpt.com/connector/oauth/HIAOUyCgIr2Y')` → **false** → 400. The rejection is correct behaviour; the mistake is upstream: a Claude-bound client_id was fed to ChatGPT.

**Why the owner ended up doing that:** ChatGPT's connector UI showed *"Registration method: User-Defined OAuth Client"* with *"DCR is unavailable until a Registration URL is present"*, and its **Registration URL field was empty**. So ChatGPT would not self-register, and the only client id the panel offers is Claude's — the owner pasted it. The whole failure chain is: DCR never became available in ChatGPT's UI → fell back to a user-defined client → the only id on hand is Claude's → redirect binding correctly rejects it.

**The fix is to make ChatGPT actually do DCR.** ChatGPT registers a *public* client (PKCE, `token_endpoint_auth_method: none`) bound to its own `chatgpt.com/connector/oauth/…` callback; `handleRegister` (`oauth.js:143`) already accepts exactly that and `authenticateClient` (`oauth.js:250-256`) already handles `none`. The server code path is correct — the gap is that ChatGPT never reaches it. Two changes, simplest first:

1. **Panel guidance (no code, guaranteed fix):** tell the owner to paste the **Registration URL** into ChatGPT's *Advanced OAuth settings → OAuth endpoints → Registration URL* field: it is `<origin>/register` (e.g. `https://aki-mba16.tailf23d51.ts.net/register`). The moment that field is non-empty, ChatGPT's UI enables DCR, registers its own client, and authorize succeeds. This is the field that was blank in the owner's screenshot. See A2 for the full walkthrough.
2. **Server auto-discovery (small, optional, may remove the manual step):** the log shows ChatGPT probing `GET /.well-known/openid-configuration → 404`. Several MCP/OAuth clients read endpoint discovery (including `registration_endpoint`) from the OIDC document, not only from `oauth-authorization-server`. Serve `/.well-known/openid-configuration` as an alias of the existing AS-metadata handler (add the path to the `metadataHandlers` branch in `gatekeeper.js:74-75` and `oauth.js:126`). One extra route, same JSON. If ChatGPT then auto-fills Registration URL, step 1 becomes unnecessary — but keep step 1 documented as the fallback. **Verify by live retry after the change** (`coding.B3` — runtime, user-triggered): a green server says nothing about whether ChatGPT's UI populated the field.

**Do NOT "fix" this by widening the static Claude client to also allow chatgpt.com redirects.** Per-client redirect binding is a real security property (`METHOD-proportionality` / the redirect allowlist that judge-proportion verified as correct). ChatGPT gets its own client via DCR; that is the design, and it already works once DCR fires.

### A2 · Panel has no usable ChatGPT walkthrough

`config-page.js:164-170` has a thin 3-line ChatGPT block that says "ChatGPT registers itself — no Client ID/Secret paste", which is true in principle but omits the one field that actually unblocks DCR (Registration URL) and gives no deep links. Rewrite panel section 2's ChatGPT subsection to a concrete, ordered walkthrough:

1. Enable Developer mode: `https://chatgpt.com/plugins#settings/Security?section=developer-mode` (paid plan; ChatGPT → Settings → Connectors/Security → Developer mode).
2. Create connector: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`.
3. **Connection = Server URL**, URL = `<origin>/mcp`.
4. **Authentication = OAuth** → open **Advanced OAuth settings**.
5. **OAuth endpoints → Registration URL = `<origin>/register`** ← the missing step from A1. Auth URL / Token URL / Authorization server base / Resource auto-fill from discovery.
6. Registration method: leave on DCR (now available), **Token endpoint auth method = none**. Do **not** paste Claude's Client ID/Secret here.
7. Tick "I understand and want to continue" → Create.
8. On connect, the browser opens the confirm page → enter the same **Passphrase** shown in the panel.

Also make the panel emit the exact `<origin>/register` value as a copy field (it already computes `origin`), so the owner copies rather than hand-types it. Keep the Claude Client ID/Secret fields clearly inside the *Claude-only* subsection so they are not mistaken for ChatGPT input (this mis-paste is exactly what caused A1).

---

## B · Shell surface — folded into `docs/plan/shell-allowlist.md` (that doc owns the subsystem)

The shell allowlist, `checkPermission`'s arg mechanism, and the `~/.aki`/`~/.claude` trust zones are designed in detail in `docs/plan/shell-allowlist.md`. To keep one SSoT (`design.A1`), the audit's shell findings live there now, re-sized by the rulings above.

### B1 · `find`/`sort`/`cat` argv escapes — accepted, not removed
`allowlist.js:8,11` (`find: null`, `sort: null`) + `shell-mcp.js:54-63,82`: `checkPermission` tests `bin` and, for arrays, `args[0]` only — a `null` value means no arg check. So `find <dir> -exec <prog> {} +` (RCE), `find <dir> -delete` (irreversible delete), `sort -o <path>` (overwrite), `cat <abs-path>` (read outside ROOTS) all pass (none contain `DANGEROUS_CHARS`; `execFile` is no defense — the risk is what the allowed binary does with its own argv).
- **Disposition: accepted risk per ruling #1.** NOT removed — pointing users to `find_path`/`search_content` and dropping `find`/`sort` was the pre-ruling proposal; convenience wins for the sole owner. Recorded as the *argv-escape footgun* note in `shell-allowlist.md`. Reopen trigger: multi-user / shared-machine deploy.
- **The one residual action:** the panel copy lies. `config-page.js:185` "read-only commands only" and `:174` "fully off-limits" are both false. Correct them to honest wording (e.g. "runs curated binaries as your user; can read what your user can") **in the same UI pass as `shell-allowlist.md`'s P0 copy fix** — that doc is already about a false UI claim ("deleting a line revokes"). Honesty, not hardening; survives ruling #1.

### B2 · Reflected XSS on the passphrase page — optional, trivial
`oauth.js:223,225` interpolate `${codeChallenge}`/`${state}` raw (no escaper in `oauth.js`). A self-registered DCR client with a crafted `/authorize` URL could render script on the funnel origin — but that needs a malicious client *and* the owner clicking the crafted link, so ruling #1 makes it low-priority. The fix costs nothing and no convenience: lift the existing `esc()` (`config-page.js:57`) into a shared helper and wrap the 5 hidden-field values (`redirectUri`, `clientId`, `codeChallenge`, `codeChallengeMethod`, `state`). Do it opportunistically when next in `oauth.js`; not a blocker.

---

## C · Containment — re-sized by the owner rulings

- **C1 · shell contains `cwd`, not path args** (`shell-mcp.js:82`): same `checkPermission` as B1 — folded into `shell-allowlist.md`, accepted per ruling #1. Residual action is only the honest-copy fix in B1.
- **C2 · secrets under a readable root** (`mcp-hub.config.json:5,10,15,20` grant `~/.aki`; secrets at `~/.aki/mcpsv/…`, `userdata.js:7-14`): **fix REJECTED per ruling #2 — the `~/.aki` grant is mandatory.** Accepted risk; the write-zone == exec-zone composition is already analysed as a deliberate trade-off in `shell-allowlist.md` → *Threat model*. Reopen trigger: shared / multi-user deploy.
- **C3 · access TTL 365 d + non-rotating refresh** (`oauth.js:19`, `:307-311`): the long TTL is a **convenience choice** — no constant re-auth for the sole owner — accepted under ruling #1. Reopen trigger (`proportion.C1`): token leak, shared-machine deploy, or audience widened beyond the single owner.

---

## D · Design / SSoT — the repo sets its own SSoT bar (`roots.js:1`) and misses it here
Fold these together into one shared `scripts/http.js` (body-in / JSON-out / static-serve) rather than fixing piecemeal:
- **serveStatic ×2, already diverged** — `gatekeeper.js:45-57` vs `panel.js:143-149` (gatekeeper allows `file===PUBLIC_DIR`, panel doesn't). Two path-traversal guards for the same `public/` = the "2nd copy of a security boundary" `roots.js:1` warns against → risk-weighted `design.A2`. Both are individually traversal-safe today (verified), but the divergence is the risk.
- **readBody ×3** — `oauth.js:107` / `streamable-bridge.js:26` / `panel.js:106` (first two byte-identical; panel adds `JSON.parse`). `design.A2` (3 sites). Extract `readBody(req)→string`, JSON-parse as a caller concern.
- **json/jsonResponse ×3** — `oauth.js:116` / `panel.js:114` / `streamable-bridge.js:160`.
- **MCP result-envelope inlined 12×** — `search-mcp.js:82` already factored `ok`/`fail`; `shell-mcp.js` + `agy-mcp.js` re-inline `{content:[{type:'text',text}],isError}`. `design.A5` — hoist the existing helper into a shared `mcp-tool.js`.
- **MIME map ×2** — `gatekeeper.js:39` (9 entries) vs `panel.js:21` (4-entry subset). `design.A1`; fold when serveStatic merges.
- **`resolveClient` exported, never imported** — `oauth.js:78`; drop `export` (used only at `:193`,`:251`).

## E · Doc drift + mechanical
- ~~`docs/index.md:13` links to `research/similar-remote-mcp-projects.md` — file absent.~~ **RESOLVED (stale):** the file now exists (created after this audit ran); the link is valid. Verified 2026-08-09.
- ~~`docs/index.md:9` gloss "(DCR skipped)" contradicts live DCR.~~ **DONE:** gloss corrected to state ChatGPT self-registers via RFC 7591 DCR (`oauth.js` `handleRegister`; `docs/ref/security-model.md`).
- **`config-page.js:194-197`** hardcoded stats "17 rule files · 9 skills · 5 subagents · 5 CLIs" are drift-prone; `index.md` lists ~19 rule files, so "17" is likely stale. Derive from a source or accept knowingly.
- **`panel.js:35`** treats `~/.aki` + `~/.claude` as ordinary deletable folder rows → a user deleting them silently revokes rule-file access. Add a guard or visual distinction. (Interacts with C2: after narrowing to `~/.aki/akidevrule`, that specific row is the rule root.)
- **6× `[WRAP]`** comments (`agent.C3`): `agy-mcp.js:13-14,28-29,32-33,81-82`; `streamable-bridge.js:19-20,123-124` — rejoin each to one physical line.
- **1 firm `[YAP]`** (`coding.B4`): `streamable-bridge.js:4-9` duplicates a rationale already in `docs/plan/bridge-session-churn.md` + `CLAUDE.md` — collapse to the reference.
- **1 soft `[YAP]`**: `agy-mcp.js:2-5` over the one-line budget but load-bearing — condense or anchor to a doc.
- **`docs/plan/shell-allowlist.md:24`** claims `panel.js` ~40-63 still has unresolved merge-conflict markers — **stale**: verified none remain (`grep` clean, PR1 merge landed). Correct that note when that doc is next touched.
- **`config-page.js` section 7** (widen-UI console snippet) is being reworked by `docs/plan/chrome-tampermonkey-autosetup.md`, while A2's ChatGPT rewrite touches section 2 of the same file — do both edits in one pass to avoid a collision.

---

## Verified CLEAN (not re-work — confirms the boundary holds)
No merge-conflict markers. No deadcode (all 30 exports referenced). OAuth core: PKCE S256 enforced at authorize + verified at token, auth-code single-use, code/refresh→client binding, `isAllowedRedirect` no sibling-domain bypass, `safeEqual` constant-time. Static traversal guards (both) decode-safe. Panel token gate covers every mutating `/api/*` route; panel binds `127.0.0.1` only. `config-page.js` escapes all dynamic values. OS-agnostic seams are data tables, not branches. `chrome.js` + native picker confirmed removed per `CLAUDE.md`. Comments carry genuine *why*.

## Not covered — separate runs
`log.js` log-injection via logged `state`/`grant_type`; `start.js` orchestration + `PUBLIC_ORIGIN`/port provenance; the Tailscale funnel edge; third-party `server-filesystem` write-tool containment; `npx -y` supply chain. Runtime exploit reachability of B1/B2 reasoned statically, not executed (`coding.B3`).

## Suggested fix order
A1+A2 (unblock ChatGPT — the only real blocker) → the honest-copy corrections (B1's "read-only only" / "fully off-limits", bundled with `shell-allowlist.md`'s P0 copy fix) → B2 XSS escape (opportunistic) → D (dedup into shared http/mcp utils) → E (doc drift + WRAP/YAP). Everything else under B/C is accepted risk per the owner rulings, not scheduled work.
