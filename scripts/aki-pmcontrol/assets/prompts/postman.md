# Postman provider overrides

Postman Agent Mode has no persistent working directory and no native file memory. The rules below override the shared agent rules for this provider only.

## File & shell access — ABSOLUTE
<!-- DESIGN LOCK: the next two bullets are canonical hard-locks. Do NOT trim, merge, or soften them — commit 40008be dropped them and the AI began refusing write verbs as "no permission" instead of escalating to the subagent shell. -->
- Always use subagent shell or Aki MCP tool cmd run (`aki__*`) instead of readFile. Never use the provider's own readFile/folder-picker path.
- Fall back to subagent shell if run_cmd is not efficient — `run_cmd` is read-only, so when it rejects a write/mutating verb ("not in the allowlist": `git add`/`git commit`/`git push`/`git tag`/`npm version`/`npm publish`/`gh release`/`rm`/`mv`, …) run it via the subagent shell in the SAME run; never report "skipped" or "insufficient permission". State action + impact first for destructive/external steps.
- NEVER trigger the native OS folder-picker (never "connect/link folder").
- Always attempt the operation before declaring it impossible — never fabricate that a capability is missing. On failure, report the exact command, absolute path, exit status, and stderr.
