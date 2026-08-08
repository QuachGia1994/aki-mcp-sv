# Merge PR #1 — Windows fixes + ChatGPT connector, rebuilt on our architecture

## Goal
Ship one release that contains the substance of PR #1 (Windows runtime fixes, ChatGPT custom-connector support) **without** importing the OS-branching design it was written against, and land it so GitHub marks PR #1 as **Merged** rather than Closed — the contributor's commits stay in history and their contribution graph is credited.

## Situation — measured, not assumed

| Fact | Value |
|---|---|
| PR | #1 `okdev888:feature/windows-support`, +424 −104 across 19 files |
| Commit author (differs from GitHub handle) | `capybara <moseskarole862@gmail.com>` |
| Merge base | `801d680` — PR was written against the tree **before** our unification |
| Master ahead by | 7 commits (unify Windows/Linux, agy MCP, shared logger, single-session bridge) |
| Actual conflicts on `git merge pr1` | **7 files / 15 hunks** — far smaller than the file overlap suggests |
| Auto-merging files | 12, of which **4 auto-merge to the wrong result** (see Correction pass) |

The PR's premise is legitimate and was written by someone actually running Windows. Its problem is not correctness — it is that it re-solves problems `docs/plan/unify-windows-linux.md` already solved in the opposite direction: it branches on `process.platform` inside business logic, restores `scripts/chrome.js` (deleted here because Chrome 136 refuses remote debugging on the default profile), and adds a WinForms folder picker plus a second `search_content` implementation.

## Mandatory constraints
- **Our architecture wins on every collision.** Per-OS difference is allowed as a *data table* selected by `process.platform` (the `open-browser.js` `LAUNCHER` shape); it is not allowed as a branch in business logic or as a second implementation of an existing mechanism.
- **No cross-platform verification gate.** The contributor runs this on Windows with Git for Windows; that is accepted as given. Nothing in this plan blocks on a Windows or Linux test run, and the Git-for-Windows prerequisite from the unify plan stands unchanged.
- **ChatGPT DCR ships in this release**, not in a separate hardened pass. It is an additive endpoint reusing the existing passphrase + PKCE flow; the Claude pre-registered path is unchanged. No new security analysis is required to land it.
- **`scripts/chrome.js` stays deleted** and the folder picker stays removed — both are our own prior decisions, already documented, not up for revision here.
- **Nothing already on master may be lost**, in particular the `log()` instrumentation in `oauth.js` and the single-shared-session bridge.

## Branch strategy — and why the two obvious options are wrong

- **Plain `git merge pr1` into master** — rejected: 12 files auto-merge, and 4 of them silently reintroduce code we deliberately removed. A clean merge here produces a wrong tree quietly.
- **Cherry-pick the good hunks** — rejected: the PR head never becomes an ancestor of master, so GitHub shows PR #1 as *Closed*. The contribution survives, the acknowledgement does not.

**Chosen: integration branch with a merge commit, then hand-correction before it reaches master.**

```
git checkout -b integrate/pr1 master
git merge --no-commit --no-ff pr1     # stops with 7 conflicts, 12 files staged
<resolve the 7>                        # table below
<correction pass on the 4>             # table below
git commit                             # merge commit: pr1 becomes an ancestor
git checkout master && git merge --no-ff integrate/pr1
```

Because `pr1`'s head is reachable from master after the push, GitHub marks PR #1 **Merged** on its own — no force-push to the contributor's fork, no rewriting of their history. Their commits keep their authorship; the merge commit carries `Co-authored-by: capybara <moseskarole862@gmail.com>`.

## Conflict resolution — the 7 files git stops on

