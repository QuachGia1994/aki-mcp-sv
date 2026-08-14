# aki-mcp-sv

Give Claude on the **web** (claude.ai) and **ChatGPT** read/edit access to files and a whitelisted shell on your local machine, over HTTPS through a swappable public edge (Tailscale Funnel by default, or your own Cloudflare tunnel / any stable HTTPS edge), gated by OAuth 2.1. No desktop app, no device install.
<img width="1190" height="1062" alt="image" src="https://github.com/user-attachments/assets/760a7202-ad61-4f5d-86e3-973e90c74bd3" />

Version: **1.6.0** ([CHANGELOG.md](CHANGELOG.md)) · License: MIT · Windows, Linux, macOS.

<img width="1024" height="1296" alt="image" src="https://github.com/user-attachments/assets/4eac7831-4b0f-49cb-a62f-aadd0af54494" />

**Contents:** [Why this exists](#why-this-exists) · [When to use & Core Use-Cases](#when-to-use--core-use-cases) · [Architecture](#architecture) · [Requirements](#requirements) · [Directory layout](#directory-layout) · [Install](#install) · [Run](#run) · [Exposing to the internet](#exposing-to-the-internet) · [Connecting from Claude web](#connecting-from-claude-web) · [Connecting from ChatGPT](#connecting-from-chatgpt) · [Autonomous Cloud Automation](#autonomous-cloud-automation-grok--local-mcp) · [Finding files](#finding-files) · [Security](#security)

## Why this exists

Claude.ai's web/Pro quota is far cheaper than paying per token via the API for equivalent usage. But most real work is project work: reading, editing, and running commands against files on your machine, not open-ended chat.

The Claude Desktop app already does local file access, but ties usage to a device ID you don't control, and running multiple accounts means repeated login/logout. With this web-based approach, you get true multi-account flexibility instead: just switch browser profiles to pick up a different account (e.g. several Claude Pro subscriptions), all pointed at the same local machine, no device lock-in.

This project routes around both problems: run an MCP server on your machine, expose it over HTTPS through Tailscale Funnel, and connect it to claude.ai as a custom connector. You get local file/shell access from the browser, on the web quota, with no app install and no account lock-in.

### When to use & Core Use-Cases

- **At your desk:** a native Terminal/CLI (Claude Code, Antigravity CLI, Cursor) is still the fastest, most fluid option — use that.
- **Away from your desk (mobile / web / a machine that isn't yours):** use `aki-mcp-sv` via Claude Web, ChatGPT Mobile, or Grok to check on a running job, read logs, clean up temp files, or pull the latest code on your home/office machine.
- **On a schedule, with nobody watching:** pair Grok's scheduled prompts with `aki-mcp-sv` for cloud-triggered local execution — see [Autonomous Cloud Automation](#autonomous-cloud-automation-grok--local-mcp).

### How this differs from Desktop Commander

[Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) is the most widely used MCP terminal server. It runs locally for **Claude Desktop** and guards shell access with a **blocklist** (`blockedCommands`, an explicit list of forbidden commands). A blocklist is inherently leaky: you can't enumerate every dangerous command and variant, and the default is *allow*: anything not on the list gets through.

This project targets a different scenario: exposing local access to Claude **on the web**, across the open internet via Funnel. It makes the opposite default choice: a **whitelist**. Nothing runs unless it's explicitly allowed. See [Security](#security) for what that buys you.

## Architecture

```
Claude web / ChatGPT
      │  HTTPS + OAuth 2.1 (Claude: paste client ID/secret; ChatGPT: DCR self-register)
      ▼
Tailscale Funnel        (https://your-machine.your-tailnet.ts.net)
      │
      ▼
gatekeeper.js  — public port 9999
      │           /.well-known/oauth-* + openid-configuration  metadata (openid is an alias for ChatGPT discovery)
      │           /authorize, /token    minimal authorization server (scripts/oauth.js)
      │           /register         RFC 7591 dynamic client registration (ChatGPT self-registers here)
      │           /mcp                  requires a valid Bearer access token, else 401
      │                                 POST → real Streamable HTTP (scripts/streamable-bridge.js)
      ▼
mcp-hub        — internal only (loopback), port 19999, legacy HTTP+SSE transport
      │
      ├─► MCP filesystem server   (read/write inside the allowed folders)
      ├─► MCP search server       (search-mcp.js — find_path/search_content, whole-tree in one call)
      ├─► MCP shell server        (shell-mcp.js — allowlisted commands, curated to read-only)
      ├─► MCP agy server          (agy-mcp.js — Antigravity CLI, read-only plan mode)
      └─► MCP kiro server         (kiro-mcp.js — Kiro arm: kiro_read (read-only), needs kiro-cli on PATH)

panel.js       — 127.0.0.1:9998, never exposed via Funnel
                 control UI: allowed folders, shell allowlist, restart hub,
                 install akidevrule, generate the connector prompt
```

The ingress layer is swappable: Tailscale Funnel is the zero-config default, but the same `/mcp` endpoint can instead be served through your own Cloudflare named tunnel or any stable public HTTPS edge you already run — see [Exposing to the internet](#exposing-to-the-internet). Everything below the ingress line (gatekeeper, OAuth, mcp-hub) is unchanged whichever edge you pick.

`mcp-hub` ships its own unauthenticated admin REST API (`/api/*`) on the same port. `gatekeeper.js` exists specifically so that never reaches the internet (`docs/plan/done/init.md`).

OAuth (not token-in-URL) is used because claude.ai always attempts Dynamic Client Registration regardless of configuration (`docs/research/claude-ai-oauth-connector.md`). ChatGPT also expects OAuth; this server advertises `/register` (RFC 7591 DCR) so ChatGPT can self-register while Claude can keep using the pre-issued Client ID/Secret.

## Requirements

- Node.js, on Windows, Linux, or macOS
- **Windows only:** [Git for Windows](https://git-scm.com/download/win) (or WSL) on `PATH` — the shell/search tools shell out to Unix binaries (`ls cat pwd grep head tail wc file stat tree ps df du whoami uname`), and akidevrule's `install.sh` needs `bash`; Git for Windows' `usr/bin` ships the coreutils/findutils/grep/diffutils this needs. Same category of prerequisite as Tailscale below, not a code dependency.
- Tailscale (one-time setup):
  1. [Install Tailscale](https://tailscale.com/download) and sign in (on macOS, the app or `brew install tailscale` both work as long as `tailscale` is on PATH)
  2. Enable [Funnel](https://tailscale.com/docs/features/tailscale-funnel) for your tailnet: free on every plan, a one-time toggle via the `login.tailscale.com/f/funnel` link `npm start` prints if it isn't on yet

After that, `npm start` enables Funnel on port 9999 automatically every run.

## Directory layout

```
aki-mcp-sv/
├── package.json
├── mcp-hub.config.json         # shipped default, uses ${MCP_DATA_DIR}/${HOME} placeholders
├── scripts/
│   ├── start.js                 # orchestrates mcp-hub + gatekeeper
│   ├── open-browser.js           # cross-platform "open default browser" — the one per-OS seam, no external dep
│   ├── gatekeeper.js             # OAuth-gated reverse proxy, public port
│   ├── oauth.js                  # minimal authorization server (pre-registered client + RFC 7591 DCR)
│   ├── streamable-bridge.js      # Streamable HTTP shim <-> mcp-hub's legacy SSE transport
│   ├── http.js                   # shared HTTP helpers: readBody / json / serveStatic (+ MIME)
│   ├── shell-mcp.js              # allowlist-gated shell tool (curated to read-only)
│   ├── agy-mcp.js                # dedicated MCP server for the agy CLI
│   ├── kiro-mcp.js               # Kiro arm: kiro_read (read-only) tool, sonnet-4.5 locked, needs kiro-cli on PATH
│   ├── mcp-tool.js               # shared MCP tool-result envelope: ok / err / fail
│   ├── allowlist.js              # default command set + settings reader — shared by server and panel
│   ├── search-mcp.js             # find_path / search_content — whole tree in one call
│   ├── roots.js                  # path containment shared by every filesystem-touching tool
│   ├── tailscale.js              # reads Funnel status — shared by start.js and panel
│   ├── log.js                    # shared timestamped logger
│   ├── panel.js                  # loopback-only control panel (:9998), token-gated
│   ├── config-page.js            # renders the panel page
│   ├── html.js                   # HTML escaper (esc) — shared by oauth confirm page and panel
│   └── userdata.js               # user data location (~/.aki/mcpsv) — single source of truth
└── public/                       # favicon + images, served publicly by gatekeeper
```

Your data lives outside the repo, at `~/.aki/mcpsv/` (the same convention CLIs like `~/.aws` or `~/.docker` use):

```
~/.aki/mcpsv/
├── mcp-hub.config.json   # live config (which folders you granted access to)
├── setting.json          # shell allowlist, edited from the panel
├── oauth-client.json     # pre-issued client ID + secret, for Claude (0600)
├── oauth-dcr-clients.json # clients that self-registered via /register, one per ChatGPT connector (0600)
├── passphrase.txt        # passphrase for the /authorize consent screen (0600)
└── tokens.json           # access/refresh tokens (0600)
```

A clone stays exactly as checked out: editing folders/allowlist from the panel never produces a diff in the repo.

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

Nothing needs preparing beforehand; `npm start` handles it:
- **Passphrase** and **OAuth client ID/secret** in `~/.aki/mcpsv/`: generated once, reused on every later run.
- **Funnel**: checks `tailscale funnel status`; if port `9999` isn't on yet, runs `tailscale funnel --bg 9999` (idempotent: never toggles an already-enabled port).
- Prints the 4 values you need: **Remote MCP server URL**, **OAuth Client ID**, **OAuth Client Secret** (paste into claude.ai), and **Passphrase** (enter on the confirmation page when you hit Connect).
- Opens the **control panel** at `http://127.0.0.1:9998/?t=<token>`. A step header maps the flow (0 Setup · 1 Connectors · 2 Install rules · 3 Instructions · 4 Extension), then the sections follow it: 0 Setup (Tailscale), 1 Connectors, 2 Install akidevrule, 3 Instructions prompt, 4 Browser utilities, 5 allowed Folders, 6 shell allowlist.

The default allowed root is your **home directory** (`$HOME`, or `%USERPROFILE%` on Windows): the one folder guaranteed to exist on any machine and to hold the projects you actually want Claude to reach. Add/remove folders from **panel section 5**: click "+ Add folder…" and type an absolute path (`/Users/you/projects` or `C:\Users\you\projects`); saving restarts the hub automatically. To change the root from the start: `MCP_DATA_DIR=/other/path npm start` (or `set MCP_DATA_DIR=D:\work` then `npm start` on Windows cmd).

Beyond `$MCP_DATA_DIR`, the filesystem server is also granted `~/.aki` (where akidevrule deploys) and `~/.claude`, so claude.ai can read your **native** `CLAUDE.md` and skill router the same way Claude Code does, with no copying or staging.

`~/.claude` is granted at the folder level (the filesystem server can't scope to individual files), so `.claude.json`/`auth-cache.json` (session tokens) and `history.jsonl` (chat history) inside it are also reachable through the connector. Remove the `${HOME}/.claude` line in panel section 5 if you don't want that; claude.ai then loses access to your `CLAUDE.md` too.

`npm start` runs in the foreground: Ctrl+C to stop, restart manually when needed. **After editing code, Ctrl+C and `npm start` again** (Node doesn't hot-reload).

## Exposing to the internet

Tailscale Funnel is the default, zero-config path and stays the recommended flow. If Funnel is unreliable for you, two alternative ingress options let you bring your own public edge instead — see [Alternative ingress](#alternative-ingress-if-funnel-is-unreliable) below.

`npm start` enables Funnel automatically when needed (see above), no manual step. Funnel is state stored in `tailscaled` (survives reboots), independent of `npm start`'s own lifecycle; disable it entirely with `tailscale funnel 9999 off`.

**Know before enabling Funnel:**
- Free on every Tailscale plan, but the tailnet needs a one-time opt-in first (the `login.tailscale.com/f/funnel?node=...` link `tailscale funnel --bg` prints if it's missing).
- Only 3 ports are fundeable: `443`, `8443`, `10000`; you can't expose an arbitrary port.
- Bandwidth is limited; Tailscale doesn't publish an exact number.
- Don't toggle Funnel on/off repeatedly: re-issuing the certificate too often can hit Let's Encrypt's rate limit (~34h lockout). `start.js` avoids this by checking `Web[].Handlers[].Proxy` for port 9999 in `tailscale funnel status --json` before deciding Funnel is off (not the `AllowFunnel` key, which reflects the public port 443, not 9999).

**Diagnosing "claude.ai can't connect" while `tailscale funnel status` says "on":** the serve-config can save locally but fail to sync to Tailscale's control plane, so a real client on the open internet is blocked at the TLS layer while the host machine, routed through the internal mesh, sees everything as fine. **Don't test with a bare `curl https://<host>` from the machine running `npm start`**: that machine is in the tailnet and silently takes the mesh shortcut. Test the real path instead:

```bash
dig @8.8.8.8 <host> A +short   # real public IP
curl --resolve <host>:443:<IP-from-above> https://<host>/.well-known/oauth-authorization-server
```

If that returns `SSL_ERROR_SYSCALL`/timeout despite `tailscale funnel status` saying "on", re-run `tailscale funnel --bg 9999` to force a config re-push (not a code bug). Full writeup: `docs/research/claude-ai-oauth-connector.md`, section "Debug round 5".

### Alternative ingress (if Funnel is unreliable)

The Funnel edge can intermittently drop individual requests in some regions. The drop-rate difference against Cloudflare is still unmeasured, so these are not a proven upgrade — reach for them only if Funnel is unreliable for you. Both replace the Tailscale edge entirely; the OAuth server and tool suite are unchanged. Precedence when more than one is set: `--tunnel` > `PUBLIC_ORIGIN` > Tailscale Funnel. Full rationale: `docs/plan/cloudflare-tunnel-ingress.md`.

**Bring your own edge (`PUBLIC_ORIGIN`):** point an env var at a stable public HTTPS origin you run and terminate yourself, and `npm start` skips Tailscale entirely, serving at that origin:

```bash
PUBLIC_ORIGIN=https://your-host npm start
```

**Cloudflare named tunnel (`--tunnel`):** the server launches a Cloudflare named tunnel for you, reading `TunnelID` from a cloudflared credentials JSON and running `cloudflared tunnel run` forwarding to `127.0.0.1:9999`:

```bash
npm start -- --tunnel <cred.json> --origin https://your-host
```

`--origin` is **required** because a credentials JSON carries no hostname. This is JSON-credentials mode only — no `yml` config, no token. Before it works you need a Cloudflare account, a named tunnel already created (`cloudflared tunnel create`), its credentials JSON, and a DNS route pointing the hostname at that tunnel.

When a custom ingress is active, the panel's section 0 skips the Tailscale checks and instead shows the active ingress and the serving origin — so the absent Tailscale UI is expected, not a fault.

## Connecting from Claude web

1. Go to **claude.ai → Settings → Connectors → Add custom connector**
2. **Remote MCP server URL**: paste `https://your-machine.your-tailnet.ts.net/mcp` (printed by `npm start`)
3. **Advanced settings → OAuth Client ID / OAuth Client Secret**: paste the two values `npm start` printed
4. Click **Connect**: a local confirmation page opens; enter the **passphrase** (contents of `~/.aki/mcpsv/passphrase.txt`) to approve

Why not token-in-URL: `docs/ref/claude-connector.md`, `docs/research/claude-ai-oauth-connector.md`.

claude.ai connects and calls the tool suite: `filesystem__*` plus the in-house `local__*` tools (`local__find_path`, `local__search_content`, `local__run_cmd`, `local__agy_run`, `local__kiro_read`).

## Connecting from ChatGPT

Needs ChatGPT Plus/Pro (or Business/Enterprise/Edu) with **Developer mode** for custom connectors.

1. ChatGPT → Settings → Apps & Connectors (or Security) → enable **Developer mode**
2. Create a custom connector / app → paste the same MCP URL (`https://your-machine.your-tailnet.ts.net/mcp`)
3. Auth: **OAuth** → **Advanced OAuth settings** → set **Registration URL** to `https://your-machine.your-tailnet.ts.net/register` (the panel prints the exact value to copy). This is the step that enables DCR: ChatGPT self-registers its own client from it. Skip it and ChatGPT can't register, so it falls back to a user-defined client — and pasting Claude's Client ID there fails, because that client only allows `claude.ai` redirects.
4. Leave registration method on **DCR**, token endpoint auth method **none** — do **not** paste Claude's Client ID/Secret here.
5. Enter the same **passphrase** on the confirmation page

Same folder allowlist and shell allowlist as Claude. Restart `npm start` after upgrading so gatekeeper advertises `registration_endpoint` and serves `/.well-known/openid-configuration` (ChatGPT reads that to auto-fill the Registration URL).

## Connecting from Gemini and Grok

Both ride the same MCP URL and passphrase flow — no separate transport or auth. They differ in *how* the client authenticates, and the connector panel (section 1) prints the exact copy fields for each.

**Gemini** (paid tiers — Pro / Business / Enterprise; the free tier may not expose custom apps): pastes a **confidential client**, exactly like Claude — set the custom app link to the MCP URL, then under Advanced Settings paste the same Client ID / Client secret. Gemini's redirect goes through Google's OAuth proxy `https://oauth-redirect.googleusercontent.com/r/...` (observed live 2026-08-09), allowlisted by `isAllowedRedirect` in `scripts/oauth.js`. **Caveat:** the OAuth handshake succeeds and Gemini accepts the instruction, but in repeated testing 2026-08-09 it did not reliably discover or drive the MCP tools — connection healthy, tool use unreliable. Claude and Grok are the dependable clients today.

**Grok**: **self-registers** via the `/register` DCR path like ChatGPT — paste only the MCP URL, no Client ID. Its real `redirect_uri` `https://grok.com/connectors-oauth-exchange-code/` was observed live 2026-08-09 and is allowlisted via `GROK_CALLBACK_PREFIX`. Verified working end to end (`authorize → token` 200). If a future Grok change moves that callback, a rejected registration logs `register REJECTED (redirect_uri not allowlisted): [...]` so the new value can be re-allowlisted.

## Autonomous Cloud Automation (Grok + Local MCP)

Grok's scheduled prompts turn your machine into a headless "personal remote AI node": no browser tab, no desktop app, just `npm start` running in the background.

- **Cloud-triggered local execution:** set up a scheduled prompt in Grok (Automation) that fires at a fixed time.
- **Headless:** Grok's cloud service sends the request to `/mcp` over your Tailscale Funnel URL, and `aki-mcp-sv` runs the task — health check, log sweep, `git pull`, cleanup — with nothing open on your end.
- **Zero UI required:** as long as the process is running, no browser or app needs to be open for the scheduled task to execute.

### Connector icon

claude.ai doesn't read the icon from the MCP server. It queries Google's favicon service with the tailnet's **apex domain**, not your host:

```
https://t2.gstatic.com/faviconV2?...&url=http://<tailnet>.ts.net&size=32
```

`<tailnet>.ts.net` has no public DNS record, so Google returns 404 and claude.ai falls back to a default letter icon. This server serves `/favicon.ico` publicly, but no file placed here can change that result: your subdomain never appears in the query Google receives.

## Finding files

Use `local__find_path`, not `filesystem__search_files`, to locate a file or directory. The built-in `search_files` doesn't return directories and tends to time out on large trees, so a remote session can appear to "not see" the very project it has access to. `find_path` scans the whole tree in one call (measured: ~0.2s across 164k files / 11.7k directories), returns **both files and directories**, and skips `node_modules`/`.git`/build output automatically. `query` is a case-insensitive substring, or a glob when it contains `*`/`?`.

## Security

Minimal OAuth 2.1: Claude uses a pre-issued confidential Client ID/Secret; ChatGPT uses DCR (`POST /register`) as a public client (`token_endpoint_auth_method: none`) with `chatgpt.com` redirect URIs allowlisted. Full writeup: `docs/ref/security-model.md`.

- `$MCP_DATA_DIR` (default `$HOME`) is the filesystem server's main root, plus `~/.aki` and `~/.claude` (for native rule files), fixed at process start; changing it via the panel restarts the hub. `~/.claude` is granted at the folder level, so session tokens and chat history inside it are also in the connector's reach (a known tradeoff, removable from the panel).
- The shell MCP is hand-written (`shell-mcp.js`), enforcing the allowlist in code (`execFile`, never through a shell, `; & | \`` blocked). The default set is read-only, defined in `allowlist.js` — flag-rich binaries whose own flags escape read-only (`find -delete`/`-exec`, `sort -o <path>`) are deliberately kept out of it (issue #2), so a default connector cannot write, delete, or exec through the shell tool; the `find_path`/`search_content` tools cover the read-only lookup they were used for. The panel shows exactly that set as your starting point for edits, saved to `~/.aki/mcpsv/setting.json` → `shell.allowlist`. **Any command you add is your own responsibility**: adding an obvious write command (e.g. `git commit`) widens the surface further. A command can run in any directory under the allowed roots via the `cwd` parameter, used instead of `cd`/`-C` to target a specific repo.
- `gatekeeper.js` is the single public entry point; the real `mcp-hub` never listens on anything but loopback.
- `panel.js` writes config and runs commands on your machine, so it **only binds to `127.0.0.1`** and is never exposed via Funnel. Its token is regenerated every `npm start` and required both in the page's query string and in the `x-panel-token` header on every API call, blocking other browser tabs from POSTing to it.
- `~/.aki/mcpsv/passphrase.txt` (the `/authorize` consent passphrase) and `~/.aki/mcpsv/oauth-client.json` (client ID/secret) are mode 0600, live outside the repo (never reach git), and are only ever shared once, pasted into the connector dialog.
- Access/refresh tokens live in `~/.aki/mcpsv/tokens.json` (mode 0600) and survive restarts: a connector is long-lived file access, not a login session, so losing tokens on every `npm start` would just force pointless re-authentication. Access token TTL is 1 year, refresh tokens don't expire. Revoke by deleting `~/.aki/mcpsv/tokens.json` and restarting.
- Each ChatGPT connector instance self-registers one client into `~/.aki/mcpsv/oauth-dcr-clients.json` (mode 0600). Registration is open but not a way in on its own: only `claude.ai` and `chatgpt.com` redirect URIs are accepted, and a registered client still has to pass the passphrase consent screen and PKCE before it gets a token. Revoke those registrations by deleting that file and restarting.
- Funnel stays enabled in the background for the whole project; `npm start` is the only thing you actively start/stop.

### Why whitelist, not blocklist

See [How this differs from Desktop Commander](#how-this-differs-from-desktop-commander) above for the comparison. For a server that exposes itself to the internet via Funnel, the whitelist choice is a real safety property, not a slogan:
- **Fail-safe**: an unfamiliar or new command is blocked automatically, no guessing required.
- **Minimal attack surface**: only the exact commands you've approved can run, nothing more.
- **Granular down to the subcommand**: `git` is scoped to `status/log/diff/show`, something a blocklist can't express cleanly.
- **Neutralizes prompt injection**: exposed to the open internet, a hard whitelist means a malicious or injected instruction has nothing to escalate to — there's no unlisted command for it to reach for.
- **Read-only by construction**: the built-in set is read-only — flag-rich binaries that could escape it via their own flags (`find`, `sort`) are kept out (issue #2); adding a write command is a deliberate edit to `~/.aki/mcpsv/setting.json`, not the removal of a ban.

## Screenshots
<img width="941" height="1196" alt="image" src="https://github.com/user-attachments/assets/b800f5f1-4e9a-4a62-bccd-0f35923c07bc" />
<img width="899" height="1035" alt="image" src="https://github.com/user-attachments/assets/c7504913-7ff0-4802-b607-b6a6220e82c2" />
<img width="898" height="834" alt="image" src="https://github.com/user-attachments/assets/2b64541a-aea8-4bcf-b4dc-341254895a32" />
<img width="892" height="1032" alt="image" src="https://github.com/user-attachments/assets/69413798-5445-4277-9797-a671da6657bd" />
<img width="651" height="701" alt="gpt-aki-mcp-setting" src="https://github.com/user-attachments/assets/c067919c-1b7f-4f49-af81-82f1193f1f17" />


