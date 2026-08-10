# Shell allowlist — revoke bug, panel UX, read-only defaults, trusted-dir preallow

## Goal
Four related problems in the shell-allowlist subsystem, bundled in one doc because they share the same code (`scripts/allowlist.js`, `scripts/shell-mcp.js`, `scripts/panel.js`/`config-page.js`) and the same underlying question — "what may run, and how is that decided":
1. A revoke bug in the panel (P0).
2. The panel's raw-JSON UX.
3. New read-only default commands.
4. A second, independent trust mechanism — preallow-by-directory for `~/.aki` and `~/.claude` — so that new Aki-authored skills/scripts don't need a manual `setting.json` edit every time. This is architecturally distinct from 1–3 (it's a new trust *model*, not a data or UI change) and is the reason the doc dropped "-ux" from its name.

## Status & decisions (2026-08-10)

| Item | State | Note |
|---|---|---|
| P0 storage `{overrides,revoked}` + `loadAllowlist()` | ✅ code done | still needs live panel→setting.json→enforce runtime check |
| OS + cross-platform read-only defaults | ✅ code done | |
| `jq` | keep — add `jq: null` | pure read-only, no write/exec primitive |
| `sort` `fd` `rg` `find` | ✗ excluded | argv-escape (`sort -o`, `fd -x`, `rg --pre`, `find -exec/-delete`) not gatable by `args[0]`; redundant with `search__find_path`/`search__search_content`. Supersedes the 2026-08-09 "accepted risk" ruling — on mechanism, not user count |
| Phase 3 row-list UI | ✅ code done | needs live browser check; panel is the product's face for many users (60★/2d), not a solo tool |
| Phase 4 `allowlistDirs` preallow | ✅ code done | both conditions met, incl. interpreter case; editable panel UI (add/remove/save, live) |

Phase 4 conditions, both met: (a) a preallow dir overlapping a filesystem write root is dropped at load, fail-safe, with a stderr warning (`activeTrustedDirs` in `shell-mcp.js`, using `roots.js` `overlaps`); (b) interpreter case — `node`/`python3`/… resolve the first non-flag arg as the script path and check it via `roots.js` `containedIn`, so `node ~/.aki/x.js` is allowed but `node -e '<code>'` (no file arg) stays blocked.

## Findings (evidence, not opinion)

### P0 — revoke bug (security-relevant, fix before any UX work)
`scripts/config-page.js:172` hint text: *"Deleting a line revokes that command."* This is false.

`loadAllowlist()` (`scripts/allowlist.js:32`):
```js
return user ? { ...DEFAULT_ALLOWLIST, ...user } : DEFAULT_ALLOWLIST;
```
`user` is whatever the last POST to `/api/allowlist` saved. If a user deletes `"whoami": null` from the textarea and saves, the saved `user` object simply lacks the `whoami` key — it does not record "revoked". On next load, the spread falls back to `DEFAULT_ALLOWLIST.whoami`, so `whoami` is still permitted. **The UI's explicit claim about how to revoke a default command does not hold.**

Root cause: the storage format has no way to express "explicitly removed" vs "never mentioned" — both look identical (absent key) once serialized.

### Unrelated blocker found in the same file — RESOLVED
`scripts/panel.js` (~line 40–63) previously had an unresolved merge-conflict marker block around `pickFolders`. **Resolved:** the PR1 merge landed and `grep` for markers across `scripts/` is now clean (verified 2026-08-09). Kept here as a closed note.

