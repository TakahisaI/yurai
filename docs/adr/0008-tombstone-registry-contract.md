# ADR 0008 — Tombstone bodies and replay-registry contract (supplement to ADR 0005)

Status: Proposed / 2026-09-28 (issue #23, slice 1: boxes 1–2)

This ADR supplements ADR 0005; it does not reinterpret the accepted policy.
It closes the two persistence/identity points 0005 deferred to the
implementation issue: where replay-prevention digests live and what a
tombstoned body looks like. Boxes 3–6 of #23 (sensitive reference IDs,
registry lookup semantics, post-purge identity limits, remaining fixtures)
are follow-up slices and are explicitly out of scope here.

Coordination: issue #30 (merge identity) owns exact-entry equality and
foreign-identity vocabulary. This ADR references that term without
redefining it, and uses only existing schema/reference vocabulary
(`request_id`, receipt, `references()`, record kinds) otherwise.

## Decision

### Box 1 — registry placement, versioning, and conflicts

1. Same-ledger table. Replay-prevention digests live in the same SQLite
   ledger as records and receipts (a future `blocked_requests` table
   holding `digest TEXT PRIMARY KEY`), under the same immutability
   triggers, the same transactions, and the same backup story. There is
   no separable companion file: a backup that can lose the registry can
   silently re-admit purged bundles on restore.
2. Opaque digests only. Each entry is the lowercase hex SHA-256 over the
   UTF-8 bytes of one purged `request_id`. No raw `request_id`, record
   ID, or content ever sits in the live table. Entries are append-only;
   no removal path exists, since removal would re-admit the bundle.
   Deterministic-hash membership/count leakage and the need for
   unguessable `request_id` values are inherited unchanged from 0005
   rule 5; lookup timing and admission wiring belong to boxes 4–5.
3. Snapshot extension, not a new snapshot version. The registry rides
   export/restore as an optional versioned extension on the snapshot:
   a top-level `registry` object `{ registry_version: 1, digests:
   string[] }` with `digests` sorted unique lowercase 64-hex. The
   snapshot-format version (`snapshot.version`, currently 1) and the
   SQLite schema version (`user_version`, currently 2) are independent
   counters that must never be compared; the extension carries its own
   `registry_version` so the digest encoding can evolve without
   renumbering either. An export of a ledger with a non-empty registry
   MUST include it; a registry-dropping export is refused, never
   silently written. An empty registry is omitted, keeping exports of
   untouched ledgers byte-identical to today.
4. Old readers reject, never drop. Readers without registry support
   already fail unknown top-level snapshot members under strict
   validation; that rejection is normative: an old reader MUST refuse
   a snapshot carrying `registry` rather than restore without it. A
   registry-aware reader MUST refuse a snapshot whose
   `registry_version` it does not support, again restoring nothing.
   Partial restore that forgets the registry is forbidden in both
   directions.
5. Legacy snapshots. A snapshot without `registry` restores exactly as
   today with an empty restored registry. No backfill is attempted:
   ledgers purged before the registry existed cannot be distinguished
   from ledgers never purged, and claiming otherwise would be the
   global-uniqueness promise box 5 forbids.
6. Live-receipt vs blocked-digest conflict. If admission input presents
   both a live receipt for `request_id` R and registry membership of
   digest(R) — on restore, capture, or verify — the operation fails
   closed with CONFLICT, restoring/admitting nothing. Neither side is
   silently preferred: the combination attests both "R is live" and
   "R was purged", which no consistent ledger produces. The error
   names only the `request_id`, which is already live via the receipt,
   never content or digests-as-proof. Lookup precedence beyond this
   fail-closed rule (registry-first vs receipt-first ordering,
   merge admission) belongs to box 4.

Reader/writer compatibility matrix:

| Input | Old reader (no registry) | Registry-aware reader |
| --- | --- | --- |
| v1 snapshot, no `registry` | restore | restore, empty registry |
| v1 snapshot, `registry_version: 1` | refuse (VALIDATION, unknown member) | restore incl. registry |
| v1 snapshot, unknown `registry_version` | refuse (VALIDATION) | refuse whole restore |
| receipt + blocked digest of same R | refuse (VALIDATION, unknown member) | CONFLICT, restore nothing |
| SQLite `user_version` newer than reader | refuse (existing SCHEMA rule) | refuse (existing SCHEMA rule) |

### Box 2 — tombstoned-body variants

