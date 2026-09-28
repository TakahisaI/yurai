# ADR 0014 — Pure purge/redact planner contract (boxes 1–6)

Status: Proposed / 2026-09-28 (issue #24, slice 1: boxes 1–6, box-4 digest binding included)

This ADR fixes what the pure planner computes, refuses, and binds. It builds
only on reviewed vocabulary: canonical `references()`, receipts, logical
revision, tombstoned bodies and the replay registry (ADR 0008), the deletion
policy (ADR 0005), and canonical JSON (merge identity). The box-4 digest
binding, exact expected results, and exact state transitions are decided
here — no separate part B. No destructive path, no CLI, no storage change.

Note: ADR 0013 is still free; this planner contract takes 0014 per the slice
assignment.

## Decision

### 1. Read-only snapshot input, never a handle (box 6)

The planner consumes a detached `PlanSource` — `{ revision, entries,
receipts }` as plain data, plus optional `source_id` (opaque caller-supplied
source identity), `schema_version` (ledger `user_version`), `registry`
(blocked request digests per the ADR 0008 extension), and
`registry_version` (the extension's version). It never accepts a
writable Store, never touches SQLite/FTS/registry/schema, and never mutates
its input (asserted by test: deep-equal before/after). Core stays
independent of CLI, providers, network, and SQLite.

Entry array order mirrors restore `seq` semantics: the last event in array
order is the latest review/verification. The source fingerprint is
deliberately order-sensitive for the same reason — a reordered event pair
changes effective state. Receipt `ids` keep stored membership order for the
same reason: capture preserves bundle order and `inspectCapture` pages in
it, so a reordered membership list reads as stale. Receipts themselves are
an order-insensitive set keyed by `request_id`.

### 2. Purge closure and refusal (box 1)

- The closure is the transitive incoming-reference closure from canonical
  `references()`: every entry that directly or transitively references a
  selected record. Cycles terminate via a visited set; duplicate paths merge
  into one member with combined `via` edges.
- Future record variants plug in through a `ReferenceResolver` hook
  (default: canonical `references()`). A resolver MUST throw `LedgerError`
  with code `'UNKNOWN_KIND'` for any kind it cannot resolve; the planner
  then halts the plan as `incomplete`, naming the `unresolved_ids`. Unknown
  kinds fail closed: a plan can never be ready while a record of unknown
  kind might reference the selection, and returning no edges for an unknown
  kind is forbidden. Malformed resolver edges fail loud (`VALIDATION`).
- Refusal first: when closure members fall outside the selection, the plan
  is `refused` (`dependents-survive`), `scope` stays empty, and the plan
  proposes the full closure as `proposed_scope` with a per-dependent reason
  (`via` target/role/kind edges, depth). Never expand silently: only a
  selection that already covers the closure yields `ready`.
- Unknown IDs in the selection refuse (`unknown-ids`) and are named; an
  empty selection is a `ready` no-op with an empty scope. Ready
  additionally requires a bound source — `source_id` and `schema_version`
  both present — or the plan halts `incomplete` (§5).

### 3. Redact bodies, degradation, and dropped receipts (box 2)

- Tombstoned bodies follow ADR 0008 box 2 exactly: `redacted`, retained
  reference targets per kind, `reason` (`sensitive | wrong-scope`, never
  free text), `redacted_at`. The planner has no clock; the caller supplies
  `redactedAt` explicitly so plans stay deterministic. Each preview carries
  its preserved reference edges, and `references()` over the tombstoned body
  equals `references()` over the live body.
- The verification cascade (ADR 0008 §12) is enforced: an evidence scope
  that omits a live verification targeting it is `refused`
  (`verification-cascade`) naming the missing verifications.
- The degradation report names unaffected transitive dependents with a fixed
  impact vocabulary (`grounds-degraded`, `endpoint-degraded`,
  `target-degraded`, `source-content-removed`). Cascade verifications are
  not degraded — they join the scope instead. Every redact plan carries the
  scope note: reference closure is not content discovery — duplicated secret
  text in other bodies is neither found nor removed, and the plan never
  claims it.
- Already-tombstoned IDs in a redact selection refuse
  (`already-tombstoned`); re-stamping `redacted_at` is a new act, not an
  idempotent replay.
- Redact preserves IDs but drops receipts: every receipt referencing a
  redacted record is dropped (ADR 0005 rule 5), including mixed receipts
  whose surviving records stay live. Affected redact receipts carry
  disposition `drop-receipt` and no blocked digest — only purged
  `request_id` values enter the replay registry, and a redact re-submission
  fails closed on immutable-ID conflict, so no block is predicted or
  required. Receipts are computed over the confirmable scope (selection plus
  required cascade), so a cascade-refused plan still names the receipts its
  confirmation would drop.

### 4. Affected purge receipts and blocked digests (box 3)

- A receipt intersecting the removal closure is affected; its disposition is
  always `remove-receipt`. A mixed receipt (selected and surviving records)
  is removed while its `surviving_ids` stay live as records — matching the
  ADR 0008 partial-purge fixture (`receipt_present: false`, survivor keeps
  its ID).
- Each affected purge receipt names its `blocked_digest`: lowercase hex
  SHA-256 over the UTF-8 bytes of `request_id` (#23 box 1), cross-checked
  against the `request-digests.json` vectors. No raw IDs or content enter
  the plan beyond what the snapshot already holds.
- Every affected purge receipt also carries
  `blocked_digest_provisional: true` in the machine-readable contract: #23
  box 4 (registry membership and admission) is pending, so the digest is a
  planner prediction, never registry state. Partial purges fail closed on
  immutable-ID conflict regardless of the registry. The purge `expected`
  result carries the same marker as `blocked_digests_provisional: true`:
  the expected digest list is a provisional prediction, never registry
  state.

### 5. Bounds and incomplete previews (box 5)

- Output is bounded (`maxClosure`, `maxReasons`, `maxReceipts`, `maxVia`).
  `maxReasons` caps every diagnostic detail list: survivors, degraded,
  unknown IDs, unresolvable IDs, cascade, state impact, already-tombstoned,
  and unsupported kinds; `maxReceipts` caps affected receipts; `maxClosure`
  caps the echoed `selection` alongside the closure it seeds, with the true
  total in `counts.selected` and the full normalized selection bound
  opaquely in `selection_digest` (SHA-256 over the canonical JSON of the
  complete array, including the omitted tail). A cut echo halts `incomplete`
  like any other cut detail — and since only `ready` plans are approvable,
  an approved plan always carries the whole confirmation selection the
  digest binds, while two truncated plans whose echoes coincide but whose
  full selections differ still carry different digests.
- Any cut detail — closure growth, reason/receipt/transition lists, ID
  lists, or per-dependent paths — yields `incomplete` with `truncated:
  true`, exact totals where computed, and an empty adoptable
  `scope`/`proposed_scope` when the closure itself did not complete. No
  success on a partially computed closure: an incomplete plan must never be
  approved as if whole.
- Totals stay exact under truncation. Counts are computed over the full
  list even when the shown detail is cut — a truncated plan reports the
  true survivor/receipt totals, never 0 for unshown rows.
- `expected` is null for every `incomplete` plan — no usable forecast
  leaves a plan that must never be approved as if whole — and otherwise
  only when exactly computable: for purge, the closure completed and
  receipt detail is whole; for redact, the closure completed, receipt
  detail is whole, and every confirmable-scope body is plannable. An
  unexecutable plan carries no expectation.
- Ready requires a bound, readable source: `source_id` and `schema_version`
  must both be present, and the registry must be readable: any supplied
  `registry_version` outside the supported set (currently `1`; ADR 0008)
  carries an unknowable digest encoding, so a would-be `ready` plan halts
  `incomplete` with `truncated: true`, an empty adoptable scope, and no
  expectation — even with an empty digest list, an explicit version is
  distinct from the absent legacy extension — as does a nonempty `registry`
  under a missing version. An absent registry with no version plans as today
  (legacy ledgers carry no version), as does an empty registry under no
  version or a supported version. Refusals keep their refusal: they are
  unexecutable forecasts, not approvals.

### 6. Digest binding, expected results, and state transitions (box 4)

- `source_fingerprint` is lowercase hex SHA-256 over the canonical JSON of
  `{ v: 2, source_id, schema_version, revision, registry_version,
  registry, entries, receipts }`: absent identity/schema/version encode as
  `''`/`null`/`null`, absent registry as `[]`, entries in source array
  order, receipts sorted by `request_id` with each receipt's `ids` in
  stored membership order, registry canonically sorted. It binds source
  identity, schema, logical revision, registry version, registry, and
  full content while leaking nothing but equality.
- `digest` is lowercase hex SHA-256 over the canonical JSON of the plan
  minus the digest field itself. It self-seals every confirmation-relevant
  byte: source fingerprint, mode, selection echo plus `selection_digest`
  over the full selection, scope, receipts, tombstones, expected results,
  transitions, limits, resolver identity, reason, and redaction time.
  `verifyPlanDigest` recomputes it; any hand edit to the artifact fails
  verification. `verifyPlanDigest` proves the artifact is untampered, not
  that it is the approved one: `verifyPlanApproval` additionally compares
  against the digest retained from the actual approval, which rejects a
  substituted fresh plan for a different selection that would otherwise
  verify, read fresh, and re-plan to itself, and requires a whole `ready`
  plan, so `refused` and `incomplete` never pass even on a digest match.
- `expected` carries the exact machine-readable outcome (ADR 0005 rule 3
  shape). Purge: assumed scope IDs, removed receipt request IDs, blocked
  digests (with `blocked_digests_provisional: true`), live count,
  `live_ids_digest` (SHA-256 over the canonical JSON of sorted surviving
  IDs), `live_entries_digest` (SHA-256 over the surviving entries as full
  objects in source array order), and `live_receipts_digest` (SHA-256 over
  the surviving receipts as full objects sorted by `request_id`). Redact:
  confirmable scope IDs, `tombstones_digest` (SHA-256 over sorted id/body
  pairs), dropped receipts, live count, `live_ids_digest`,
  `live_entries_digest` (full post-redact entries: scope tombstoned in
  place, untouched byte-identical, in source array order), and
  `live_receipts_digest`. The ID digests pin the surviving set; the
  content digests pin what ADR 0005 re-export equality needs — a changed
  survivor body or receipt moves them while the ID digest stands still.
  The executor recomputes and compares; for a refused plan with a
  complete closure the expectation assumes the proposed scope is
  confirmed.
- `state_transitions` (purge) and `state_impact` (redact) carry exact
  before/after pairs for every removed/redacted review or verification
  event whose target survives, computed in array order mirroring the ledger
  view: latest live review decides (`proposed` when none live), anchors
  read `anchor_<latest outcome>` (`anchor_not_verified` when none live),
  tombstoned events skipped on both sides (ADR 0008 §11). Equal
  before/after means observably unchanged.
- The executor rejects instead of silently recomputing: refuse when
  `verifyPlanApproval` fails against the digest retained from the actual
  approval (substituted or altered artifact — `verifyPlanDigest` alone
  cannot see substitution), when `isPlanStale` reports true (any source
  change, even at the same revision — revision movement is neither
  necessary nor sufficient for freshness), or when a fresh plan over the
  live source with the retained selection, limits, resolver, and
  confirmation parameters yields a digest different from the retained
  approval digest (altered scope or effects). A bare revision number
  passed to `isPlanStale` compares revisions only, for callers without
  the source at hand.
- Plans echo their effective `limits`, `resolver_id` (default
  `'canonical'`), and — for redact — `reason` and `redacted_at`, so a
  re-plan for comparison uses identical inputs. A custom resolver is caller
  context: the digest binds its identity string, not its code, and the
  executor must re-plan with the same resolver.

### 7. PROVISIONAL — pending #23 boxes

The following are explicitly not decided here and block their consumers:

- **P1 (#23 box 3: sensitive reference IDs).** The planner preserves every
  reference ID per ADR 0008 §10. When a retained ID is itself sensitive,
  redact is the wrong tool and a separately confirmed purge scope is
  required — but detecting that sensitivity is operator judgment today.
  A future explicit flag routing such cases from redact to purge belongs to
  the box 3 slice, not to silent planner inference.
- **P2 (#23 box 4: registry lookup semantics).** The planner computes which
  digests a purge would block; admission wiring (capture/verify/merge
  lookup, precedence, leakage documentation beyond the inherited rule)
  belongs to box 4. Blocked digests leaving the planner are provisional
  predictions, marked so in the contract (§4), not registry writes.

## Reasons

- Refusal-first with a proposed scope keeps the operator's confirmation
  meaningful: the planner shows its work instead of growing the blast radius.
- Deterministic, clock-free planning over detached data makes plans
  reviewable artifacts with no live-ledger side effects to audit.
- Fixed impact/reason vocabularies and exact totals on truncated previews
  keep partial output honest instead of silently short.
- Fail-closed unknown kinds keep future record variants from silently
  shrinking a blast radius the operator confirmed.
- A self-sealing digest over source-bound plans turns "don't execute a
  stale plan" from operator discipline into a mechanically checkable gate.
  Comparing against the retained approval digest closes the substitution
  hole a self-comparison gate leaves open.

## Alternatives considered

- Auto-expanding purge scope with a warning: rejected — box 1 forbids
  silent expansion, and a warning is still silent for a scripted executor.
- Tombstone-before-plan (redact unknown kinds by dropping all keys):
  rejected — dropping a retained reference target would break links the
  tombstone must preserve; unknown kinds refuse instead.
- Revision-only staleness: rejected — a same-revision content change is
  exactly the concurrent-mutation case box 4 names, and revision equality
  cannot see it.
- Whole-plan digest versus an enumerated preimage: the whole-plan form won
  — it binds every confirmation-relevant byte by construction, so a future
  field cannot silently fall outside the seal.
- Emitting blocked digests for redact receipts: rejected — the replay
  registry covers purged `request_id` values only (ADR 0005 rule 5), and
  redact re-submission already fails closed on immutable-ID conflict. A
  digest on a redact receipt would over-claim a block that is never
  required.

## Costs

Spec plus a pure Core module (`src/core/planPurge.ts`) and its tests
(`test/plan-purge.test.mjs`): no behavior change to capture, search,
restore, or storage; no migration; no destructive path.

## Revisit when

- The destructive executor lands — it consumes the digest/staleness/
  expectation gates decided here.
- #23 boxes 3–4 land (sensitive references, lookup semantics) — P1/P2 close.
- A new record variant registers — extend the resolver/tombstone tables.
