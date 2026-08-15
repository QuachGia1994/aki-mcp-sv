# Docs drift audit, 2026-08-15

**Start time**: 2026-08-15, immediately after the 1.8.0 release (tree clean, `9b43b27` pushed and tagged): the stable-baseline moment `docs.C1` calls for.

**Initial purpose**: Full `docs/*` topology walk against the repo as it stood at 1.8.0, per `docs.C3` (index completeness, plan lifecycle, anchor stamps, ref accuracy, inverse code-to-docs check). No specific complaint triggered this; a routine post-release audit.

**Strategy**: Walk each topic folder against `docs.C3`'s checklist; cross-check every claim against the actual code/git state (`docs.C1` requires reading current source, not trusting doc prose). Severity-classified per `docs.C4`.

**Checklist**:
- `docs/index.md`: every entry resolves; every existing doc is listed (A1)
- `docs/plan/`: any active plan whose work already shipped (B1)
- `docs/feat/`: anchor stamp present (A4); described behavior still matches code
- `docs/ref/`: commands/claims still hold against current code
- `docs/research/`: supersede-chain integrity (B2)
- `docs/.DS_Store`: untracked macOS artifact, checked against `.gitignore`

**Result**:

| Finding | Severity | Evidence |
|---|---|---|
| `docs/ref/claude-connector.md` "Current decision" paragraph claims DCR is skipped by "not advertising `registration_endpoint`" | **Wrong** | `scripts/oauth.js:137` advertises `registration_endpoint` unconditionally (added for the ChatGPT DCR path, `docs/plan/done/merge-pr1-windows-chatgpt.md`); a reader would conclude DCR is off when it is live for ChatGPT |
| `docs/plan/consolidate-mcp-tool-processes.md` Status still reads "Runtime verification ... pending" | **Stale** | Shipped in 1.5.0 (`98e00d8`, 2026-08-11) and has been in continuous live use for 4 releases since; `local__*` tools have been called dozens of times in the current session alone |
| `docs/feat/tools.md` has no `docs.A4` anchor stamp | **Incomplete** | `feat/` is a stamped folder; file has no `updated <date> · v<version>` line |
| `docs/plan/panel-ux-improve.md` exists but is absent from `docs/index.md` | **Incomplete** | `find docs -type f` lists it; not among the 36 index entries (A1: "nothing that exists is missing from it") |
| `docs/research/akiflow-council-v018-ingress-standalone-env.md` also absent from `docs/index.md` | **Incomplete** | same check as above |
| `docs/index.md` lists `plan/unify-mcp-tools-single-process.md` twice (two different one-line summaries) | **Cosmetic** | index lines 15 and 26 in the pre-fix file |

**Verification**: Every row cross-checked against source, not doc prose: `grep registration_endpoint scripts/oauth.js`, `git log --diff-filter=A -- scripts/local-tools-mcp.js` plus release tag history, `find docs -type f` diffed against index entries. `docs/.DS_Store` is untracked (`git ls-files` empty) and already covered by the repo's `.gitignore`; no action needed.

**Decision**: **Action**, fixed directly in this same session (scope small enough that a separate scheduling `plan/` doc would add no value beyond this record, per `pattern.B3`'s subtract-first gate):
- `docs/ref/claude-connector.md`: "Current decision" paragraph corrected to state DCR is now advertised (for ChatGPT), Claude still uses the pre-issued path.
- `docs/plan/consolidate-mcp-tool-processes.md`: moved to `docs/plan/done/`, Status corrected to shipped and verified.
- `docs/feat/tools.md`: anchor stamp added.
- `docs/index.md`: `panel-ux-improve.md` and `akiflow-council-v018-ingress-standalone-env.md` entries added; duplicate `unify-mcp-tools-single-process.md` entry removed; consolidate-mcp-tool-processes.md entry repointed to `plan/done/`.

**Cross-references**: `docs/index.md`, `docs/ref/claude-connector.md`, `docs/plan/done/consolidate-mcp-tool-processes.md`, `docs/feat/tools.md`, `CHANGELOG.md` [1.8.1].

**Out of scope, flagged not fixed**: a repo-wide grep found em/en dash used as the default clause separator across nearly every doc in `docs/*` and `README.md` (roughly 1000+ occurrences, `docs/index.md`'s own link-separator convention included). Most of that text lives in `docs/plan/done/` and `docs/research/`, both immutable by `release.B3`/`docs.B2`, so a mechanical repo-wide rewrite would violate immutability and is disproportionate to a routine drift audit (`agent.B3`: large rewrites need explicit go-ahead). This audit only kept its own new/edited content dash-free; the pre-existing corpus is unaddressed and recorded here for a deliberate decision rather than silent inaction.
