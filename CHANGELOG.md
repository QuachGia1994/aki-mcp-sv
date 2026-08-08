# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning per [SemVer](https://semver.org/).

## [1.0.4] — 2026-08-08

### Added
- ChatGPT custom connector support on the same Funnel URL: RFC 7591 `POST /register` (DCR), public-client token auth (`none`), and allowlisted `https://chatgpt.com/connector/oauth/…` redirects. Panel section 2 documents Claude + ChatGPT side by side.

### Changed
- OAuth metadata advertises `registration_endpoint` and `token_endpoint_auth_methods_supported: ["none","client_secret_post"]`. Claude’s pre-issued Client ID/Secret path is unchanged.

## [1.0.3] — 2026-08-08

### Fixed
- Windows: `npm start` no longer dies on Unix-only env syntax in `package.json`, `spawn npx ENOENT`, or macOS-only `open` / `osascript` / `pgrep`.
- Windows: hub is started via `node …/mcp-hub/dist/cli.js` (no `npx` shim); panel accepts `C:\…` absolute paths; Chrome CDP launch uses `chrome.exe`; folder picker uses WinForms; `search_content` uses a JS walker when `grep` is missing; shell allowlist ignores `\` as a dangerous char and adds `where` / `findstr`.

### Changed
- Supported platforms: macOS and Windows. Shipped `mcp-hub.config.json` uses `${userHome}${pathSeparator}…` so home-relative roots expand correctly on both.

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