7. Discriminated variant per type. Every record kind gains a
   schema-valid tombstoned body discriminated by `redacted: true`
   (const). The body schema becomes oneOf(live, tombstoned); both
   sides keep `additionalProperties: false`, so live bodies never
   carry `redacted` and tombstoned bodies carry exactly the keys
   below. Tombstones arise only from the future redact path: direct
   capture of a `redacted: true` body is rejected, so user input can
   neither pre-redact nor evade validation.
8. Retained keys. A tombstoned body keeps only the reference targets
   its kind needs to preserve links, plus a minimal reason marker
   and the redaction time:

| Kind | Tombstoned body keys |
| --- | --- |
| source | `redacted`, `reason`, `redacted_at` |
| claim | `redacted`, `reason`, `redacted_at` |
| evidence | `redacted`, `source_id`, `reason`, `redacted_at` |
| assessment | `redacted`, `claim_id`, `evidence_id`, `reason`, `redacted_at` |
| relation | `redacted`, `from_claim_id`, `to_claim_id`, `reason`, `redacted_at` |
| review | `redacted`, `target_id`, `reason`, `redacted_at` |
| verification | `redacted`, `target_evidence_id`, `target_source_id`, `reason`, `redacted_at` |

   `reason` is the enum `sensitive | wrong-scope`: a marker, never
   free text, so it structurally cannot copy the removed secret (the
   box 3 rule; the enum shape is defined here so fixtures can use
   it). `redacted_at` is a timestamp validated exactly like
   `created_at`. Removed required live fields (`title`, `text`,
   `quote`/`locator`, `stance`, `state`, `outcome`, …) MUST NOT be
   backfilled with placeholders: their absence is the valid
   tombstoned shape, and fabrication would forge content the ledger
   no longer holds.
9. Envelope preserved. The entry envelope keeps the original `id`,
   `type`, `actor`, and `created_at` unchanged: `actor` stays the
   original recorder, not the redacting operator. The redaction act
   itself is audited only by the 0005-mandated pre-delete export
   held by the operator, never by a live record.
10. Links survive; content does not. `references()` over a tombstoned
    body yields the same (id, role, kind) links as the live body did,
    so restore regenerates links with no format change beyond the
    body variant, and dependents keep resolving visibly degraded.
    When a retained reference ID is itself sensitive, redact is the
    wrong tool (0005 rule 6): the scope needs a purge, owned by
    box 3.
11. Read-path purge of old content (normative for implementation).
    Tombstoned reviews contribute NOTHING to effective Review state:
    they are skipped as if absent, the latest live Review decides,
    and none-live means proposed. Tombstoned verifications are
    likewise skipped: anchor warnings recompute from the latest live
    verification, typically back to `anchor_not_verified`.
    Tombstoned claims/sources index no text; tombstoned evidence
    contributes no discovery paths; tombstoned assessments break the
    paths through them (no stance survives to report). Every view —
    show, search (incl. expanded `via` and refs-v1 `included`),
    inspectCapture — renders the marker only. Old verdicts, quotes,
    paraphrases, rationales, outcomes, offsets, and hashes MUST NOT
    remain in any view, page, index, effective state, or summary.

12. Redaction scope cascade for Verifications. Redacting an Evidence
    MUST redact every Verification targeting it in the same
    operation; an Evidence-only scope is refused. The cascade is
    mechanical, not operator-judged: a live Verification retains
    `passage_sha256`, byte offsets, and the outcome of the removed
    quote, and would keep reporting `anchor_match` for tombstoned
    Evidence — old quotes in verification summaries, which box 2
    forbids. The refusal mirrors 0005 rule 4 (purge refuses unless
    the scope expands to cover dependents), applied to redact.
    Read-path backstop: views of a tombstoned Evidence MUST NOT
    surface anchor outcomes from any Verification; with the cascade
    enforced none survives live. Restore backstop: future restore
    MUST refuse, restoring nothing, any snapshot that pairs a
    tombstoned Evidence with a live (non-tombstoned) Verification
    targeting it — a direct view of the surviving Verification would
    otherwise keep exposing the removed quote's outcome, byte offsets,
    and passage hash, which no Evidence-view filter can suppress. The
    refusal is whole-snapshot, like the §6 CONFLICT and
    unknown-`registry_version` rules: no partial restore that keeps one
    side and drops the other. Dependent Reviews,
    Assessments, and Relations carry free text that may or may not
    quote the secret: the redact procedure MUST surface them for
    operator confirmation, but only the Verification cascade is
    mandatory here — routing a sensitive retained reference to a
    purge instead belongs to box 3.

### Logical equality

