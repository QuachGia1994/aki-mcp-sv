---
name: aki-strix
description: Audit GitHub repositories and owned/authorized apps for security bugs and risk using evidence-first repo research plus Strix when available. Separate passive code/repo risk review from active pentesting, require reproducible findings, and never treat an incomplete scan as clean.
---

# Aki Strix Security Risk

Use this skill when the user asks for a security audit, vulnerability/risk review, GitHub repo security assessment, pentest, Strix scan, exploit validation, or remediation of validated security findings.

This skill adapts the workflow of the Apache-2.0 `usestrix/strix` project to Aki's repo-first rules. It does not vendor Strix, install it silently, or assume every security task should launch an active attack.

## Trigger and authorization boundary

For a public GitHub repository, passive source/repository analysis is allowed: inspect code, dependencies, advisories, issues, releases, CI, permissions, auth boundaries, and existing security reports. Active probing of a live domain/API/IP requires that the user owns the target or is authorized to test it. If authorization is unclear for third-party infrastructure, stay passive.

Do not auto-install Docker, Strix, scanners, browser drivers, or exploit tooling just to satisfy an audit. First use what is already available in the repo/environment.

## Repo-risk pass

Before forming conclusions:

1. Lock the scope: project-wide or change-related plus callers.
2. Research the exact GitHub repo/upstream, current release, open security/bug issues, advisories, and relevant framework/runtime versions.
3. Run repo-native mechanical gates first: tests, typecheck/lint when present, dependency audit, secret/config scans already provided by the project, and targeted greps for the trust boundary under review.
4. Map attack surfaces: auth/session, filesystem/path handling, shell/process execution, network fetch/SSRF, deserialization/parsing, database/tenant isolation, secrets, uploads, CI/release/supply chain, mobile deep links/permissions, and agent/tool boundaries when present.
5. Reproduce a suspected bug safely before calling it CERTAIN. A pattern match without a working code path or deterministic failing test remains SUGGESTED.

For GitHub issue evidence, distinguish an upstream issue from a bug proven in the current installed version. Closed/fixed issues require version matching before they become a local finding.

## Strix mode

If Strix is already installed and the target is owned/authorized, it may be used to validate dynamic vulnerabilities. Prefer a focused/diff scan for code changes and a scoped target for live testing. Keep the scan instruction narrow enough to finish and produce artifacts.

Read the generated run metadata and vulnerability artifacts, not only the CLI exit line. A completed Strix finding should include severity, affected endpoint/code, technical analysis, and a reproducible PoC. Re-run the PoC or equivalent regression when feasible before reporting it as closed.

A zero-finding result is not proof of safety if the run stopped early, hit budget/time limits, skipped material scope, or failed setup. Report coverage and completion state explicitly.

## Finding classes

Use two evidence classes:

- **CERTAIN** — reproduced by a deterministic test, command, request/PoC, or exact machine-decidable violation. Include `path:line` or endpoint, reproduction, impact, and origin when auditing a diff.
- **SUGGESTED** — heuristic risk, suspicious pattern, design concern, or upstream issue not yet reproduced in this repo/version. State what evidence is missing.

Prioritize by exploit impact and reach: critical/high before medium/low, but do not inflate severity merely because a sink looks dangerous. Owner-only/local-only boundaries have different reach from unauthenticated internet paths.

## Remediation

Fix the root cause, not one payload: authorization at the object boundary, parameterization at the query sink, URL/host policy for SSRF, canonical path containment for filesystem access, origin/tenant binding for IDs, least-privilege capabilities for mobile/Tauri, and secret rotation plus history/config cleanup for leaked credentials.

Use framework/platform defenses before custom sanitizers. After a fix, add a regression that reproduces the original exploit shape and re-run both the focused security check and the repo's normal test suite. If Strix produced the finding, re-test the finding or run a focused verification scan when available.

## Report

Return findings first, ordered by severity, then coverage. For every CERTAIN item provide evidence sufficient for another engineer to reproduce it. Never print live secrets. If no P0/P1 remains, say so only for the checked scope and name any untested live/runtime boundary.

For implementation simplicity after the security contract is fixed, load `../ponytail/SKILL.md`. Security controls are a hard floor and are never removed just to reduce code.
