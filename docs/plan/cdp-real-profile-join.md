# CDP real-profile join for Aki Watch

> status: implemented · pending manual live test

## Goal
Add a join mode that opens up to 8 **real** LibreWolf profiles (no clone, no selenium/geckodriver), each with its own random `--remote-debugging-port`. The user clears any Cloudflare challenge by hand in the visible windows; once a page passes the challenge (URL no longer matches `security_verification_signal`), the join is driven automatically over Firefox's CDP endpoint.

## Why
The geckodriver path clones a profile and cannot survive a Cloudflare/CAPTCHA challenge unattended — it just marks `challenge_page` and gives up. Driving the real, visible profile lets a human solve the challenge once, then hands control back to automation.

## Design
- **Launch**: `launch_real_profile()` runs `librewolf --profile <real> --remote-debugging-port <rand> --no-remote --new-instance`. No profile copy.
- **Navigate**: CDP HTTP `/json/list` → page tab → `webSocketDebuggerUrl`; navigation via `Runtime.evaluate` setting `window.location.href` (Firefox CDP has no reliable `Page.navigate`).
- **Challenge wait**: poll each tab URL every `CDP_POLL_INTERVAL` (0.5s) up to `CDP_CHALLENGE_TIMEOUT` (300s). Cleared when `not security_verification_signal(url,'','')`.
- **Join**: reuse the same account-card selectors, accept-button JS, and shared signals (`team_destination_signal`, `joined_signal`, `invite_failure_signal`, `rate_limit_signal`) as the selenium path — run through `Runtime.evaluate` instead of selenium.
- **WebSocket**: minimal RFC 6455 client in Python stdlib (`socket`+`base64`+`struct`); client frames masked. No third-party dependency.
- **Concurrency**: `ThreadPoolExecutor(max_workers=len(instances))`, one thread per profile.
- **Cleanup**: all launched browser processes terminated/killed in a `finally` block.
- **Result format**: identical to `run()` so `formatPostmanPoolReport` and the Telegram report path work unchanged.

## Files
- `scripts/postman-pool-join.py` — CDP constants, `free_port`, `launch_real_profile`, `cdp_get_tabs`, `cdp_page_tab`, `cdp_page_url`, WS client (`_ws_send_frame`, `_ws_read_message`, `ws_send_recv`), `cdp_evaluate`, `cdp_navigate`, `cdp_join_account`, `cdp_join_run`; `--cdp-join` CLI arg + `main()` dispatch.
- `scripts/postman-pool-control.js` — `CDP_JOIN_RUNTIME_PATH`, `CDP_JOIN_REPORT_STATE_PATH`, `buildCdpJoinWorkerInvocation`, `cdpJoinStatus`, `runCdpJoin`, `startCdpJoin`, `stopCdpJoin`; CLI `--run-cdp-join`, `--cdp-join-start-json`, `--cdp-join-status-json`, `--cdp-join-stop-json`.
- `apps/aki-watch/src-tauri/src/lib.rs` — `cdp_join_start`, `cdp_join_status`, `cdp_join_stop` commands + `invoke_handler` registration.
- `apps/aki-watch/src/index.html` — CDP Join buttons + status + progress bar in the Join tab.
- `apps/aki-watch/src/main.js` — `renderCdpJoin`, `refreshCdpJoin`, `ensureCdpJoinPolling`, `startCdpJoin`, `stopCdpJoin`; event wiring + startup poll.

## Verification
- `py -3 -m py_compile scripts/postman-pool-join.py` — passes.
- `node scripts/postman-pool-control.js --cdp-join-status-json` → `{"running":false,...}`.
- `npm test` — 0 failures.
- `cargo check --manifest-path apps/aki-watch/src-tauri/Cargo.toml` — pending (Rust toolchain).
- Live: open a real invite, click Cloudflare bypass in each window, confirm auto-join + Telegram report.

## Notes
- The classic selenium `run()`/`--verify-login`/CLI stays completely unchanged.
- CDP mode forces `headless: false` (real visible windows are required for manual bypass).
