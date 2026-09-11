# Aki Watch — Postman Pool Auto-Joiner: independent read-only audit

- Repo: `D:\LacViet\aki-mcp-sv`
- Branch: `main` (uncommitted working tree; `scripts/__pycache__/` preserved, nothing reset/reverted)
- Scope: read-only audit of the Aki Watch Tauri app + `scripts/postman-pool*` control/join path
- Method: static/code review + git state + on-disk artifact inspection. No files modified during the audit itself.

## Verdict: HOLD

Functional today as a **Windows developer-machine tool run from the repo**. It is **not** a portable/newbie installer, and macOS/Linux are code-only (unbuilt, untested). Lift HOLD only when the gates below pass.

---

## Cross-platform verdicts

| Target | Verdict | Basis |
|---|---|---|
| Chrome | Removed from runtime (BYPASSED/out-of-scope) | CERTAIN |
| Windows | Builds + smoke-launches from repo | CERTAIN |
| macOS | Code branches only; unbuilt, untested | CERTAIN (no proof) |
| Linux | Code branches only; unbuilt, untested | CERTAIN (no proof) |

**Chrome (CERTAIN):** `git grep` for `chrome|chromium|puppeteer|remote-debugging` across `scripts/` and `apps/aki-watch/` returns only documentation (`docs/index.md`, `docs/plan/chrome-tampermonkey-autosetup.md` — an unrelated claude.ai userscript plan, `docs/research/chrome-cdp-default-profile-block.md`). The join worker `scripts/postman-pool-join.py` is LibreWolf/geckodriver end-to-end. No CDP path remains. Do not treat as a Chrome repair.

**macOS (CERTAIN unproven):** `lib.rs` has `#[cfg(target_os="macos")]` (osascript/Terminal, `python3`, fix-path-env), but there is no macOS cargo build, `.app`/`.dmg`, signing/notarization, or runtime test. `release.yml`'s mac matrix smoke-tests the Node bootstrap launcher, not the Tauri app.

**Linux (CERTAIN unproven):** `lib.rs` has `#[cfg(target_os="linux")]` (x-terminal-emulator/gnome-terminal/konsole, `python3`), but no Linux Tauri compile/package/runtime. `ci.yml` is `ubuntu-latest` Node syntax-check + `npm test` only. `bundle.targets = "all"` but only Windows artifacts exist on disk.

**Windows artifacts on disk (CONFIRMED):**
- `apps\aki-watch\src-tauri\target\release\aki-watch.exe`
- `apps\aki-watch\src-tauri\target\release\bundle\msi\Aki Watch_0.1.0_x64_en-US.msi` (only `msi/` under `bundle/`)

---

## Findings

### P0
1. **MSI is not self-contained — depends on the source repo at a baked path (CERTAIN).**
   `apps/aki-watch/src-tauri/src/lib.rs` `repo_dir()` resolves `AKI_WATCH_REPO_DIR`, else compile-time `CARGO_MANIFEST_DIR/../../..` canonicalized, else `PathBuf::from(".")`. The build baked `D:\LacViet\aki-mcp-sv`. On a machine without that path and no env var, `canonicalize()` fails → cwd-relative `./scripts/...` → `node`/`python` spawn fails. `tauri.conf.json` bundles **no `resources`/`externalBin`**, so `scripts/` and the `.py` worker do not ship in the MSI. The installer effectively only works on the build machine.
2. **Unbundled external runtime dependencies (CERTAIN).**
   The app shells out to `node`, `py -3`/`python3`, LibreWolf, and geckodriver — none bundled or version-checked at startup. A fresh user with only the MSI cannot run a join.

### P1
3. **Headless + Human-Verify trap (CERTAIN).**
   `index.html` exposes a bare `headless` checkbox; `browserArgs()` passes it straight to `--headless`. Manual verification instructs the user to "Complete it in the open LibreWolf window" (`main.js` `renderJoin`), which is impossible headless. No guard/warning → silent deadlock until `manualVerificationSeconds` timeout.
4. **No pre-flight readiness gate (CERTAIN).**
   `startJoin` (main.js) only checks the invite field is non-empty, then scans + spawns. Missing/incomplete config surfaces later as a raw backend `readBrowserConfig` throw. No block on missing binary/config/zero profiles before spawning.
5. **`Verify login` has no cancel and no per-profile progress (CERTAIN).**
   `verifyProfiles` disables the button, shows one "Checking…" line, and blocks on a single `spawnSync --verify-login` over all profiles. Long-running, opaque, uncancellable.
6. **Live Postman invite E2E not run after the GUI/control rewrite (INFERRED; no artifact).**
   Node 141/141 + Python 19/19 are green, but no end-to-end join against a real invite through the new GUI/control path.

### P2
7. **`csp: null` + `withGlobalTauri: true` (CERTAIN; low real risk).**
   Frontend is fully local/bundled; all dynamic strings pass through `escapeHtml`/`textContent`, so XSS surface is small. Still, set a restrictive CSP and drop global Tauri in favor of scoped imports (defense-in-depth).
8. **Accessibility / recall-heavy settings (CERTAIN).**
   Tabs are `<button data-screen>` with no `role=tab/tablist`/`aria-selected`; `.progress-track` has `aria-label` but no `role=progressbar`/`aria-valuenow`; status/log `<pre>` have no `aria-live`; settings form is ID/path/comma-list heavy with no inline validation, no profile picker, no per-account retry.

