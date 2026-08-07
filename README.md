# aki-mcp-sv

Give Claude on the **web** (claude.ai) read/edit access to files and a whitelisted shell on your local machine — over HTTPS via Tailscale Funnel, gated by OAuth 2.1. No desktop app, no device install.

Version: **1.0.1** ([CHANGELOG.md](CHANGELOG.md)) · License: MIT · macOS only.

<img width="288" height="438" alt="Screenshot 2026-08-07 at 23 25 12" src="https://github.com/user-attachments/assets/8947f948-c012-4802-8936-28d2495586b1" />

<img width="498" height="390" alt="Screenshot 2026-08-07 at 23 06 42" src="https://github.com/user-attachments/assets/94800561-b799-49ce-a7ab-08a52b6dbfde" />

## Why this exists

Claude.ai's web/Pro plan quota is generous compared to paying per token through the API for the same usage — the API route runs noticeably more expensive for equivalent work. But most real usage is project work: reading, editing, and running commands against files on your own machine, not open-ended chat.

The Claude Desktop app can do local file access, but it comes with tradeoffs: usage gets tied to a device ID and other identifiers you don't control, and running multiple accounts means repeated login/logout instead of just switching a Chrome profile.

This project routes around both problems: run an MCP server on your machine, expose it over HTTPS through Tailscale Funnel, and connect it to claude.ai as a custom connector. You get local file/shell access from the browser, on the web quota, with no app install and no account lock-in.

### How this differs from Desktop Commander

[Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) is the most widely used MCP terminal server, and solves a related but different problem: it runs locally for **Claude Desktop**, and guards shell access with a **blocklist** (`blockedCommands` — an explicit list of forbidden commands). A blocklist is inherently leaky: you can't enumerate every dangerous command and variant, and the default is *allow* — anything not yet added to the list gets through.

This project targets a different scenario — exposing local access to Claude **on the web**, across the open internet via Funnel — and makes the opposite default choice: a **whitelist**. Nothing runs unless it's explicitly allowed. See [Security](#security) for what that buys you.

## Architecture

```
Claude web (claude.ai)
      │  HTTPS + OAuth 2.1 (DCR skipped — self-issued client ID/secret)
      ▼
Tailscale Funnel        (https://your-machine.your-tailnet.ts.net)
      │
      ▼
gatekeeper.js  — public port 9999
      │           /.well-known/oauth-*  metadata
      │           /authorize, /token    minimal authorization server (scripts/oauth.js)
      │           /mcp                  requires a valid Bearer access token, else 401
      │                                 POST → real Streamable HTTP (scripts/streamable-bridge.js)
      ▼
mcp-hub        — internal only (loopback), port 19999, legacy HTTP+SSE transport
      │
      ├─► MCP filesystem server   (read/write inside the allowed folders)
      ├─► MCP search server       (search-mcp.js — find_path/search_content, whole-tree in one call)
      └─► MCP shell server        (shell-mcp.js — allowlisted commands, read-only by default)

panel.js       — 127.0.0.1:9998, never exposed via Funnel
                 control UI: allowed folders, shell allowlist, restart hub,
                 install akidevrule, generate the connector prompt, Chrome CDP
```

`mcp-hub` ships its own unauthenticated admin REST API (`/api/*`) on the same port — `gatekeeper.js` exists specifically so that never reaches the internet. Details: `docs/plan/init.md`.

OAuth (not token-in-URL) is used because claude.ai always attempts Dynamic Client Registration regardless of configuration — details: `docs/ref/oauth-research-2026-08-07.md`.

## Requirements
<img width="649" height="689" alt="image" src="https://github.com/user-attachments/assets/c4d50b51-fb2f-4e13-9ee4-4214068d8b3f" />