### `find`/`sort`/`cat` argv-escape footgun — accepted risk, not scheduled (owner ruling 2026-08-09)
`checkPermission` gates `bin` + `args[0]` only; a `null`-arg entry means no flag check. So allowed read-labelled binaries can escape their intent: `find <dir> -exec <prog> {} +` (arbitrary exec), `find <dir> -delete` (irreversible delete), `sort -o <path>` (overwrite), `cat <abs-path>` (read outside ROOTS). None trip `DANGEROUS_CHARS`, and `execFile` (no shell) is no defense — the risk is the binary's own argv.
- **Owner ruling:** threat model is a single owner behind OAuth + passphrase + Funnel; per `METHOD-proportionality` this is accepted, **not** cause to drop `find`/`sort` or build a per-binary flag sanitizer (the arms race Claude Code avoids). Convenience wins. Reopen trigger: multi-user / shared-machine deploy.
- **The one residual duty:** do not label this surface "read-only commands only" (`config-page.js:185`) or the folders "fully off-limits" (`:174`) — both are false. Correct them to honest wording in the same UI pass as the P0 copy fix above. (Source finding: `docs/plan/audit-1.1.0-todo.md` §B1.)

### UX review of the current textarea (`config-page.js:170-176`, `saveAllowlist` handler)
- Cognitive load: user must know the `null` = any-subcommand vs `array` = whitelist-subcommand convention by heart; nothing in the UI teaches it beyond one hint line.
- Feedback: parse/validation errors are generic strings (`invalid JSON — usually a missing comma...`, or `"bin": must be null or array of strings` from `validateAllowlist` in `panel.js`) — no line/position pointer.
- Recognition: no visual distinction between "still default", "user-modified", "user-added". Same problem that produces the P0 bug also produces this: the merged object is indistinguishable from its parts.
- Inconsistent with the rest of the same page: section 3 (Folders) already has a list-of-rows + add/remove UI (`addPath`/`markDirty` in `config-page.js`); section 4 regresses to raw JSON right below it.
- No per-command risk signal beyond one static paragraph; a user adding `rm` or `git commit` gets no stronger warning than adding `ls`.

## Decisions

