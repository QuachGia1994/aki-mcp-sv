# Claude control center — Electron shell, multi-profile, self-hosted usage tracking

## Status
Not started. Written as a note for a future session — see owner's request in chat, 2026-08-10. Research-then-plan, no code yet.

## Goal
One app the owner fully controls, modeled on the multi-profile game-automation apps (Telegram auto-game) the owner already builds: a control center that sees every claude.ai "profile" at once (status, account, usage/limit), drives the usage bar and context-size readout without depending on a third-party extension, auto-runs setup JS (widen pane, etc.) on every new window, creates/edits/deletes profiles the way Chrome profiles work, opens new windows from a given profile, and gives those windows a custom, minimal, own-titlebar chrome.

Immediate goal → control every open claude.ai session from one place. Intermediate → stop manual babysitting of rate limits across accounts. Ultimate → same operating model the owner already runs for game automation, applied to claude.ai. No conflict with this repo's own "no desktop app" README stance: that stance is about not depending on *Anthropic's* Claude Desktop (device-ID lock-in the owner doesn't control); this is an app the owner owns end to end, which is the opposite case.

## This supersedes the Playwright-only recommendation floated earlier in chat
That recommendation covered only "detect limit + auto-continue" — it did not have items 4–5 (profile CRUD as first-class objects, custom-chrome windows) in scope. A headless/scripted Playwright process has no native window-chrome or multi-window session model; building one on top of it means reimplementing what Electron already is. Given the full 5-item requirement list, Electron is the smaller build, not the bigger one. Superseded, not layered on top of.

## Facts vs assumptions (first-principles pass)

**Facts, verified this session:**
- Chrome ≥136 only blocks `--remote-debugging-port`/`--remote-debugging-pipe` against the **default** user-data directory; a non-default dir works fine (`docs/research/chrome-cdp-default-profile-block.md`, 5-source-corroborated). Not relevant to the Electron path below (Electron ships its own Chromium, never touches the host's Chrome profile at all), but rules out "drive the user's live default-profile Chrome" as an option either way.
- claude.ai's own usage bars are **not** DOM-scraped by the reference implementation. `she-llac/claude-counter` (MIT, 1.1k★) reads a native `/usage` REST endpoint plus live SSE `message_limit` fields from the chat stream, authenticated via the `lastActiveOrg` cookie already on the page — "more accurate than the rounded /usage page." Token count shown is a **client-side approximation** (`gpt-tokenizer` o200k_base), not a server-reported number — there is no server-exact context-size figure to read, only estimate.
- claude-counter's network bridge is injected as a `world: "MAIN"` content script that patches `fetch`/`EventSource` in the page's own JS context to observe the SSE stream (v0.5.1 changelog note) — the same technique works from any environment that can run an init script in page context, extension or not.
- This repo already scoped and rejected building a custom Chrome extension for this exact usage-bar problem, choosing Tampermonkey instead specifically to avoid extension-maintenance cost (`docs/plan/chrome-tampermonkey-autosetup.md`). That decision was made without today's full requirement list (profile CRUD, custom chrome) — Electron changes the cost-benefit because it replaces "extension we'd maintain" with "one app we already have to build for items 4–5."

**Unverified — needs a runtime check before committing engineering time (`coding.B3`):**
- Whether claude.ai's Cloudflare layer (or any layer in front of it) challenges/blocks a **plain Electron `BrowserWindow`** loading claude.ai while logged in. General web-scraping literature says Playwright/Puppeteer get flagged via `navigator.webdriver` and CDP-automation signals — but a stock Electron `BrowserWindow` is not driven through the WebDriver/CDP automation surface those articles describe, so the failure mode may not transfer. No source found that tests claude.ai specifically either way. First checklist item below, before anything else is built.
- Whether the `/usage` endpoint and `message_limit` SSE field are stable, undocumented internal APIs (most likely, given claude-counter reverse-engineered them) — expect breakage risk on Anthropic-side changes, same class of risk this repo already accepted for the DOM-anchor approach in `chrome-tampermonkey-autosetup.md`.
- Whether claude.ai's custom-connector flow (this repo's own MCP integration) can point at `localhost` from an Electron-embedded page, which would let a profile window keep this repo's filesystem/shell tools without Funnel/OAuth. Nice-to-have, not required for v1 — do not let it block the plan.

## Decision: Electron, session-partition profiles, no Chrome extension anywhere

| Requirement | Mechanism | Why this and not another |
|---|---|---|
| 1. Control center sees every profile's status/account/usage at a glance | Main-process in-memory store, one entry per open profile window, pushed to a dedicated Control Center `BrowserWindow` over IPC | Same process owns every window already — no cross-process bridge needed, unlike the aki-mcp-sv panel (separate process, would need a new IPC/HTTP hop for no benefit) |
| 2. Usage bar + context size, no third-party extension | Preload script (`contextBridge`) injected into every claude.ai window: (a) patches `fetch`/`EventSource` in page context to capture live `message_limit` SSE, replicating claude-counter's proven MAIN-world technique, (b) polls `/usage` directly using the window's own session cookies, (c) `gpt-tokenizer` for the same client-side context estimate claude-counter uses, since no server-exact number exists | Reuses a technique already proven in production (1.1k★ extension) instead of inventing a new detection method; "no extension" is satisfied because the same JS now ships as our own preload, not a Chrome extension |
| 3. Auto-widen + arbitrary injected JS per new window | `webContents.on('dom-ready', …)` → `executeJavaScript` with the widen script this repo already drafted for Tampermonkey (`docs/plan/chrome-tampermonkey-autosetup.md`, "Widen chat pane" row) | Reuse, not reinvent (`coding.A3` prefer existing code/patterns) — port the same script, drop the Tampermonkey delivery mechanism |
| 4. Profile CRUD, open new window from a profile | Each profile = `session.fromPartition('persist:<id>')` (isolated cookies/storage, exactly Chrome-profile semantics) + our own JSON registry (name, color, notes) under `~/.aki/mcpsv-cc/profiles.json`, new convention parallel to this repo's `userdata.js` pattern | Electron partitions are already Chrome-profile-equivalent; no custom multi-profile engine to build |
| 5. Minimal window, custom titlebar | `frame: false`, custom `-webkit-app-region: drag` region in the injected/host chrome | Standard Electron pattern; conceptually the same "titlebar sacred boundary" this org already codifies for Tauri (`RULE-stack-tauri.md` B1) — same idea, different mechanism (CSS var + drag region, not Tauri's window API), not a literal reuse of that rule |

## Why not Tauri (checked on request, evidence below)

Titlebar customization is not the blocker — Tauri has a first-class, already-house-documented pattern for it (`RULE-stack-tauri.md` B1: `decorations:false` + `transparent:true` + `top: var(--titlebar-h)`), at least as mature as the Electron equivalent.

**Multi-profile isolation (requirement 4) is the blocker, and it is currently weak in Tauri, not just untested:**
- `tauri-apps/tauri` issue #11491 (open) — a developer needs exactly this app's requirement 4 ("multiple users to log in to the same website simultaneously, each with their own isolated session") and reports Tauri's current `data_directory` option only gives "some level of isolation"; full per-webview data-store control (e.g. macOS `WKWebsiteDataStore`) is a *requested feature*, not a shipped one.
- `tauri-apps/tauri` issue #10981 (open) — localStorage does not even stay isolated *correctly* across multiple webview windows on Linux (syncs on Windows/macOS, silently diverges and gets dropped on exit on Linux) — a correctness bug on top of the isolation gap, and platform-inconsistent.
- `tauri-apps/wry` issue #621 (open) — cookie/web-storage sharing between multiple webviews needs a manual `WKProcessPool` workaround on macOS; no cross-platform solution yet.

Electron's `session.fromPartition('persist:<id>')` is one line, shipped, and cross-platform stable — this is precisely the requirement this plan's whole app exists to satisfy, so it is the one place a maturity gap is disqualifying rather than cosmetic.

**Secondary cost, not the deciding one:** Tauri backend is Rust — zero reuse of this repo's existing Node code (the widen-script port, the `/usage`+SSE preload logic could still be plain JS injected into the webview either way, but profile-registry/IPC orchestration would need a rewrite or a Node sidecar, adding `tauri.A2`'s PATH-resolution-race class of problem for no benefit this app needs). `tauri.A1`'s absolute no-blocking-UI rule also means every `/usage` poll must be `async fn` + `spawn_blocking` by policy — enforceable, just more ceremony than the equivalent Node code.

Conclusion unchanged: Electron. Revisit only if issue #11491 ships and closes the isolation gap.

## Critique (mandatory pass, `METHOD-deep-think.md` B3)

1. **Steelman the option this rejects (headless Playwright, script-only, no GUI shell).** Smaller surface, no packaging, no Chromium-bundle weight, easiest to run as a background service on a headless machine. If the owner never actually wants a window (pure background automation, checked via the aki-mcp-sv panel or a CLI), this plan is doing more work than needed. Worth a one-line confirmation before starting: does the owner want to *see* windows, or only *query* status?
2. **Attack the favored option (Electron).** Bundled Chromium is a real disk/memory cost per profile window if many profiles run concurrently — game-multiboxing tools hit exactly this ceiling. No mitigation designed yet; size it once profile count is known.
3. **Inversion — how would this fail on purpose?** Ship it depending on the undetected-fingerprint assumption above being false: claude.ai starts challenging the Electron session on day one, every window shows a CAPTCHA instead of chat. That is why it is checklist item #1, not an afterthought.
4. **Pre-mortem, six months out.** Anthropic changes the `/usage` response shape or SSE field name (unversioned internal API) → usage bars silently show stale/wrong numbers with no error, because nothing currently in this plan validates the shape before trusting it. Add a schema sanity-check, not just a try/catch.
5. **Second-order effects.** A second, Electron-owned Chromium profile per claude.ai account means login state now lives in two places (the owner's normal browser and this app) — sign-out/2FA/session-expiry handling has to be designed per profile, not assumed away.

## Open questions to resolve before execution starts

- Confirm item 1 of the critique: window-based or headless-first?
- Where does this app live — new repo, or a subfolder of `aki-mcp-sv`? Different bounded context (`design.A6`) from the existing MCP server; leaning new repo, not decided.
- Concurrent profile count target — shapes whether Chromium-per-window memory cost (critique #2) needs addressing in v1 or can wait.

## Execution checklist (phased, not started)

- [ ] **Phase 0 — spike, answers the one unverified blocker.** Bare Electron `BrowserWindow` loading claude.ai, log in by hand, confirm no bot challenge and that `/usage` + SSE both respond normally to a request issued from that window's context. Stop and rethink if this fails.
- [ ] **Phase 1 — profile registry.** JSON store + partition-per-profile create/rename/delete, no UI yet (CLI or panel-style temp UI for testing).
- [ ] **Phase 2 — claude.ai window.** Preload script: widen-pane injection (ported from the Tampermonkey draft) + fetch/EventSource patch for `message_limit` + `/usage` poll, IPC the parsed numbers to main.
- [ ] **Phase 3 — control center window.** Lists all profiles + live status pushed from main; start/open/close actions per profile.
- [ ] **Phase 4 — custom chrome.** `frame:false` + drag region + minimal window styling.
- [ ] **Phase 5 (stretch, not required for v1).** Investigate whether an Electron-embedded window can register as this repo's MCP custom connector via `localhost`, removing the Funnel/OAuth hop for this specific app.

## Out of scope (this note)

- Auto-clicking "continue" on limit reset — trivial to add once Phase 2's usage data is live (same numbers, one more IPC action), deliberately left out of v1 scope so the plan doesn't balloon before Phase 0 even answers whether the approach works at all.
- Anti-detection hardening (stealth patches, proxy rotation) — only relevant if Phase 0 fails; do not pre-build a mitigation for a risk not yet confirmed real.
- Any change to `aki-mcp-sv` itself. This is a new, separate app; nothing here edits `scripts/*.js` in this repo.

## Cross-references

- `docs/plan/chrome-tampermonkey-autosetup.md` — the widen-script source this plan ports into a preload script; also the prior (now superseded, see above) reasoning for avoiding a custom extension.
- `docs/research/chrome-cdp-default-profile-block.md` — why "attach to the user's live default Chrome" was never an option, for either this or the old `chrome.js`.
- `she-llac/claude-counter` (MIT, github.com/she-llac/claude-counter) — source of the `/usage` + SSE `message_limit` mechanism this plan reuses; read `userscript/claude-counter.user.js` directly when Phase 2 starts, don't reimplement from this summary alone.
- `RULE-stack-tauri.md` B1 — titlebar-boundary pattern this plan's Phase 4 echoes conceptually (Electron mechanism differs).

## Decision
**Action** → build per phases above, Phase 0 first, next session with implementation time. Not started.
