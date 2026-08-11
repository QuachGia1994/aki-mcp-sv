# Plan: Control-panel UX improvements (sections 5 & 6, plus a scroll-spy TOC)

## Status
Design only — not started. No code written. Four independent features; feature 3 is the load-bearing one and carries a latent-bug must-fix. All evidence is `file:line` against the current working tree.

## Goal
Make the local panel (`scripts/config-page.js`) faster to operate and bring the two list editors (section 5 Folders, section 6 Allowed shell commands) to behavioral parity. The headline change is feature 3: a folder add/remove should take effect at **runtime**, the way a command allowlist edit already does, instead of forcing "Save & restart hub".

Scope is the panel page and the folder-scope wiring it drives (`scripts/roots.js`, `scripts/panel.js`, `scripts/allowlist.js`, `mcp-hub.config.json`). Read-only tools and the OAuth/bridge layer are untouched.

---

## Feature 1 — Filter bar for section 6 (Allowed shell commands)

**Problem.** The default allowlist already ships ~40 command entries (`allowlist.js:10-22`), rendered as chips + rows (`config-page.js:316-317`). Finding one to edit or delete is a visual scan with no narrowing — cognitive-load cost grows with every command the user adds (`ux.A1`).

**Current state.** `renderAllowlist(map)` (`config-page.js:511-518`) empties `#cmdChips`/`#cmdRows` and appends one `.chip` per any-subcommand entry and one `.cmdrow` per restricted entry, each carrying `dataset.bin` (`config-page.js:479, 494`). No filter exists.

**Design.** One text input above `#cmdChips`, placeholder `filter commands…`. On `input`, toggle `display` on every `.chip`/`.cmdrow` whose `dataset.bin` does not include the (lowercased) filter substring — pure client-side visibility, no re-render, no data touched. Reuse the existing `input[type=text]` styling (`config-page.js:107`); no new class tier (`ui.A1` — a runtime display toggle is not a pattern).
- **Keep it distinct from the existing "add a command" input** (`#newCmd`, `config-page.js:319`): the add-input stays *below* the list (its current position), the filter sits *above* it. Same widget, opposite roles — separating them by position prevents the mental-model collision of one box that both filters and creates (`ux.A6`, `ux.A2`).
- Filtering only hides; it never alters `collectAllowlist()` (`config-page.js:521-534`), so a save while filtered still persists the full set.
- Empty filter restores all. No "no matches" dead-end needed — the add-input directly below is the escape (`ux.B4`).

---

## Feature 2 — Auto-sort section 5 (Folders) on save

**Problem.** Folders render in stored order (`config-page.js:585` iterates `s.paths` as-is); adds append to the bottom (`addPath`, `config-page.js:439-458`). The list drifts into insertion order and is hard to scan — while section 6 already renders sorted (`renderAllowlist` sorts keys, `config-page.js:514`). Inconsistent behavior between two sibling editors (`ux.A6`).

**Current state.** `savePaths` (`config-page.js:610-616`) collects `#paths input` values, filters empties, POSTs them verbatim; server `validatePaths` (`panel.js:58-63`) only normalizes, never orders; the list persists in whatever order it arrived.

**Design.** In `savePaths`, sort the collected list before POST with a stated key: **case-insensitive by full path** — `a.localeCompare(b, undefined, { sensitivity: 'base' })`. The server re-serves the saved order on next `GET /api/state`, so the sorted order is what the user sees after save — no separate re-render needed. Persisted sorted = SSoT of order (`design.A1`).
- **Locked rows** (`RULES_DIR`/`CLAUDE_DIR`/`AKI_DIR`, `config-page.js:437`) sort in place with the rest; they are still submitted (`savePaths` reads all `#paths input`). Optional refinement: pin the three locked rows to the top for recognition (`ux.A2`) — decide at build time, default is plain sort.
- **Section 6 parity:** section 6 is *already* sorted on render (`config-page.js:514`), so this feature closes the gap rather than adding a second behavior — the goal is one sort rule shared by both list editors (SSoT of behavior, not two implementations). No change needed in section 6.

---

## Feature 3 — Rebuild section 5 to be runtime, like section 6 (KEY ITEM)

**Problem.** Section 5 shows "Save & restart hub" (`config-page.js:308`); a folder change only takes effect after `restartHub()` respawns mcp-hub, dropping every tool child. Section 6 needs no restart. The restart is a heavy hammer, and between save and restart the user believes a folder is active when it is not — a recognition/feedback defect (`ux.A2`, `ux.A3`).

**Why the asymmetry exists (root cause, with evidence).**

