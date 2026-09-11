# Postman pool auto-join

Local automation for the owner's existing Postman accounts in LibreWolf profiles. Aki Watch owns the Telegram watcher as a separate local background process, so the group does not need to add a bot and toggling the watcher does not restart Aki MCP. When an allowlisted admin posts a Postman team invite link, the watcher serially drives session-only copies of selected LibreWolf profiles through Selenium/geckodriver, accepts normal Postman invite UI when possible, verifies the joined outcome, and reports through a Telegram bot DM/chat. The Tauri GUI also supports pasting an invite for an immediate all-profile run with live progress/logs.

## Boundary

- The group listener is the owner's Telegram account, not a bot. The account must already be a member of the source group and able to see the admin's message.
- Trigger authorization requires both the exact source chat ID and an allowlisted sender user ID from `~/.aki/mcpsv/postman-pool.json`; another group member posting an invite does nothing.
- `telegramApiHash`, the Telethon `.session`, and `reportBotToken` are credentials. They stay only under the user-local Aki config/session directory and never enter git.
- The report bot is outbound-only for this feature. Aki never calls `getUpdates`, `setWebhook`, or `deleteWebhook` on that bot.
- The invite URL is treated like a bearer link: it is passed to the Python worker through stdin, never logged, and never echoed in the Telegram result.
- The worker copies only the session material it needs into a scratch profile, drives that copy, then deletes it. Original LibreWolf profiles may remain open and are not modified by the join worker.
- Aki does not attempt to solve or click Cloudflare/Human Verify. When a security-verification page appears, it emits a manual checkpoint and waits in the same visible browser context for the owner to clear it.
- If Postman redirects invite acceptance into a forced interactive re-auth wall, Aki reports `manual_accept_required` instead of looping until timeout.

## Requirements

Install Python packages into the Python used by Aki:

```powershell
py -3 -m pip install selenium telethon
```

Install LibreWolf. Selenium 4 uses Selenium Manager/geckodriver for Firefox-compatible automation; no Chrome/CDP profile is required by the current implementation.

Default profile roots:

- Windows: `%APPDATA%\librewolf\Profiles`
- Linux: `~/.librewolf` or `~/.mozilla/librewolf`
- macOS: `~/Library/Application Support/librewolf/Profiles`

The worker also accepts explicit `librewolfBinary`, `profilesRoot`, and `profileDirectories` values when auto-discovery does not match the host.

## Config

Create or edit `~/.aki/mcpsv/postman-pool.json`:

```json
{
  "enabled": false,
  "telegramApiId": 12345678,
  "telegramApiHash": "<api-hash-from-my.telegram.org>",
  "telegramSessionPath": "C:\\Users\\YOU\\.aki\\mcpsv\\telegram-user.session",
  "sourceChatId": "",
  "adminUserIds": [],
  "reportBotToken": "<existing-report-bot-token>",
  "reportChatId": "<your-private-chat-id-with-the-bot>",
  "librewolfBinary": "C:\\Program Files\\LibreWolf\\librewolf.exe",
  "profilesRoot": "C:\\Users\\YOU\\AppData\\Roaming\\librewolf\\Profiles",
  "profileDirectories": [],
  "headless": false,
  "scratchRoot": "D:\\LacViet\\.aki-tmp\\postman-pool",
  "timeoutSeconds": 45,
  "manualVerificationSeconds": 300
}
```

Aki Watch blocks auto-join/verify while `headless=true` because Human Verify is manual-only and requires a visible LibreWolf window. `profileDirectories=[]` means discover all valid LibreWolf/Firefox-style profile directories under `profilesRoot`; otherwise choose specific profiles in the GUI picker or provide exact directory/display names. The legacy `enabled` field remains in local config compatibility, but `npm start` no longer owns the watcher lifecycle; the Aki Watch GUI starts/stops the background watcher directly.

## Telegram setup

`telegramApiId` and `telegramApiHash` come from the owner's Telegram application at `my.telegram.org/apps`; they are Telegram user-client credentials, not the bot token.

Login once and list groups visible to that Telegram account:

