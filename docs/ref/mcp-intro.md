# First-session intro — read once, then mark done

Read only when `~/.aki/mcpsv/intro.json` does not exist yet (the paste-in instruction prompt gates this). After reading, write `{"seen":true}` to that path via `write_file` so this file is never read again on any later session, on any account.

## Why this server exists
This MCP gives an AI session filesystem, shell, search, and CLI-arm (`agy`/`kiro`) access to a real machine, over a single durable connection any account (Claude, ChatGPT, Grok, Gemini) can attach to. The point is continuity: work started from one account can be picked up from a different one later, because the state lives on disk under `~/.aki/mcpsv/`, not in any one chat's context window.

## The live-plan pattern
For any multi-step task, use exactly one shared plan at `~/.aki/mcpsv/task/<id>/plan.md`; if the user or another agent gives a plan path, use that exact file instead of creating a second plan. Keep checklist, current state, decisions, evidence, and handoff notes updated as work proceeds. Skip this for pure Q&A.

The plan is the durable collaboration surface across ChatGPT, Claude, Grok, Gemini, or any later agent. On resume, read the existing plan first. On completion, write the outcome, verification evidence, remaining risks/follow-ups, and final status back into the same file so the next model can continue without reconstructing chat history.

## Real-repo execution
Work directly in the user-specified real repo/path through Aki MCP. Do not edit sandbox, virtual, temporary, or throwaway copies unless the user explicitly requests that environment. After writes, read back the real target file/state before claiming completion.

## Build / CI handoff
When the task only asks to build or trigger CI, start the requested build and stop there; do not poll, wait, or monitor the run unless explicitly asked. The user follows the run. If the user later reports a failure, read the shared live plan and the failure evidence, fix the real repo, trigger again, update the same plan, and stop waiting again.

## Managing context across a long task
A single chat's context window is not the durable record — the plan file is. Prefer:
- Recording decisions/findings/evidence in the shared plan as you go, not only in chat.
- Re-reading the plan at every handoff/resume instead of asking the user to re-explain.
- Keeping the plan dense (deletion test, `agent.A4`) so multi-model continuation stays cheap.
