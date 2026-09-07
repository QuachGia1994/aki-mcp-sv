# Postman pool auto-join

Windows-only local automation for the owner's existing LibreWolf Postman accounts. Aki listens to a Telegram group through the owner's own Telegram user session (Telethon/MTProto), so the group does not need to add a bot. When an allowlisted admin posts a Postman team invite link, Aki opens the invite through each local LibreWolf profile with Selenium/geckodriver, clicks `Accept Invite`, extracts the account email from local Postman identity metadata, then reports the joined accounts through a Telegram bot DM/chat.

## Boundary

- The group listener is the owner's Telegram account, not a bot. The account must already be a member of the source group and able to see the admin's message.
- Trigger authorization requires both the exact source chat ID and an allowlisted sender user ID from `~/.aki/mcpsv/postman-pool.json`; another group member posting an invite does nothing.
- `telegramApiHash`, the Telethon `.session`, and `reportBotToken` are credentials. They stay only under the user-local Aki config/session directory and never enter git.
- The report bot is outbound-only for this feature. It may already use a webhook elsewhere: Aki never calls `getUpdates`, `setWebhook`, or `deleteWebhook` on that bot, so an existing webhook owner keeps exclusive inbound control.
- Postman stays a normal web session inside the owner's existing LibreWolf profiles; the automation does not parse/decrypt access tokens, cookies, saved passwords, or Password Manager data.
- The invite URL is treated like a bearer link: it is passed to the Python worker through stdin, never logged and never echoed in the Telegram result.
- Browser profiles are cloned serially into a scratch directory so currently open LibreWolf windows are not killed or profile-locked. Cache folders are excluded; each clone is removed after its run. Put `scratchRoot` on a roomy non-system drive when possible.
- Aki's Node process owns authorization, dedupe, queueing, Selenium orchestration, and bot reporting. One long-lived Telethon Python child supplies Telegram user-session events; Selenium/geckodriver children exist only during an invite run.

## One-time setup

Install the two optional Python packages into the Windows Python used by Aki:

```powershell
py -3 -m pip install selenium telethon
```

Create or edit `~/.aki/mcpsv/postman-pool.json` while keeping `enabled=false`:

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
  "profileRoot": "C:\\Users\\YOU\\AppData\\Roaming\\LibreWolf",
  "librewolfBinary": "C:\\Program Files\\LibreWolf\\librewolf.exe",
  "scratchRoot": "D:\\LacViet\\.aki-tmp\\postman-pool",
  "timeoutSeconds": 45
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

This mode is non-interactive: if the session is not authorized it exits and tells you to run `--login`; it never starts a login flow itself.

To learn the pool admin's immutable sender ID without adding a bot to the group, run:

```powershell
py -3 scripts/postman-pool-telegram.py --observe-senders --config C:\Users\YOU\.aki\mcpsv\postman-pool.json
```

Wait until the intended admin posts a normal message, copy that `senderUserId` into `adminUserIds`, then stop with Ctrl+C. The observer prints sender identity only; it does not print message text or execute a Postman join.

Check Postman profile discovery without opening a browser:

```powershell
py -3 scripts/postman-pool-join.py --dry-run
```

Check that Selenium can control a cloned LibreWolf profile without touching Postman:

```powershell
py -3 scripts/postman-pool-join.py --smoke-browser
```

Finally set `enabled=true` and restart Aki. On boot Aki prints only the authorized source chat ID; it never prints Telegram credentials or the invite URL.

## Reusing an existing webhook bot

A separate report bot is not required merely because the existing bot has a webhook. This feature uses the bot only for Telegram Bot API `sendMessage`. The source-group listener is the Telethon user session, so there is no `getUpdates` versus webhook conflict.

For the ROBOT SLTP setup, the cloud control installs `https://www.oakgatekeeper.uk/api/telegram/webhook` with `setWebhook` and separately uses the same token for outbound `sendMessage`. Reusing `@hathawayVN_bot` for outbound pool reports is therefore compatible with its webhook as long as the bot can send to `reportChatId`. Do not move the bot's webhook, call `deleteWebhook`, or point Aki at `getUpdates`.

ROBOT SLTP does not currently expose that bot token through a clean local shared-secret file or generic authenticated report endpoint: its H1 cloud config stores the token encrypted in Redis. Aki must not scrape/decrypt that vault or couple this automation to ROBOT SLTP's storage internals. To use `@hathawayVN_bot`, supply the existing token once through `AKI_POSTMAN_POOL_REPORT_BOT_TOKEN` or the user-local `reportBotToken` field; do not commit or print it. This is a local credential copy, not a reason to create a second Telegram bot.

If the existing bot cannot DM the intended report recipient, have that recipient open the bot and press Start once, or use a report chat where the bot is already present. A second bot is only needed if you want credential/identity isolation or the existing bot is intentionally forbidden from sending these reports.

## Runtime flow

1. The configured admin posts a Postman team invite link in the configured Telegram group; no bot membership is required.
2. The local Telethon session emits the message to Aki. Aki validates sender ID, chat ID, HTTPS host, and invite-shaped URL, deduplicates the link, and queues one join run at a time.
3. `scripts/postman-pool-join.py` discovers LibreWolf profiles. Numbered profiles are included; a non-numbered main profile is also included when Postman identity metadata identifies an account.
4. Each profile is cloned to scratch, opened visibly with LibreWolf, and given the invite link. The worker clicks only `Accept Invite` / `Join Team` controls and reports success only after an explicit joined/already-member signal or a redirect to a known Postman application host; an arbitrary redirect or generic `Welcome to Postman` copy is not success.
5. Joined account emails are written to `~/.aki/mcpsv/postman-emails.txt`; the report bot sends joined/already-joined, skipped, and failed counts plus account emails/profile names to `reportChatId`.
6. Scratch profile clones are deleted after each account. A failed account does not prevent the remaining profiles from running.

Postman's invite-link flow remains open invite -> `Accept Invite` -> sign in if needed -> redirect to the team. If a profile is no longer signed in, the worker reports that profile as failed instead of attempting to enter credentials.
