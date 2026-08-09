# Unify Windows + Linux — drop macOS-only paths, remove Chrome control

## Goal
One codebase that runs identically on Windows and Linux, with no per-OS branching in application logic except the one unavoidable OS primitive (opening the default browser). macOS keeps working automatically — it already shares the POSIX path with Linux, so it needs no separate work and is not treated as a distinct target here. Chrome CDP control is removed outright, not ported: it is broken on its own terms since Chrome 136, independent of this unification.

## Why Chrome control is removed, not just deprioritized
Not the "after Chrome 131" figure originally suspected — the actual change landed in **Chrome 136**: remote debugging is now refused on Chrome's default user-data directory, and `scripts/chrome.js` launches exactly that (no `--user-data-dir`). CDP itself still works; a fix would mean debugging a throwaway profile instead of the user's real, logged-in one, defeating the one reason this feature existed. Full verification (5 corroborating sources) and the "why not workaround it" reasoning: `docs/research/chrome-cdp-default-profile-block.md`.

## Mandatory constraints
- Single code path: no `process.platform` branching inside business logic. The only sanctioned per-OS seam is the default-browser launch, and it goes through one small cross-platform helper, not scattered checks.
- Security model unchanged: shell tool stays whitelist-based, `execFile` only (no real shell), panel stays loopback-only (127.0.0.1, token-gated), gatekeeper stays the sole public entry point. None of that is up for revision here.
- Chrome removal is a clean, full removal — code, panel UI, README section, env var — not a disabled flag left in place (`agent.B1`, no half-features).
- Windows needs the same Unix-style read-only binaries (`ls cat pwd find grep head tail wc file stat tree ps df du whoami uname`) reachable on `PATH`. This plan does not rewrite `shell-mcp.js`/`search-mcp.js` in pure Node to avoid that dependency — it documents **Git for Windows** (or WSL) as a required prerequisite, the same way Tailscale already is one. Reassess only if that prerequisite proves unacceptable in practice.

## Architecture decisions

