# Aki Watch

Tauri v2 desktop front-end for the repository's Postman pool auto-join runtime.

It does not reimplement join logic. The app calls `scripts/postman-pool-setup.js` for config, `scripts/postman-pool-control.js` for GUI runtime control, and `scripts/postman-pool-telegram.py` for interactive Telegram setup. The reusable watcher/worker remain `scripts/postman-pool.js` and `scripts/postman-pool-join.py`.

## Runtime prerequisites

- Node
- Python 3 + `telethon` + `selenium`
- LibreWolf with the intended Postman profiles already signed in

Packaged builds bundle the minimal Aki Watch runtime scripts as Tauri resources under `aki-watch-runtime/`; the source repository is no longer required on the target machine. `AKI_WATCH_REPO_DIR` remains an optional development override when it points at a valid checkout.

The GUI runs a machine-readable preflight at launch and before Join/Watcher/Verify actions. Manual Join/Stop has live per-account progress; Verify Login is background/cancellable, always headless, and checks profiles through a bounded five-worker pool so it never opens verification browser windows. Join Now uses the same bounded five-worker profile pool and shorter event-driven polling while retaining the destination, challenge, rate-limit, and invite-secrecy gates. Auto Watch has independent Start/Stop. Join Now follows the uploaded author flow: open Postman's account chooser, discover saved accounts, switch each account session through its chooser card, auto-confirm normal invite controls/checkboxes, and only mark success after reaching a Postman team/application destination. There is no manual Human Verify checkpoint in the normal flow; if Postman presents a security challenge that does not clear during the bounded automatic loop, that account fails/retries instead of pausing for operator input. Completion reports use the team slug, unique account count, main-account marker, and naturally ordered account emails.

Join Now sends its completion report through the configured Report Bot Token and Report Chat ID, including batches with failed accounts. A detached local supervisor owns the join worker and the single report attempt, so closing the window does not suppress delivery. The GUI keeps polling through delivery and shows Telegram sent/failed status; failures also appear in the Realtime log. Report requests time out after 10 seconds and are not automatically retried. Stop cancels the supervisor and its worker; a report already accepted by Telegram cannot be recalled.

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

`tauri.conf.json` uses `bundle.targets = "all"` and maps the runtime scripts into Tauri resources. `.github/workflows/aki-watch.yml` builds and smoke-launches the native Tauri app on Windows, macOS, and Ubuntu.

Windows also ships a no-install portable ZIP under the same `src-tauri/target/release/bundle/` root as the MSI. Extract the ZIP before launching it, and keep `aki-watch.exe` beside the `aki-watch-runtime/` folder. `npm run portable:stage` stages the release executable and the exact `bundle.resources` map from `tauri.conf.json` into `bundle/portable/Aki-Watch-portable/`, removing legacy duplicate staging folders first. CI first runs a hidden backend smoke that resolves and executes the bundled Node control script, then smoke-launches the GUI before publishing `aki-watch-windows-portable`. The portable app still requires the same host prerequisites listed above.
