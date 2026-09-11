# Aki Watch

Tauri v2 desktop front-end for the repository's Postman pool auto-join runtime.

It does not reimplement join logic. The app calls `scripts/postman-pool-setup.js` for config, `scripts/postman-pool-control.js` for GUI runtime control, and `scripts/postman-pool-telegram.py` for interactive Telegram setup. The reusable watcher/worker remain `scripts/postman-pool.js` and `scripts/postman-pool-join.py`.

## Runtime prerequisites

- Node
- Python 3 + `telethon` + `selenium`
- LibreWolf with the intended Postman profiles already signed in

Packaged builds bundle the minimal Aki Watch runtime scripts as Tauri resources under `aki-watch-runtime/`; the source repository is no longer required on the target machine. `AKI_WATCH_REPO_DIR` remains an optional development override when it points at a valid checkout.

The GUI runs a machine-readable preflight at launch and before Join/Watcher/Verify actions. Manual Join/Stop has live per-account progress; Verify Login is also background/cancellable with per-profile progress; Auto Watch has independent Start/Stop. Join Now follows the uploaded author flow: open Postman's account chooser, discover saved accounts, switch each account session through its chooser card, auto-confirm normal invite controls/checkboxes, and only mark success after reaching a Postman team/application destination. There is no manual Human Verify checkpoint in the normal flow; if Postman presents a security challenge that does not clear during the bounded automatic loop, that account fails/retries instead of pausing for operator input.

## Development

```text
npm install
npm run tauri dev
```

Static Rust check:

```text
cargo check --manifest-path src-tauri/Cargo.toml
```

## Packaging

`tauri.conf.json` uses `bundle.targets = "all"` and maps the runtime scripts into Tauri resources. `.github/workflows/aki-watch.yml` builds and smoke-launches the native Tauri app on Windows, macOS, and Ubuntu. Windows can be verified locally; macOS/Linux remain unproven until that workflow actually runs green on committed code.
