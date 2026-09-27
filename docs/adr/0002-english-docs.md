# ADR 0002 — English for repository prose; ledger content stays multilingual

Status: Accepted / 2026-09-27

## Decision

Write all repository prose — README, docs/, issue/PR templates, and GitHub issues — in English.
Translate the existing Japanese docs and open issues (#1–#5) once, at the start, so later readers never face diverging interpretations.

Ledger content, fixtures, and example data are not prose: Japanese example strings and regression coverage for Japanese search stay as-is.

## Reasons

AI agents are the primary readers and writers of this prose. English removes cross-model variance in Japanese wording and wasted deliberation over phrasing.
The boundary is deliberately crisp: anything a human or agent reads as instruction or description is English; anything stored as ledger content keeps its original language.
Doing it now, while the repository is small, costs one translation pass; doing it later costs per-file judgment forever.

## Alternatives considered

- Agent-facing docs only in English: rejected; a mixed-language repository reintroduces the same per-file language judgment the decision removes.
- Keep Japanese: rejected by owner decision after agent friction observed in dogfooding (Issue #1).

## Costs

One translation pass over docs and five issues; history stays in git and GitHub edit history.
The owner maintains the repository in English.

## Revisit when

If human-only readers need Japanese versions, add them as secondary translations rather than reverting the primary prose.