- macOS with Node.js installed
- Tailscale — one-time setup:
  1. [Install Tailscale](https://tailscale.com/download) and sign in (app or `brew install tailscale`, either works as long as `tailscale` is on PATH)
  2. Enable [Funnel](https://tailscale.com/docs/features/tailscale-funnel) for your tailnet — free on every plan, one-time toggle via the `login.tailscale.com/f/funnel` link `npm start` prints if it isn't on yet

After that, `npm start` enables Funnel on port 9999 automatically every run.

## Directory layout

```
aki-mcp-sv/
├── package.json
├── mcp-hub.config.json         # shipped default, uses ${MCP_DATA_DIR}/${HOME} placeholders
├── scripts/
│   ├── start.js                 # orchestrates mcp-hub + gatekeeper
│   ├── gatekeeper.js             # OAuth-gated reverse proxy, public port
│   ├── oauth.js                  # minimal authorization server (DCR skipped)
│   ├── streamable-bridge.js      # Streamable HTTP shim <-> mcp-hub's legacy SSE transport
│   ├── shell-mcp.js              # allowlist-gated shell tool (read-only by default)
│   ├── allowlist.js              # default command set + settings reader — shared by server and panel
│   ├── search-mcp.js             # find_path / search_content — whole tree in one call
│   ├── roots.js                  # path containment shared by every filesystem-touching tool
│   ├── tailscale.js              # reads Funnel status — shared by start.js and panel
│   ├── panel.js                  # loopback-only control panel (:9998), token-gated
│   ├── config-page.js            # renders the panel page
│   ├── userdata.js               # user data location (~/.aki/mcpsv) — single source of truth
│   └── chrome.js                 # minimal CDP client; opens Chrome if not running
└── public/                       # favicon + images, served publicly by gatekeeper
```

Your data lives outside the repo, at `~/.aki/mcpsv/` — the same convention CLIs like `~/.aws` or `~/.docker` use:

```
~/.aki/mcpsv/
├── mcp-hub.config.json   # live config (which folders you granted access to)
├── setting.json          # shell allowlist, edited from the panel
├── oauth-client.json     # client ID + secret (0600)
├── passphrase.txt        # passphrase for the /authorize consent screen (0600)
└── tokens.json           # access/refresh tokens (0600)
```

A clone stays exactly as checked out — editing folders/allowlist from the panel never produces a diff in the repo.

## Install

```bash
git clone <repo-url> aki-mcp-sv
cd aki-mcp-sv
npm install
```

## Run

```bash
npm start
```

Nothing needs preparing beforehand — `npm start` handles it:
- **Passphrase** and **OAuth client ID/secret** in `~/.aki/mcpsv/`: generated once, reused on every later run.
- **Funnel**: checks `tailscale funnel status`; if port `9999` isn't on yet, runs `tailscale funnel --bg 9999` (idempotent — never toggles an already-enabled port).
- Prints the 4 values you need: **Remote MCP server URL**, **OAuth Client ID**, **OAuth Client Secret** (paste into claude.ai), and **Passphrase** (enter on the confirmation page when you hit Connect).
- Opens the **control panel** at `http://127.0.0.1:9998/?t=<token>` — 8 sections in the order you need them: Tailscale, connector, allowed folders, shell allowlist, akidevrule, connector prompt, utilities, Chrome.

The default allowed root is your **home directory** (`$HOME`) — the one folder guaranteed to exist on any machine and to hold the projects you actually want Claude to reach. Add/remove folders from **panel section 3**: the "Choose folder…" button opens macOS's native picker (multi-select in one pass); saving restarts the hub automatically. To change the root from the start: `MCP_DATA_DIR=/other/path npm start`.

Beyond `$MCP_DATA_DIR`, the filesystem server is also granted `~/.aki` (where akidevrule deploys) and `~/.claude`, so claude.ai can read your **native** `CLAUDE.md` and skill router the same way Claude Code does — no copying, no staging.

`~/.claude` is granted at the folder level (the filesystem server can't scope to individual files), so `.claude.json`/`auth-cache.json` (session tokens) and `history.jsonl` (chat history) inside it are also reachable through the connector. Remove the `${HOME}/.claude` line in panel section 3 if you don't want that — claude.ai then loses access to your `CLAUDE.md` too.

`npm start` runs in the foreground, same as before — Ctrl+C to stop, restart manually when needed. **After editing code, Ctrl+C and `npm start` again** — Node doesn't hot-reload.

## Exposing via Tailscale

`npm start` enables Funnel automatically when needed (see above) — no manual step. Funnel is state stored in `tailscaled` (survives reboots), independent of `npm start`'s own lifecycle; disable it entirely with `tailscale funnel 9999 off`.

**Know before enabling Funnel:**
- Free on every Tailscale plan, but the tailnet needs a one-time opt-in first (the `login.tailscale.com/f/funnel?node=...` link `tailscale funnel --bg` prints if it's missing).
- Only 3 ports are fundeable: `443`, `8443`, `10000` — you can't expose an arbitrary port.
- Bandwidth is limited; Tailscale doesn't publish an exact number.
- Don't toggle Funnel on/off repeatedly — re-issuing the certificate too often can hit Let's Encrypt's rate limit (locks you out for ~34h). `start.js` only enables it when it's genuinely off: `tailscale funnel status --json` keys `AllowFunnel` by the **public port (443)**, not the internal one, so it has to look inside `Web[].Handlers[].Proxy` for port 9999 — checking the wrong field makes every run think Funnel is off and re-enable it.

**Diagnosing "claude.ai can't connect" even though `tailscale funnel status` says "on":** a real failure mode — the serve-config saves locally correctly but doesn't sync to Tailscale's control plane, so a real client on the open internet gets blocked at the TLS layer while the host machine (routed through the internal mesh) sees everything as fine. **Don't test with a bare `curl https://<host>` from the machine running `npm start`** — that machine is in the tailnet and silently takes the mesh shortcut, so it doesn't reflect the real path. Test correctly instead:

```bash
dig @8.8.8.8 <host> A +short   # real public IP
curl --resolve <host>:443:<IP-from-above> https://<host>/.well-known/oauth-authorization-server
```

If that returns `SSL_ERROR_SYSCALL`/timeout despite `tailscale funnel status` saying "on", re-run `tailscale funnel --bg 9999` to force a config re-push (not a code bug). Full writeup: `docs/ref/oauth-research-2026-08-07.md`, section "Debug round 5".

## Connecting from Claude web

1. Go to **claude.ai → Settings → Connectors → Add custom connector**
2. **Remote MCP server URL**: paste `https://your-machine.your-tailnet.ts.net/mcp` (printed by `npm start`)
3. **Advanced settings → OAuth Client ID / OAuth Client Secret**: paste the two values `npm start` printed
4. Click **Connect** — a local confirmation page opens; enter the **passphrase** (contents of `~/.aki/mcpsv/passphrase.txt`) to approve

Why not token-in-URL: `docs/ref/claude-connector.md`, `docs/ref/oauth-research-2026-08-07.md`.

claude.ai connects and calls 14 tools: `filesystem__*`, `search__find_path`, `search__search_content`, `shell__run_cmd`.

### Chrome control — why "reconnect" is a separate button

Chrome only opens its debug port **at launch**: an already-running Chrome without that flag can't be attached to, it has to be quit and reopened. So the panel splits this in two — "Connect Chrome" never closes anything (opens it if it's not running, warns and stops if it's running without the flag), while quitting Chrome sits behind one button that says exactly what it does. A browser disappearing from a click that never promised that is a UX bug, not a convenience.

### Connector icon: not controllable from the server

claude.ai doesn't read the icon from the MCP server. It queries Google's favicon service with the tailnet's **apex domain**, not your host:

```
https://t2.gstatic.com/faviconV2?...&url=http://<tailnet>.ts.net&size=32
```

`<tailnet>.ts.net` has no public DNS record, so Google returns 404 and claude.ai falls back to a default letter icon. This server does serve `/favicon.ico` publicly, but there's no file we can place to change that result — your subdomain never appears in the query Google receives.

## Finding files — use `find_path`, don't browse level by level

`filesystem__search_files` doesn't return directories and tends to time out on large trees, so a remote session can appear to "not see" the very project it has access to. `search__find_path` scans the whole tree in one call (measured: ~0.2s to find one name across 164k files / 11.7k directories), returns **both files and directories**, and skips `node_modules`/`.git`/build output automatically. `query` is a case-insensitive substring, or a glob when it contains `*`/`?`.

## Security

Minimal OAuth 2.1, Dynamic Client Registration skipped on purpose (self-issued client ID/secret instead of letting claude.ai self-register). Full writeup (real request flow, the two actual barriers, known limits): `docs/ref/security-model.md`.

- `$MCP_DATA_DIR` (default `$HOME`) is the filesystem server's main root, plus `~/.aki` and `~/.claude` (for native rule files) — fixed at process start, changed via the panel restarts the hub. `~/.claude` is granted at the folder level, so session tokens and chat history inside it are in the connector's reach too — a known tradeoff, removable from the panel.
- The shell MCP is hand-written (`shell-mcp.js`), enforcing the allowlist in code (`execFile`, never through a shell, `; & | \`` blocked). The default set is read-only, defined in `allowlist.js`; the panel shows exactly that set as your starting point for edits, saved to `~/.aki/mcpsv/setting.json` → `shell.allowlist`. **Any command you add is your own responsibility** — adding a write command (e.g. `git commit`) crosses the "read-only" boundary this project ships with by default. A command can run in any directory under the same allowed roots as the filesystem server, via the `cwd` parameter — that's how you target a specific repo, instead of `cd`/`-C`.
- `gatekeeper.js` is the single public entry point — the real `mcp-hub` never listens on anything but loopback.
- `panel.js` writes config and runs commands on your machine, so it **only binds to `127.0.0.1`** and is never exposed via Funnel. Its token is regenerated every `npm start` and required both in the page's query string and in the `x-panel-token` header on every API call — blocking other browser tabs from POSTing to it.
- `~/.aki/mcpsv/passphrase.txt` (the `/authorize` consent passphrase) and `~/.aki/mcpsv/oauth-client.json` (client ID/secret) are mode 0600, live outside the repo (never reach git), and are only ever shared once, pasted into the connector dialog.
- Access/refresh tokens live in `~/.aki/mcpsv/tokens.json` (mode 0600) and survive restarts — a connector is long-lived file access, not a login session, so losing tokens on every `npm start` would just force pointless re-authentication. Access token TTL is 1 year, refresh tokens don't expire. Revoke by deleting `~/.aki/mcpsv/tokens.json` and restarting.
- Funnel stays enabled in the background for the whole project — `npm start` is the only thing you actively start/stop.

### Why whitelist, not blocklist

See [How this differs from Desktop Commander](#how-this-differs-from-desktop-commander) above for the comparison. For a server that exposes itself to the internet via Funnel, the whitelist choice is a real safety property, not a slogan:
- **Fail-safe** — an unfamiliar or new command is blocked automatically; nothing has to guess whether it's dangerous first.
- **Minimal attack surface** — only the exact commands you've approved can run, nothing more.
- **Granular down to the subcommand** — `git` is scoped to `status/log/diff/show`; a blocklist can't express that cleanly.
- **Read-only by default** — the built-in set is read-only commands only; adding a write command is a deliberate edit to `~/.aki/mcpsv/setting.json`, not the removal of a ban.

### DEMO img
 <img width="894" height="756" alt="image" src="https://github.com/user-attachments/assets/d91a86ea-0d3e-4695-95ef-d13861a242e6" />
 <img width="915" height="957" alt="image" src="https://github.com/user-attachments/assets/d32bd711-6bb7-4bf9-a5b0-d49eea3a9ffc" />