### Security / lifecycle — positives (CERTAIN)
- Watcher control server binds `127.0.0.1:0` (random port) with a 24-byte random Bearer token; runtime file written atomically at mode `0o600`.
- Secrets (`telegramApiHash`, `reportBotToken`) never returned to the UI — only `hasApiHash`/`hasReportBotToken` flags.
- Invite passed via **stdin**, never argv (no process-listing leak); backend `normalizeManualInvite` validates URL/`invite_code` before spawn.
- Subprocesses run on `spawn_blocking` (UI never freezes); `stopJoin` kills the process tree (`taskkill /T /F` on Windows, process-group kill on POSIX).
- `main.rs` calls `fix_path_env::fix()` so a GUI-launched app can still find node/python on PATH.

---

## Nielsen heuristics (independent re-score)

| Heuristic | Score | Note |
|---|---|---|
| Visibility of status | 8 | Live table/metrics/progress, watcher pill |
| Match with real world | 7 | "Human Verify" clear; jargon-y profile/scratch fields |
| User control/freedom | 6 | Join has Stop; Verify login cannot be cancelled |
| Consistency/standards | 8 | Consistent controls/labels |
| Error prevention | 4 | No readiness gate; headless+manual trap |
| Recognition over recall | 5 | Comma-lists, raw paths, manual IDs |
| Flexibility/efficiency | 8 | Paste/Enter, auto-scan, detached watcher |
| Minimalist design | 8 | Clean 3-tab layout |
| Error recovery | 6 | Raw backend errors surfaced verbatim |
| Help/docs | 5 | Terse inline copy only |

**Overall ≈ 65/100** (below the 67 baseline — error-prevention and the headless trap pull it down).

### Top 5 UX fixes
1. Guard headless vs manual verification (disable headless when manual verify is expected, or hard-warn).
2. Pre-flight readiness check before Start (config ready, binaries found, ≥1 profile) with actionable messages.
3. Make `Verify login` cancellable with per-profile progress streamed like the join table.
4. Humanize surfaced errors (map raw stderr to guidance) instead of dumping backend text.
5. Add ARIA roles (`tab`/`tablist`/`aria-selected`, `progressbar`+`aria-valuenow`, `aria-live` on status/log).

---

## SHIP gates (all must pass to lift HOLD)
1. **Packaging:** bundle `scripts/` + `.py` as Tauri `resources` (or ship a runtime that resolves them independent of `CARGO_MANIFEST_DIR`); verify the MSI runs on a machine that never held the repo with `AKI_WATCH_REPO_DIR` unset.
2. **Dependency preflight:** detect node/python/LibreWolf/geckodriver at launch with clear remediation.
3. **Cross-platform:** actually build + smoke-launch Aki Watch on macOS (DMG + signing/notarization decision) and Linux (bundle + terminal-launcher runtime); do not treat the Node launcher CI as Tauri proof.
4. **Live E2E:** one real Postman invite join through the GUI/control path.
5. **P1 UX:** headless/manual guard + readiness gate landed.

Windows-dev-from-repo use is functional today; the HOLD is specifically about distribution, cross-platform coverage, and the two P1 traps.

---

## Remediation merge — 2026-09-11

This section records implementation after the independent audit; it does not rewrite the original findings.

- **P0.1 addressed in code:** Tauri now bundles the minimal Aki Watch runtime scripts as `aki-watch-runtime` resources. Packaged runtime resolution prefers those resources; `AKI_WATCH_REPO_DIR` is only a valid-checkout development override. The compile-time source repo path is now a development fallback, not the production dependency.
- **P0.2 mitigated, not fully eliminated:** Node/Python/LibreWolf/Telethon/Selenium remain host dependencies. A machine-readable preflight now detects them plus profile discovery and geckodriver/Selenium-Manager state, with actionable UI remediation. Bundling third-party runtimes is intentionally deferred rather than silently inflating the installer.
- **P1.3 addressed:** Headless Join/Watcher/Verify is hard-blocked because Human Verify requires a visible LibreWolf window.
- **P1.4 addressed:** launch/action preflight exposes separate `joinReady` and `watcherReady` gates; Start buttons are guarded.
- **P1.5 addressed:** Verify Login is now a detached job with per-profile `verify_start`/`verify_done` events and explicit Stop.
- **P1.6 still external:** no fresh live Postman invite E2E evidence yet.
- **P2.7 partially addressed:** restrictive local CSP enabled. `withGlobalTauri` remains until a proper frontend module/bundler migration can remove it without using internal IPC APIs.
- **P2.8 improved:** ARIA tab/progress/live-region semantics, humanized common errors, watcher Degraded state, and scanned checkbox profile picker replace the comma-list profile field.
- **Cross-platform gate prepared, not yet proven:** `.github/workflows/aki-watch.yml` builds and smoke-launches native Windows/macOS/Linux Tauri artifacts. macOS/Linux remain UNPROVEN until that workflow runs green on committed code.

**HOLD remains** until (a) rebuilt Windows package proves the bundled resource layout, (b) macOS/Linux matrix runs green, and (c) one fresh live invite E2E succeeds.