```powershell
py -3 scripts/postman-pool-telegram.py --login --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

After the first login, re-list dialogs without an OTP prompt:

```powershell
py -3 scripts/postman-pool-telegram.py --list-dialogs --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

Observe immutable sender IDs without adding a bot to the group:

```powershell
py -3 scripts/postman-pool-telegram.py --observe-senders --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

Copy the intended pool group's ID into `sourceChatId` and the authorized admin's sender ID into `adminUserIds`.

## Aki Watch GUI control

`apps/aki-watch` is the primary runtime controller. At launch and before actions it runs a machine-readable readiness preflight. **Join Now** mirrors the uploaded Postman Team Auto-Joiner flow: paste an invite, scan profiles, Start/Stop, per-account progress, and realtime logs. **Auto Watch** starts/stops the Telegram watcher as a detached local process through `scripts/postman-pool-control.js`; no Aki MCP restart is required. Verify Login is also detached/cancellable with per-profile progress. **Settings** edits the same `~/.aki/mcpsv/postman-pool.json` source of truth and uses a scanned profile picker.

The GUI control layer never puts the invite URL in process argv. Manual joins send the invite through stdin to `postman-pool-join.py`; watcher invites already follow the same stdin boundary.

## Browser/profile checks

Check environment and config without opening a browser:

```powershell
node scripts/postman-pool-setup.js --check
```

List discovered profiles and inferred Postman email metadata without opening LibreWolf:

```powershell
py -3 scripts/postman-pool-join.py --dry-run
```

Launch a session-only copy of the first profile against `about:blank` to verify Selenium/geckodriver can drive LibreWolf:

```powershell
py -3 scripts/postman-pool-join.py --smoke-browser
```

Check whether profile copies still carry a usable Postman session:

```powershell
py -3 scripts/postman-pool-join.py --verify-login
```

`--smoke-browser` and `--verify-login` open a real browser and are runtime checks. They do not accept a team invite by themselves.

## Reusing an existing webhook bot

A separate report bot is not required merely because the existing bot has a webhook. This feature only uses the Bot API `sendMessage`; the source-group listener is Telethon, so there is no `getUpdates` versus webhook conflict.

For the ROBOT SLTP setup, the cloud control may retain webhook ownership while the same token is used for outbound reporting. Do not move or delete the bot webhook for Postman pool automation. Supply the existing token through `AKI_POSTMAN_POOL_REPORT_BOT_TOKEN` or the local `reportBotToken` field; do not commit or print it.

## Runtime flow

1. The configured admin posts a Postman team invite link in the configured Telegram group.
2. The Aki Watch background watcher receives the Telethon message. `scripts/postman-pool.js` validates sender ID, chat ID, HTTPS Postman host, and invite-shaped URL, deduplicates the link, and queues one join run at a time.
3. `scripts/postman-pool-join.py` discovers selected LibreWolf profiles. Email labels are inferred from Postman identity URLs in each profile's `places.sqlite` when available.
4. For each profile, the worker creates a lightweight session-only copy containing the signed-in session files and Postman web storage, starts LibreWolf through Selenium/geckodriver, then opens the invite.
5. Normal Postman controls such as `Accept Invite` / `Join Team` may be clicked automatically. `Keep these accounts separate` and bounded Postman rate-limit refresh handling are normal interstitial handling.
6. If Cloudflare/Human Verify appears, Aki reports `manual_verification_required` and only waits. After the owner clears the challenge in the same window, Aki emits `manual_verification_resolved` and resumes. It does not interact with challenge controls.
7. If invite acceptance forces a Postman re-auth wall, Aki reports `manual_accept_required` for that account and continues the remaining profiles.
8. Success requires an explicit joined/already-member signal or a redirect to a recognized Postman application/team host. One failed account does not stop the remaining profiles.
9. Joined account emails are written to `~/.aki/mcpsv/postman-emails.txt`; the report bot sends joined/already-joined, manual-accept, skipped, and failed counts plus account/profile labels.

## Current architecture note

The production path is LibreWolf/geckodriver. Lightpanda is not a runtime dependency, and undocumented Postman Root APIs are not used for authentication or invite acceptance. Future account-chooser optimization should preserve the existing profile path until it has live Postman evidence.
