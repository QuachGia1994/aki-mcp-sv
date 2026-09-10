# Postman pool auto-join

Windows-only local automation for the owner's existing Postman accounts in dedicated Chrome profiles. Aki listens to a Telegram group through the owner's Telegram user session (Telethon/MTProto), so the group does not need to add a bot. When an allowlisted admin posts a Postman team invite link, Aki launches the selected Chrome profile from a dedicated non-default user-data directory, attaches Selenium through Chrome DevTools Protocol (CDP), clicks the normal `Accept Invite` / `Join Team` control, verifies the joined outcome, and reports the result through a Telegram bot DM/chat.

## Boundary

- The group listener is the owner's Telegram account, not a bot. The account must already be a member of the source group and able to see the admin's message.
- Trigger authorization requires both the exact source chat ID and an allowlisted sender user ID from `~/.aki/mcpsv/postman-pool.json`; another group member posting an invite does nothing.
- `telegramApiHash`, the Telethon `.session`, and `reportBotToken` are credentials. They stay only under the user-local Aki config/session directory and never enter git.
- The report bot is outbound-only for this feature. It may already use a webhook elsewhere: Aki never calls `getUpdates`, `setWebhook`, or `deleteWebhook` on that bot, so an existing webhook owner keeps exclusive inbound control.
- The invite URL is treated like a bearer link: it is passed to the Python worker through stdin, never logged and never echoed in the Telegram result.
- Chrome must use a dedicated persistent user-data directory. The worker refuses Chrome's normal `%LOCALAPPDATA%\Google\Chrome\User Data` root. Initialize the dedicated profiles manually, sign them into Postman, then close those Chrome windows before Aki owns a join run.
- Aki does not copy, parse, or decrypt Chrome cookies, access tokens, saved passwords, or Password Manager data. It only reads Postman identity history metadata when available so reports can name the account email.
- CDP is used for normal browser navigation and the Postman invite control. If Postman/Cloudflare presents Human Verify, Aki reports a manual checkpoint and waits in the same browser context. It does not solve, click, spoof, inject into, or otherwise bypass the challenge.

## One-time setup

Install the optional Python packages into the Windows Python used by Aki:

```powershell
py -3 -m pip install selenium telethon
```

Install Google Chrome. Create or edit `~/.aki/mcpsv/postman-pool.json` while keeping `enabled=false`:

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
  "chromeBinary": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "chromeUserDataRoot": "D:\\LacViet\\.aki-postman-cdp\\chrome-user-data",
  "chromeProfileDirectories": [],
  "scratchRoot": "D:\\LacViet\\.aki-tmp\\postman-pool",
  "timeoutSeconds": 45,
  "manualVerificationSeconds": 300
}
```

`telegramApiId` and `telegramApiHash` come from the owner's Telegram application at `my.telegram.org/apps`; they are Telegram user-client credentials, not the bot token.

Log in once and list the groups visible to that Telegram account:

```powershell
py -3 scripts/postman-pool-telegram.py --login --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

The script prompts for phone/login code and 2FA if enabled, stores the Telethon session at `telegramSessionPath`, prints the owner's immutable Telegram user ID, then prints each group/channel as `chatId=<immutable-id> type=<group|channel> title=<name>`. Copy the intended pool group's ID into `sourceChatId`.

After that first login, re-list dialogs without any OTP prompt using:

```powershell
py -3 scripts/postman-pool-telegram.py --list-dialogs --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

To learn the pool admin's immutable sender ID without adding a bot to the group, run:

```powershell
py -3 scripts/postman-pool-telegram.py --observe-senders --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

Wait until the intended admin posts a normal message, copy that `senderUserId` into `adminUserIds`, then stop with Ctrl+C. The observer prints sender identity only; it does not print message text or execute a Postman join.

## Chrome profile setup

Chrome 136+ requires remote debugging to use a non-default `--user-data-dir`. Do not point `chromeUserDataRoot` at `%LOCALAPPDATA%\Google\Chrome\User Data`; the worker rejects that normal Chrome root.

Initialize the dedicated browser state manually once. Create the Chrome profiles you want under a directory such as `D:\LacViet\.aki-postman-cdp\chrome-user-data`, sign each selected profile into Postman, then close Chrome. Leave `chromeProfileDirectories` empty to discover `Default` plus `Profile N` directories, or list exact names such as `["Default", "Profile 1"]`.

Check profile discovery without opening Chrome:

```powershell
py -3 scripts/postman-pool-join.py --chrome-user-data-root D:\LacViet\.aki-postman-cdp\chrome-user-data --dry-run
```

Check that Chrome/CDP can launch the first selected dedicated profile without touching Postman:

```powershell
py -3 scripts/postman-pool-join.py --chrome-user-data-root D:\LacViet\.aki-postman-cdp\chrome-user-data --smoke-browser
```

Finally set `enabled=true` and restart Aki. On boot Aki prints only the authorized source chat ID; it never prints Telegram credentials or the invite URL.

## Reusing an existing webhook bot

A separate report bot is not required merely because the existing bot has a webhook. This feature uses the bot only for Telegram Bot API `sendMessage`. The source-group listener is the Telethon user session, so there is no `getUpdates` versus webhook conflict.

For the ROBOT SLTP setup, the cloud control installs `https://www.oakgatekeeper.uk/api/telegram/webhook` with `setWebhook` and separately uses the same token for outbound `sendMessage`. Reusing `@hathawayVN_bot` for outbound pool reports is therefore compatible with its webhook as long as the bot can send to `reportChatId`. Do not move the bot's webhook, call `deleteWebhook`, or point Aki at `getUpdates`.

ROBOT SLTP does not currently expose that bot token through a clean local shared-secret file or generic authenticated report endpoint: its H1 cloud config stores the token encrypted in Redis. Aki must not scrape/decrypt that vault or couple this automation to ROBOT SLTP's storage internals. To use `@hathawayVN_bot`, supply the existing token once through `AKI_POSTMAN_POOL_REPORT_BOT_TOKEN` or the user-local `reportBotToken` field; do not commit or print it.

## Runtime flow

1. The configured admin posts a Postman team invite link in the configured Telegram group; no bot membership is required.
2. The local Telethon session emits the message to Aki. Aki validates sender ID, chat ID, HTTPS host, and invite-shaped URL, deduplicates the link, and queues one join run at a time.
3. `scripts/postman-pool-join.py` discovers `Default` and `Profile N` under the dedicated Chrome user-data root, optionally restricted by `chromeProfileDirectories`.
4. For each profile, Aki launches visible Chrome with a loopback-only CDP port, attaches Selenium, navigates through CDP, and dispatches normal pointer events only to the Postman `Accept Invite` / `Join Team` control. Success requires an explicit joined/already-member signal or a redirect to a known Postman application host.
5. If Postman/Cloudflare shows a security-verification page, Aki stops normal UI automation, sends a `manual verification required` notice, and waits up to `manualVerificationSeconds` (default 300, bounded 60-900) for the owner to complete the challenge. When the challenge disappears in the same browser context, Aki resumes automatically. A verification timeout is retryable and the invite hash is not newly deduplicated by that run.
6. Joined account emails are written to `~/.aki/mcpsv/postman-emails.txt`; the report bot sends joined/already-joined, skipped, and failed counts plus account emails/profile names to `reportChatId`.
7. A failed account does not prevent the remaining Chrome profiles from running.

If a selected Chrome profile is no longer signed into Postman, the worker reports that profile as failed instead of attempting to enter credentials. Human Verify remains manual by design.
