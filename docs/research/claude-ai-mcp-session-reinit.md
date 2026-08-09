# claude.ai re-initializes MCP sessions instead of reusing the session id

**Start time:** 2026-08-08

**Initial purpose:** Decide whether the streamable-HTTP↔SSE bridge (`scripts/streamable-bridge.js`) could keep its per-client session model (one internal mcp-hub session per external claude.ai session, bounded by a cap + LRU eviction — "Option A") or had to move to a single shared hub session multiplexing all clients ("Option B"). The whole choice hinged on one **runtime fact only claude.ai's backend can produce**: after `initialize` returns a `Mcp-Session-Id`, does the client resend that header on subsequent requests (→ A is correct and churn-free), or does it keep sending header-less `initialize` (→ A churns and B is required)? Context: the bridge opens a new internal hub session only for a `POST /mcp` that arrives **without** `Mcp-Session-Id`; mcp-hub spins up a whole MCP `Server` per such session and logs a connect/disconnect pair per session. The symptom under investigation was thousands of `client disconnected from MCP HUB` lines from only 1–2 real conversations.

## Strategy
The fact cannot be settled statically — it is the behavior of Anthropic's remote MCP client, not of our code — and running live claude.ai traffic is user-triggered (`coding.B3`). So: instrument the bridge with a low-noise counter (`opened` = header-less sessions actually created, `reused` = requests that did carry a session id), printed only on a new-session event; then have the user run real claude.ai sessions and read the counter line straight from the `npm start` terminal. The counter's slope decides A vs B directly.

## Checklist
- [x] Added `opened`/`reused` counters + a one-line log per new session (commit `527162f`, since removed by the B rewrite that superseded it)
- [x] Confirmed from `node_modules/mcp-hub/dist/cli.js` (`mcp-hub@4.2.1`) that each `GET /mcp` creates a fresh `Server` and logs one connect/disconnect pair — so bridge `opened` count maps 1:1 to hub disconnect lines
- [x] User ran **three** separate claude.ai conversations against a fresh `npm start`, ~4 minutes total, and pasted the full gatekeeper/bridge log

## Result
**claude.ai does not reuse its MCP session id — it re-sends `initialize` with no `Mcp-Session-Id` on a timer (~every 10 seconds).** Every new internal session in the log was `method=initialize`, and the count climbed monotonically with wall-clock time, not with real conversation count. So the per-client model (Option A) churns by construction regardless of any cap/LRU hardening: the client's re-initialize cadence drives the session count, and nothing the bridge does to *evict* sessions addresses the rate at which they are *created*. **Option B (one shared hub session, initialize answered locally) is required** — it is the only design under which the hub session count is independent of claude.ai's re-initialize behavior.

Secondary observations from the same log:
- The client sends two distinct client names — `Anthropic/Toolbox` (the first probe) then `Anthropic/ClaudeAI` (the working session) — each doing its own header-less `initialize`.
- `reused` did climb too (real tool calls between re-inits *do* carry the session id), so the client is not stateless within a short window — it simply keeps minting new sessions in parallel rather than holding one.

### Verification
Direct measurement, not inference. Bridge counter over ~4 minutes, three conversations:

| Time (UTC) | `opened` | `reused` | method |
|---|---|---|---|
| 13:20:06 | 1 | 0 | initialize |
| 13:20:14 | 2 | 2 | initialize |
| 13:20:28 | 3 | 6 | initialize |
| 13:20:55 | 5 | 10 | initialize |
| 13:21:59 | 10 | 20 | initialize |
| 13:22:27 | 17 | 33 | initialize |

`opened` reached **17 sessions in ~4 minutes** for **3** real conversations, every one `method=initialize`, still climbing when the log was cut. Under Option A each of those 17 is one hub connect + one eventual disconnect — the mechanical origin of the "thousands of disconnect lines" symptom. Cross-checked against mcp-hub source (a `GET /mcp` = one `Server` + one connect log; `Op.close()` loops all tracked clients at shutdown, hence the Ctrl-C burst).

### Corroborating links
- `docs/plan/done/bridge-session-churn.md` — the flow-audit plan this measurement was run to resolve (§ "Measurement result").
- `node_modules/mcp-hub/dist/cli.js` (`Op.handleSSEConnection` / `Op.close`) — the per-session `Server` creation and shutdown-loop that make bridge `opened` count equal hub disconnect-log count. Vendored, not editable (lost on reinstall).

## Decision
**Action** → `scripts/streamable-bridge.js` rewritten to Option B (single shared hub session + JSON-RPC id remapping + local `initialize` synthesis), commit on `master`; the per-client sessions Map / `MCP_MAX_SESSIONS` cap / LRU eviction / the diagnostic counters that produced this finding were all removed as the compensating machinery the corrected shape no longer needs. Recorded in `CHANGELOG.md` [Unreleased] → Fixed, and in `CLAUDE.md` § "Session lifecycle".

**Cross-references:** `docs/plan/done/bridge-session-churn.md` (execution checklist), `CLAUDE.md` § "Session lifecycle" (the single-session contract this finding established — do not reintroduce a per-client cap).