| # | File | Issue | Decision | Why |
|---|---|---|---|---|
| 1 | `package.json` | `start` script uses bash-only syntax `MCP_DATA_DIR="${MCP_DATA_DIR:-$HOME}" node ...` | Simplify to `"start": "node ./scripts/start.js"` | `start.js:11` already does `process.env.MCP_DATA_DIR \|\| os.homedir()` itself — the shell prefix is dead weight that also happens to break every Windows shell (`cmd.exe`, PowerShell) outright |
| 2 | `scripts/panel.js` (`pickFolders`) | Folder picker calls `osascript` (AppleScript), macOS-only | Remove the picker entirely; folders are added by typing an absolute path into a text field already present in the panel UI (`+ Add folder…` replaces `+ Choose folder…`) | No native folder-picker exists identically across macOS/Windows/Linux without a GUI toolkit dependency (Electron, `tkinter`, PowerShell forms). A plain text input is the only mechanism that is truly one code path, not three |
| 3 | `scripts/panel.js` (`validatePaths`) | Requires every path to start with `/`, rejecting Windows drive-letter paths (`C:\Users\...`) | Replace with `path.isAbsolute(p)` (`node:path`, cross-platform) | Built-in, zero-dependency, already correct on every OS Node supports |
| 4 | `scripts/start.js` | `execFileSync('open', [panelUrl])` to auto-open the panel — `open` is a macOS-only binary | Own 3-line cross-platform helper (`scripts/open-browser.js`): `open`/`cmd /c start`/`xdg-open` by `process.platform`, no npm dependency | 3 platform commands don't justify a package; keeps the dependency count and supply-chain surface minimal (`coding.A2` simple/direct, YAGNI) |
| 5 | `scripts/chrome.js` | Entire file: `pgrep`, `osascript`, `open -a "Google Chrome"` — all macOS-only, and broken since Chrome 136 regardless of OS (see Verified finding) | **Delete the file** | Not portable and not fixable without changing what the feature does; see Verified finding |
| 6 | `scripts/panel.js` | Imports `listTabs, evaluate, connectChrome, restartChrome` from `chrome.js`; routes `/api/chrome/*` | Remove the import and the 4 routes (`connect`, `restart`, `tabs`, `eval`) | Dead code once #5 is gone |
| 7 | `scripts/config-page.js` | Section 8 "Chrome" (HTML block, `ACTIONS.connect/restartChrome/tabs/widen`, `renderTabs`, `showTabs`, `pickTab`, `#chromeRestart` warning box) | Remove section 8 and its JS entirely. Keep the "Widen chat pane" **manual** copy-paste snippet (`WIDEN_SNIPPET`) folded into section 7 "Utilities" as a plain copyable command, since pasting it into the browser console never needed CDP | Manual snippet has zero dependency on Chrome automation; no reason to lose it along with the automated path |
| 8 | `scripts/config-page.js` | `` `${os.homedir()}/.claude` `` — manual `/` concatenation | Replace with `path.join(os.homedir(), '.claude')` | Produces a mixed `\`/`/` path on Windows today; `path.join` is the one correct primitive |
| 9 | `scripts/search-mcp.js` (`walk`, `findPath`) | Directory results get a hardcoded `` `${full}/` `` suffix; `found.sort()` splits on `'/'` to estimate depth — both assume POSIX separators | Use `path.sep` for the directory suffix and for the depth-sort split | `path.join` already returns native separators (`\` on Windows); mixing a hardcoded `/` into that output is cosmetically wrong and the depth-sort silently degrades to "no sort" on Windows |
| 10 | `scripts/search-mcp.js` (`searchContent`) | Shells out to `grep` directly via `execFile('grep', ...)` | No code change — same call, same binary name, relies on constraint above (Git for Windows on `PATH`) | Keeps one implementation instead of a `ripgrep`/native-JS fallback path; revisit only if the Git-for-Windows prerequisite is rejected |
| 11 | `scripts/allowlist.js`, `scripts/shell-mcp.js` | `DEFAULT_ALLOWLIST` names Unix binaries by string; `execFile(bin, args)` resolves them via `PATH` | No code change — same reasoning as #10 | The whitelist mechanism itself (`execFile`, no shell, dangerous-char blocking) is already OS-agnostic; only binary *availability* is platform-specific, which is a `PATH`/prerequisite concern, not a code concern |
| 12 | `README.md` | States "macOS only"; documents `osascript`-based folder picker and the "Chrome control" section; Requirements section lists only macOS/Tailscale | Rewrite: drop "macOS only", document Git for Windows (or WSL) as a Windows prerequisite for the shell/search tools, replace the folder-picker walkthrough with "type an absolute path", remove the "Chrome control" subsection and its screenshot references | Keeps the README truthful against the code once the above lands (`docs.C1`, wrong docs are worse than none) |
| 13 | `scripts/userdata.js`, `scripts/oauth.js` | `mkdirSync(..., { mode: 0o700 })` / `writeFileSync(..., { mode: 0o600 })` — Node no-ops the POSIX mode bits on Windows, so `tokens.json`, `oauth-client.json`, `passphrase.txt` are not actually access-restricted there | **No fix in this pass** — documented as a known gap (see Out of scope) | Closing it needs an `icacls`-based ACL path specific to Windows, which is a security-hardening task or... its own small plan, not a prerequisite for the app to *run* cross-platform |
| 14 | `mcp-hub.config.json`, `scripts/roots.js` | Use `${MCP_DATA_DIR}`/`${HOME}` placeholders and `node:path` throughout | No change | Already OS-agnostic — placeholders are plain strings expanded by `os.homedir()`/`path.resolve`, verified during audit |

## Execution checklist
- [x] `package.json` — simplify `start` script (item 1)
- [x] `scripts/panel.js` — remove `pickFolders`/`osascript`, add manual "Add folder" flow; fix `validatePaths` to `path.isAbsolute` (items 2, 3)
- [x] `scripts/start.js` — own cross-platform `openBrowser` helper (`scripts/open-browser.js`), no `open` npm dependency (item 4)
- [x] Delete `scripts/chrome.js` (item 5)
- [x] `scripts/panel.js` — remove chrome import + 4 routes (item 6)
- [x] `scripts/config-page.js` — remove section 8 + JS, keep manual widen snippet in section 7, fix `CLAUDE_DIR` path join (items 7, 8)
- [x] `scripts/search-mcp.js` — `path.sep` fix in `walk`/`findPath` sort (item 9)
- [x] `README.md` — full rewrite per item 12 (drop macOS-only claim, Windows prerequisite note, remove Chrome section, remove folder-picker walkthrough)
- [x] `package.json` — no new dependency needed (item 4 done via local helper, not the `open` package)
- [x] Live verification on macOS: owner-confirmed running cleanly since 2026-08-08, no regression after the shared-code changes (items 1–4, 8, 9)
- [~] Live verification on Windows (Git for Windows on `PATH`) and Linux: covered by the contributor's own Windows runtime per `docs/plan/done/merge-pr1-windows-chatgpt.md` (no cross-platform verification gate); `tree`/`file`/`ps`/`df` availability in Git-for-Windows `usr/bin` still not independently confirmed
- [x] Update `docs/index.md` with an entry for this plan — already present (verified 2026-08-08), no action needed

## Out of scope
- Rewriting the shell allowlist / `search_content` in pure Node to drop the Git-for-Windows dependency entirely — larger rewrite, only worth it if the prerequisite proves unacceptable to users.
- ACL hardening (`icacls`) for `tokens.json`/`oauth-client.json`/`passphrase.txt` permissions on Windows (item 13) — real gap, deliberately deferred, needs its own small plan.
- WSL as a first-class alternative to Git for Windows — mentioned as viable but not tested or documented step-by-step here.
- Any change to the OAuth/gatekeeper/mcp-hub architecture — untouched by this plan.

## Cross-references
- `docs/plan/init.md` — original architecture decisions (mcp-hub + gatekeeper + funnel), unaffected by this plan
- `docs/ref/security-model.md` — current OAuth security model, unaffected by this plan
- `README.md` — target of item 12's rewrite

## Decision
**Action** → execute items 1–12 as scoped above; item 13 recorded as a deliberate "no action this pass" (see Out of scope); item 14 confirmed as already correct, no action needed.
