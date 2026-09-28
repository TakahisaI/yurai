# ADR 0015 — Stage-1 consolidation freeze

Status: Accepted / 2026-09-28 (owner feedback: stop spec-drift, make docs/state truthful)

Spec work was outrunning validated need: merge-identity tables, measurement
harnesses, and staged plans were accumulating at the package root and in
docs while dogfooding (#18) and the owner gate (#15) were still open. This
ADR freezes that drift: narrow the shipped surface, name one progress doc,
and gate new work on real demand.

## Decision

### 1. Root export surface narrowed, files kept

`src/index.ts` now re-exports only the Ledger, the model (`LedgerError`,
schemas, record types), the `Store` port, the SQLite adapter, and the
landed planner (`planPurge.ts`) and refs (`refs.ts`) APIs.

Removed from the root, kept in place and importable by deep relative
path inside this repo (tests, scripts). Package consumers cannot
deep-import: `package.json` `exports` exposes only `"."`, so a
package-path import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` and
external consumers get only the narrowed root:

- Merge-identity classification (`src/core/mergeIdentity.ts`): spec-only
  and pure per its own header — comparison tables and predicates for a
  future cross-ledger merge (#30, ADR 0009). Values
  (`canonicalJson`, `classifySameId`, `exactContentEquals`,
  `exactEntryEquals`, `isLedgerId`, `outcomeFor`, `sameForkMappingKey`,
  `sameOriginIdentity`, `FORK_REWRITTEN_REFERENCE_FIELDS`,
  `MERGE_IDENTITY_OUTCOMES`) and types (`MergeOutcome`,
  `OriginIdentity`, `OriginLabel`, `OutcomeCaseId`, `OutcomeRow`,
  `SameIdClass`).
- Measurement harness (`src/core/observe.ts`): `CountingStore` and
  `ScanCollector` plus the observer/stat types. Production paths never
  wrap the store; only the measurement harness opts in. Used by
  `scripts/measure-scale.mjs` and the instrumentation/lock regression
  tests via deep imports.

No runtime behavior changed: no Store, Ledger, CLI, or default-output
change. Affected imports (`test/instrumentation.test.mjs`,
`test/locks.test.mjs`, `test/merge-identity.test.mjs`,
`scripts/measure-scale.mjs`) moved to deep paths.

### 2. docs/status.md is the single progress doc

Now / Next / Deferred / Rejected, updated 2026-09-28. The early staged
plan moved to `docs/archive/roadmap-2026-09-28.md` as history with an
archive banner; it no longer reads as instruction. README and validation
claims were corrected to match the code and tests (`verify` + Verification
record exist; crash, concurrency, and source-matching coverage are pinned
to their test files).

### 3. Freeze until dogfooding validates

No new root trackers or record types until the #18 dogfooding
consultations prove real need. Deferred (merge #16/#33, MCP #3, semantic
search, source blob storage, large backup) stays deferred; rejected
(truth scores, vector DB, cloud sync) stays rejected.

## Consequences

- In-repo users of merge-identity or measurement helpers moved to deep
  relative paths (tests, scripts). External package consumers cannot
  follow: with `exports` exposing only `"."`, those modules are
  unreachable to them — no other API change.
- New spec modules land without root re-export by default; root export is
  earned by shipped use.
- Status updates go to `docs/status.md`, not new tracker files.
