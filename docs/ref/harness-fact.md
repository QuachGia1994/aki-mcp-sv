# AGY CLI arm harness facts

Facts the current local AGY arm (`scripts/agy-mcp.js`) depends on. Each fact is version-bound and should be re-verified after a CLI upgrade.

- **[obs]** — observed by running the CLI on this machine. True-until-contradicted; re-verify before relying on a changed version.
- **[owner]** — supplied by the owner or upstream docs but not runnable here. A rule leaning on it must carry a verification step.

If a fact changes, revisit the code that encodes it rather than patching around it.

## agy (Antigravity CLI) — `scripts/agy-mcp.js`

| Fact | Checked | Where it is encoded |
|---|---|---|
| `-p`/`--print` takes the prompt as its value, so it must be the last arg; anything after it is swallowed into the prompt instead of parsed as a flag. | 2026-08-09 | `agy-mcp.js` builds flags first and appends `-p` last. |
| `--effort` accepts `low`, `medium`, `high`. | 2026-08-09 | `agy-mcp.js` effort schema. |
| `--mode plan` is read-only by mechanism and is the only mode enabled by default; other modes require `setting.json → agy.allowedModes`. | 2026-08-09 | `agy-mcp.js` mode allowlist. |
| Valid model ids include `gemini-3.7-flash-{low,medium,high}`, `gemini-3.6-flash-{low,medium,high}`, `gemini-3.5-flash-{low,medium,high}`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium`. | 2026-08-15 | `agy-mcp.js` model description. |
| `gemini-3.7-flash-high` is available and accepts a headless `--mode plan` call; this fork intentionally keeps it as the default discovery tier. | 2026-08-31 | `agy-mcp.js` default model and `buildAgyArgs()`. |
| AGY writes some errors to stdout and a denied action can exit 0 with empty output. Empty stdout is therefore inconclusive and must be returned as an error, never as a successful empty result. | 2026-08-09 | `agy-mcp.js` output classification. |
| AGY's workspace index can resolve paths outside `cwd`, so prompts must name exact paths; `cwd` alone is not a hard scope boundary. | 2026-08-09 | `agy_run` tool description. |

## Retired worker arms

OpenCode and Kiro were removed from Aki MCP by owner decision on 2026-09-10. Their old operational facts are no longer current runtime guidance; historical integration/removal records remain in released CHANGELOG entries and `docs/plan/done/`.