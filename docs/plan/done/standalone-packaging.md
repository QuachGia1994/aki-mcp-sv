# Standalone packaging — remove the Node.js/npm install step for end clients

## Status
Closed — shipped. The recommended option below (full pre-bundled package) was built (council item I2, room `2026.08.15-0039-aki-mcp-sv-release-018`). Known gap: Windows/Linux archives have not actually been built or tested — see Decision.

## Problem this addresses

Today a client must: install Node.js, `git clone` (or download) the repo, run `npm install`, then `npm start` (README § Install/Run). That is a normal workflow for a developer and a real barrier for a non-technical client who was just handed a `--tunnel <cred.json> --origin https://your-host` invite (README § "Someone gave you a tunnel JSON"). The goal is to remove the Node/npm-install step specifically — not to change anything about OAuth, ingress, or the tool suite.

## The real blocker — bundling `start.js` does not remove the Node dependency

`scripts/start.js` does not just run its own code; it **spawns external processes by resolved file path**, and that pattern defeats every "fuse the JS into one binary" tool identically:

- `spawnHub()` resolves `mcp-hub/dist/cli.js` via `createRequire(...).resolve(...)` and runs it as `spawn(process.execPath, [cli, '--port', ...])` — i.e. it hands a **file path** to whatever binary `process.execPath` currently points at, and trusts that binary to behave like a generic "run this script" Node runtime.
- `mcp-hub.config.json`'s `filesystem` entry runs `npx -y @modelcontextprotocol/server-filesystem ...` — a second, independent spawn that needs a real `npx` (hence Node + npm) resolvable on `PATH`, plus network access to the npm registry on first run (it is not vendored — confirmed absent from this repo's own `node_modules`).
- `spawnCloudflared()` and Tailscale (`scripts/tailscale.js`) shell out to the `cloudflared`/`tailscale` **binaries** — already separate, pre-existing external installs, unrelated to Node at all. Packaging this project's JS does nothing to remove them either way; they stay a documented prerequisite regardless of which option below is chosen.

**Why every "single executable" tool hits the same wall:** SEA, `pkg`/`nexe`, and Bun's `bun build --compile` all work by statically tracing the `import`/`require` graph of one entry file and fusing it (plus, for Bun, the resolved `node_modules`) into a single binary. A file path resolved and spawned *at runtime* — like `mcp-hub/dist/cli.js` above — is invisible to that static trace; it is never embedded. After fusing `start.js` into a SEA/pkg/nexe/Bun binary, `process.execPath` inside it points at that fused binary — which is not a generic runtime and does not execute an arbitrary script path handed to it as `argv`. So `spawnHub()` would either error or (worse) silently misbehave. The fusion step only shrinks `start.js`'s own ~15 files into one file; it does **not** remove the need for a real, generic, on-disk JS runtime plus the actual `mcp-hub` package files for that second spawn to load. Any option that fuses the main entry must therefore *also* solve the exact same "provision a real runtime for the child spawns" problem that Option 6 below solves directly — at which point the fusion step has bought nothing.

This is the single fact that should drive the recommendation below: **the packaging problem is not "compile `start.js` into an .exe," it is "make a real Node runtime + `mcp-hub`'s files silently present on the client's machine without the client doing it by hand."**

## Options evaluated

