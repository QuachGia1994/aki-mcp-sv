# Standalone release delivery for Node-absent users

## Status

Steps 1, 2, 3, 4, and 6 of the "Required implementation sequence" are implemented (commits `9a07fb4`, `b39e0e7`, `209ebf8`): network-free filesystem-server invocation, the payload+launcher builder, the tag-triggered release workflow, the multi-OS bootstrap smoke test, and the release-gate script that checksum-verifies assets against the real uploaded release before publish.

**Step 5 (README/CHANGELOG public copy) is still blocked, by design.** It requires an actual tagged release to run through the new workflow and land real assets on GitHub — that is an external, hard-to-reverse action (pushing a release tag) outside a subagent's authority, not something left undone by oversight. Next action to close this plan: cut a real release tag, let the workflow run end to end, confirm via `gh release view <version> --json assets` that all 6 assets are present and checksums match, then write the README/CHANGELOG copy against that confirmed reality. Do not move this plan to `done/` until that's done.

This plan supersedes the distribution-status claim in `docs/plan/done/standalone-packaging.md`: the builder existed, but no standalone asset was attached to releases 1.8.0 or 1.8.1. That completed-plan record remains immutable; this plan is the source of truth for the release path until step 5 closes.

**Step 1's "network-free at runtime" claim had a gap, now fixed.** It only held for fresh installs: `scripts/userdata.js`'s live-config reconciliation never migrated an existing `filesystem` server entry's launch shape, so any pre-existing (upgrade) install kept the old `npx -y` invocation, and pressing "Apply to file tools" on it produced a broken hybrid command that killed the filesystem MCP server. Found and fixed during `panel-ux-improve`'s runtime verification (2026-08-16) — reconciliation now self-heals the launch shape via `splitLaunchArgs()`, shared with `scripts/panel.js`. No action needed here; noted so step 5's copy doesn't repeat the unqualified claim.

## Goal

The next patch release provides a visible, per-OS bootstrap package on its GitHub Release. A person without Node.js downloads one file for macOS, Windows, or Linux, opens/runs it, and the app starts without cloning a repository, installing Node/npm, or running `npm install`.

Developer flow remains `git clone && npm install && npm start`.

## Decision

Ship a small, versioned bootstrap launcher per OS. On its first run it downloads and checksum-verifies:

1. The official Node 22.14.0 portable runtime for its OS and architecture.
2. The release's prebuilt production app payload: application files plus `node_modules`, built by CI with `npm ci --omit=dev`.

It installs both under one user-owned application directory, then starts the bundled Node against `scripts/start.js`. Later runs reuse the verified local installation. The launcher never runs npm or npx on the client.

| OS | Release asset | First-run action | User action |
|---|---|---|---|
| macOS Apple Silicon / Intel | `aki-mcp-sv-<version>-macos.command` | Download/extract matching official Node archive and app payload | Double-click; macOS may require right-click → Open once because it is unsigned |
| Windows x64 | `aki-mcp-sv-<version>-windows.cmd` | PowerShell downloads/extracts matching Node zip and app payload | Double-click; SmartScreen may require More info → Run anyway because it is unsigned |
| Linux x64 | `aki-mcp-sv-<version>-linux.run` | Download/extract matching official Node archive and app payload | Mark executable once, then run it |

The first run needs internet and writable user storage. This is intentional: it removes the permanent download size and release-upload failure risk of embedding a full Node runtime in every artifact while preserving the no-Node/no-npm user flow. Existing prerequisites remain unchanged: Tailscale for Funnel mode, or `cloudflared` for named-tunnel mode; Windows also still needs Git for Windows for the Unix command tools.

## Why this instead of a fused single executable

| Option | Decision | Reason |
|---|---|---|
| Node SEA / `pkg` / `nexe` / Bun / Deno executable | Reject now | `start.js` launches `mcp-hub` through `process.execPath`, and the current filesystem server launches through `npx`. A fused executable cannot act as a general Node runtime for those child scripts. Solving that requires a runtime/process-topology refactor, not a release-sized patch. |
| Full Node runtime archive per OS | Reject for this patch | It works technically, but releases 1.8.0 and 1.8.1 proved the operational failure mode: artifacts were never built/uploaded. Three 40–50 MB archives raise release friction without improving first-run UX enough to justify it. |
| Custom `.app`, `.msi`, `.exe`, or AppImage | Defer | Better OS-native presentation, but introduces platform-specific packaging and signing maintenance. It does not remove the need to provision Node and app files. |
| Bootstrap launcher + verified runtime/payload | Choose | One visible file per OS, no Node/npm work for the user, one shared app payload, no `mcp-hub` fork, and a small release workflow that can be mechanically gated. |

## Delivery shape

### Release assets

Every release that advertises Node-less installation must contain all of these assets before it is published:

- `aki-mcp-sv-<version>-app.tar.gz` and `aki-mcp-sv-<version>-app.zip`, containing only `scripts/`, `mcp-hub.config.json`, `package.json`, `LICENSE`, direct production dependencies, and the vendored filesystem server dependency.
- `aki-mcp-sv-<version>-macos.command`.
- `aki-mcp-sv-<version>-windows.cmd`.
- `aki-mcp-sv-<version>-linux.run`.
- `SHA256SUMS`, covering every project asset.

The app payload is platform-neutral only while the dependency scan finds no native files (`*.node`, `*.dylib`, `*.so`, `*.dll`). CI must fail rather than falsely reuse it when that assumption stops being true. If a native dependency is introduced, the workflow changes to one app payload per target; the launcher contract stays the same.

### Installation layout

Use platform-normal per-user application data locations:

