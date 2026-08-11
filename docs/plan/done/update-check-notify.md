# Update check + notify — dual-source banner + versioned instruction

## Goal
Detect when either GitHub source — this repo (`lacvietanh/aki-mcp-sv`, `main`, via `package.json`) **or** the rule corpus (`lacvietanh/akidevrule`, `master`, via CHANGELOG) — is newer than the local copy, on every `npm start`, and surface it in a colored console line + a panel banner (own update on top, rule update below with a re-paste warning). Cover both distribution paths — `git clone` and plain zip download — since a zip has no `.git/` at all, not just "no git binary".

## Built — expanded scope (delta from the original single-source design below)
The original plan (kept below for the design rationale) checked **only** aki-mcp-sv. As built, it does more:
- **Dual-source.** `checkForUpdate()` returns `{ mcp, rule }`, each `{ current, latest, updateAvailable }`. `current` is always local (never nulls the branch); `latest` is `null` on any network/parse failure. akidevrule has no version field, so its version is the newest released `## [x.y.z]` header in `CHANGELOG.md` (skipping `[Unreleased]`) — `parseChangelogVersion()`.
- **Status file for the self-check.** `writeStatusFile()` drops `~/.aki/aki-mcp-status.json` (under `~/.aki`, an already-locked allowed root) each boot. The pasted instruction reads it at session start to warn when the instruction itself is stale — see `docs/plan/done/` note in CHANGELOG and the instruction builder in `config-page.js` `buildPrompt()`.
- **Versioned instruction.** The paste-in prompt now opens with `[akimcp <ver> · akidevrule <ver>]` so a stale paste is visible, plus a self-warn line that reads the status file and tells the user to re-paste into each account (claude/grok/chatgpt/gemini) on any mismatch.
- **Rule update path reuses `POST /api/install-rules`** (runs `install.sh`); only the mcp self-update needed the new `POST /api/pull-update` route.

## Context — why HTTP, not `git`
Earlier draft considered `git ls-remote origin`. Rejected: a zip download has no `.git/` and no configured remote, so that path fails structurally for zip users regardless of whether `git` is on PATH. Chosen instead: one `GET` to
`https://raw.githubusercontent.com/lacvietanh/aki-mcp-sv/main/package.json`, parse `.version`, compare to the local `package.json`. Works identically for clone or zip, needs no git, no auth, no new dependency (Node ≥18's built-in `fetch`, already an implicit baseline given `@modelcontextprotocol/sdk ^1.30.0`). Compares local `package.json` (SSoT, `pattern.A1`) against upstream's same field — not against tag/Release presence, which `release.A3` already treats as optional for this app type.

## Architecture decisions

| Issue | Decision | Why |
|---|---|---|
| Version source | `raw.githubusercontent.com/.../main/package.json`, field `.version` | Universal (clone or zip), no git dependency, single SSoT-to-SSoT comparison |
| New module | `scripts/update-check.js` — `checkForUpdate({ timeoutMs })` → `{ current, latest, updateAvailable } \| null` | Shared by `start.js` (console) and `panel.js` (HTML banner + pull button), avoids two separate implementations |
| Frequency | Once per `npm start` process, no throttle/cache | Explicit requirement — user wants it checked every run, not daily-cached |
| Failure mode | `AbortController` timeout (3s) around the fetch; any error/timeout → `null`, logged at most as one quiet line, never blocks `spawnHub`/`gatekeeper` startup | Startup must never depend on GitHub reachability (`coding.C1` — core flow stays safe even when the network dependency fails) |
| Version compare | Small local semver split-and-compare (3-part numeric), no `semver` package | YAGNI — one comparison, not worth a dependency |
| Console banner | One line, ANSI yellow-bg/black-fg (`\x1b[43m\x1b[30m ... \x1b[0m`), printed in the existing `[start]` info block, right after the passphrase line | Matches "màu nổi bật" ask without adding a color-library dependency; sits where the user is already reading the block they need each run |
| Panel banner | New section rendered by `config-page.js`, injected directly under `<h1>`, only when `updateAvailable` — orange bar reusing the panel's existing `--accent:#ff4800` token | Same visual language as the rest of the panel; "ngay đầu file HTML" per the request |
| Auto-update | **Not unattended.** One-click **"Pull & restart"** button in the panel banner, enabled only when `path.join(REPO_ROOT,'.git')` exists — mirrors the existing `installRules()` button pattern in `panel.js` (`run('git', ['pull','--ff-only'], REPO_ROOT)`) | A fully silent `git pull` on every start is a hard-to-reverse action on the user's working tree (`agent.B3`) — if they have local edits, an unattended pull can conflict/lose work. A one-click confirm button gets the "auto update" convenience the user asked for without crossing that boundary |
| Auto-update tree-safety | At click time (not at page load), run `git status --porcelain` in `REPO_ROOT`; non-empty → refuse with a clear message instead of pulling | Tree state can change between page load and the click; check right before the destructive step, not earlier |
| Auto-update for zip installs | No `.git` → banner shows "download new version" link to the GitHub repo instead of a button | Nothing to `git pull` without a git checkout; must not offer a button that will just error |
| Post-pull restart | Button response text tells the user to `Ctrl+C` and `npm start` again (existing documented behavior — "Node doesn't hot-reload", already in README) | `git pull` updates files on disk; the already-running Node process still has old code loaded in memory — pulling alone does not apply the update |

## Execution checklist
- [x] `scripts/update-check.js`: `checkForUpdate()` → `{ mcp, rule }`, `parseChangelogVersion()`, `cmpSemver()`, `getLocalVersions()`, `writeStatusFile()`, exported repo/branch/`STATUS_PATH` constants
- [x] Wire into `scripts/start.js`: call once, write status file, print colored banner (mcp on top, then rule with re-paste reminder)
- [x] Pass `updateInfo` into `startPanel({ ..., updateInfo })` → `renderPanel({ ..., updateInfo, hasGit })`
- [x] `config-page.js`: banner under `<h1>` (mcp: Pull&restart if `.git` else Download link; rule: Install/update + re-paste warning); section-3 warning; `[akimcp·akidevrule]` header + self-warn line in `buildPrompt()`
- [x] `panel.js`: `POST /api/pull-update` — `git status --porcelain` clean-tree gate, then `git pull --ff-only`, restart message
- [x] Runtime test (user-triggered): mock older local versions → both banners + console lines; zip copy (no `.git`) → Download link not button; dirty tree → Pull refuses; copy prompt → version header + self-warn present + char count — confirmed by user 2026-08-12
- [x] `CHANGELOG.md`: entry moved to `## [1.6.0]` at the release event (`release.A5`)

## Out of scope
- Fully unattended `git pull` with no user confirmation — crosses `agent.B3`, not bundled into this plan
- Any update mechanism for zip installs beyond a link (no re-download/re-extract automation)
- Caching/throttling the check — explicitly not wanted per this request; revisit only if GitHub's unauthenticated rate limit ever becomes a real problem in practice

## Cross-references
- `scripts/panel.js` — `installRules()` is the direct precedent this plan's `pullUpdate` mirrors (clone/pull pattern, button-triggered, error-surfaced-at-click)
- `README.md` — "Node doesn't hot-reload" note that the post-pull restart message points back to
- `RULE-release.md` A3/A5 — why tag presence isn't the check source, and why this feature's own version bump waits for the release event
- `.git/config` — confirmed remote: `git@github.com:lacvietanh/aki-mcp-sv.git`, branch `main`

## Decision
**Shipped in 1.6.0** (2026-08-12) with the dual-source + versioned-instruction expansion above. Runtime-confirmed by the user; released after akidevrule shipped its rename.