| Option | Mechanism | Solves the real blocker? | Maturity / risk (2026) |
|---|---|---|---|
| **Node SEA** (`--experimental-sea-config`, or `--build-sea` since Node 25.5) | Injects a bundled script blob into a copy of the `node` binary (`postject`, or one-step since 25.5) | No — fuses only the statically-imported graph; `spawnHub()`'s resolved-path spawn and `npx` are untouched (see above) | Stable since Node 22, improved in Node 24, one-step build added Node 25.5 (Jan 2026). Core Node feature, no extra dependency — but solves the wrong problem here. |
| **`pkg` (vercel/pkg)** | Same fusion model as SEA, older tool | No — identical blocker | **Archived by Vercel, Jan 2024, last release 5.8.1.** The maintained continuation is the community fork **`@yao-pkg/pkg`** (drop-in rename, tracks modern Node). Even maintained, adds a third-party build-pipeline dependency for no gain over SEA. |
| **`nexe`** | Same fusion model, older/smaller project | No — identical blocker | Historically lags several Node majors behind, sporadic maintenance. No advantage over SEA/`@yao-pkg/pkg`. |
| **Bun compile** (`bun build --compile`) | Bundles imports + `node_modules` + the Bun runtime into one binary; supports cross-compiling other OS/arch targets from one host | No — same static-trace limitation for the resolved-path spawn and `npx`; also introduces an **unverified compatibility risk**: `mcp-hub` and `@modelcontextprotocol/sdk` have never been run under Bun by this project | Bun itself is mature and fast-moving, but adopting it here means becoming the first to discover any Node-API gap in two actively-changing third-party dependencies — an ongoing maintenance cost for a single maintainer, for a problem it doesn't actually solve. |
| **Deno compile** | Bundles into one self-contained executable; `npm:` specifier compat layer for Node packages; needs `--allow-run`/`--allow-net`/`--allow-read` at compile or run time | No — same limitation, plus Deno's Node-compat is its own separate reimplementation, an even less common pairing with `mcp-hub`/the MCP SDK than Bun | Mature runtime, but the least-tested compatibility path of the four fusion options for this dependency set. |
| **Full pre-bundled package** (portable Node runtime + pre-installed `node_modules`, built at CI/release time) | CI runs `npm ci --omit=dev` **once, at build time**, then packages a portable Node binary + the resulting `node_modules` + app code into one per-OS archive; the launcher inside just execs the bundled `node scripts/start.js` — **no network call, no npm install, on the client's machine** | **Yes** — `process.execPath` is a real generic Node binary again, so `spawnHub()` needs no change at all; combined with vendoring `@modelcontextprotocol/server-filesystem` (below), the `npx` spawn is fixed too | No new build pipeline beyond the packaging step itself, no compat-layer risk, no third-party fork dependency. Artifact is larger (ships `node_modules` + a Node binary per OS) but is genuinely zero-install for the client. |
| **Electron** | Bundles Chromium + Node into a desktop app shell | Not applicable — this is a headless server with an existing browser-based control panel (`panel.js`, 127.0.0.1:9998); there is no UI to render natively | Rejected. ~150MB+ per install, its own update mechanism, zero UX gain over "open the URL `start.js` already prints." |

## The vendoring fix `npx` needs regardless of which packaging option is picked

`@modelcontextprotocol/server-filesystem` is not a dependency of this repo today — `mcp-hub.config.json`'s `filesystem` entry launches it via `npx -y`, which resolves and installs it from the npm registry into npx's own cache on first run. That is a second, independent source of "needs Node+npm+network," separate from packaging `start.js` itself. The fix is small and self-contained: add the package as a real `dependency`, and change the `filesystem` entry's `command`/`args` from `npx -y @modelcontextprotocol/server-filesystem ...` to the vendored package's resolved binary — mirroring exactly the `createRequire(...).resolve(...)` pattern `spawnHub()` already uses for `mcp-hub`. This is scoped, testable on its own, and valuable even before any installer work — it stays in scope for Phase 1 below.

This is deliberately **not** the same as Stage 2 of `docs/plan/unify-mcp-tools-single-process.md` (reimplementing the filesystem tools natively in-process). That plan removes `npx` by removing the whole external server; this plan removes `npx` by vendoring the same external server as a direct dependency and pointing at it by path. Vendoring is the right size for a packaging concern; the native rewrite stays scoped to its own, already-deferred plan.

**mcp-hub itself:** no separate Node provisioning question — it is already spawned via `spawnNode()` = `spawn(process.execPath, ...)`, so once `process.execPath` is a real private Node binary (the installer's job), `mcp-hub` just works, same as today.

## Cross-platform requirement

Follows the project's existing OS-agnostic-by-decision rule (`CLAUDE.md`, `docs/plan/done/unify-windows-linux.md`): per-OS difference is a **data table**, never a branch in business logic and never a second implementation. The installer/launcher mirrors the `LAUNCHER` map already in `scripts/open-browser.js` — one table keyed by `process.platform`, each row holding that OS's Node download URL pattern, archive format (`.tar.gz`/`.zip`), and extraction command. The provisioning logic itself (download → extract → `npm ci` → exec) is written once and shared; only the table entries differ. Windows' existing Git-for-Windows prerequisite (for the shell/search tools' Unix binaries) is unaffected and unrelated — this plan does not touch it.

## Scope: this artifact is for Node-absent machines only