| File | Hunks | Resolution |
|---|---|---|
| `scripts/chrome.js` | modify/delete | `git rm` — keep deleted (Chrome 136, `docs/research/chrome-cdp-default-profile-block.md`) |
| `scripts/oauth.js` | 5 | **Hand-graft, take neither side wholesale.** Ours is the base (it carries every `log()` line and `issueTokens(res, clientId, existingRefresh, via)`); add from theirs: `isAllowedRedirect`, `loadDcrClients`/`saveDcrClients`, `resolveClient`, `handleRegister`, `authenticateClient`, the `registration_endpoint` + `token_endpoint_auth_methods_supported: ['none','client_secret_post']` metadata, the `entry.clientId !== client.clientId` check on both grants, and `Cache-Control: no-store` in `json()`. New signatures `handleAuthorize(req, res, passphrase, origin)` / `handleToken(req, res)` must match what the auto-merged `gatekeeper.js` already calls |
| `scripts/start.js` | 2 | Ours as base; take their hub-spawn fix (`require.resolve('mcp-hub/dist/cli.js')` run through `process.execPath` instead of `npx`), the `HOME`-in-child-env fix, and the `child.on('error')` handlers — **inlined into `start.js`**, not via `platform.js` |
| `scripts/panel.js` | 1 | Ours (no picker, manual path input). Take only `windowsHide: true` in `run()`; drop the `IS_WIN`/`IS_MAC` import and the WinForms branch |
| `mcp-hub.config.json` | 1 | **Ours** — keeps the `agy` server the PR never saw, and keeps `${HOME}` placeholders, which now resolve on Windows because `start.js` sets `HOME` in the child env. Their `${userHome}${pathSeparator}` rewrite becomes unnecessary |
| `README.md` | 5 | Ours as base; fold in their ChatGPT connector section and Windows requirement note. Do not restore the Chrome section or the folder-picker walkthrough |
| `CHANGELOG.md` | 1 | Ours as base; fold their `1.0.3`/`1.0.4` entries into our `[Unreleased]`, released as one version |

## Correction pass — the 4 files that auto-merge to the wrong result

Git reports these as clean. They are not what we want, and each needs an explicit edit **before** the merge commit:

| File | What auto-merge brings in | Correction |
|---|---|---|
| `scripts/platform.js` | New file, added silently. After `chrome.js` stays deleted and the picker stays removed, `findChrome`, `execCapture`, `IS_MAC` are dead, and `openUrl` duplicates our `open-browser.js` | **Delete the file.** Its three live helpers (`hubCliPath`, `childEnv`, `spawnNode`) have exactly one caller, `start.js` — inline them there. A module named `platform` is a standing invitation to add the next OS branch |
| `scripts/search-mcp.js` | `searchContentNode` + `nameMatchesGlob` — a second, pure-JS implementation of `search_content` behind a `win32` branch | **Remove both functions and the branch.** Keep our `path.sep` fixes. The unify plan chose the Git-for-Windows prerequisite over a fallback implementation (item 10); two implementations of a root-scoped search is the exact duplication that rule exists to prevent |
| `scripts/shell-mcp.js` | `DANGEROUS_CHARS = process.platform === 'win32' ? … : …` | Replace with one branchless regex that keeps the original dangerous set minus the backslash (semicolon, ampersand, pipe, backtick, dollar, angle brackets, newline). `execFile` never invokes a shell, so a backslash is an inert literal on every OS while being a legitimate path separator on Windows — dropping it universally is correct rather than conditional. Keep `windowsHide: true` |
| `package.json` | Version jumped to `1.0.4` (their two-release numbering) | Set to `1.1.0` — this release adds a connector platform on top of everything already sitting in `[Unreleased]`; a minor bump is the honest SemVer and avoids inheriting numbering for releases that never existed here |

`scripts/config-page.js` and `scripts/gatekeeper.js` auto-merge **correctly** and need no correction: the panel gains the ChatGPT subsection while section 8 stays gone, and the gatekeeper gains the `/register` route with the new handler signatures.

`scripts/roots.js`, `scripts/allowlist.js`, `scripts/userdata.js`, `scripts/tailscale.js` auto-merge correctly and are kept as-is — case-insensitive path containment, the per-OS allowlist table, `DCR_CLIENTS_PATH`, and `windowsHide`.