| OS | Root |
|---|---|
| macOS | `~/Library/Application Support/aki-mcp-sv/` |
| Windows | `%LOCALAPPDATA%\\aki-mcp-sv\\` |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/aki-mcp-sv/` |

Within the root, keep `runtime/<node-version>/<target>/` and `app/<app-version>/`. Extract to a sibling temporary directory, verify checksums before activation, then atomically rename into place. A failed download/extract must leave the prior working version intact.

The launchers embed four immutable values generated from the release build: app version, target-specific Node URL, Node SHA-256, app-payload URL and SHA-256. Do not fetch an unpinned `latest` manifest at startup. A checksum mismatch stops with a clear error and no execution.

### Runtime prerequisites and exact behavior

- macOS/Linux launcher requires POSIX `sh`, `curl`, `tar`, and a standard checksum command. These are present on supported stock systems; test the exact commands on CI runners.
- Windows launcher uses built-in PowerShell, `Invoke-WebRequest`, `Get-FileHash`, and `Expand-Archive`; do not require Node, npm, Git, WSL, Chocolatey, or a third-party installer for bootstrap.
- Node archive URLs and hashes come from the pinned official Node release, currently `https://nodejs.org/dist/v22.14.0/`. Do not use a Node installer (`.pkg`/`.msi`) or mutate system-wide PATH.
- The bundled runtime is a real Node binary, so `spawnHub()` remains valid. No attempt is made to trim `bin/` or `lib/`: Node's runtime files are an opaque supported unit. Only documented non-runtime files (`include`, `share`, Node's top-level docs) may be excluded if an offline bundle is ever revived.

## Required implementation sequence

1. **Make the payload network-free at runtime.** Add `@modelcontextprotocol/server-filesystem` as a direct production dependency. Replace `mcp-hub.config.json`'s `npx -y @modelcontextprotocol/server-filesystem` command with a direct invocation through the bundled Node runtime and the resolved package entry point. Verify first filesystem-tool use with the network disabled after installation.
2. **Replace the current archive builder with payload and launcher builders.** Retain one Node-target data table. The builder creates the preinstalled production payload, scans it for native files, writes deterministic archives plus `SHA256SUMS`, and renders the three launchers from templates with pinned URLs/hashes.
3. **Add a release workflow, not only a local build command.** On a deliberate release tag, CI builds the payload/launchers, performs target-specific syntax/content checks, creates or updates a draft GitHub Release, uploads every asset, lists release assets through `gh`, and publishes only after the required-asset gate passes.
4. **Add bootstrap smoke tests on macOS, Windows, and Linux runners.** Each test starts with no Node on PATH, serves or uses the built release inputs, runs its OS launcher into a temporary user-data root, asserts the private Node binary exists, and invokes `--version`/a non-network startup check. The first real release additionally performs a manual end-to-end startup on each OS; Tailscale/OAuth/browser flow remains runtime verification, not a CI claim.
5. **Change public copy only after assets exist.** README names the three launchers, says first run downloads the runtime, lists unchanged external prerequisites, and links the release. CHANGELOG says “bootstrap packages attached to the release” only after the asset gate and release inspection pass. Do not use “standalone” to mean a builder script or an unuploaded `dist/` file.
6. **Release gate.** Before publish, require `gh release view <version> --json assets` to contain the six required assets; download and checksum one asset per OS from the actual release URL. If any is missing, leave the release draft/unpublished and omit the Node-less-installation claim.

## Acceptance criteria for the next patch release

- GitHub Release shows all six required assets before publication.
- A clean macOS Apple Silicon, Windows x64, and Linux x64 machine without Node can run its corresponding launcher without `npm install` or a repository checkout.
- First run downloads only pinned, SHA-256-verified content and subsequent runs do not download again unless the user selects a new release launcher.
- The app can launch `mcp-hub` and the filesystem tool without `npx`, npm registry access, or a system Node runtime.
- Existing developer install/run instructions still work unchanged.
- README, CHANGELOG, and the GitHub Release all describe the actual bootstrap behavior and remaining Tailscale/cloudflared/Git-for-Windows prerequisites.

## Risks and stop conditions

| Risk | Handling |
|---|---|
| Corporate proxy/offline user blocks first download | Explain first-run internet requirement before download; offer a future offline full bundle only after demand is measured. Do not claim offline support. |
| Apple Gatekeeper or Windows SmartScreen blocks an unsigned launcher | Document the OS-native override path. Signing is a separate measured-friction decision, not a reason to ship no artifact. |
| Native dependency makes one payload invalid across OSes | CI native-file scan fails; produce per-target payloads before release instead of silently shipping an invalid shared archive. |
| Bootstrap runs while an older app instance is active | Install versioned directories; never overwrite the active version in place. |
| Release assets are missing again | Required-asset gate blocks publication and blocks documentation/release claims. This is the root operational control. |

## Non-goals

- Refactor `mcp-hub` into this process or remove the existing four-process topology.
- Promise a literal fused executable for every OS.
- Install Node system-wide or change the user's PATH.
- Code-sign/notarize this patch release.
- Build automatic self-updating or delta-patching.
- Support unsupported CPU targets before a real user needs them.

## Verification record to add during implementation

Record the exact target, runner, launcher asset hash, installation root, Node-private-binary check, and whether full OAuth/Tailscale verification was run. A green archive build alone is not verification of a client installation.

## Cross-references

- `scripts/start.js` — `spawnHub()` depends on a generic Node runtime.
- `mcp-hub.config.json` — current `npx` filesystem-server dependency to remove.
- `docs/plan/done/unify-mcp-tools-single-process.md` — deferred process-topology work, explicitly out of scope.
- `docs/plan/done/standalone-packaging.md` — prior builder decision and the release-assets gap this plan corrects.
- `README.md` — public install instructions to update only once the assets are real.
