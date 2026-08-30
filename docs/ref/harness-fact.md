# CLI arm harness facts — agy & kiro

Facts the two "arm" MCPs (`scripts/agy-mcp.js`, `scripts/kiro-mcp.js`) depend on. Each is marked and dated, because all of it is version-bound and expected to rot. Style borrowed from akidevrule's `references/harness-facts.md`, scoped to what *this* repo actually invokes.

- **[obs]** — observed here by running the CLI on this machine. True-until-contradicted; re-verify before relying on a detail.
- **[owner]** — supplied by the owner / upstream docs, not runnable here. Weakest tier: a rule leaning on it must carry a verification step.

If a fact changes, revisit the code that encodes it rather than patching around it.

## agy (Antigravity CLI) — `scripts/agy-mcp.js`

Fully runnable on this machine; facts are [obs] unless noted.

| Fact | Checked | Where it is encoded |
|---|---|---|
| `-p`/`--print` takes the prompt as its **value**, so it must be the **last** arg — anything after it is swallowed into the prompt, not parsed as a flag, and the call returns a confident, unrelated answer with no error. | 2026-08-09 | `agy-mcp.js:74` pushes `-p` last, after `--mode`/`--model`/`--effort`/`--output-format`. |
| `--effort` accepts **`low`, `medium`, `high`** only. Live `agy --help` rejects `xhigh`/`max` (those exist for kiro, not agy — do not copy one CLI's enum onto the other). | 2026-08-09 | `agy-mcp.js:53` `z.enum(['low','medium','high'])`. |
| `--mode plan` is read-only **by mechanism**, not by prompt wording. It is the only mode enabled by default; others must be opted in via `setting.json → agy.allowedModes`. | 2026-08-09 | `agy-mcp.js:12,59-63` (`DEFAULT_MODES=['plan']`, allowlist gate). |
| Valid `--model` ids: `gemini-3.7-flash-{low,medium,high}`, `gemini-3.6-flash-{low,medium,high}`, `gemini-3.5-flash-{low,medium,high}`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. Note the Claude ids use a **hyphen** minor (`-4-6`), not a dot — a different convention from kiro's `claude-sonnet-4.5`. | 2026-08-15 | `agy-mcp.js:11,48` (default is now `gemini-3.7-flash-medium`; ids in the `model` describe). |
| `gemini-3.7-flash-high` is available and accepts a headless `--mode plan` call. akidevrule designates it the default discovery tier, superseding `gemini-3.6-flash-medium`; this arm now defaults to `gemini-3.7-flash-medium` (changed 2026-08-17). | 2026-08-15 | `agy-mcp.js:11` hard-locks the current default; `agy-mcp.js:64-67` constructs the smoke-tested headless invocation. |
| agy writes its **own errors to stdout**, not stderr; a denied action still exits 0 with an **empty** response. Empty stdout is inconclusive (possible silent denial), never a clean empty result. | 2026-08-09 | `agy-mcp.js:24-31` checks `stdout` first, treats empty as `err`. |
| agy's global workspace index resolves paths **outside `cwd`**, so `cwd` is not a hard scope boundary — the prompt must name exact paths. | 2026-08-09 | Documented in the `agy_run` tool description (`agy-mcp.js:46-48`). |

## kiro (kiro-cli 2.16.2) — `scripts/kiro-mcp.js`

Installed at `~/.local/bin/kiro-cli`; every row below was run-verified on this machine 2026-08-09, so all are **[obs]**. Still version-bound — re-check after a kiro-cli upgrade.

| Fact | Checked | Where it is encoded |
|---|---|---|
| Headless invocation is `kiro-cli chat --no-interactive <prompt>`, prompt passed as a separate `execFile` arg (no shell tokenizing). `--list-models` and `--effort` are `chat` subflags, not top-level. | 2026-08-09 | `kiro-mcp.js:20-22` |
| Tool grant is set by `--trust-tools=fs_read` (read-only); `--trust-tools=` (empty) trusts nothing. `kiro_write` (`fs_read,fs_write`) was removed 2026-08-10 — redundant with the `filesystem` MCP arm's `write_file`/`edit_file` (`docs/plan/done/remove-kiro-write.md`). Flag name confirmed verbatim in `chat --help`. | 2026-08-09 | `kiro-mcp.js:41` (single `registerTool`) |
| Model is hard-locked to `claude-sonnet-4.5` (dot-minor form) — confirmed a real id in `chat --list-models` (1.30x credits). Note this is genuinely different from agy's `claude-sonnet-4-6`; the two CLIs use different conventions, so neither literal is portable to the other. Not a tool parameter, so a prompt cannot escalate tier. | 2026-08-09 | `kiro-mcp.js:12` `const MODEL` |
| `--effort` accepts `low\|medium\|high\|xhigh\|max` — confirmed in `chat --help` (`e.g. low, medium, high, xhigh, max`). Unlike agy (`low\|medium\|high` only), kiro's full range is real. | 2026-08-09 | `kiro-mcp.js:39` `effortSchema` |
| A missing binary or denied action must fail loud, never fabricate output. Empty stdout is reported as a possible silent denial. | 2026-08-09 | `kiro-mcp.js:25-31` — ENOENT → `err`, empty stdout → `err`. |

## Why this file exists

The 1.2.0 release shipped agy tuning verified against live `--help` **and** a kiro arm whose literals came from upstream docs the same release proved unreliable elsewhere (agy's `--effort` docs said `xhigh|max`; live output said otherwise). The evidence-tier split kept the then-unverified kiro literals from reading as settled fact and carried the exact promotion command. On 2026-08-09 `kiro-cli` 2.16.2 was installed here and every kiro row was promoted `[owner]→[obs]`; the split now records that history and stays the discipline for the next unverified arm. On 2026-08-15 the akidevrule source re-probed `agy models` and the `gemini-3.7-flash-*` family was confirmed live on this machine too (`[obs]`); the new default-tier fact is carried as its own row, not folded into the model-list row, so the "what is available" vs "what is the default" distinction stays explicit until `DEFAULT_MODEL` in `agy-mcp.js` is actually changed.