## Allowlist expansion

Keep the merged shape (`UNIX_DEFAULT` base + `WIN_EXTRA` selected by platform) — a data table, which the constraints permit — and widen both sides with commands that are read-only by construction:

- **Shared additions:** `sort`, `uniq`, `cut`, `diff`, `basename`, `dirname`, `realpath`, `which`, `date`
- **Windows additions** (on top of the PR's `where`, `findstr`): `tasklist`, `hostname`
- **Deliberately excluded:** `sed`, `awk`, `xargs`, `perl`, `python`, `env` — each can write files or execute an arbitrary program, which would void the "read-only default" claim. `type` and `dir` are `cmd.exe` builtins and cannot be reached by `execFile` at all

## Version & credit
- Release as **1.1.0**, folding the PR's `1.0.3`/`1.0.4` notes into the existing `[Unreleased]` block.
- Merge commit carries `Co-authored-by: capybara <moseskarole862@gmail.com>` (commit-author identity, which differs from the GitHub handle `okdev888`).
- CHANGELOG names the contributor for the Windows fixes and the ChatGPT connector.
- A review comment on PR #1 states plainly what was adopted, what was rebuilt to fit `docs/plan/unify-windows-linux.md`, and why `chrome.js` and the JS search fallback were not taken.

## Execution checklist

All items executed 2026-08-08. Master merged as `86cbc55` (integration merge `bf610b0`), released 1.1.0, PR #1 shows **Merged**, default branch renamed `master` → `main` after the push.
- [x] Commit the working tree first — `agy-mcp.js`, `search-mcp.js`, `shell-mcp.js` carry one coherent uncommitted change (MCP server/tool `title` fields) and the merge cannot start on a dirty tree
- [x] `git checkout -b integrate/pr1 master` and `git merge --no-commit --no-ff pr1`
- [x] Resolve the 7 conflicts per the table
- [x] Run the correction pass on the 4 auto-merged files
- [x] Delete `scripts/platform.js`, inline its three live helpers into `start.js`
- [x] Expand `DEFAULT_ALLOWLIST` per the section above
- [x] Bump to `1.1.0`; rewrite `[Unreleased]` into the release block with contributor credit
- [x] Update `README.md` (ChatGPT section, Windows note) and `docs/ref/security-model.md` (the DCR paragraph auto-merged; confirm it matches the grafted `oauth.js`)
- [x] `node --check` every changed script — the only mechanical gate in this plan
- [x] Commit the merge with the co-author trailer, merge into master, push
- [x] Comment on PR #1, then confirm GitHub flipped it to Merged
- [x] Open a follow-up issue for the `find: null` allowlist entry, which permits `-delete`/`-exec` and predates this work

## Out of scope
- Any Windows or Linux verification run — explicitly excluded by the constraints above.
- Hardening or re-reviewing the ChatGPT DCR flow beyond what the PR implements.
- Restoring Chrome CDP control in any form.
- Tightening `find` in the default allowlist — real, pre-existing, tracked as a follow-up issue rather than mixed into a merge.
- ACL hardening of `tokens.json` / `oauth-client.json` / `passphrase.txt` on Windows — still deferred from the unify plan.

## Cross-references
- `docs/plan/unify-windows-linux.md` — the OS-agnostic design this merge is bent to fit
- `docs/ref/security-model.md` — OAuth model, extended by the DCR graft
- `docs/research/chrome-cdp-default-profile-block.md` — why `chrome.js` stays deleted
- `docs/plan/bridge-session-churn.md` — the single-session bridge that must survive the merge
- PR #1: https://github.com/lacvietanh/aki-mcp-sv/pull/1

## Decision
**Action** → integration branch with a real merge commit, our architecture authoritative on every collision, PR #1 credited and marked Merged, shipped as 1.1.0. No verification gate.
