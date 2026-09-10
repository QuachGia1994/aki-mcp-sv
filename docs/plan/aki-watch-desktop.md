# Aki Watch desktop app (Phase 1)

Goal: a small Tauri v2 desktop GUI so a non-technical owner can set up and run Aki Watch (Postman pool auto-join) — a friendly front-end over the proven `scripts/postman-pool*.js|py`, shareable as a Windows app.

## Scope-lock (MVP) and non-goals

- MVP **wraps existing runtimes**; it does NOT bundle Node/Python/Telethon/Selenium or Google Chrome. The pool uses Chrome/CDP only and requires a dedicated non-default Chrome user-data directory. Target machine already has this repo plus those dependencies. A self-contained installer that ships runtimes is a later phase.
- MVP reuses `~/.aki/mcpsv/postman-pool.json` (the scripts' own loader). Moving secrets into the OS keychain is a follow-up.
- MVP produces an **unsigned** Windows build (SmartScreen warning expected). Code signing + Tauri updater are follow-ups.
- No automation logic is reimplemented in Rust — the app shells out to the Node/Python that is already tested (131/131).

## Toolchain (verified 2026-09-07)

cargo 1.97.1 · rustc 1.97.1 · node v26.7.0 · npm 11.19.0. Tauri v2 is feasible on this machine.

## Decisions

- Location: `apps/aki-watch/` inside this repo (tight coupling to `scripts/*`; additive and reversible).
- Backend↔scripts: Rust `#[tauri::command] async fn` spawns `node`/`py` from the repo via `tauri::async_runtime::spawn_blocking` (tauri.A1 never-block-UI), scoped to the repo dir (tauri.B7 scope every spawn).
- Single source of truth for readiness/validation: reuse the Node exports `getPostmanPoolConfigStatus`, `resolveReportCredentials`, `sendPostmanPoolReportMessage` through a tiny `node -e`/subcommand bridge — no duplicate validation in Rust.
- Telethon interactive login (phone/OTP/2FA): MVP launches the existing interactive login/setup in a console the owner completes, then the GUI polls `getPostmanPoolConfigStatus` for readiness. Hosting the OTP fields natively (staged stdin protocol into the Python) is the main UX debt — recorded here so it is not mistaken for done.
- Version SSOT: `package.json`; `tauri.conf.json` version = `"../package.json"`; `Cargo.toml` crate version bumped in lockstep (tauri.B5).

## MVP screens

1. Environment check — runs the `--check` path, shows the readiness table.
2. Setup wizard — API creds form (link my.telegram.org) → launch login (console) → pick `sourceChatId` → capture `adminUserIds` → bot token + `reportChatId` → configure Chrome binary + dedicated user-data/profile directories → validate → send test → enable toggle.
3. Status/control — enabled state, missing fields, send outbound test, open the onboarding doc.

## Security/boundary (inherited, unchanged)

Outbound `sendMessage` only; never `getUpdates`/`setWebhook`/`deleteWebhook`; secrets never printed or committed; invite URLs never logged. Chrome/CDP binds only to loopback, requires a dedicated non-default Chrome user-data directory, and never automates Human Verify.

## Build checklist (staged)

- [x] Stage 1 — scaffold `apps/aki-watch` (Tauri v2 + vanilla frontend); async command `env_check` runs Node `--check`; window renders it. Verified via `npm run tauri dev` (owner) after installing VS C++ Build Tools.
- [x] Stage 2 — config read/status/save via Node JSON bridge (`--status-json`/`--get-config-json`/`--set-config-json`, secret-safe); Rust `config_status`/`get_config`/`save_config`; 3-screen UI.
- [x] Stage 3 — `launch_login`/`launch_observe` (Windows CREATE_NEW_CONSOLE for interactive OTP), `list_dialogs` (non-interactive), `send_test` (sendMessage-only), enable/disable toggle guarded on `ready`.
- [x] Stage 4 audit — 8 commands all async + spawn_blocking (tauri.A1 pass); version SSOT consistent (package.json 0.1.0 = Cargo.toml, tauri.conf version=../package.json); bundle target set to `["msi"]`.
- [ ] Stage 4 package — owner runs `npm run tauri build` to produce the unsigned `.msi` (heavy release build; first bundle downloads WiX). Output: `src-tauri/target/release/bundle/msi/*.msi`. Unsigned → SmartScreen warning expected.
- [ ] Follow-ups (not MVP) — native OTP fields, OS keychain secret storage, code signing + Tauri updater, bundled runtimes.

## Risks

- Auto-join across many accounts + a Telegram user session: Postman/Telegram ToS (see `docs/ref/aki-watch-onboarding.md`).
- First `cargo build` time and network dependency.
- Unsigned build triggers Windows SmartScreen until signing is added.

## Open confirmations

- Location `apps/aki-watch/` acceptable inside this repo?
- MVP login-in-console acceptable for now (vs waiting for native OTP UX in-window)?
