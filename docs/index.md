# Docs index

- [plan/init.md](plan/init.md) — architecture decisions (mcp-hub + gatekeeper + funnel) and repo bootstrap checklist
- [plan/repl-config-tools.md](plan/repl-config-tools.md) — plan to add a persistent-session REPL + get_config (inspired by Desktop Commander), write allowlist (shell) deferred
- [plan/unify-windows-linux.md](plan/unify-windows-linux.md) — plan to unify the codebase for Windows + Linux (macOS unaffected) and remove Chrome CDP control
- [plan/bridge-session-churn.md](plan/bridge-session-churn.md) — flow audit + fix for the mass "client disconnected from MCP HUB" log; the stateless↔stateful session mismatch, and the A/B decision (per-session vs one shared hub session)
- [ref/claude-connector.md](ref/claude-connector.md) — the real fields on claude.ai's "Add custom connector" dialog
- [ref/security-model.md](ref/security-model.md) — the current minimal OAuth 2.1 security model (DCR skipped)
- [ref/oauth-research-2026-08-07.md](ref/oauth-research-2026-08-07.md) — research behind the switch from token-in-URL to OAuth, with dates and sources
- [research/chrome-cdp-default-profile-block.md](research/chrome-cdp-default-profile-block.md) — why `scripts/chrome.js` is being removed: Chrome 136 blocks remote debugging on the default profile
- [research/claude-ai-mcp-session-reinit.md](research/claude-ai-mcp-session-reinit.md) — measured fact: claude.ai re-sends `initialize` with no session id every ~10s (17 hub sessions in 4 min for 3 conversations) — the evidence that forced the single-shared-session bridge