| | Section 6 — commands (runtime) | Section 5 — folders (boottime) |
|---|---|---|
| Where enforced | `shell-mcp.js:100` `checkPermission` → `loadAllowlist()` **fresh every `run_cmd`** | `roots.js:7-13` computes `ROOTS`/`ROOT` **once at module import** from `process.env.MCP_DATA_DIR`, a module-level const |
| Source of truth | `setting.json` read per call (`allowlist.js:53-60`) | env var baked into the child at spawn |
| How it reaches the tool | disk read, no process boundary | mcp-hub injects it at spawn: `local.env.MCP_DATA_DIR` for our tools, **positional argv** for the npx filesystem server (`mcp-hub.config.json:5,10`) |
| Save path today | `POST /api/allowlist` writes file, **no restart** (`panel.js:154-157`) | `POST /api/paths` writes `mcp-hub.config.json` **and** `restartHub()` (`panel.js:149-153`) |

So commands are live because the gate re-reads its list from disk on every call; folders are frozen because their list is a snapshot captured at process spawn and never re-read.

**Two distinct owners of the boottime constraint — they do not have the same fix.**

1. **Our own tools** (`local__*`: shell, `find_path`, `search_content`, agy, kiro) all enforce scope through `roots.js`. This is *our* code — nothing forces the snapshot except that `ROOTS` is a module const. We can read the folder list fresh per call, exactly as the allowlist already does.
2. **The external `@modelcontextprotocol/server-filesystem` npx child** takes its allowed dirs as **positional spawn args** (`mcp-hub.config.json:5`). Third-party code, re-reads nothing, exposes no runtime API to change dirs. We are not in its call path — mcp-hub proxies `filesystem__*` straight through — so we cannot gate it per call without either a per-child respawn (mcp-hub offers none) or replacing it with our own implementation, which is exactly **Stage 2** (`docs/plan/unify-mcp-tools-single-process.md`), deferred because it means reimplementing ~14 security-sensitive filesystem tools (`consolidate-mcp-tool-processes.md`, Out of scope).

**Design — make folders the SSoT twin of the command allowlist (`design.A1`, `design.A8`).**

- **Persist folders like the allowlist.** Store the folder list in `setting.json` (a `folders` key beside `shell.allowlist`) as the authoritative source, and add `loadFolders()` mirroring `loadAllowlist()` (`allowlist.js:53-60`): read fresh, filter non-strings, `path.resolve`, dedupe. `mcp-hub.config.json` stops being the folder SSoT — it holds only a stable spawn seed (below).
- **Convert `roots.js` from a const to a per-call read.** Replace the module-level `ROOTS`/`ROOT` (`roots.js:7-13`) with `getRoots()` that calls `loadFolders()` (optionally memoized with an mtime check to avoid a disk read on every call). `resolveUnderRoot`/`containedIn` (`roots.js:28-36`) call `getRoots()` instead of closing over the frozen const. This makes shell/search/find/agy/kiro honor a folder add/remove on the **next call — runtime, no restart.** It is the "one flow made natural" move (`design.A8`): folders become the same kind of object as commands — a per-call-checked containment list — instead of a spawn-time snapshot.
- **`POST /api/paths` stops restarting** for our tools: write `setting.json`, return. Feature 2's sort applies here.
- **The npx filesystem child stays spawn-arg-bound until Stage 2 — state this honestly.** Recommended interim: spawn it with a **stable seed root** (write `filesystem.args`/`local.env` once at seed) and split the button — the common actions (narrow/add a folder for shell, search, `find_path`, `search_content`) are live immediately; the file read/write/edit tools pick up the new scope only after an explicit, clearly-labeled optional **"apply to file tools (restarts hub)"** action. This removes the restart from the everyday path while being truthful that the external tool lags. The restart disappears entirely at Stage 2, when the filesystem tools move into `local-tools-mcp` (our code) and `getRoots()` governs them too — cross-reference `unify-mcp-tools-single-process.md`.

**Must-fix folded in — a latent bug this rewrite lands on.** `setFilesystemPaths` (`panel.js:38-46`) writes `config.mcpServers.search.env` and `config.mcpServers.shell.env`, and `userdata.js:29` reads `live.mcpServers.search.env.MCP_DATA_DIR` — but the consolidated `mcp-hub.config.json` has only `filesystem` + `local` (`mcp-hub.config.json:2-12`); the `search`/`shell` keys were merged away in Stage 1. On a fresh consolidated install `config.mcpServers.search` is `undefined`, so `setFilesystemPaths` throws and `POST /api/paths` 400s — section 5's Save is currently broken there. The redesign must retarget `local.env.MCP_DATA_DIR`. **Do not treat as confirmed-shipped:** the working tree shows Stage 1 mid-flight (`local-tools-mcp.js` untracked, `mcp-hub.config.json` modified, `panel.js`/`userdata.js` NOT among the changed files), so this may be known in-progress work — confirm with the author before scheduling the fix (`agent.B5`, no auto-classification).

