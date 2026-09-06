---
name: aki-anti-vibecoding
description: Prevent ad-hoc AI coding by forcing each nontrivial change through an explicit contract, repo evidence, smallest implementation, executed verification, and convergence check. Never claim success from plausible-looking code, stale tests, screenshots alone, or an unfinished scan/build.
---

# Aki Anti-Vibecoding

Use this skill for implementation, bug fixing, refactoring, migration, integration, CI/build repair, or any task where an AI could otherwise guess-and-patch until something appears to work. It adapts the discipline behind GitHub Spec Kit's spec → plan → tasks → implement → converge flow to Aki's existing shared-plan/checkpoint workflow; do not install Spec Kit merely to use this skill.

## Trigger

Load/apply for nontrivial code changes, repeated bug-fix loops, unfamiliar repositories, cross-file changes, build/CI failures, runtime bugs, migrations, or whenever the user explicitly says to avoid vibe coding. Tiny factual edits can stay lightweight, but they still need a read-back.

## Anti-vibe contract

Before editing, write down or recover the smallest testable contract:

- **Goal:** exact user-visible or system behavior that must change.
- **Non-goals:** adjacent behavior that must remain untouched.
- **Evidence:** current repo files/callers/config/runtime/test evidence proving where the behavior lives.
- **Acceptance:** deterministic checks that distinguish fixed from merely plausible.
- **Constraints:** platform/version/security/data/backward-compatibility requirements.

For Aki multi-step work, keep this contract in the one shared plan/checkpoint already required by the repo rules; do not create a second planning system.

## Evidence before edit

1. Reproduce or mechanically confirm the bug/risk when possible.
2. Read the real implementation and its direct callers before designing the patch.
3. Check installed versions/configuration instead of assuming current framework behavior.
4. Search for an existing abstraction or native API before adding another path.
5. For fresh/external behavior, check current upstream docs/issues/releases and distinguish upstream evidence from local evidence.

A screenshot, error string, or model explanation is a lead, not proof of root cause.

## Implementation loop

Use a hypothesis-driven loop, not random patching:

1. State the failure mechanism in one sentence.
2. Make the smallest change that directly closes that mechanism.
3. Add or update a regression that fails for the old behavior when practical.
4. Run the narrowest relevant check first.
5. Run the required broader gates after the narrow check is green.
6. Compare the final behavior against the original contract and non-goals.

After two failed implementations of the same hypothesis, stop stacking patches. Re-read the flow, invalidate the hypothesis, and gather new evidence before another edit.

## No-fake-green rules

Never report a task as fixed/complete merely because:

- code compiles by inspection;
- a model says the patch is correct;
- unrelated tests are green;
- CI was triggered but not observed when observation was required;
- a build produced an artifact that was never launched where runtime behavior matters;
- a security scanner stopped early or returned no finding without full coverage;
- a UI screenshot looks right while interaction/accessibility/state behavior is untested;
- a mock/stub passes while the real integration path is broken.

Say exactly what was executed, what passed, what was not exercised, and what remains external/blocking.

## Regression discipline

Prefer tests at the lowest layer that captures the bug, plus one higher-level check when the failure crosses a boundary. Do not rewrite tests to match broken behavior. If the code is difficult to test, first look for a seam already present; do not add a large abstraction solely to make one assertion possible.

For mobile/runtime issues, simulator/emulator tests do not replace a physical-device check when the bug depends on OEM media, permissions, gestures, launcher masking, hardware codecs, or lifecycle behavior.

## Convergence gate

Before declaring done, answer all five with evidence:

1. Does the implementation satisfy the stated goal?
2. Are the named non-goals unchanged?
3. Did the targeted regression run and pass?
4. Did the relevant broader suite/build/lint/security gate run and pass?
5. Is there any untested environment-specific behavior that must be reported instead of implied green?

If any answer is unknown, the task is not fully converged; report the exact residual instead of smoothing it over.

## Handoff

Use `../ponytail/SKILL.md` to keep the eventual fix minimal. Use `../strix/SKILL.md` for security evidence/severity. For mobile platform work also load `../mobile-native/SKILL.md`; for app-icon/logo asset work load `../icon-silhouette/SKILL.md`.