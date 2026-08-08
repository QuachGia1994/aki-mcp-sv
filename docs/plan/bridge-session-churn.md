# Fix: streamable-bridge internal-session churn (mass disconnect log)

## Problem, in the user's words
1–2 real claude.ai conversations produce **thousands** of `client disconnected from MCP HUB` lines. Sessions drop when the connector sits idle (even with no machine sleep), and Ctrl-C on the `npm start` window dumps a huge burst of disconnect lines at once. The volume is wildly out of proportion to the real session count — a sign the flow shape is wrong, not just noisy logging.

## Root shape (flow audit — the conclusion first)
The bridge represents each external claude.ai session (a **stateless** thing, keyed only by an `Mcp-Session-Id` header the client may or may not resend) with a **stateful** held-open internal SSE socket to mcp-hub, and mcp-hub spins up a **whole MCP Server instance per socket**. There is no reliable "external session ended" signal, so every cleanup mechanism (idle-close, `MAX_SESSIONS` eviction) is *artificial enforcement* compensating for that missing signal. Each un-reused or prematurely-closed internal session is one hub connect/disconnect log pair. Churn is therefore a direct symptom of the stateless↔stateful mismatch.

## Verified from source (read, not guessed)
- **Hub log mechanism** — `node_modules/mcp-hub/dist/cli.js` (`mcp-hub@4.2.1`), `Op.handleSSEConnection()`: every `GET /mcp` creates a fresh MCP `Server` (`createServer()`) + transport, registered in `this.clients` by a new sessionId. The client name is set only inside `n.oninitialized`; the close handler logs `'${s?.name ?? "Unknown"}' client disconnected from MCP HUB`.
  - **Diagnostic that needs no new code:** a `"Unknown"` disconnect = an SSE opened but its MCP `initialize` never completed before it closed (the bridge opened a hub session whose first forwarded message was *not* `initialize` — i.e. the client sent a request with no session id that wasn't an init). A **named** disconnect = a fully-initialised session being torn down (churn from the old idle-close, or from eviction). Read the existing hub log: which kind dominates tells you which failure you have.
- **Ctrl-C burst** — `Op.close()` loops `this.clients` synchronously and closes every tracked client in one pass; that is why dozens/hundreds share one millisecond. The burst size = how many internal SSEs were still open at shutdown.
- **Bridge session source** — `scripts/streamable-bridge.js`: a new internal SSE (`openInternalSession()`) is opened only for a `POST /mcp` that arrives **without** `Mcp-Session-Id`. With a header present, the existing session is reused. So churn volume is governed entirely by **whether claude.ai resends the header**.

## Already landed (commit `a48b3ce`, this fix's first pass)
- **Idle auto-close removed.** The 5-min `SESSION_IDLE_MS` timer was silently destroying every connector left quiet for a few minutes → directly caused "drops when idle". Gone: a session now lives as long as its upstream SSE stays open.
- Per-request timeout 30s → 10min (`MCP_REQUEST_TIMEOUT_MS`); cap 64 → 256 (`MAX_SESSIONS`).
- Timestamped logging (`scripts/log.js`) across gatekeeper/oauth/bridge, incl. session open/close-with-reason.

## Landed in this pass (bounded-model hardening + instrumentation)
- **Eviction is now LRU, not oldest-created.** A reused session is re-inserted to the tail of the `sessions` Map, so the eviction victim (`.values().next()`) is the least-recently-used — previously it was the oldest-inserted, i.e. usually the *main long-lived conversation*, the worst possible one to drop under load.
- **Churn counters** `opened` / `reused`, printed only on a *new-session* event (low volume). `opened` climbing while `reused` stays low = the client is not resending the header = root cause confirmed. `opened` staying ~1–2 = reuse works and the churn is already fixed by the idle-close removal above.

## Measurement result (2026-08-08) — resolved to B
Three real claude.ai conversations, ~4 minutes, produced `opened` climbing **1 → 17 monotonically**, one new session every ~10s, **every one `method=initialize`**. claude.ai re-sends `initialize` with **no** `Mcp-Session-Id` on a timer; it does not hold one session per conversation. So the per-session model (Option A) churns regardless of the LRU/cap hardening — the client's behaviour, not our eviction, drives the count. **Decision: Option B, implemented below.**

## The (now-settled) decision — measure, then pick A or B
The question was a **runtime fact only claude.ai can produce**: does its backend resend `Mcp-Session-Id`? Settled by the measurement above (it does not). Kept for the record:

### Option A — keep the per-session model (smaller, reuse-dependent)
Bounded-growth via cap + LRU is the *correct* model for a stateless-keyed session **if** the client reuses its id: 1–2 conversations = 1–2 hub sessions = 1–2 disconnect lines at shutdown, no periodic churn. Nothing more to build — the landed changes already realise A. Ships the fix **only if** the diagnostic shows reuse works.

### Option B — one shared hub session, multiplex all external clients (structural root fix)
The bridge holds **exactly one** persistent internal hub session for the whole process, initialised once. External `initialize`/`notifications/initialized` are answered **locally** from the cached hub capabilities (never re-forwarded — the hub rejects a second `initialize` on one session). Real requests are forwarded over the single session with **JSON-RPC id remapping**, responses routed back by mapped id.
- **Makes churn impossible by construction, independent of claude.ai's behaviour:** the hub ever sees one client → one "connected" at startup, one "disconnected" at Ctrl-C. Thousands → 1, guaranteed.
- **Removes the whole compensating apparatus:** the `sessions` Map, `MAX_SESSIONS`, eviction, and per-session SSE all disappear (`flow.B6` — "what can be removed once the shape is corrected").
- **Cost / risk:** ~80–120 lines of protocol-multiplexer (id remap table, local init synthesis, notification routing). A subtle bug there breaks real tool calls, not just logs. Safe because this is a single-user server with stateless tools (filesystem/search/shell/agy) — per-session isolation was never actually needed; recoverable (single user, behind git).

**Chosen: B**, after the measurement confirmed A depends on an external behaviour claude.ai does not exhibit. Matches the flow-audit ideal (make the correct path impossible to break, not repeatedly guarded).

## Landed — Option B (single shared session multiplexer)
`scripts/streamable-bridge.js` now holds one internal hub session for the whole process:
- **`initialize` answered locally.** The first one boots the shared session (using that client's params, so the negotiated protocol version is real) and caches the hub's initialize result; every later `initialize` returns the cache without touching the hub. `notifications/initialized` from clients is swallowed (the shared session was initialized once at boot).
- **id remapping.** Every forwarded request gets a globally-unique upstream id (`nextUpstreamId`), so concurrent clients never collide on one session; the original id is restored on the response.
- **Removed the whole compensating apparatus** — the `sessions` Map, `MAX_SESSIONS` cap, LRU eviction, `opened`/`reused` counters, and per-client SSE are gone (`flow.B6`). `externalIds` (a Set) remains only for protocol-correct 404-on-stale, which now triggers a *cheap* local re-initialize.
- **Self-healing.** If the shared SSE dies (hub restart), `shared` resets to null and the next request re-boots it transparently.

## Execution checklist
- [x] Remove idle auto-close; raise per-request timeout and cap (`a48b3ce`)
- [x] LRU eviction + `opened`/`reused` churn counters (`527162f`)
- [x] Run one normal work session; read the counters → `opened` climbed 1→17, all `initialize` → **A insufficient, B needed**
- [x] Implement the single-session multiplexer; delete the sessions Map / cap / eviction
- [ ] **Runtime verification (user-triggered, `coding.B3`):** run one work session on the new build; confirm the hub logs exactly one `client connected` at boot and the disconnect count no longer tracks call volume (target: ~1)

## Out of scope
- Editing `node_modules/mcp-hub`'s log level or behaviour — vendored, lost on reinstall (`docs/ref` never patches node_modules).
- If log *volume itself* still needs taming independent of root cause: redirect the hub child's stdout (`stdio` in `scripts/start.js`) to a file rather than the terminal. Separate from the churn fix; do not conflate.

## Cross-references
- `docs/ref/oauth-research-2026-08-07.md` — why the bridge exists at all (Debug round 7), and the recurring Funnel desync (round 8)
- `docs/ref/security-model.md` — the gatekeeper/hub boundary this bridge sits inside
- `CLAUDE.md` § "Session lifecycle" — the no-idle-close contract this plan established

## Decision
**Action** → the measurement step is next; the A/B choice is the owner's, with B recommended. This checklist is the execution sequence once the choice is made.