This packaged path exists **only** for a machine that does not already have Node.js. A machine that already has Node.js keeps using the existing `git clone && npm install && npm start` developer flow, unchanged — the package is an additional distribution channel for non-technical clients, not a replacement for the dev flow, and not something a machine with Node should bother downloading.

## Client-facing UX (end to end)

1. Client downloads one artifact for their OS (built by CI from this repo — a portable Node binary, the already-installed `node_modules`, the app code, `mcp-hub.config.json`, and a thin launcher stub; **not** the dev tree, no `.git`, no `package.json` install step).
2. First run: double-click the launcher (or run the one command it documents). Everything needed is already inside the archive — the launcher just execs the bundled Node binary against `scripts/start.js`. **No network call, no npm install, happens on the client's machine.**
3. The launcher execs `node scripts/start.js` with any forwarded args — **unchanged from today**: prints the Remote MCP URL / OAuth Client ID+Secret / passphrase, opens the control panel, same OAuth/passphrase confirmation flow.
4. If the client was handed a tunnel by the owner (README § "Someone gave you a tunnel JSON"), they still run with `--tunnel <the-json-they-sent> --origin https://the-subdomain-they-gave-you` — this plan changes nothing about that flow, only what happens *before* it (no separate Node install, no manual `npm install`).

## Code-signing / OS gatekeeping

- **macOS Gatekeeper:** the official nodejs.org macOS builds are already signed/notarized by the Node.js Foundation, so the *downloaded runtime* passes Gatekeeper on its own. The *launcher stub this project ships* would still need an Apple Developer ID ($99/yr) + notarization for a silent double-click-and-run experience; without it, first run shows "unidentified developer" and needs a right-click → Open.
- **Windows SmartScreen:** an unsigned launcher `.exe`/`.bat` is flagged similarly; a code-signing cert (OV is cheaper but needs install-count reputation to build up, EV is pricier but skips that) removes the warning.
- **MVP call:** do not buy certificates yet. Ship unsigned, document the one extra click each OS requires on first run. Revisit only if real client friction shows the extra click is actually a blocker (`proportion.A` — size the control against measured, not assumed, friction).

## Auto-update

The project already has this half-solved: `scripts/update-check.js` + the panel's update banner, and per the 1.6.0 CHANGELOG entry, the mcp branch **already** distinguishes a git checkout ("Pull & restart") from a non-git install ("Download link"). For a packaged/zip-installed client there is no `.git` dir, so it already falls into the "Download" path — that link just needs to point at the packaged-artifact release instead of assuming a git remote, a small follow-up inside the existing mechanism, not a new subsystem.

**Decision for this plan:** reuse the existing check-and-link banner as-is. Do **not** build a silent/automatic self-replacing binary updater (signed-update verification, delta patching, background restart) — that is Electron/Squirrel-scale complexity disproportionate to a single-maintainer CLI tool, and it depends on the code-signing decision above being reversed first anyway. Explicit non-goal.

## Recommended option

**Full pre-bundled package (last row of the table above), built at CI/release time** — not any fusion tool (SEA/`pkg`/`nexe`/Bun compile), not Deno compile, and explicitly **not** an at-runtime installer that downloads Node or runs `npm ci` on the client's machine. The `npm ci` step happens once, on the maintainer's/CI's machine, and its output (`node_modules`) ships inside the archive.

Reasoning, in order of weight:
1. It is the only option that actually removes the real blocker (see above) — the other four solve a cosmetic problem ("one file instead of many") while leaving both spawn-by-path calls needing a real runtime anyway.
2. **Zero install step of any kind at client runtime** — no download, no `npm ci`, no network dependency the first time the client runs it. This was an explicit requirement: a machine without Node.js runs the packaged artifact as-is; it does not "go install npm" even automatically.
3. Zero change to `spawnHub`/`spawnCloudflared`/the process topology — `process.execPath` stays a genuine generic Node binary, so nothing in `start.js`'s existing, working orchestration logic has to change.
4. No new build pipeline beyond the packaging step, no third-party fork dependency (`@yao-pkg/pkg`), no untested compat-layer risk (Bun/Deno) — the lowest ongoing maintenance cost for a single maintainer, per `coding.A2`.
5. Matches the project's own precedent: `docs/plan/done/unify-windows-linux.md` already chose "document a real prerequisite" (Git for Windows) over "reimplement to avoid it" — here, machines that already have Node just keep the normal flow; only Node-absent machines get the heavier bundled artifact.

## Phased rollout

