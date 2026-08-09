# Persistent-session REPL + get_config — extending process-mcp

## Goal
Add the ability to run persistent interactive sessions (Python/Node REPL...) and auto-detect the environment (OS/shell/Python-Node version), inspired by Desktop Commander (`start_process` / `interact_with_process` / `read_process_output`, `get_config`) — **without** changing the existing safety philosophy (whitelist instead of blocklist, no real shell, every request still goes through the single gatekeeper port).

**Out of scope (c):** adding *write* commands (`git commit`, `npm install`...). The read-only allowlist can already be extended via `~/.aki/mcpsv/setting.json` → `shell.allowlist`, but the defaults stay read-only; adding write commands there crosses boundary (c) and needs its own security plan.

## Mandatory constraints
- No new port, no change to the existing `gatekeeper → mcp-hub` architecture — the new server still spawns over stdio, folded into `mcp-hub.config.json` alongside the 2 existing servers.
- No real shell (`/bin/sh`) to launch processes — use `spawn(bin, args)` directly, keeping the same principle already applied to `execFile` in `shell-mcp.js`.
- REPL binary whitelist is **separate** from `ALLOWED` (the read whitelist) — don't share a set, to avoid one command accidentally landing in both permission groups.
- No idle-timeout auto-kill — the main point of this feature is keeping a session alive for remote coding, so a REPL stays up until the user (or another Claude session) explicitly calls `kill_process`, or the machine/server itself restarts.
- Cap the number of concurrent processes — avoid unbounded session sprawl, especially from remote access that isn't closely monitored in real time.

## Architecture decisions

| Issue | Decision | Why |
|---|---|---|
| New file vs. extend `shell-mcp.js` | New file `scripts/process-mcp.js`, its own entry in `mcp-hub.config.json` | Keeps `shell-mcp.js`'s name and meaning accurate as "read-only" — don't mix a live process (which can accept arbitrary input) into the same file/tool. Matches the existing convention of one file per concern (`oauth.js`, `gatekeeper.js`, `streamable-bridge.js`) |
| Mechanism to keep a process alive | `child_process.spawn`, stored in a `Map<pid, ChildProcess>` in `process-mcp.js`'s own process memory | Same mechanism as Desktop Commander's 3 REPL tools — needs state across multiple tool calls; `execFile` can't do this since it exits when done and doesn't keep stdin open |
| New tools | `start_process(command)`, `interact_with_process(pid, input)`, `read_process_output(pid)`, `kill_process(pid)` | Minimum needed to drive a REPL. No `list_processes` in the first version — single user, few concurrent sessions, add later if needed |
| REPL launch binary whitelist | Its own small set to start: `python3 -i`, `node -i` (exact string match, no extra flags/args accepted from input) | Borrows DC's REPL support without copying its "run any command" philosophy — every binary added later must be considered individually, no automatic expansion |
| Concurrency limit | Max 3 live processes at once, beyond that `start_process` is refused with a clear message | Single-user MVP, doesn't need many; a low limit reduces risk if abused |
| `get_config` | New tool, read-only, returns JSON `{platform, shell, pythonVersion, nodeVersion, repoRoot}` — `repoRoot` comes from `process.cwd()` at run time, not hardcoded | Cheap, near-zero risk. `repoRoot` is bundled in because it's the only reliable channel for another Claude session to locate the repo itself — see "the `instructions` field — why not used" below; neither README nor the `instructions` field is used for this |

## The `instructions` field — why it's not used

The MCP spec has an `instructions` field on the `initialize` response (designed to inject background context into the system prompt), and the SDK supports it. But **`mcp-hub@4.2.1` doesn't forward** `instructions` from child servers to the client — anything set in `shell-mcp.js` is blocked at the aggregation layer. Even Claude Desktop doesn't read this field yet (`anthropics/claude-code#43749`).

**Decision:** push context into each tool's `description` instead — the one channel every client is guaranteed to read (via `tools/list`).

## Permissions — decisions

| Issue | Decision | Mechanism |
|---|---|---|
| REPL whitelist | `python3 -i`, `node -i` — exact fixed-string match, no arbitrary arg parsing | in `process-mcp.js` code, different from how `shell-mcp.js` parses argv for read commands |
| Concurrency limit | 3 processes, checked against `Map.size` before spawning a new one | in `process-mcp.js` |
| Output buffering | Same cap style as the existing shell tool (~1MB), truncated with a clear note if exceeded | prevents one process printing without bound from ballooning memory |

## Execution checklist
- [ ] `scripts/process-mcp.js` — `start_process`, `interact_with_process`, `read_process_output`, `kill_process`, `get_config`
- [ ] Add a `process` entry to `mcp-hub.config.json`
- [ ] 3-process concurrency limit
- [ ] Local test: open `python3 -i`, send a command, read the result; leave idle for a long stretch and confirm it's still reachable; open a 4th process → rejected; `kill_process` actually terminates it
- [ ] Test through real claude.ai (same way `shell__run_cmd` was verified) — confirm the new tools appear in `tools/list`
- [ ] Update `README.md` (architecture section + tool list) once verified

## Out of scope (later)
- (c) Extending `shell-mcp.js` with write capability (e.g. `git commit`, `npm install`) — belongs to the shell group, changes the current "read-only" philosophy, needs its own security plan.
- Reading structured files (docx/xlsx/pdf) — lower value for the current use case, not needed yet.

## Cross-references
- `docs/plan/done/init.md` — original architecture decisions (mcp-hub + gatekeeper + funnel)
- `docs/ref/security-model.md` — current OAuth security model, unchanged by this doc
- `README.md` — setup; the repo location is printed by the panel itself from `process.cwd()`, so the repo can live anywhere

## Decision
**Action** → build `scripts/process-mcp.js` per the table above, add an entry to `mcp-hub.config.json`, don't touch `shell-mcp.js` yet.