| Issue | Decision | Why |
|---|---|---|
| Storage format | Store allowlist as an explicit diff against `DEFAULT_ALLOWLIST`: `{ overrides: { bin: null\|string[] }, revoked: string[] }` instead of a flat merged object | Makes "explicitly removed" representable — the only fix that makes the existing UI claim true |
| `loadAllowlist()` | `{ ...DEFAULT_ALLOWLIST, ...overrides }` then delete every key in `revoked` | One extra pass, no behavior change for the non-revoked path |
| Panel UI | Replace the raw textarea with a row-list (same pattern as section 3's folder list): one row per binary, dropdown for any-subcommand vs limited, tag-input for subcommand list, a delete button that writes to `revoked` (not silently omits) | Reuses an already-shipped interaction pattern instead of inventing a second one on the same page |
| Add-new-command | Existing "+ Add folder…" pattern reused as "+ Add command…" | Consistency, zero new interaction to learn |
| Risk indicator | Static list of known write/destructive binaries (`rm`, `mv`, `cp -f`, `git commit`, `git push`, `npm publish`, …) checked client-side; row renders with a yellow/red border + short reason when matched | Immediate feedback at the point of risk, not just a paragraph read once |
| Raw JSON access | Kept behind a collapsed "Advanced" toggle, defaulting closed | Power users keep the fast path; newbies get the guided path by default |
| Validation errors | Point at the specific row/key, not a generic string | Directly answers the "feedback" UX gap found above |

### Revision 2026-08-10 — storage + UI superseded (same unreleased cycle)
Three of the decisions above were refined once built; the enforcement path (`checkPermission`, the in-memory `{bin:null|array}` map) is unchanged, so the risk profile is identical.
- **Storage** is now `{ added: [2-level entries], revoked: string[] }`, where `added` is the same array `DEFAULT_ALLOWLIST` uses (bare string = any subcommand, `[bin, ...subs]` = restricted). This drops the hand-written `bin: null` the `overrides` map required. `loadAllowlist()` reads all three shapes (v3 `added`, v2 `overrides`, v1 flat map) via `normalizeStored`, discriminated by `added` then `overrides`. `revoked` is unchanged and still the P0 fix.
- **Panel UI** dropped the raw-JSON "Advanced" toggle entirely and split the flat row-list into compact **chips** (any-subcommand) + **rows** (restricted, with a subcommand field). Clicking a chip promotes it to a row; a row emptied of subcommands collapses back to a chip on save (level inferred from the data), or explicitly via an **"any"** button on the row. Risk flag is now chip/row coloring + tooltip, not a per-row note line.
- **Trusted-dir UI** became an editable list (add / remove / save, sharing the one `flist` field pattern), replacing the earlier read-only status readout: users configure `shell.allowlistDirs` from the panel instead of hand-editing `setting.json` (the audience for this feature is mostly non-technical). A zone overlapping a section-3 write root still renders disabled with the offending folder named. Save writes `setting.json` and takes effect live with no hub restart, because `checkPermission` reads `loadAllowlistDirs()` per command (`shell-mcp.js`).

## Default read-only allowlist additions

All entries below are read-only by construction (no `-f`, no write/delete verbs, no `Set-`/`Remove-`/`Stop-` on the Windows side). Same shape as `UNIX_DEFAULT`/`WIN_EXTRA` in `scripts/allowlist.js`: `null` = any subcommand/flag, array = restricted to listed subcommands.

**macOS** (extends `UNIX_DEFAULT`):

| Category | Command | Subcommand restriction |
|---|---|---|
| RAM/CPU | `vm_stat` | `null` |
| RAM/CPU | `sysctl` | `['-n']` — works today: checkPermission matches args[0] literally, and for a single-flag command the flag itself is args[0], so ['-n'] already blocks sysctl -w |
| RAM/CPU | `top` | `['-l']` — same mechanism, one-shot mode only, not interactive stream |
| Disk | `diskutil` | `['list', 'info']` |
| Disk | `du` | already default (`null`) |
| Process | `ps` | already default (`null`) |
| Process | `pgrep` | `null` |
| Network | `ifconfig` | `null` |
| Network | `netstat` | `['-an']` |
| Network | `lsof` | `['-i']` — restrict to network-socket queries |
| System | `sw_vers` | `null` |
| System | `uname` | already default (`null`) |
| System | `system_profiler` | `null` |
| Git | `git` | extend existing array with `branch`, `remote` |

**Linux** (new `LINUX_EXTRA`, mirrors `WIN_EXTRA` pattern):

| Category | Command | Subcommand restriction |
|---|---|---|
| RAM/CPU | `free` | `null` |
| RAM/CPU | `top` | `['-b']` — batch mode only |
| RAM/CPU | `nproc` | `null` |
| Disk | `df` | `null` |
| Disk | `lsblk` | `null` |
| Process | `pgrep` | `null` |
| Network | `ip` | `['addr']` |
| Network | `ss` | `['-tuln']` — same single-token mechanism as `sysctl`/`top` above, works as written |
| Network | `lsof` | `['-i']` |
| System | `cat` | already default (`null`) — used for `/etc/os-release`, no new entry needed |

**Windows** (extends `WIN_EXTRA`):

| Category | Command | Subcommand restriction |
|---|---|---|
| RAM/CPU | `Get-CimInstance` | `null` |
| RAM/CPU | `Get-Counter` | `null` |
| RAM/CPU | `Get-Process` | `null` |
| Disk | `Get-PSDrive` | `null` |
| Disk | `Get-Volume` | `null` |
| Process | `Get-Service` | `null` |
| Network | `Get-NetIPAddress` | `null` |
| Network | `Get-NetTCPConnection` | `null` |
| Network | `Test-Connection` | `null` |
| System | `Get-ComputerInfo` | `null` |
| System | `systeminfo` | `null` |

## Cross-platform dev-tooling baseline (reconciled against the tables above)

User-supplied list, cross-checked against `UNIX_DEFAULT` and the OS tables above to avoid duplicate entries. "Already covered" rows need no code change.

| Command | Status | Restriction |
|---|---|---|
| `basename`, `dirname`, `realpath` | new, cross-platform | `null` |
| `diff` | new — top-level binary, distinct from `git diff` (already default) | `null` |
| `fd`, `rg`, `jq` | new, cross-platform (require the binary installed) | `null` |
| `sort`, `strings`, `uptime`, `which` | new, cross-platform (`which` has no meaning on Windows — `where` already in `WIN_EXTRA`) | `null` |
| `cat`, `df`, `du`, `file`, `grep`, `head`, `ls`, `ps`, `stat`, `tail`, `wc` | already in `UNIX_DEFAULT` | no change |
| `free`, `pgrep` | already added above (Linux / macOS+Linux tables) | no change |
| `lsof`, `netstat`, `ss` | already added above with restriction | no change |
| `npm` | new — clean subcommand array | `['list', 'ls', 'outdated']` |
| `pip` | new — clean subcommand array | `['freeze', 'list']` |
| `node -v` | new — single leading flag, same mechanism as `sysctl -n`/`top -l` (see correction note below) | `['-v']` |
| `git blame`, `check-ignore`, `ls-files`, `rev-parse`, `tag` | new — extend the existing `git` array | add to array |
| `git branch`, `diff`, `log`, `remote`, `show`, `status` | already covered (`UNIX_DEFAULT` + macOS table) | no change |
| `git stash list` | dropped — genuine two-level gap, see below | not added |

## Correction: the earlier "flag restriction" concern was wrong for single-flag commands

`checkPermission` (`shell-mcp.js`) checks `array.includes(args[0])` — literal string equality on the first token, nothing dash-aware about it. For a command whose entire safe/unsafe boundary is its *first* token — `sysctl -n` vs `-w`, `top -l` vs interactive, `node -v` vs `node -e '<code>'` — the existing array mechanism already enforces that correctly. An earlier draft of this doc flagged `node -v` as blocked by the same gap as `git stash list`; that was incorrect and is corrected above: `node: ['-v']` is safe and already in the cross-platform baseline table.

## `git stash list` — genuine two-level gap, dropped (not deferred)

`git stash list`, `git stash pop`, `git stash drop` all share `args[0] = 'stash'` — the distinguishing token (`list` vs `pop`/`drop`) is `args[1]`, which `checkPermission` never inspects. This is a real, different gap: no single-token restriction can separate the read-only case from the destructive ones. Adding `git: [..., 'stash']` would silently permit `stash pop`/`stash drop` too.

- Stretching `checkPermission` into a two-level matcher just to fit one subcommand grows the trust surface of the one function every other allowlist entry relies on — a bug there risks every command, not just this one.
- If genuinely needed later, the correct fix is a **dedicated tool** with that one narrow capability hardcoded (no general argv matching) — same precedent as `docs/plan/repl-config-tools.md`'s decision to add `process-mcp.js` as a new file rather than stretch `shell-mcp.js`'s scope.
- **Action:** do not add `git stash` in any form. The allowlist philosophy (verb-level matching, not arbitrary-depth argv parsing) is working as intended here — not a gap to patch around.

## Trusted-directory preallow — `~/.aki`, `~/.claude`

### Context
Today every runnable binary/script needs an exact-match line in `shell.allowlist`. Each new Aki-authored skill or script requires a manual `setting.json` edit before it can run — doesn't scale as skill count grows.

### Philosophy
Preallow by **trust zone**, not by **file**. `~/.aki` and `~/.claude` are directories Aki fully owns and writes scripts into deliberately; whitelisting individual files inside a zone already controlled end-to-end is the wrong grain. This is a second, independent mechanism alongside the name-based allowlist above — not a replacement for it (`rm`, `git commit`, etc. outside these zones still need an explicit line).

### Proposal
`shell.allowlistDirs: ["~/.aki", "~/.claude"]` in `setting.json`. In `checkPermission`, when `bin` is not found in the name-based allowlist, fall back to: resolve `bin` with `fs.realpathSync` → check it is contained in one of `allowlistDirs` → check it is executable (`fs.accessSync(path, fs.constants.X_OK)`) → allow if all three hold.

**Reuse, don't duplicate, the containment check.** `scripts/roots.js` already has `containedIn(abs, root)` — case-insensitive on Windows, prefix-with-separator on Unix, written specifically because "a second copy of a security boundary is a second chance to get it subtly wrong" (the file's own comment). The new check must import and reuse it, not reimplement path-prefix matching in `shell-mcp.js`.