**Phase 1 (MVP-sized, do first):**
- Vendor `@modelcontextprotocol/server-filesystem` as a direct dependency; repoint `mcp-hub.config.json`'s `filesystem` entry away from `npx -y` to the vendored package's resolved path (mirrors `spawnHub()`'s existing `createRequire(...).resolve(...)` pattern for `mcp-hub`). Valuable standalone, before any installer work exists.
- Add an `engines` field to `package.json` (currently absent) pinning the Node LTS version the installer will fetch — the installer needs to know exactly which version to provision anyway.
- Build the packaging script for **one** OS first (whichever the first real non-technical client is on), not all three at once: **at build/CI time** — download a portable Node binary → `npm ci --omit=dev` → bundle Node binary + `node_modules` + app code into one archive with a launcher stub that execs `node scripts/start.js`. Nothing installs or downloads on the client machine; the launcher only extracts (if the archive format needs it) and execs.
- Ship unsigned; document the one first-run Gatekeeper/SmartScreen click for that OS.
- Point the existing `update-check.js` "Download" branch at the packaged release artifact.

**Phase 2 (after Phase 1 proves out):** extend the same data-table-driven launcher to the remaining two OSes — one small table row each (download URL pattern, archive format), never a second implementation of the provisioning logic.

**Phase 3 (explicitly deferred):** code-signing/notarization for a zero-warning double-click experience; any auto-update beyond the existing check-and-link banner; a Bun/Deno migration, if Node itself is ever shown to be the actual limiting factor (it is not, per the analysis above — Node runtime choice isn't the axis this problem lives on).

## Non-goals

- Electron, or any GUI shell — no rendering need exists; the panel is already a browser page.
- Fusing `start.js` into a SEA/`pkg`/`nexe`/Bun-compiled binary — solves a cosmetic problem, not the real one; adds build-pipeline and/or compat risk for no gain.
- Deno migration — same reasoning, plus the least-tested compat path of the four fusion options.
- Code-signing certificates for MVP — real recurring cost for friction that hasn't been measured yet.
- Silent/automatic self-updating binaries — the existing banner-and-link mechanism is sufficient for now.
- Rewriting `spawnHub`/`spawnCloudflared` or any part of the current process topology — the recommended option is chosen specifically so this stays untouched.
- Reimplementing the filesystem MCP server natively — stays scoped to the already-deferred `docs/plan/unify-mcp-tools-single-process.md` Stage 2; this plan only vendors the existing package.
- Supporting arbitrary/every Node version in the provisioned runtime — pin one LTS version via the new `engines` field.

## Cross-references

- `CLAUDE.md` — process topology (start.js/gatekeeper/panel in-process, mcp-hub spawning four in-house tool servers + `npx filesystem`), OS-agnostic-by-decision rule this plan follows
- `README.md` §§ Requirements, Install, Run, Alternative ingress — the existing install/run/tunnel flow this plan's UX section ties back to unchanged
- `scripts/start.js` — `spawnHub`/`spawnCloudflared`/`spawnNode`, the exact call sites the blocker analysis is based on
- `scripts/update-check.js` — existing update-check mechanism reused for the auto-update decision
- `scripts/open-browser.js` — the `LAUNCHER` data-table pattern the per-OS installer table mirrors
- `mcp-hub.config.json` — the `filesystem`/`local` entries Phase 1's vendoring step edits
- `docs/plan/done/unify-windows-linux.md` — the OS-agnostic precedent and the "document a real prerequisite instead of reimplementing" decision this plan follows for Node itself
- `docs/plan/consolidate-mcp-tool-processes.md`, `docs/plan/unify-mcp-tools-single-process.md` — process topology this plan does not alter (Stage 1) or attempt (Stage 2, filesystem-native-rewrite)
- `docs/plan/cloudflare-tunnel-ingress.md` — the `--tunnel`/`PUBLIC_ORIGIN` flow the client UX section ties back to

## Decision

**Shipped.** The recommended option (full pre-bundled package) was implemented in `scripts/build/package.js` (council item I2): it bundles a portable Node binary plus `node_modules` plus app code into a per-OS archive for Node-absent client machines, with `npm ci` running at build/CI time only, never at client runtime. **Known gap, not yet closed:** Windows and Linux archives have not actually been built or tested — only the macOS path is verified. This gap is deferred to the release gate (council item I7), which remains open/blocked pending the owner's release go-ahead.
