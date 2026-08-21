# Standalone newbie UX follow-ups

> status: done · 2026-08-16

Sequences the two findings left open by `docs/research/standalone-newbie-user-flow-audit-aug16.md` (items 13, 15). Everything else that audit found is already fixed.

## 1. README structure — theory before install (finding 13)

**Status: done, 2026-08-16.** Owner gave explicit go-ahead ("cứ xử lý đi chứ hỏi gì") and specified the method: two `agy` models (`gemini-3.1-pro-high`, `gemini-3.7-flash-high`) hold a pinned, verify-before-trust discussion (per `agent.A5`/`agent.B2`) to draft and cross-check the rewrite before it lands.

**What shipped — a variant of Option A, broader than the original two options below.** `## Install` now follows the value pitch (Why this exists / When to use) directly; `Requirements` / `Architecture` / `Directory layout` moved down as reference material after the connector steps; `Run` no longer tells standalone users to "skip ahead" past context they need; `Connecting from Grok and Gemini` reordered Grok-first with Gemini explicitly labeled experimental (matching the tool-reliability caveat already in the file); `Connector icon` and `How this differs from Desktop Commander` relocated to the sections they're actually about (Claude-web connecting, Security). Round 1 (`3.1-pro-high`) drafted; Round 2 (`3.7-flash-high`) independently re-read the real README and caught a factual error in round 1's draft (wrong claim about the launcher's extraction path) before the final version was applied — logged as the reason this process, not a single-pass rewrite, was used. Full prompts/outputs were scratch files, not persisted (the resulting diff in `README.md`/`CHANGELOG.md` is the durable record, per `agent.C2`).

~~**Option A — move Install earlier, leave theory intact below it.**~~ ~~**Option B — add a top-of-file "Quick start" callout.**~~ Superseded by the broader restructure above; kept here only as the original framing this decision started from.

## 2. Tailscale Funnel desync — error surfaces on claude.ai with no pointer back (finding 15)

**Status: filed as a known limitation. No action scheduled.**

The fix (a hint inside claude.ai's own connection-failure UI) is outside this repo's control — claude.ai is Anthropic's surface, not this project's. `README.md:192-199` already documents the diagnosis and fix for the desync itself; the gap is only that a newbie hitting it via claude.ai has no way to discover that section at the moment of failure. No further doc change closes this gap. Revisit only if claude.ai's connector UI ever supports custom error-help links, or if the connector's own error response body is ever shown to the user (currently it is not, per `docs/research/claude-ai-oauth-connector.md`).
