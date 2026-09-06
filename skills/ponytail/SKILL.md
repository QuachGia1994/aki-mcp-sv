---
name: aki-ponytail
description: Apply a minimal-solution ladder to coding work: understand the real flow, delete or reuse before adding, prefer stdlib/native platform features and installed dependencies, then write the smallest correct change without weakening security, accessibility, data safety, or verification.
---

# Aki Ponytail

Use this skill on coding, refactoring, bug-fixing, dependency, architecture, or implementation tasks when the smallest correct solution matters. It adapts the MIT-licensed Ponytail method from `DietrichGebert/ponytail` to Aki's existing repo/rule workflow; Aki does not install Ponytail's hooks or plugin runtime.

## Trigger

Load/apply when writing or changing code, choosing a dependency, reviewing over-engineering, or when the user asks for Ponytail/YAGNI/minimal/simple/native-first work. Do not use it as a substitute for understanding the code: read the touched flow and its callers first.

## Ladder

Stop at the first rung that fully satisfies the requirement:

1. Does this need to exist? If no, delete/skip it.
2. Does the repo already have the behavior or abstraction? Reuse it instead of creating a parallel path.
3. Does the language standard library solve it? Use that.
4. Does the native platform/framework already provide it? Prefer the native contract.
5. Does an already-installed dependency solve it safely? Reuse it.
6. Can the requirement be expressed directly without a new abstraction? Keep it direct.
7. Only then add the minimum new code that closes the real requirement.

## Hard floors

Minimal does not mean careless. Never simplify away authentication/authorization, trust-boundary validation, secret handling, data-loss protection, concurrency correctness, migrations, accessibility, platform lifecycle requirements, or verification evidence. A smaller change that weakens one of those is not a valid Ponytail solution.

Do not add a dependency merely to remove a few local lines. Before adding one, check current repo conventions, maintenance/version compatibility, license, and whether the installed stack already has the feature.

Do not create generic factories/helpers/components for a single use unless the risk boundary itself benefits from centralization. Prefer deletion, inheritance/reuse, and native behavior before abstraction.

## Review mode

For an existing diff, identify only concrete simplifications that preserve behavior. Each finding should name the unnecessary layer and the smaller replacement, for example: `path:line — wrapper duplicates native API; call native API directly`. Do not count stylistic preferences as bloat.

## Handoff

For any nontrivial implementation or repeated bug-fix loop, also load `../anti-vibecoding/SKILL.md` so minimal code still has an explicit contract and executed verification. If the task is mobile UI/navigation, also load `../mobile-native/SKILL.md`. If it touches app icons/launcher artwork, load `../icon-silhouette/SKILL.md`. If the task is security/risk review, `../strix/SKILL.md` owns the evidence and exploit-validation workflow; Ponytail may simplify the eventual fix but never lower the security floor.
