# Docs index

- [plan/done/init.md](plan/done/init.md) — architecture decisions (mcp-hub + gatekeeper + funnel) and repo bootstrap checklist
- [plan/instruction-prompt-improve.md](plan/instruction-prompt-improve.md) — compact the paste-in instruction prompt under ChatGPT's 1500-char cap (hoist the rules-dir prefix) and add the mandatory survey + `working.md` per-task workflow
- [plan/integrate-gemini-grok.md](plan/integrate-gemini-grok.md) — bring Gemini (Enterprise) + Grok onto the same OAuth+DCR connector: provisional redirect-allowlist prefixes (confirmed on first live connect) + panel walkthroughs
- [plan/integrate-kiro-cli.md](plan/integrate-kiro-cli.md) — Kiro CLI as a second worker arm: separate read-only + write MCP tools (approve write independently), model locked to claude-sonnet-4.5; plus agy effort-enum/model tuning
- [plan/repl-config-tools.md](plan/repl-config-tools.md) — plan to add a persistent-session REPL + get_config (inspired by Desktop Commander), write allowlist (shell) deferred
- [plan/shell-allowlist.md](plan/shell-allowlist.md) — shell-allowlist subsystem: revoke-bug storage format, panel row-list UX, read-only default additions, trusted-dir preallow
- [plan/chrome-tampermonkey-autosetup.md](plan/chrome-tampermonkey-autosetup.md) — auto-detect/point Tampermonkey at the token-counter + widen-UI userscripts on `npm start` (design only, not started)
- [plan/done/unify-windows-linux.md](plan/done/unify-windows-linux.md) — unify the codebase for Windows + Linux (macOS unaffected) and remove Chrome CDP control
- [plan/done/merge-pr1-windows-chatgpt.md](plan/done/merge-pr1-windows-chatgpt.md) — how PR #1 (Windows fixes + ChatGPT connector) is merged onto our OS-agnostic architecture: integration branch, the 7 real conflicts, the 4 files that auto-merge wrong, and how the PR still lands as Merged
- [plan/done/audit-1.1.0-todo.md](plan/done/audit-1.1.0-todo.md) — read-only v1.1.0 audit backlog (ChatGPT blocker, honest shell copy, XSS escape, SSoT dedup); shipped 2026-08-09, now a record
- [plan/done/bridge-session-churn.md](plan/done/bridge-session-churn.md) — flow audit + fix for the mass "client disconnected from MCP HUB" log; the stateless↔stateful session mismatch, and the A/B decision (per-session vs one shared hub session)
- [ref/claude-connector.md](ref/claude-connector.md) — the real fields on claude.ai's "Add custom connector" dialog
- [ref/security-model.md](ref/security-model.md) — the current OAuth 2.1 security model (Claude pre-registered client; ChatGPT self-registers via RFC 7591 DCR, live)
- [ref/oauth-research-2026-08-07.md](ref/oauth-research-2026-08-07.md) — research behind the switch from token-in-URL to OAuth, with dates and sources
- [research/chrome-cdp-default-profile-block.md](research/chrome-cdp-default-profile-block.md) — why `scripts/chrome.js` is being removed: Chrome 136 blocks remote debugging on the default profile
- [research/claude-ai-mcp-session-reinit.md](research/claude-ai-mcp-session-reinit.md) — measured fact: claude.ai re-sends `initialize` with no session id every ~10s (17 hub sessions in 4 min for 3 conversations) — the evidence that forced the single-shared-session bridge
- [research/similar-remote-mcp-projects.md](research/similar-remote-mcp-projects.md) — landscape scan of 11 comparable remote-MCP projects scored against aki-mcp-sv's 5 defining axes (web chat access, subcommand whitelist, rule-ecosystem bundling, edit+shell+smart-search, professional OAuth); no candidate reaches more than 2 of 5