### Interpreter + script-argument invocations — RESOLVED
The direct case (`bin` itself is the script, e.g. `~/.aki/scripts/foo.sh`) and the interpreter case (`node ~/.claude/skills/foo/run.js`, `python3 ~/.aki/scripts/bar.py`) are both covered by `preallowedByDir` in `shell-mcp.js`:
- **Direct:** `bin` contains a path separator → resolve, require it under a trusted dir **and** executable (`X_OK`).
- **Interpreter:** `path.basename(bin)` ∈ `INTERPRETERS` (`node python python3 bun deno tsx ruby perl php`; shells deliberately excluded — their arg is arbitrary code, not a locatable file) → the first non-flag arg is the script; require it under a trusted dir. `node -e '<code>'`/`python3 -c '<code>'` have no file arg, so they never match and stay blocked.
- Crucially, the check runs even when `bin` **is** in the name allowlist but the subcommand is not (e.g. `node` is name-allowed only for `-v`): `checkPermission` is now `name-allow OR dir-allow`, so `node ~/.aki/x.js` passes via the dir path without loosening `node`'s name entry.
- **Known limitation (fail-safe):** a *relative* script path is resolved against the server's cwd, not the run `cwd`, so it will be under-permitted, not over-permitted. Pass an absolute script path (the norm for skill invocations) for the preallow to fire. Not worth threading `cwd` into `checkPermission` for the MVP.

