---
name: aki-browser
description: Route live/current web research, website audits, deploy verification, and visual web comparisons to the current host's native browser/web tools first, while keeping Aki MCP for local repo/files/shell work.
---

# Aki Browser

Use this skill when the task depends on current web state or on what a live page actually renders: website/live audits, concept-vs-live comparisons, current docs/issues/releases, deploy verification, navigational checks, or browser-visible UI behavior.

## Trigger

Load/apply when the user asks to browse, open, inspect, compare, audit, research, verify, or check a live/current website, URL, deploy, GitHub page, documentation page, or web UI. For a task that also asks for a new visual concept/artwork, finish the browser evidence pass first, then apply `../imagegen/SKILL.md`.

## Tool order

1. Prefer the current host's native browser/web/search capability. Use its open/click/find/screenshot/browser interaction features when available instead of simulating them through shell commands.
2. Use Aki MCP for the local side of the comparison: repo files, configs, source, logs, git, and shell. Browser evidence does not replace reading the real local implementation.
3. If the host has no native browser/web capability, use an already-configured local browser automation capability only when one is actually available. Do not invent a browser tool or silently install Playwright/Chrome automation just to satisfy the task.
4. If no browser-capable path exists, say that live browser verification is unavailable and continue only with evidence that can actually be obtained.

## Evidence rules

- For live UI audits, inspect the rendered target, not only search snippets or source text. Use screenshots when the host supports them and the visual state matters.
- For current/fresh claims, prefer current primary sources and cite them through the host's normal citation mechanism.
- Keep web and repo evidence distinct: state which finding came from the live page and which came from local code.
- Do not claim a deploy/live page matches a concept unless the relevant viewport/state was actually inspected.

## Visual parity workflow

When the task is "compare live with concept/demo": open the live target, inspect the relevant states, identify concrete visual/behavior gaps, then read the local implementation through Aki MCP. If the user then asks for a replacement concept or artwork, hand the verified constraints to the ImageGen skill rather than generating a visual from memory alone.
