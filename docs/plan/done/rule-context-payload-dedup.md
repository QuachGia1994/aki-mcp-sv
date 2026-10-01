# Stop the rule-context tool serializing the corpus twice

> DONE 2026-09-30 (v2.1.0). Fix landed in `scripts/rule-context-mcp.js` (success + error branches); regression assertion added in `test/rule-context-mcp.test.js`; full `npm run test` green (21/21 files).

## Problem

`akidevrule_context`'s handler returns the assembled corpus **twice** in one MCP result:

- `scripts/rule-context-mcp.js:28` — `content: [{ type:'text', text: header + result.context }]` **and** `structuredContent: result`, where `result.context` (`scripts/rule-context.js:184-191`) is the same joined blob (~90 KB this session).
- Measured wire payload ≈ 178 KB — the ~90 KB string counted once in `content[0].text` and again in `structuredContent.context`.

Origin, not regression: the line is present in the file-creation commit `6ea9462` (`git log --diff-filter=A --follow` and `git log -S "structuredContent: result"` both point only there).

## Decisions

- **`content` carries the human-readable rules; `structuredContent` is provenance/metadata only** (`status, parity, receipt, rulesVersion, workingRoot, sources, warnings`, `audit` when present). The corpus text ships once, via `content`.
- **Drop `context` from `structuredContent`, in both the success and error branches**, so the envelope contract is uniform (error already carried only `context: ''`).
- **No `outputSchema` is added here.** Per MCP spec `structuredContent` is optional and does not require an `outputSchema`; the SHOULD-mirror-for-compat guidance means serialized JSON in a text block, which this handler never did (its text is `header + context`, not `JSON.stringify(result)`). Adding a schema is separate, larger work — out of scope.
- **Wire-only claim.** The fix halves the JSON-RPC payload for this tool. Whether it also cuts model-window tokens is host-dependent and **not** claimed: in this very session the host condensed the response, so the model window never received 2×90 KB. Assumption stated, not asserted as fact.

## Blast radius — verified

| Consumer | Reads | Affected by dropping `structuredContent.context`? |
|---|---|---|
| `test/rule-context-mcp.test.js:18,26` | `structuredContent.status` only | No |
| `test/rule-context.test.js:36-53` | `.context` on `assembleRuleContext()`'s **direct return**, not the MCP envelope | No — `assembleRuleContext` return shape is unchanged |
| repo grep (`scripts/`, `test/`, `public/`) | no reader of `structuredContent.context` | No |
| `docs/arch/rule-context-delivery.md` | describes "provenance + receipt + assembled Markdown"; never the `structuredContent` JSON shape | No — Markdown still ships via `content`; receipt + sources stay in `structuredContent` |

Isolated to this one handler: `structuredContent` appears in no other `scripts/*` tool.

## Checklist

- [x] Success branch (`scripts/rule-context-mcp.js`): destructure `const { context, ...meta } = result;` — build the text from `context`, return `structuredContent: meta`
- [x] Error branch: drop `context: ''` from the error `result` so `structuredContent` never carries `context`
- [x] `npm run test` green (esp. `test/rule-context-mcp.test.js` + `test/rule-context.test.js`)
- [x] Sanity: `content[0].text` still equals `header + "\n\n" + context`; `structuredContent` no longer contains a `context` key (asserted in test)
- [x] `docs/index.md` entry added; this plan moved to `docs/plan/done/` with a `> DONE <date> (<version>)` marker

## Verification

Static + automated tier is sufficient (no runtime/UX judgment needed):
- `npm test` proves the handler contract and the assembler return shape.
- A one-shot handler call in the test asserting `!('context' in output.structuredContent)` confirms the drop.

## Open, not done

- **`outputSchema` for the tool** — declaring one (and validating `structuredContent`) is a real improvement but separate scope; deferred.
- **Model-token accounting** — quantifying host-side prompt inclusion is out of this repo's reach; left as a host-dependent note above.
