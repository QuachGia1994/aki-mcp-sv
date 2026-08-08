# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning per [SemVer](https://semver.org/).

## [1.1.0] — 2026-08-08

Windows support and the ChatGPT custom connector come from [PR #1](https://github.com/lacvietanh/aki-mcp-sv/pull/1) by **capybara** (`okdev888`), rebuilt onto the OS-agnostic architecture of `docs/plan/unify-windows-linux.md` — see `docs/plan/merge-pr1-windows-chatgpt.md` for what was adopted as-is and what was reshaped.

### Added
- ChatGPT custom connector on the same Funnel URL (contributed): RFC 7591 `POST /register` (dynamic client registration), public-client token auth (`none`), and allowlisted `https://chatgpt.com/connector/oauth/…` redirects. Registered clients persist in `~/.aki/mcpsv/oauth-dcr-clients.json`. Panel section 2 documents Claude and ChatGPT side by side. Claude's pre-issued Client ID/Secret path is unchanged.
- `scripts/agy-mcp.js`: dedicated MCP server for the `agy` CLI (wired into `mcp-hub.config.json`), replacing the generic shell route that shell-tokenized the whole command and could mis-split a multi-word `-p` prompt. Here `prompt`/`mode`/`model`/`effort`/`outputFormat` are separate `execFile` args, so no quoting step can get them wrong. Defaults to read-only mode `plan` and the fast wide-context discovery model; other modes must be opted into via `setting.json` `agy.allowedModes`, and `cwd` is enforced under an allowed root through the shared `resolveUnderRoot`.
- `scripts/open-browser.js`: small cross-platform "open default browser" helper (`open` / `cmd start` / `xdg-open` by `process.platform`), replacing the macOS-only `execFileSync('open', ...)` call in `start.js` — no new npm dependency added.
- `scripts/log.js`: shared timestamped logger. Gatekeeper request lines now carry an ISO timestamp + duration; `oauth.js` and `streamable-bridge.js` log each OAuth step, session open/close (with reason), stale-session 404s, and request timeouts — so a failed connect points at its exact cause instead of going silent.

### Changed
- OAuth metadata advertises `registration_endpoint` and `token_endpoint_auth_methods_supported: ["none","client_secret_post"]` (contributed). The token endpoint now authenticates the client per its registered method and binds each authorization code and refresh token to the client it was issued to.
- `agy-mcp.js`, `search-mcp.js`, `shell-mcp.js`: each MCP server and tool now advertises a human-readable `title` ("Antigravity CLI", "File Index" / "Find Path" / "Search Content", "Shell" / "Run Command"), so the connector UI lists them by name instead of by bare protocol id.
- Windows/Linux unification (`docs/plan/unify-windows-linux.md`): `package.json` `start` script no longer relies on bash-only `${VAR:-default}` syntax; `scripts/panel.js` folder picker (`osascript`, macOS-only) replaced with a manual "+ Add folder…" text input; `validatePaths` now uses `path.isAbsolute` instead of a hardcoded leading-`/` check, so Windows drive-letter paths pass; `scripts/config-page.js`'s `CLAUDE_DIR` build now uses `path.join` instead of manual `/` string concatenation; `scripts/search-mcp.js`'s path-depth sort in `walk`/`findPath` now splits on `path.sep` instead of `/`.
- `streamable-bridge.js`: per-request response timeout raised 30s → 10 min (`MCP_REQUEST_TIMEOUT_MS`) so long shell runs aren't cut off. (The 5-minute idle auto-close and the per-client session model it belonged to are gone entirely — see the single-session rewrite under Fixed.)

### Removed
- `scripts/chrome.js` and its 4 panel routes/UI (Chrome tab connect/restart/list/eval via CDP): macOS-only (`pgrep`, `osascript`) and already broken since Chrome 136 regardless of OS. The manual "paste this into the browser console" widen-chat-pane snippet is kept, folded into the Utilities section, since it never depended on Chrome automation.

### Fixed
- `streamable-bridge.js`: **the mass "client disconnected from MCP HUB" log is fixed at the root** (`docs/plan/bridge-session-churn.md`, Option B). Measurement (`docs/research/claude-ai-mcp-session-reinit.md`) showed claude.ai re-sends `initialize` with no `Mcp-Session-Id` every ~10s — 17 hub sessions in 4 minutes for 3 conversations — so the old per-client model spawned a throwaway hub session each time, producing thousands of connect/disconnect pairs. The bridge now holds **one** internal hub session for the whole process: every external client multiplexes onto it via JSON-RPC id remapping, and each `initialize` is answered locally from the cached hub result. The hub now logs one connect at boot and one disconnect at shutdown regardless of re-initialize frequency. Removed the per-client sessions Map, the `MCP_MAX_SESSIONS` cap, LRU eviction, and the diagnostic churn counters that scoped this fix — all compensating machinery the corrected shape no longer needs.
- `start.js` / `tailscale.js`: `npm start` now auto-starts Tailscale when it is stopped. `tailscale status --json` returns valid JSON even while the backend is `Stopped`, so `funnelStatus` previously reported the daemon as healthy and never brought it up — the public Funnel URL then closed every connection (`ERR_CONNECTION_CLOSED`). `funnelStatus` now reads `BackendState`, and `start.js` runs `tailscale up` before enabling the Funnel. A `NeedsLogin` state still requires manual login (surfaced in the log).
- Windows (contributed): `npm start` no longer dies on `spawn npx ENOENT` — the hub is resolved with `require.resolve('mcp-hub/dist/cli.js')` and run through `process.execPath`, and every child inherits an explicit `HOME`/`USERPROFILE` so the `${HOME}` placeholders in `mcp-hub.config.json` expand. Child processes spawn with `windowsHide: true`, spawn failures are reported instead of dying silently, path containment compares case-insensitively, and the panel's rule installer looks for `bash.exe` with a Git-for-Windows hint when it is missing.
- `shell-mcp.js`: the backslash is no longer treated as a dangerous character on any platform. `execFile` never invokes a shell, so it is an inert literal everywhere while being a legitimate path separator on Windows — one branchless rule rather than a per-OS one.
- Default shell allowlist widened with read-only commands: `sort`, `uniq`, `cut`, `diff`, `basename`, `dirname`, `realpath`, `which`, `date` everywhere, plus `where`, `findstr`, `tasklist`, `hostname` on Windows. `sed`/`awk`/`xargs`/`perl`/`python`/`env` are deliberately excluded — each can write files or execute an arbitrary program.

## [1.0.2] — 2026-08-08

### Changed
- README restructured for density: em dash count in prose cut from 46 to 0 (replaced with periods/colons/parentheses per clause meaning), a Contents line added, vague headings renamed (`DEMO img` → `Screenshots`, `Chrome control — why "reconnect" is a separate button` → `Chrome control`, `Connector icon: not controllable from the server` → `Connector icon`), and self-justifying design commentary cut in favor of stated facts. No content removed, no accuracy changes.

## [1.0.1] — 2026-08-07

### Changed
- `roots.js`: single root (`ROOT`) widened to an array of roots (`ROOTS`), enforced identically for `shell-mcp.js` and `search-mcp.js` through the same `resolveUnderRoot`. Saving folders in the panel (`setFilesystemPaths`) now syncs that same list into `search`/`shell`'s `MCP_DATA_DIR` — one allowlist, not two copies that can drift apart.
- README rewritten entirely in English: added a "Why this exists" section (web vs API quota economics, why Tailscale+MCP instead of installing an app) and moved the whitelist-vs-blocklist comparison with Desktop Commander to the top instead of burying it at the end.

### Removed
- The one-time `<repo>/data/` → `~/.aki/mcpsv/` migration in `userdata.js` (added in 1.0.0): it serves no purpose past the first run, removed outright instead of leaving dead code in place permanently. **Known risk**: anyone who installed before `~/.aki/mcpsv/` existed and never ran 1.0.0 loses their old OAuth client/passphrase on upgrading straight to this version — accepted since 1.0.0 shipped the same day, with no external users yet.

### Fixed
- `resolveUnderRoot` (`roots.js`) now fails closed when `MCP_DATA_DIR` is empty/malformed (falls back to home) instead of silently losing containment.

## [1.0.0] — 2026-08-07

First public release: strip everything that only worked on the author's machine, so anyone can clone and run it.

### Added
- `scripts/userdata.js` — all user data (live config, OAuth client, passphrase, tokens) consolidated under `~/.aki/mcpsv/`, secrets at mode 0600.
- `scripts/tailscale.js` — reads Funnel status in one place, shared by `start.js` and the panel.
- `scripts/allowlist.js` — the default shell command set becomes a single source of truth: the server enforces and the panel displays the same set.
- `scripts/search-mcp.js` — `find_path` / `search_content`, whole tree scanned in one call.
- `scripts/chrome.js` — Chrome control via CDP, no external package dependency.
- Panel: Tailscale section with a status indicator, folder picker via macOS's native dialog (multi-select in one pass), akidevrule section showing the install command, AkiTao ecosystem footer.
- Panel shows every command verbatim for copying: the akidevrule install command, the claude.ai chat-window expansion command.

### Changed
- Default root for the filesystem MCP server: `$HOME` instead of the author's hardcoded path.
- `mcp-hub.config.json` in the repo becomes the shipped default; the live copy lives in `~/.aki/mcpsv/`, so nothing edited in the panel shows up as a repo diff.
- Panel sections reordered to match the actual setup sequence, Chrome moved to the end since it's optional.
- Chrome: "Connect" no longer quits Chrome on its own — Chrome only opens its debug port at launch, so reopening it now sits behind a button that says exactly what it does.

### Fixed
- Funnel re-enabling on every `npm start`: `AllowFunnel` is keyed by the public port (443), not the internal one, so the port-9999 comparison never matched. Repeated toggling risked hitting Let's Encrypt's certificate rate limit.
- The panel didn't validate incoming data: a wrongly-typed allowlist made `Array.isArray` false and **silently allowed every subcommand** of that binary. Now rejected at the boundary with an actionable error.
- The panel could show an empty allowlist and then save it over the entire default set.
- The "Copy all 5 values" button matched every copy field on the page, not just the intended ones.
- Author-specific paths left over in `docs/plan/`.

## [0.1.0]

Internal, never released.

- MCP server (filesystem + shell) exposed via Tailscale Funnel with an OAuth 2.1 gatekeeper.
