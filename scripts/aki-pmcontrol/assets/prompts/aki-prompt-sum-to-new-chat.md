# Summarize for a new chat

Create one self-contained handoff for a brand-new chat with no memory of this one.
Lead with the current actionable state; do not retell the conversation or restate already-resolved requests.
Reuse confirmed facts from the shared plan/checkpoint/current git state; do not reread or research them unless stale, ambiguous, changed, or required for verification.
For a substantive session, target 30–100 non-empty lines and never exceed 100 lines. If all required state fits in fewer than 30 lines, do not pad.
Include only what the new session needs to continue correctly:
- current goal/scope;
- taskKey, cwd, planPath when present;
- branch/HEAD/remotes only when relevant to the next action;
- intentional dirty files that must be preserved;
- key decisions that still constrain future work;
- completed work only as compact outcomes/evidence;
- pending work and blockers;
- last-green verification that can be trusted without rerunning;
- the single next concrete step;
- any explicit commit/push/deploy authorization already granted.
Omit narrative chronology, repeated rationale, full transcripts, superseded alternatives, secrets/credentials, unrelated personal data, and details already stored durably in the plan/checkpoint unless the fresh chat needs the pointer.
Do not invent tests, status, commits, or evidence. Mark anything uncertain as unresolved instead of researching merely to make the handoff look complete.
Output only the handoff message itself, ready to paste as-is into the new chat.
Wrap the entire handoff in one fenced code block using four backticks (````), so inner triple-backtick blocks remain copyable.