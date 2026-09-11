# Aki Watch — onboarding & setup

Aki Watch is the desktop front-end for Postman pool auto-join. The same codebase targets Windows, macOS, and Linux; it listens to one Telegram group through the owner's Telethon user session, processes allowlisted Postman team invites through existing LibreWolf profiles, and reports results through an outbound Telegram bot. Runtime architecture: `docs/ref/postman-pool-autojoin.md`.

## Human checkpoints

The setup UI assembles and validates config, but these provider-owned steps remain interactive:

| Step | Reason |
|---|---|
| Get `telegramApiId` / `telegramApiHash` at my.telegram.org | Telegram issues user-client credentials through its authenticated site. |
| Telethon login (phone/code/2FA) | Credentials and one-time codes stay with the owner. |
| Create/reuse the report bot | Bot creation is handled through @BotFather. |
| Sign the selected LibreWolf profiles into Postman | Aki does not enter Postman credentials/SSO/2FA. |
| Clear Human Verify when Postman/Cloudflare presents it | Aki detects and waits; it does not interact with challenge controls. |

## Prerequisites

- Node matching the repository requirement.
- Python 3 (`py -3` on Windows, `python3` on macOS/Linux).
- `selenium` and `telethon` installed in that Python.
- LibreWolf installed and the selected profiles already signed into Postman.
- On macOS/Linux, the packaged Tauri app restores the shell PATH before launching Node/Python so Homebrew/package-manager installs remain discoverable.

Default LibreWolf profile roots are `%APPDATA%\librewolf\Profiles` on Windows, `~/.librewolf` or `~/.mozilla/librewolf` on Linux, and `~/Library/Application Support/librewolf/Profiles` on macOS. Explicit `librewolfBinary` and `profilesRoot` override auto-discovery.

## Setup

Check prerequisites and current config:

```text
node scripts/postman-pool-setup.js --check
```

Run the guided CLI setup when preferred:

```text
node scripts/postman-pool-setup.js
```

Or use `apps/aki-watch`: a launch preflight checks Node/Python/Telethon/Selenium/LibreWolf/profile readiness and shows actionable blockers. **Join Now** scans profiles and runs a pasted invite with Start/Stop, progress, account table, and realtime logs; **Auto Watch** starts/stops the Telegram watcher without restarting Aki MCP and exposes cancellable per-profile login verification plus Telegram helper actions; **Settings** edits the same `~/.aki/mcpsv/postman-pool.json`, uses a scanned profile picker, and runs the environment check.

The setup fields are Telegram API/session IDs, authorized source/admin IDs, report bot/chat, LibreWolf binary/profile root/profile allowlist, scratch root, and timeouts. Headless auto-join is blocked because Human Verify is manual-only and requires a visible LibreWolf window. `npm start` no longer owns the Postman-pool watcher lifecycle; Aki Watch's background controller does, so normal Start/Stop changes need no MCP restart.

## Telegram setup

Use the existing scripts for the first interactive login and immutable IDs:

```text
py -3 scripts/postman-pool-telegram.py --login --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
py -3 scripts/postman-pool-telegram.py --observe-senders --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

On macOS/Linux replace `py -3` with `python3`. The Aki Watch Login/Observe buttons open a native terminal for these interactive flows.

## Profile checks

```text
py -3 scripts/postman-pool-join.py --dry-run
py -3 scripts/postman-pool-join.py --smoke-browser
py -3 scripts/postman-pool-join.py --verify-login
```

`--dry-run` only inventories profiles. `--smoke-browser` opens a session copy against `about:blank`. `--verify-login` loads Postman and reports each copied profile's auth state. Replace `py -3` with `python3` on macOS/Linux.

## Safety & limits

Secrets remain under `~/.aki/mcpsv/` or the documented environment variable; invite URLs are not logged. The report path uses Bot API `sendMessage` only, so an existing webhook can keep inbound ownership. Aki drives only normal Postman UI; Human Verify is manual. Use only accounts/groups you control and comply with provider terms.

## Packaging

Tauri bundle targets are platform-native (`all`). The minimal Aki Watch runtime scripts are bundled as Tauri resources under `aki-watch-runtime`, so the target machine no longer needs the source repository. External prerequisites (Node, Python + Telethon/Selenium, LibreWolf/browser driver) are still host dependencies and are checked by preflight. `.github/workflows/aki-watch.yml` builds and smoke-launches native Windows/macOS/Linux artifacts; macOS/Linux should not be called verified until that workflow actually runs green on committed code. Tauri signing/notarization requirements still apply per platform.
