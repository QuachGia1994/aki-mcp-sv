# Aki Watch — onboarding & setup

Aki Watch is the Windows-only Postman pool auto-join: it listens to one Telegram group through your own Telegram user session, and when an allowlisted admin posts a Postman team invite it opens that invite in each configured Postman browser profile, accepts it, and reports the joined accounts back through a Telegram bot DM. LibreWolf/Selenium remains the default backend; `chrome-cdp` is an optional backend using a dedicated Chrome user-data directory. This guide is the human walkthrough; the architecture and runtime flow live in `docs/ref/postman-pool-autojoin.md` (how the pieces fit and why).

## What only a human can do (no tool skips these)

The guided setup automates config assembly, validation, and the outbound test — but four steps are gated by Telegram/Postman themselves and must be done by you:

| Step | Why it cannot be automated |
|---|---|
| Get `telegramApiId` / `telegramApiHash` at my.telegram.org | Telegram issues app credentials only through its web login; there is no API to mint them. |
| Telethon login (phone + one-time code + 2FA) | Interactive by design, and the code/2FA are secrets you type once. |
| Create the report bot with @BotFather (or reuse one) | Telegram has no API to create a bot; you chat with @BotFather to get the token. |
| Sign each selected browser profile into Postman | Automating a Postman login (credentials/SSO/2FA) is a security and terms risk; the automation only accepts invites in profiles already signed in. Chrome/CDP must use its own dedicated user-data directory. |

So the realistic target is "guided, validated, one place" — not "zero human steps".

## Prerequisites

- Windows, Node (the version in `package.json` `engines`), and the Windows Python launcher `py -3`.
- Python packages: `py -3 -m pip install telethon selenium`.
- Default backend: LibreWolf installed (default `C:\Program Files\LibreWolf\librewolf.exe`), with the Postman profiles you want already signed in.
- Optional `chrome-cdp`: Google Chrome installed plus a dedicated non-default `chromeUserDataRoot` whose selected Chrome profiles are already signed into Postman. Do not use Chrome's normal `%LOCALAPPDATA%\Google\Chrome\User Data` root.
- A roomy non-system drive for `scratchRoot` (LibreWolf clones and identity-history copies are temporary).

## Step 1 — Telegram API credentials (my.telegram.org)

Open `https://my.telegram.org`, log in with your phone number, go to **API development tools**, create an app (any title/short-name), and copy **App api_id** and **App api_hash**. These identify your Telegram user client — keep them local, never commit them.

## Step 2 — Report bot (@BotFather) or reuse an existing outbound bot

In Telegram, open **@BotFather**, send `/newbot`, choose a name and a username ending in `bot`, and copy the **HTTP API token** it returns. To send reports to your own DM, open your new bot and press **Start** once (a bot cannot message a user who never started it).

You may instead reuse an existing outbound bot: this feature only ever calls Bot API `sendMessage`. If that bot already uses a webhook elsewhere, that is fine — Aki never calls `getUpdates`, `setWebhook`, or `deleteWebhook`, so the webhook owner keeps exclusive inbound control.

## Step 3 — Postman profiles

Ensure each browser profile you want in the pool is already logged into Postman. The automation operates only the normal `Accept Invite` / `Join Team` path; if a profile is signed out it is reported as failed, never fed credentials. For `chrome-cdp`, initialize the dedicated user-data directory manually and close its Chrome windows before Aki starts a join run. Human Verify is always manual; Aki waits in the same browser context and resumes after you clear it.

## Step 4 — Run the guided setup

```powershell
node scripts/postman-pool-setup.js --check
```

`--check` is non-interactive: it prints Node/Python/Telethon/Selenium plus the selected browser backend readiness and the current config state (which required fields are still missing), without printing any secret value. Run it any time to see whether the watcher can be enabled.

```powershell
node scripts/postman-pool-setup.js
```

The interactive wizard walks through Telegram credentials/session, source/admin IDs, report bot/chat, and browser backend selection. It can keep the existing `librewolf` backend or configure `chrome-cdp` with Chrome binary, dedicated user-data root, and optional profile-directory allowlist; it then validates the config, offers a single outbound `sendMessage` test, and only then offers to set `enabled=true`. Secrets are written to `~/.aki/mcpsv/postman-pool.json` (outside git) and never echoed. After enabling, restart Aki so the watcher process reads the new config.

`reportChatId` for a private DM is your own Telegram user ID (shown on the `SELF` line during login); for a group, add the bot to that group and use its chat ID from the dialog list.

## Safety & limits

- The token and api hash stay only in `~/.aki/mcpsv/` (or the `AKI_POSTMAN_POOL_REPORT_BOT_TOKEN` env var). Never commit or paste them.
- Outbound only: the report path is `sendMessage`; the source listener is your Telethon user session. Do not point the bot at `getUpdates` or move its webhook.
- Human Verify is not automated. The Chrome/CDP backend does not add stealth, fingerprint spoofing, challenge-control injection, or random-mouse behavior; it pauses on the challenge and resumes only after you clear it manually.
- Terms-of-service caution: auto-joining Postman team invites across many accounts, and driving a Telegram user session for automation, can violate Postman's and Telegram's terms. Use it only with accounts and groups you own, at small scale, and stop if a provider flags the activity.

## Reference

- `docs/ref/postman-pool-autojoin.md` — architecture, boundary, and runtime flow.
- `scripts/postman-pool-setup.js` — the wizard (`--check` and interactive).
- `scripts/postman-pool-report-test.js` — standalone outbound `sendMessage` test.