13. Ledger/snapshot-level logical equality is defined over
    entry-level exact-entry equality (term owned by #30: same
    id/type/body/actor/created_at under canonical key ordering):
    two snapshots are logically equal iff (a) they hold the same
    entry set by ID with per-ID exact-entry equality, the same
    receipt set by `request_id`, and the same registry digest set —
    all compared order-insensitively as sets — AND (b) the
    per-target event order matches: for every target, the relative
    order of Review IDs (by `target_id`) and of Verification IDs
    (by `target_evidence_id`) as listed in the entries arrays is
    identical. Gate (b) is required because latest-by-insertion-order
    (`seq`; restore preserves snapshot array order as `seq`) decides
    effective Review state and anchor warnings: a reordered event
    pair changes the latest event — and hence the effective state —
    while set-equality still passes. Relative order of non-event
    entries stays ignored: paging-position differences are not
    logical inequality. Bytewise SQLite-file equality is explicitly
    NOT the criterion: page layout, freelist state, `seq` gaps, and
    index bytes legitimately differ after a rebuild. Per 0005 rule 3,
    survivors additionally preserve full `seq` order, but that is a
    rebuild requirement, not part of equality. A tombstoned body and
    its live original are NOT equal: redacted/full versions of one ID
    are distinct entries, consistent with #30's collision coverage.

## Fixtures (slice 1)

Synthetic fixtures under `test/fixtures/tombstone/`, asserted by pure
tests with no DB mutation (`test/tombstone-contract.test.mjs`):

- `request-digests.json`: digest definition vectors plus leakage-shape
  notes (digests-only, no raw IDs).
- `snapshot-legacy-v1.json`: v1 snapshot without `registry`; parses
  under the current schema (legacy handling).
- `snapshot-with-registry.json`: same content plus a v1 registry;
  current readers reject it (unknown member), proving fail-closed.
- `snapshot-registry-v99.json`: well-formed registry with an
  unsupported `registry_version`; refused whole, never partially
  restored (compatibility-matrix row 3).
- `receipt-registry-conflict.json`: receipt plus blocked digest of the
  same `request_id`; a pure detector flags the CONFLICT case.
- `tombstones.json`: live/tombstoned entry pairs for all seven kinds
  incl. Review and Verification.
- `redact-evidence-scope.json`: Evidence plus a live Verification
  targeting it; the Evidence-only scope is invalid, the joint scope
  valid (§12 cascade).
- `snapshot-tombstoned-evidence-live-verification.json`: tombstoned
  Evidence plus a live Verification targeting it; future restore MUST
  refuse the combination whole (§12 restore backstop), flagged by a
  pure detector returning the offending Verification ID.
- `tombstone-invalid.json`: tombstone-shaped bodies the future oneOf
  schema MUST reject — missing retained reference, retained content,
  invalid reason, invalid timestamp — rejected by today's parser,
  with machine-checkable defect markers for the later schema tests.
- `purge-partial.json` / `purge-full.json`: post-purge live-ID sets and
  registry expectations for partial vs full capture purge.
- `logical-equality.json`: byte-different but logically equal pair, a
  registry-dropping unequal pair, and event-reordered unequal pairs
  (Review order and Verification order gates, §13).

## Reasons

- Same-file placement removes the separable-backup failure mode while
  reusing the ledger's existing atomicity and immutability story.
- Strict-validation rejection turns "old readers drop the registry"
  from a silent risk into a loud, already-tested behavior.
- The discriminated variant keeps typed import validation total:
  tombstones are schema-valid records, not a side channel, and the
  do-not-fabricate rule keeps them honest.
- Skipping (not reinterpreting) tombstoned Reviews/Verifications keeps
  "accepted is a decision, never truth" intact: a redacted verdict is
  no verdict.

## Alternatives considered

- Separable companion file for the registry: rejected — it can part
  from the backup it protects (box 1 forbids it).
- Bumping top-level snapshot `version` for registry presence: rejected
  — coarser than a versioned extension and conflates format evolution
  with one feature's encoding.
- Tombstone as live body with blanked fields: rejected — blank strings
  fail nonblank validation, and placeholders would fabricate content.
- Tombstoned Review keeps its verdict: rejected — a redacted rationale
  cannot ground a kept state, and box 2 forbids old verdicts in
  effective state.

## Costs

Spec-only: no behavior change, no migration, no destructive path. Future
implementation cost is a schema/storage change plus read-path filtering,
owned by later issues consuming this contract and its fixtures.

## Revisit when

- Boxes 3–6 land (sensitive reference IDs, lookup semantics, identity
  limits, remaining fixtures) — expected as amendments here, not edits
  to 0005.
- A second registry encoding or tombstone reason is proposed.