### Threat model — the trade-off, stated precisely
Today: `run_cmd` access can only run the ~20 named, individually-reviewed binaries. After this change: it can run anything that ends up under `~/.aki` or `~/.claude`. The composition risk: if those directories are also inside the filesystem MCP's writable roots (panel section 3), a write via `write_file` followed by a run via `run_cmd` becomes arbitrary code execution with no allowlist review in between — that overlap (write-access zone == exec-preallow zone), not the preallow mechanism alone, is the thing actually being accepted. Worth checking at implementation time whether `~/.aki`/`~/.claude` are in the configured filesystem roots, so the trade-off is verified, not assumed.

Recorded here as a deliberate scope decision, consistent with the philosophy above — not a design flaw needing a fix, per the owner's framing.

## Execution order
1. ✅ Fix P0 storage format + `loadAllowlist()`. Done — needs live runtime check.
2. ✅ Add OS-specific + cross-platform read-only defaults. Done. `jq` still to add; `sort`/`fd`/`rg`/`find` excluded (see Status).
3. ✅ Section 4 UI: compact chips (any-subcommand) + rows (restricted, with a subcommand field); raw-JSON editor removed; risk flag via chip/row coloring + tooltip. Code done — needs live browser check. (See Revision 2026-08-10.)
   - Defaults now authored as a list where structure carries the level (`'ls'` = any subcommand · `['git','status',…]` = restricted); `toMap` builds the `{bin: null|array}` map once, so no hand-written `null` and the rest of the subsystem is untouched.
4. ✅ `allowlistDirs` preallow implemented with both conditions (see Status). `roots.js` now exports `containedIn` + `overlaps`; `allowlist.js` adds `loadAllowlistDirs()` (default `~/.aki`, `~/.claude`, `~`-expanded); `shell-mcp.js` adds `activeTrustedDirs`/`underTrusted`/`preallowedByDir` and the `name-allow OR dir-allow` `checkPermission`; panel shows an editable active/inactive list per zone (`POST /api/trusted-dirs`, live, no restart). Needs a live run to confirm a trusted-dir script executes end-to-end.
5. Separately: merge-conflict markers in `panel.js` — already resolved (finding above), no action.

## What still needs a live check (not statically verifiable — `coding.B3`)
- Phase 3 panel: rows render, risk borders fire, Save round-trips through `setting.json` and re-enforces.
- Phase 4: a script under `~/.aki`/`~/.claude` actually runs via `run_cmd` when those zones are disjoint from the filesystem roots; a zone overlapping a root shows `disabled` in the panel and is refused by the server.
