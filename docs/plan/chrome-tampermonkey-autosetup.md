# Chrome Tampermonkey auto-setup — token counter + widen UI on every `npm start`

## Goal
On `npm start`, auto-detect whether the user's Chrome has what's needed to show a claude.ai token/usage progress bar (like the "Claude Token Counter" extension) and auto-apply the "widen chat pane" UI tweak — **without** requiring the user to open DevTools console each session, and without promising silent installs Chrome's security model doesn't allow.

## Hard constraint (why this shape, not a custom extension)
Chrome never allows a fully silent install from the Web Store — always one real user click, no CLI/script bypass except enterprise `ExtensionInstallForcelist` (see "Out of scope" below). Also, CDP (`--remote-debugging-port`) can no longer drive the user's real logged-in tab: Chrome 136+ refuses the default profile (`docs/research/chrome-cdp-default-profile-block.md`, already the reason `scripts/chrome.js` was deleted). So no code path can auto-inject JS into an already-open, already-logged-in claude.ai tab — the mechanism has to be something Chrome itself runs on page load, i.e. a real extension's content/userscript.

## Decision: Tampermonkey host, not a custom-built extension
Don't build/maintain our own Chrome extension. Use **Tampermonkey** (Web Store ID `dhdgffkkebhmkfjojejmpbldmpobfkfo`) as the one-time-installed host, then point it at two userscripts that auto-run on every claude.ai page load forever after:

| Need | Script | Source |
|---|---|---|
| Token count / cache timer / session+weekly usage bar | `claude-counter.user.js` | Installed directly from `she-llac/claude-counter` (MIT) raw GitHub URL — no vendoring, no copy into this repo |
| Widen chat pane (`max-w-3xl → max-w-7xl`) | new small userscript, own repo | `@match https://claude.ai/*`, `MutationObserver` to reapply on SPA nav (replaces the current manual console-paste snippet in `config-page.js` section 4) |

## Architecture decisions

| Issue | Decision | Why |
|---|---|---|
| Detection | Read-only parse of Chrome's `Preferences` JSON (`extensions.settings["dhdgffkkebhmkfjojejmpbldmpobfkfo"]`); resolve the right profile dir via `Local State` → `profile.last_used` | No official CLI to query installed extensions; the profile JSON is the only local source of truth. Never write to this file — see next row |
| Never hand-edit `Preferences` to flip enable state | Detect-only; if disabled, open `chrome://extensions/` and tell the user to toggle it themselves | Chrome checksums this file; an external write is treated as tampering and the extension gets auto-disabled again — editing it is actively counterproductive, not just risky |
| Missing Tampermonkey | `openBrowser()` (existing helper, already used for the panel URL) → Tampermonkey's Web Store page | One click is unavoidable; this is the minimum-friction version of that click |
| Tampermonkey present & enabled, scripts not yet installed | `openBrowser()` the two raw `.user.js` URLs → Tampermonkey's own "Install this script?" tab opens automatically | Still one click per script, but no manual URL typing, no console, no file download |
| Re-runs | Marker file in the existing `dataDir`/`userDir` (already used by `panel.js`/`oauth.js`) recording last-known state | Avoid re-opening install tabs every single `npm start` once everything is already installed |
| Silent enterprise-policy install (`ExtensionInstallForcelist`) | **Out of scope, not auto-enabled** | Removes the "This extension is managed by your organization" boundary permanently across the whole Chrome profile and requires quitting/relaunching Chrome — a one-way door (`RULE-agent-behavior.md` B3); needs explicit separate user approval, never a default |

## Execution checklist
- [ ] New `scripts/chrome-extensions.js`: profile-dir resolver (`Local State` → active profile), `Preferences` JSON reader, Tampermonkey install/enabled-state check
- [ ] New userscript file (repo-owned) for the widen-UI tweak, replacing the manual snippet currently shown in `scripts/config-page.js` section 4
- [ ] Wire into `scripts/start.js`: one check call before/alongside the existing `openBrowser(panelUrl)` call, using the existing `openBrowser()` helper for every URL it needs to open
- [ ] Marker file under `USER_DIR` (from `scripts/userdata.js`) so a fully-set-up machine does nothing on subsequent starts
- [ ] Update panel section 4 (`config-page.js`) to reflect the new one-time-setup flow instead of the manual console-paste instructions
- [ ] Manual test on a clean Chrome profile: no Tampermonkey → Web Store tab opens; Tampermonkey installed, scripts missing → 2 install tabs open; everything installed → `npm start` opens nothing extra
- [ ] Update `README.md` if section 4 workflow is documented there

## Out of scope
- Building/maintaining a custom Chrome extension in this repo instead of using Tampermonkey — no evidence the maintenance cost buys anything the existing MIT userscript doesn't already cover
- `ExtensionInstallForcelist` silent auto-install — one-way door, needs its own explicit approval, not bundled into this plan
- Any CDP-based injection into the user's real profile — blocked since Chrome 136, already the closed history in `docs/research/chrome-cdp-default-profile-block.md`

## Cross-references
- `docs/research/chrome-cdp-default-profile-block.md` — why CDP-based injection is not viable
- `scripts/open-browser.js` — existing cross-platform browser-open helper, reused as-is
- `scripts/config-page.js` section 4 — current manual instructions this plan replaces
- `scripts/userdata.js` — existing `USER_DIR` convention for the marker file

## Decision
**Action** → build `scripts/chrome-extensions.js` + the widen-UI userscript per the tables above, wire into `scripts/start.js`, update panel section 4. Not started yet — this doc records the design only.
