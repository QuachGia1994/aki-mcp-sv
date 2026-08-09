# Update check + notify — banner on every `npm start` + panel

## Goal
Detect when the GitHub repo (`lacvietanh/aki-mcp-sv`, branch `main`) has a newer `package.json` version than the local checkout, on every `npm start`, and surface it two places: a prominent colored console line, and a banner at the top of the panel HTML. Cover both distribution paths — `git clone` and plain zip download — since a zip has no `.git/` at all, not just "no git binary".

## Context — why HTTP, not `git`
Earlier draft considered `git ls-remote origin`. Rejected: a zip download has no `.git/` and no configured remote, so that path fails structurally for zip users regardless of whether `git` is on PATH. Chosen instead: one `GET` to
`https://raw.githubusercontent.com/lacvietanh/aki-mcp-sv/main/package.json`, parse `.version`, compare to the local `package.json`. Works identically for clone or zip, needs no git, no auth, no new dependency (Node ≥18's built-in `fetch`, already an implicit baseline given `@modelcontextprotocol/sdk ^1.30.0`). Compares local `package.json` (SSoT, `design.A1`) against upstream's same field — not against tag/Release presence, which `release.A3` already treats as optional for this app type.

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
- [ ] `scripts/update-check.js`: `checkForUpdate({ timeoutMs = 3000 })`, semver-compare helper, exported `REPO = 'lacvietanh/aki-mcp-sv'`/`BRANCH = 'main'` constants
- [ ] Wire into `scripts/start.js`: call once near the top, print the colored banner line in the existing info block if `updateAvailable`
- [ ] Pass the `checkForUpdate()` result into `startPanel({ ..., updateInfo })`
- [ ] `config-page.js`: render the orange banner under `<h1>` when `updateInfo.updateAvailable`; show "Pull & restart" button when `existsSync(path.join(repoRoot,'.git'))`, else a plain link to the GitHub repo
- [ ] `panel.js`: new `POST /api/pull-update` route — `git status --porcelain` check, then `run('git', ['pull','--ff-only'], REPO_ROOT)`, return a message telling the user to restart `npm start`
- [ ] Manual test: mock an older local `package.json` version → confirm both banners appear; test on a zip-extracted copy (no `.git/`) → confirm banner shows link, not button; test with a dirty tree → confirm the pull button refuses with a clear message
- [ ] `CHANGELOG.md`: add under `## [Unreleased]` once built (`release.A5` — do not bump `package.json` in this task; version is minted at the actual release event)

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
**Action** → build `scripts/update-check.js`, wire into `start.js` + `panel.js` + `config-page.js` per the tables above. Not started yet — this doc records the design only.
