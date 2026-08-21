# First-session intro — read once, then mark done

Read only when `~/.aki/mcpsv/intro.json` does not exist yet (the paste-in instruction prompt gates this). After reading, write `{"seen":true}` to that path via `write_file` so this file is never read again on any later session, on any account.

## Why this server exists
This MCP gives an AI session filesystem, shell, search, and CLI-arm (`agy`/`kiro`) access to a real machine, over a single durable connection any account (Claude, ChatGPT, Grok, Gemini) can attach to. The point is continuity: work started from one account can be picked up from a different one later, because the state lives on disk under `~/.aki/mcpsv/`, not in any one chat's context window.

## The live-plan pattern
For any multi-step task, write a plan to `~/.aki/mcpsv/task/<id>/plan.md` and keep it updated as you work — checklist, current state, decisions — instead of only reporting progress in chat. Skip this for pure Q&A. This is what makes cross-account continuity actually work: a session on a different account can `find_path`/`read_text_file` that same plan and resume mid-task instead of starting over blind.

## Managing context across a long task
A single chat's context window is not the durable record — the plan file is. Prefer:
- Committing decisions and findings to the plan file as you go, not just at the end.
- Re-reading the plan file at the start of a resumed session instead of asking the user to re-explain.
- Keeping the plan file itself dense (deletion test, `agent.A4`) so resuming from it is cheap.
