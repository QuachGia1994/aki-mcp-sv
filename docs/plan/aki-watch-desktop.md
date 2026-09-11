# Aki Watch desktop app

Goal: provide a small Tauri v2 GUI for Postman pool auto-join that reuses the proven `scripts/postman-pool*.js|py` runtime and can be built natively for Windows, macOS, and Linux.

## Scope

- The app orchestrates existing Node/Python/Telethon/Selenium scripts; join/report/config logic remains in those scripts.
- Runtime browser is LibreWolf through Selenium/geckodriver. The join worker drives a session-only copy of each selected profile so originals can remain open.
- `~/.aki/mcpsv/postman-pool.json` remains the config SSoT. Secrets stay local; OS keychain storage remains a later hardening item.
- Join follows the supplied author's fully automatic normal flow: Account Chooser discovery → per-account session switch via chooser card `href` → automatic invite controls/checkboxes → success only on joined signal or real `*.postman.co` destination. There is no manual verification checkpoint; no CAPTCHA/challenge solver or bypass is implemented.
- The app bundles its own minimal Node/Python script runtime as Tauri resources, so packaged builds no longer depend on a source checkout. Node, Python, LibreWolf, Telethon, Selenium, and the browser driver remain host prerequisites; launch preflight reports them with remediation.

## Architecture decisions

- Location: `apps/aki-watch/`.
- All Tauri commands that wait for Node/Python run as `async fn` + `tauri::async_runtime::spawn_blocking`.
- GUI readiness/config actions call `scripts/postman-pool-setup.js`; runtime Start/Stop/status/profile/manual-join actions call `scripts/postman-pool-control.js`; Telegram interactive actions call `scripts/postman-pool-telegram.py`. No duplicate business rules in Rust.
- Windows uses `py -3`; macOS/Linux use `python3`.
- Interactive Telegram login/observe opens a native console/terminal: Windows new console, macOS Terminal through `osascript`, Linux via `x-terminal-emulator`, `gnome-terminal`, or `konsole`.
- Packaged GUI processes restore the user's shell PATH with `tauri-apps/fix-path-env-rs` pinned to `c4c45d503ea115a839aae718d02f79e7c7f0f673`, so Node/Python installed through normal package managers remain discoverable.
- Bundle target is `all`; actual installers are built on their native host/CI. Windows does not produce a native macOS DMG by itself. Windows additionally stages a no-install portable folder by copying the release executable plus the exact `bundle.resources` map from `tauri.conf.json`, then archives it as a ZIP.
- Version SSoT remains `package.json`; `tauri.conf.json` references it and `Cargo.toml` must stay in lockstep.

## Screens

1. Join Now — paste a full invite link or raw `invite_code`, scan all LibreWolf profiles, Start/Stop one manual all-profile run, show progress/account status/realtime worker log.
2. Auto Watch — Start/Stop/Refresh the detached Telegram watcher without restarting Aki MCP; scan/verify Postman profile sessions; run Telegram login/list/observe/report-test helpers.
3. Settings — Telegram credentials/session IDs, source/admin allowlist, report bot/chat, LibreWolf binary/profile root/profile selection, `headless`, scratch root, timeouts, and the shared environment check.

## Current checklist

- [x] Tauri v2 scaffold and async subprocess boundary.
- [x] Config/status/save bridge to the Node SSoT.
- [x] Telegram login/list/observe controls.
- [x] GUI migrated from stale Chrome/CDP fields to LibreWolf/geckodriver fields.
- [x] Windows/macOS/Linux Python launcher paths implemented.
- [x] PATH restoration added for packaged GUI apps.
- [x] Bundle config changed from MSI-only to platform-native `all`.
- [x] Runtime watcher ownership moved out of `scripts/start.js`; Aki Watch controls a detached watcher with loopback-authenticated graceful stop/status.
- [x] Manual GUI join uses stdin for invite data, supports raw `invite_code`, and records only the latest local result/log instead of accumulating run files.
- [x] Python worker emits chooser discovery + per-account start/status/done events for live GUI progress; manual Human Verify/manual-accept states were removed from the normal flow.
- [x] GUI rebuilt around the uploaded Joiner flow: invite input, Start/Stop, progress metrics, account table, realtime log, watcher controls, profile health, and settings.
- [x] `cargo check`, `cargo fmt --check`, focused Python/Node tests, and full repo tests are green on Windows.
- [x] Opus HOLD P0 packaging fix: minimal runtime scripts are Tauri resources and packaged runtime resolution no longer requires the compile-time repo path.
- [x] Opus P1 UX: machine-readable preflight, cancellable Verify Login with per-profile progress, humanized common errors. The earlier Headless/Human-Verify hard guard was superseded after direct comparison with the supplied author's source: headless is now allowed because the join path has no manual checkpoint.
- [x] Accessibility hardening: tabs/progress/live regions plus profile checkbox picker; restrictive local CSP enabled.
- [x] Dedicated `.github/workflows/aki-watch.yml` native build/smoke matrix added and proven green on Windows/macOS/Linux.
- [x] Windows no-install portable ZIP stages the executable beside the same Tauri runtime resources, is smoke-launched in CI, and publishes as `aki-watch-windows-portable`.
- [ ] Run a fresh real Postman invite E2E; static tests cannot prove the provider's current page flow.
- [ ] Later: native in-window OTP/2FA fields, keychain secret storage, code signing/updater, optional bundled runtimes.

## Risks / limits

- macOS and Linux terminal launchers need a supported local terminal and installed runtime dependencies.
- Provider login/invite UI can change independently of the app; the production Account Chooser selectors/flow are source-faithful to the supplied joiner but still require a fresh live-invite E2E against Postman's current UI.
- Building distributable artifacts has platform-specific prerequisites and signing requirements.