**Safety floor (`coding.C4`, `proportion`).** Folders are a containment boundary. Per-call reads must stay fail-safe: an empty or malformed list must never read as "no restriction" — keep `roots.js`'s explicit home-dir fallback (`roots.js:12`) and the panel's existing block on saving an empty list (`config-page.js:611-612`). Write `setting.json` atomically so a partial write can never transiently widen the boundary.

---

## Feature 4 — Scroll-spy TOC sidebar

**Problem.** The only in-page nav is the top stepper (`config-page.js:186-194`), which lists steps 0–4 only — sections 5 and 6 have no nav entry, and nothing marks which section the user is currently in while scrolling this long page.

**Current state.** Seven `<section id="s0">…<section id="s6">` (`config-page.js:196, 209, 265, 276, 292, 303, 314`). Main column is `max-width: 880px; margin: 0 auto` (`config-page.js:88`), leaving free gutter on wide viewports. Existing breakpoints: `700px`, `560px` (`config-page.js:180-181`).

**Design.** A fixed left-gutter list of all seven sections; the current section highlights on scroll; click scrolls to it. Reuse existing tokens (`--muted`/`--accent`/`--line`) and the `.step-n` circle pattern (`config-page.js:121`) — no new value (`ui.A2`).

- **Keywords (shortest distinctive, one per section):**

  | id | Section title | Number | Keyword |
  |---|---|---|---|
  | s0 | 0 Setup | 0 | Setup |
  | s1 | 1 Connectors | 1 | Connect |
  | s2 | 2 Install AkiDevRule | 2 | Rules |
  | s3 | 3 Instructions | 3 | Prompt |
  | s4 | 4 Browser utilities | 4 | Browser |
  | s5 | 5 Folders | 5 | Folders |
  | s6 | 6 Allowed shell commands | 6 | Shell |

  "Rules" (§2 install) vs "Prompt" (§3 choose rules + copy prompt) keeps the two adjacent rule-related sections distinguishable (`ux.A6`).

- **RWD / breakpoints:**
  - **≥1100px** (gutter wide enough for text without overlapping the 880px column): number **+ keyword**, fixed left.
  - **700–1100px**: number **only** — a thin fixed rail, no room for text.
  - **<700px**: hidden. The existing top stepper already serves narrow-screen navigation (`config-page.js:186-194`); a fixed side rail on mobile would steal scarce width (`ux.A1`). Reusing the top stepper as the mobile affordance avoids a second nav to maintain (subtraction before addition, `design.A8`).
- **Fixed positioning:** `position: fixed; top: <below h1>; left: calc((100vw - 880px)/2 - <rail width> - gap)` so the rail rides the left gutter and never overlaps the centered column; clamp `left` to a small min so it degrades gracefully as the viewport narrows toward 1100px.
- **Active detection — IntersectionObserver, not a scroll handler.** Observe the seven sections; mark active the topmost section currently intersecting, using `rootMargin` biased toward the top (e.g. `-40% 0px -55% 0px`) so "active" flips as a section reaches the upper third. Chosen over a `scroll` listener because it fires only on threshold crossings (no per-frame handler, no manual `getBoundingClientRect` thrash) and is the native primitive for exactly this (`coding.C3`). Click handlers use `scrollIntoView({ behavior: 'smooth' })`; anchor `href="#sN"` remains the no-JS fallback.
- **Relationship to the top stepper:** they coexist (stepper = onboarding progress 0–4 with done-state; TOC = persistent all-section scroll-spy). A later pass could unify them; not in scope here — noted so it is a decision, not an oversight.

---

## Risks / open questions

1. **Stage-1 tree state (blocks feature 3's must-fix).** Is the consolidation (`local` server replacing `search`/`shell`) intended to ship as-is, and were `panel.js`/`userdata.js` deliberately left referencing the old keys? Answer decides whether the `setFilesystemPaths` retarget is a bugfix or part of the same in-flight change. Do not classify unasked.
2. **Per-call disk read cost (feature 3).** `getRoots()` reading `setting.json` on every filesystem/shell call adds a small stat+parse. The allowlist already pays this (`loadAllowlist` per `run_cmd`), so the pattern is proven; still, memoize with an mtime check if a hot loop shows up.
3. **Filesystem-tool lag is user-visible (feature 3).** Until Stage 2, `filesystem__read_file`/`write_file`/`edit_file` honor a folder change only after the optional restart. The split button must word this precisely or it recreates the exact "I thought it was active" confusion feature 3 set out to fix (`ux.A3`). Validate by a behavior signal: after adding a folder, `local__find_path` reaches it with no restart; `filesystem__read_file` does not until restart (`ux.C4`).
4. **Sidebar gutter math (feature 4).** The `left: calc(...)` depends on the 880px column width; if that width ever becomes a token or changes, the rail offset must follow it (single source — read the column width, don't hardcode a second copy).
5. **Locked-row sort choice (feature 2).** Plain case-insensitive sort vs pinning the three locked rule-dirs first — a small recognition-vs-simplicity call to settle at build time.
