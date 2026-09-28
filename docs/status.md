# Status — the single progress record

Updated: 2026-09-28. This file is the only current statement of what is
done, next, deferred, or rejected. The early staged plan is archived at
[docs/archive/roadmap-2026-09-28.md](archive/roadmap-2026-09-28.md) and no
longer directs work.

Freeze: no new root trackers or record types until dogfooding validates
real need (see [ADR 0015](adr/0015-consolidation-freeze.md)).

## Now

- [#15](https://github.com/TakahisaI/yurai/issues/15) owner gate: the pure
  purge/redact planner has landed; selective purge stays gated on real
  need — no destructive path, no CLI, no storage change until then.
- [#18](https://github.com/TakahisaI/yurai/issues/18) dogfooding priority:
  coverage-convention trial on 5+ real consultation records, confirming a
  later reader can tell what to re-check, before any extension work resumes.

## Next

- [#18](https://github.com/TakahisaI/yurai/issues/18) completion via real
  consultations: apply the coverage convention to 5+ real records, confirm
  a later reader can tell what to re-check, and record what the trial teaches.
- Small `oneOf` error-message improvement
  ([#40](https://github.com/TakahisaI/yurai/issues/40)): better diagnostics
  for the existing validation rejections, no behavior change.

## Deferred until real demand

- Merge ([#16](https://github.com/TakahisaI/yurai/issues/16) /
  [#33](https://github.com/TakahisaI/yurai/issues/33)): spec assets frozen
  (`src/core/mergeIdentity.ts` stays in place but is no longer re-exported
  from the package root).
- MCP ([#3](https://github.com/TakahisaI/yurai/issues/3)): gated on a
  concrete required client (or demonstrated integration need) plus a
  bounded compatibility/context-cost check for that named target —
  the adoption gates in #3, not CLI stabilization.
- Semantic search: the literal + expanded-evidence search stands until
  failing real examples prove more is needed.
- Source blob storage: sources stay external paths/URIs; the ledger pins
  checked bytes by hash instead of keeping them.
- Large backup: the 16 MiB snapshot limit stands until a real ledger
  outgrows it.

## Rejected

- Truth scores: the ledger records who stated what and who interpreted it
  how; it never adjudicates truth.
- Vector DB: no embedding store; retrieval stays literal and inspectable.
- Cloud sync: the ledger is local-only; multi-user sync is out of scope.
