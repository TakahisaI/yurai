# ADR 0012 — Merged event-state semantics and the restore/merge CLI boundary

Status: Proposed for owner review / 2026-09-28 (issue #32, parent #16,
coordination #22, siblings #30/#31, deletion track #23)

Current `import` is whole-snapshot restore into an empty ledger only
(contract §"Main operations", `Ledger.importSnapshot`). Before any merge
exists, this ADR makes the effects of importing a foreign history
predictable. Its load-bearing rule: **an old foreign Review or
Verification must never silently become the newest local judgment
because it was appended last.** Imported events arrive as reported
history; local effective state changes only through explicit local
action or an explicitly accepted rule — never through arrival order,
wall-clock timestamps, or silent reinterpretation of
latest-insertion semantics.

Spec only: no command, no migration, no record rewriting, no schema
change, no activated merge. The executable companions are the synthetic
fixtures under `test/fixtures/merge-semantics/` plus
`test/merge-semantics.test.mjs`; both assert contract examples only and
run no merge. Collision-policy ownership stays with #30 / ADR 0009:
where a clause needs the unselected winner, or #31-final mechanics,
this ADR writes the rule as far as decidable and marks the remainder
**PROVISIONAL** with the exact pending dependency (§7). Provisional
remainder keeps the corresponding implementation blocked; it never
expands into a silent default.

Vocabulary shared with ADR 0009 (local/origin identity, exact-entry
equality, the four same-ID classes, the outcome table, fork
obligations) and with ADR 0005 / issue #23 (purge, redact, tombstone,
replay registry) is reused, not redefined.

## 0. Vocabulary: three orderings, two provenances, two operations

Three orderings must never be confused:

- **Origin order** — the per-target event order inside the foreign
  artifact: array position in the source snapshot, which was the
  foreign ledger's insertion (`seq`) order at export. Preserved by
  restore today (`Ledger.importSnapshot` inserts in array order).
- **Local arrival order** — the local `seq` order at merge admission:
  where imported events land relative to existing local events.
  Imported events always arrive after every pre-existing local event.
- **Effective order** — the order that decides working state and
  anchor warnings. Today it is latest-by-local-`seq` per target
  (`latestReview` / `latestVerification`: `ORDER BY seq DESC`). This
  ADR fixes what effective order means once foreign events are
  admitted (§1). It is never wall-clock order.

Two provenances must never be confused:

- **Imported actor/provenance** — the original recorder (`actor`) and
  recording instant (`created_at` / `verified_at`) stored on the
  foreign entry. Self-reported history, preserved byte-identically.
- **Importer / import operation** — the operator (and request) that
  performed the merge locally. Recorded on the merge operation, never
  stamped onto imported entries (§2).

Two operations must never be confused:

- **Restore** (`import` today) — whole-snapshot restore into an empty
  ledger. Unchanged by this ADR.
- **Merge** — the future explicit operation this ADR specifies:
  admitting a foreign artifact (or selection) into a non-empty ledger
  through plan → apply. The name `merge` below is the specified
  surface name; any rename by implementation is editorial and must
  keep the properties in §4.

## 1. Event order and effective state (box 1)

### 1.1 FINAL rules

1. **No wall-clock universal order.** `created_at`, `verified_at`,
   and `accessed_at` never order events across ledgers. Clocks skew,
   exports reorder nothing, and equal timestamps prove nothing
   (contract §"States and corrections" already refuses to infer order
   from equal timestamps). A merge planner that sorts the combined
   history by timestamp to decide "newest" violates this ADR.
2. **No silent latest-insertion change.** Existing ledgers keep
   latest-by-local-insertion semantics exactly: for targets with no
   imported events, effective state and anchor warnings compute as
   today. This ADR adds rules for admitted foreign events; it does
   not reinterpret any existing event.
3. **Arrival is not adoption.** An imported Review or Verification,
   however it is admitted, MUST NOT change any local record's
   effective working state or anchor warning by arrival order alone.
   Imported events are reported history until an explicit local act
   adopts them (§1.3, option A). In particular: a foreign `rejected`
   Review older (by origin order) than the local `accepted` Review
   leaves the local state `accepted` when merged — the motivating
   case of issue #32.
4. **Events without an effect-free representation refuse by
   default.** Where the merge cannot represent an imported event as
   history-without-effect (no adopted mechanism available), it
   refuses every imported Review or Verification that would be
   admitted — whether or not the target already carries local
   events — rather than admitting it with ambiguous effect (§1.3,
   option C as the safe default). A target with no local events is
   not a safe harbor: under latest-insertion the imported event
   would arrive last and become the effective state by arrival
   alone. Same-entry event pairs still skip (§3.1.8); only
   would-be-admitted events refuse. Refusal names the target and
   the rule (`merge.ambiguous-overlap`, §4.5).

### 1.2 Options compared

**Option A — Explicit adoption/review on import.** Imported events
land as history; effective state derives from locally authored
events only. A state change the operator wants from foreign
information arrives as a NEW local Review/Verification (new ID,
local actor, current time, rationale citing the foreign event).
Benefit: every effective-state change has a local author and a
local reason; foreign history stays readable without becoming
local judgment. Cost: adopting N foreign judgments needs N local
events (batchable in one merge application, §4.4). Failure case:
an adoption review that copies the foreign rationale verbatim
without local judgment is theater — mitigated because the local
actor is still on record, which is the honest minimum.

**Option B — Preserving independent origin histories.** Effective
state derives per-origin: local state from local events, foreign
state from foreign events, each computed within its own origin
order; readers see both. Benefit: no information loss, no forced
re-review. Cost: every read path (show, search, expanded
discovery, anchor warnings) needs an origin dimension it does not
have; "the" working state of a record becomes ambiguous in
exactly the way operators must not see. This ADR does NOT adopt
option B as the effective-state rule: it doubles the meaning of
state without a read-path design. Origin histories are still
preserved as stored events (per §2 nothing is dropped), but they
do not get a second vote on local state.

**Option C — Refusing events without an effect-free
representation.** Any foreign Review or Verification that would be
admitted is refused (or the whole merge is refused unless the
event is excluded) — whether or not its target already carries
local events, since arrival alone would make it effective.
Benefit: smallest predictable policy; no new state derivation at
all. Cost: legitimate history cannot accumulate; large merges
refuse on first event. Adopted ONLY as the safe default (§1.1.4),
not as the whole story: refusal is what the merge does when it
cannot do better, per §7.

### 1.3 Selected rule (FINAL) and provisional mechanism

The selected rule is **A with C as default**: imported events are
admitted as history without effective-state effect; effective
state advances only through locally authored events; events
that cannot be admitted as effect-free history refuse.

**PROVISIONAL (§7, P1):** the exact read-time mechanism that
distinguishes an imported event from a locally authored event in
effective-state derivation. Candidates — an origin tag preserved
alongside imported events, a separate event partition, or
admission-time rewriting into a history-only representation — all
depend on **#31-final box 3** (what origin information is
preserved and where it lives). This ADR fixes the semantic rule
above; it does not select the representation. Until #31 lands,
implementation of event admission stays blocked and any merge
carrying a Review or Verification that would be admitted (i.e.
anything but a same-entry skip) refuses under
`merge.ambiguous-overlap` — including an imported event whose
target carries no local events at all, which would otherwise
become the effective state by arrival order alone (fixture
`imported-event-no-local.json`). Only non-event content (records
that are neither Reviews nor Verifications) is unaffected by P1.

Worked example (synthetic; fixture `old-remote-review.json`):

- Local: `clm_mrg_old` (claim, "Synthetic dosage claim."), local
  `rev_mrg_old_local` (`accepted`, origin order T2).
- Foreign artifact: byte-identical `clm_mrg_old` (same-entry, skips
  per ADR 0009) plus `rev_mrg_old_foreign` (`rejected`, origin
  order T1 < T2).
- Arrival order appends the foreign review last. Effective state
  MUST stay `accepted`: the foreign `rejected` is reported history
  (readable, attributed to its foreign recorder), not the newest
  local judgment.
- If the operator agrees with the foreign rejection, they record a
  new LOCAL review (`rev_mrg_old_adopt`, actor: the operator,
  rationale citing `rev_mrg_old_foreign`); only then does the state
  become `rejected`. The adoption review is an ordinary local
  event, inspectable under `show --request-id` like any other.
- The same holds for verifications: a foreign `match` outcome on
  `evd_mrg_old` leaves the local anchor warning unchanged
  (`anchor_not_verified` stays until a local check runs); see §2.4.

## 2. Imported actor/provenance versus the importer (box 2)

### 2.1 FINAL rules

1. **Imported entries keep their testimony byte-identical, except
   explicitly mapped reference fields.** Actor, `created_at`,
   `verified_at`, `why`, `scope`, `attributed_to`, quotes,
   locators, rationale, and stance arrive unchanged. Reference
   targets arrive unchanged too — EXCEPT under an explicit
   approved remap (only if fork/remap wins in the #30 follow-up),
   where exactly the reference-target fields of the ADR 0009 §6
   inventory (`source_id`; `claim_id` + `evidence_id`;
   `from_claim_id` + `to_claim_id`; `target_id`;
   `target_evidence_id` + `target_source_id`) are rewritten to the
   remapped ID of their original target, per §3.1.5. The remap
   changes addressing, never testimony (ADR 0009 §6): any other
   rewriting (re-stamping actors, "refreshing" timestamps,
   trimming quotes) would silently break same-entry detection and
   is refused.
2. **No reinsertion to refresh sequence.** An already-present entry
   (same-entry per ADR 0009) is skipped, never reinserted — not to
   refresh `seq`, not to "touch" recency, not to attach the
   importer. Search recency (`ORDER BY seq DESC`) and effective
   state therefore never move because a merge re-saw an entry.
   Reinsertion under the same ID would also violate immutability
   (storage triggers reject UPDATE/DELETE).
3. **The importer is recorded on the operation, not the entries.**
   Who ran the merge, when, from which artifact, and under which
   approved plan is operation metadata. Imported entries carry no
   importer stamp: no actor rewriting, no `imported_by` content
   field, no silent extra Review "confirming" the import.
4. **Imported verification is reported history.** An imported
   Verification attests that somebody, somewhere, once checked the
   quoted passage against bytes THEY held. It is not a new local
   byte check, not proof of authenticity, and not a local anchor
   decision. Anchor warnings on local records derive only from
   local verification history (ADR 0009 §6, event-targets rule (b));
   a foreign `match` never clears `anchor_not_verified`, and a
   foreign `mismatch` never raises `anchor_mismatch` on a local
   record. Re-verifying locally stays one explicit `verify` away.
5. **Provenance is self-reported, not authenticated.** Actors and
   digests recorded in a foreign artifact are declarations by the
   foreign ledger's operator, exactly as local actors are
   declarations (architecture §"Storage invariants": an actor is
   not a signed identity). Merge surfaces them with their
   foreign-ness intact; nothing in this ADR authenticates them.

### 2.2 Provisional remainder

**PROVISIONAL (§7, P2):** where importer identity and the merge-operation
record live (table vs receipt extension vs operator-held artifact),
and the exact operation-identity fields. Depends on **#31-final box 1**
(local merge operation/request identity) and **box 3** (preserved
origin information). This ADR fixes only the negative rules above:
whatever #31 designs, it must not stamp the importer onto imported
entries (§2.1.3) and must not install a foreign receipt as a local
capture receipt whose membership/digest no longer describes local
creation (#31 box 2 direction, endorsed here).

### 2.3 Round-trip preservation of the imported/local distinction

Post-merge export MUST preserve the imported/local event
distinction, so that restoring the export reproduces identical
effective state: a restored history-only foreign Review MUST NOT
become effective by landing last in array order, and a restored
locally authored event MUST keep its authorship. Round-trip
preservation is a FINAL required property of the merge design;
the representation carrying the distinction (tag, partition, or
history-only rewriting) is **PROVISIONAL (§7, P1)** on
**#31-final box 3**, like the read-time mechanism it feeds.

Snapshots written before the distinction exists — which carry no
distinction marker — restore exactly as today: array order replays
as insertion order and effective state derives as it always has.
The distinction mechanism MUST NOT change restore behavior for
those legacy snapshots (fixture `preserved-testimony.json`
carries an imported event with effective-state-relevant content
precisely to pin this: M13).

## 3. Reference closure and validation over the combined graph (box 3)

Let **G** be the combined graph: local entries plus admitted entries
with post-remap IDs. All rules below apply to G as one graph. Two
individually valid ledgers can combine into an invalid one; validating
each side separately is insufficient.

### 3.1 FINAL rules

1. **Closure.** Every outbound reference of every admitted entry
   MUST resolve inside G — to a local entry or to a fellow admitted
   entry. Reference fields are the `references()` inventory (ADR 0009
   §6 table: `source_id`; `claim_id` + `evidence_id`;
   `from_claim_id` + `to_claim_id`; `target_id`;
   `target_evidence_id` + `target_source_id`). No dangling edges, no
   silent re-pointing at a same-ID local record of different
   meaning, no dropping an unresolvable edge to "save" the merge.
2. **Missing dependencies refuse whole.** An admitted entry whose
   reference resolves nowhere in G fails the merge before anything
   is written, naming the missing IDs
   (`merge.missing-dependency`). The operator re-exports with the
   dependency or cuts the request to exclude the dependent;
   selection mechanics belong to #31/#34, the refusal rule is here.
3. **Combined supersedes cycle check.** Supersedes acyclicity is
   checked over G, not per side: local `rel_mrg_a` (A supersedes B)
   plus foreign `rel_mrg_b` (B supersedes A) are each valid alone
   and form a cycle together. The check is the `checkReferences`
   traversal extended to G (fixture
   `overlapping-corrections.json`). A cycle fails the merge
   (`merge.supersedes-cycle`), naming the cycle members. Other
   semantic relations still infer nothing (architecture invariant 8).
4. **Type and agreement checks carry over.** Review targets stay
   reviewable (never a review or verification); verification targets
   stay evidence+source with the source-agreement rule; evidence
   still needs quote or locator; self-relations still refused. These
   are the `checkReferences` + `semantic` rules applied to G.
5. **Conflicting references after remapping refuse.** Where a remap
   is in play (only if fork/remap wins in the #30 follow-up): every
   rewritten reference MUST point at the remapped ID of its
   original target (ADR 0009 §6.1); a target outside the import
   scope, a remapped ID colliding with a live local ID, or a
   remapped ID outside the ledger grammar fails the merge
   (`merge.remap-conflict`), never truncates, coerces, or re-points.
   The minting scheme belongs to the merge planner (#34); the
   refusal rules are here and FINAL.
6. **Inactive targets stay informational.** An admitted entry
   referencing a locally rejected/withdrawn record (or vice versa
   through local views) is allowed: the reference is preserved, the
   target's state rides every view, and default search keeps
   excluding inactive records exactly as today (contract §"Expanded
   discovery", AGENTS.md). Inactive-ness never silently drops an
   edge and never flips an import into a state change.
7. **Tombstones refuse by default, never restore, never pair
   across the backstop.** (a) A merge meeting a tombstone on
   either side of a same-ID pair is an ADR 0009
   `tombstone-collision` (privacy-sensitive needs-decision):
   refused by default; the surviving body MUST NOT flow into the
   redacted ledger and the tombstone MUST NOT silently delete the
   foreign account (fixture `local-tombstone.json`). Tombstone
   representation stays owned by #23. (b) Cross-ledger backstop:
   G MUST NOT pair a tombstoned Evidence with a live
   (non-tombstoned) Verification targeting it, whatever the
   verification's ID — the ADR 0008 §12 restore backstop applies
   to the combined graph, not to one snapshot alone. A live
   Verification with a distinct ID targeting a tombstoned
   Evidence refuses the merge whole (`merge.tombstone-conflict`),
   naming both IDs; the mirror case (foreign tombstone, local
   live verification) refuses identically (fixture
   `tombstoned-evidence-foreign-verification.json`). (c)
   Tombstoned Reviews and Verifications — either side, any ID —
   contribute no effective state: skipped as if absent in
   derivation over G (ADR 0008 §11, extended to the combined
   graph). A distinct-ID tombstoned foreign Review is history
   without effect even after P1 lands; until P1 lands it refuses
   like any other would-be-admitted event (§1.3).
8. **Duplicated events with different history positions conflict.**
   Same review/verification ID, different bodies or different
   actor/time, at different positions in the two histories, is
   `different-body` / `different-provenance` per ADR 0009 — a
   conflict, never a silent skip and never a silent overwrite
   (fixture `duplicate-events-positions.json`). Same-entry event
   pairs skip exactly like content pairs (§2.1.2).

### 3.2 Provisional remainder

**PROVISIONAL (§7, P3):** which same-ID pairs are admitted under
remap versus refused outright — i.e. every `needs-decision` row of
the ADR 0009 outcome table. Depends on the **#30-follow-up
collision-policy winner** (unselected; ADR 0009 refuses by default
until then). The closure/validation rules above (§3.1) are FINAL
and apply to whatever admission set the winning policy produces;
the admission set itself is P3. Corresponding implementation
(application of non-exact pairs) stays blocked until the winner
lands.

## 4. The merge surface and the restore boundary (box 4)

### 4.1 `import` is unchanged

Current `import` stays whole-snapshot restore into an empty ledger,
with its present caps and refusals (contract §"Snapshot",
§"Main operations"). This ADR specifies NO renaming of `import`, NO
flag that turns `import` into a merge, and NO fallback where a
merge travels through the restore path. A merge into a non-empty
ledger via `import` keeps failing exactly as today
(`Ledger.importSnapshot` CONFLICT). Restore and merge share
snapshot parsing and per-entry schema validation; they share
nothing else.

### 4.2 Distinct explicit merge surface (FINAL properties)

The merge is a separate explicit operation with two steps —
**plan** then **apply** — and no combined "just do it" step:

- **Plan** (non-mutating preview; the dry-run). Inputs: a source
  artifact plus an explicit target ledger. Outputs: the admission
  list, the skip list (same-entry pairs), the complete conflict
  inventory, the source/target binding (§5.3), and a plan digest
  the apply step re-checks. Plan writes no records, no receipts,
  no index data, and no journal-visible state; running plan twice
  yields byte-identical output for an unchanged ledger and
  artifact. Under `--readonly` plan still runs (it is a read).
- **Apply** (atomic execution). Inputs: an explicit plan reference
  plus explicit operator confirmation against an explicit target.
  Output: the merge result or a refusal naming every blocker. No
  other shape executes a merge: piping plan output at the ledger,
  re-running plan with a "force" flag, or hand-editing a plan file
  never constitutes an approved apply (§4.4).
- Plan-then-apply is mandatory even for trivially clean merges:
  the plan is the audit record of what was approved, and skipping
  it would make "clean" a silent judgment call.

### 4.3 Bounded reports (FINAL)

Reports are bounded exactly like existing paged reads, and bounds
are always visible:

- Conflict inventory: at most 100 entries per category, default 20
  shown, with exact `total` counts per category — mirroring
  search/show page bounds (`pageBounds`: limit 1..100). Categories
  follow the `detail.kind` taxonomy (§4.5).
- Admission/skip lists: same bounds; totals exact.
- Every bounded list carries an explicit truncation marker
  (`truncated: true` plus the complete `total`) whenever the shown
  window is not the whole set — the `paths_truncated` /
  `via_next_offset` pattern from expanded discovery, not a silent
  cut.
- Plan and apply reports are byte-bounded as well as
  item-bounded: serialized report output MUST NOT exceed 16 MiB
  (the input/export bound, §5.1). A report that would exceed the
  bound is truncated with explicit markers — and a truncated plan
  still cannot authorize a complete change (next bullet).
- Cycle and path listings are length-bounded: a reported
  supersedes cycle names at most 100 member IDs with the exact
  member count and a truncation marker when longer; any
  discovery-style path enumeration inside a report pages like
  expanded discovery (`path-limit` 1..100, exact totals,
  truncation markers). Combined-graph traversals (closure, cycle
  detection) visit each edge at most once.
- **A preview that is incomplete cannot authorize a complete
  change.** A plan whose reports are truncated MUST NOT be applied
  as "approve all": apply requires a complete (untruncated) plan,
  or an explicit operator-supplied scope selecting which listed
  items apply. Scope-selection mechanics are **PROVISIONAL (§7,
  P4)** on **#31-final box 2** (partial selection); until then,
  truncated plans refuse at apply time with
  `merge.truncated-plan`.

### 4.4 Stale-plan detection and atomic application (FINAL rules)

- **Binding.** Every plan binds the exact source artifact digest
  (raw-byte SHA-256, §5.3) and the exact target planning
  fingerprint it was computed against (§5.3). Apply re-checks
  both inside the application transaction: source bytes differ
  (including a byte-level reformatting of identical content) →
  refuse; target fingerprint moved (any intervening
  planning-relevant write, including an unrelated capture or an
  all-equal merge operation) → refuse with `merge.stale-plan`,
  naming the planned and current fingerprints. This is the
  `--as-of` pattern from paged reads, moved before the write
  instead of after it — but bound to the whole planning-relevant
  state, not to `MAX(records.seq)` alone.
- **Exact retry is recognized before the stale check.** When the
  target ledger already records a committed merge operation with
  the same operation identity as the incoming apply — same source
  artifact digest, same plan digest, same operation identity —
  apply returns the recorded result with `replayed: true`,
  writes nothing new, and does NOT refuse stale: the fingerprint
  advance is that operation's own commit (M1). A different
  operation using an old plan is not a retry: same artifact
  bytes and same plan content but a different operation
  identity, after any fingerprint move, refuses with
  `merge.stale-plan` exactly as above (M16). Each apply attempt
  is its own operation unless it explicitly presents the
  original operation's identity as a retry — so two concurrent
  applies of one plan are two operations and the loser refuses
  stale (§5.3); only a retry presenting the winner's operation
  identity replays. The check order (retry recognition first,
  stale binding second) and the exact-retry versus
  different-operation distinction are FINAL; the
  operation-identity fields and how a retry presents them are
  **PROVISIONAL (§7, P2/P5)** on **#31-final box 1**.
- **Atomicity.** Application commits in ONE SQLite transaction:
  admitted records, references, index entries, and the merge
  operation record all commit together or nothing does. Any
  failure — validation, collision, cycle, limit, stale binding,
  crash-safety timeout — rolls everything back and reports the
  refusal; the ledger is unchanged and the operator re-plans.
  There is no partial success, no "applied 12 of 15", and no
  resume-from-middle: a failed apply is re-planned from scratch.
- **No default overwrite, no inferred permission.** Apply never
  overwrites an immutable ID (ADR 0009 `overwrite-immutable-id`,
  refused unconditionally); never treats plan as consent (apply is
  its own explicit step against an explicit `--db` target); never
  fetches anything (URIs inert, no network, no source-file reads
  beyond the given artifact bytes — §5.4).

**PROVISIONAL (§7, P5):** the plan artifact's identity and storage
(plan IDs, where approved plans live, how a plan reference names
an immutable plan). Depends on **#31-final box 1** (merge
operation/request identity). The staleness rule above (digest +
fingerprint binding) is FINAL and constrains whatever #31 designs:
any plan identity that cannot re-check both halves is unfit.

### 4.5 Domain error codes (FINAL taxonomy)

Merge refusals reuse the existing top-level code taxonomy and exit
map (VALIDATION→2, NOT_FOUND→3, CONFLICT→4, IO/runtime→1,
contract §"Output and errors"); no new top-level code is needed.
The domain detail rides a stable `detail.kind` string, required on
every merge refusal alongside human-readable `message` and the
complete (bounded, §4.3) offending set:

| `detail.kind` | Top-level | Meaning |
| --- | --- | --- |
| `merge.missing-dependency` | CONFLICT | §3.1.2: admitted entry references an ID in neither side |
| `merge.supersedes-cycle` | CONFLICT | §3.1.3: combined supersedes graph cycles; members named |
| `merge.remap-conflict` | CONFLICT | §3.1.5: remap target collides, is ungrammatical, or out of scope |
| `merge.tombstone-conflict` | CONFLICT | §3.1.7: tombstone meets a same-ID counterpart; never restores |
| `merge.collision` | CONFLICT | P3-driven: same-ID pair the active policy refuses; class named (ADR 0009 class) |
| `merge.ambiguous-overlap` | CONFLICT | §1.1.4: imported Review/Verification would be admitted without an effect-free representation, even with no local target events |
| `merge.stale-plan` | CONFLICT | §4.4: source digest or target fingerprint moved since planning |
| `merge.truncated-plan` | CONFLICT | §4.3: truncated plan applied without explicit scope (until P4 lands: always) |
| `merge.limit-exceeded` | VALIDATION | §5.1/§5.2/§4.3: artifact bytes, admission items, or report output beyond the documented bound; nothing written |
| `merge.empty-selection` | VALIDATION | nothing selected for merge (malformed or vacuous scope) |

Kind strings are stable API: implementation issues MUST emit
exactly these, and later policies add kinds rather than
redefining them. Reports that omit WHICH ids collided, under
which class, strand the operator (ADR 0009 §3A failure case) and
violate this ADR.

## 5. Limits and snapshot binding (box 5)

### 5.1 Input byte limit (FINAL)

The merge source artifact is bounded exactly like restore input:
raw input bytes MUST NOT exceed 16 MiB (the `import`/`export`
bound, cli.ts `readJson`/`readRaw`). The check runs on raw bytes
before JSON parsing; exceeding it fails with VALIDATION (exit 2)
carrying `detail.kind: merge.limit-exceeded` (§4.5) and leaves the
target untouched. The exit code matches import's oversize refusal
(USAGE, exit 2), but inside the merge surface the refusal is a
domain refusal with a stable kind — one contract for every
oversized case — not CLI misuse. Size is measured on the artifact
as given
(`--file` or stdin); no decompression, fetching, or multi-part
assembly exists to measure around.

### 5.2 Item limits (FINAL rules)

- The source artifact MUST satisfy the snapshot item caps
  (entries/receipts arrays within schema bounds; the 100,000
  safety bound from contract §"Snapshot" is a bound, not a
  performance promise).
- Each merge application commits atomically within one
  transaction item cap: at most 200 admitted entries per
  application — content records AND Review/Verification events
  alike (mirroring the bundle 1..200 cap, `bundleSchema`).
  Events are not a side channel around the cap: a merge
  admitting 200 content records plus one review is beyond cap.
  Larger merges proceed as explicit sequential applications,
  each planned and bound separately (§5.3) — never as one
  silent multi-commit stream, never as a partial success.
  Beyond-cap applications refuse with `merge.limit-exceeded`
  and write nothing.
- Reports are item-bounded per §4.3 (100 per category, default
  20, exact totals, explicit truncation markers), byte-bounded
  (16 MiB serialized output), and path-bounded (cycle member
  lists at most 100 IDs; discovery-style path enumeration
  pages like expanded discovery).

### 5.3 Source/target snapshot binding (FINAL)

A merge transaction binds two snapshots:

- **Source binding:** the SHA-256 hash over the raw bytes of the
  source artifact as given (lowercase hex; NOT a canonical-JSON
  digest). Apply re-reads the artifact and refuses on any byte
  difference — including a reformatting that parses to identical
  JSON: approving plan P for artifact A never applies to
  artifact A′. The operator approved exactly the bytes they
  reviewed; a canonical digest forgives byte differences this
  binding must not forgive.
- **Target binding:** the target ledger's planning fingerprint at
  plan time: an opaque string that advances on EVERY
  planning-relevant write — record admission, receipt minting
  (including merge-operation receipts for all-equal merges,
  ADR 0009 §4 case 1), replay-registry appends (#23), and any
  future merge-admission state. `Store.revision()` —
  `MAX(records.seq)` — is NOT sufficient: a receipt-only or
  registry-only write advances no record `seq` yet changes what
  a plan means. Apply refuses when the live fingerprint differs
  — including writes unrelated to the merge: interleaving is
  re-planned, never silently accommodated. The fingerprint's
  exact encoding is implementation detail; the advance property
  (equal iff no planning-relevant write intervened) is FINAL.
- The binding is checked inside the application transaction, so
  check-then-act races fail closed: two concurrent applies of
  the same plan are two distinct operations (§4.4) and serialize
  on the write lock, and the loser sees a moved fingerprint and
  refuses stale rather than double-applying. A retry presenting
  the winner's operation identity replays instead of refusing
  (M1); anything else re-plans.

### 5.4 Negative permissions (FINAL)

No silent partial success (§4.4, §5.2). No default overwrite
(§4.4). No inferred save permission: planning never implies
applying, and apply targets exactly the `--db` it is given —
there is no "merge into the ledger this artifact came from". No
implicit network or source-file access: the merge reads the
artifact bytes given via `--file`/stdin and the local target
ledger, and nothing else. Foreign `uri`/`snapshot_uri` fields
stay inert (no fetching to "complete" the graph); foreign
`content_sha256` pins are never checked against local bytes (no
local file is read to re-verify them — that is what explicit `verify` is for).

## 6. Acceptance matrix and contract examples (box 6)

Each row names the fixture(s) under `test/fixtures/merge-semantics/`,
the required implementation-test result, and FINAL vs PROVISIONAL
status (§7). "Unchanged" rows pin current behavior the merge must
not perturb.

| # | Case | Fixture(s) | Required result | Status |
| --- | --- | --- | --- | --- |
| M1 | Repeated merge | `repeated-merge.json` | exact retry (same artifact + plan + operation identity) replays after its own commit: `replayed: true`, no duplicated records, no reinsertion, same-entry skips; a different operation reusing the old plan refuses stale (M16) | Rule FINAL; operation identity P2/P5 (#31 box 1) |
| M2 | Preserved why/scope/actor | `preserved-testimony.json` | admitted entries byte-identical incl. `why`, `scope`, `attributed_to`, actor, `created_at`; importer stamped nowhere on entries | FINAL |
| M3 | Old remote review | `old-remote-review.json`, `imported-event-no-local.json` | foreign older-by-origin `rejected` leaves local `accepted` unchanged; readable as foreign history; local adoption review flips explicitly; the refusal gate covers every would-be-admitted event, even with no local target events | Rule Final; admission mechanism P1 (#31 box 3) |
| M4 | Old remote verification | `old-remote-review.json` | foreign `match` leaves `anchor_not_verified` unchanged; local `verify` still required; admission of the foreign verification itself refuses until P1, like M3 | Rule Final; admission mechanism P1 (#31 box 3) |
| M5 | Overlapping corrections | `overlapping-corrections.json` | combined supersedes cycle refuses whole (`merge.supersedes-cycle`), cycle members named, nothing written | Final |
| M6 | Missing dependency | `missing-dependency.json` | refused whole (`merge.missing-dependency`), missing IDs named, nothing written | Final |
| M7 | Remap conflict | `remap-conflict.json` | colliding/ungrammatical remap refuses whole (`merge.remap-conflict`); no truncation, coercion, or re-pointing | Rule Final; minting scheme → planner (#34); admission set P3 |
| M8 | Inactive target | `inactive-target.json` | admitted entry referencing a withdrawn local claim imports; state/warnings preserved; default search still excludes inactive | Final |
| M9 | Duplicate original requests | `duplicate-request-ids.json` | equal request strings across unrelated ledgers never identify the same operation; no foreign receipt installed as a local capture receipt | Negative rule Final; receipt treatment P4 (#31 box 2) |
| M10 | Local tombstone | `local-tombstone.json`, `tombstoned-evidence-foreign-verification.json` | `tombstone-collision` refuses by default; body never flows into the redacted ledger, tombstone never silently deletes the foreign account; distinct-ID live-verification-meets-tombstoned-evidence refuses whole (cross-ledger backstop); tombstoned events contribute no effective state | Refusal Final; resolution P3 (#30 winner) |
| M11 | Duplicated events, positions differ | `duplicate-events-positions.json` | same-ID event pairs classify per ADR 0009; non-exact pairs refuse by default, naming class | Refusal Final; resolution P3 (#30 winner) |
| M12 | Failure/rollback | `overlapping-corrections.json`, `missing-dependency.json` | any refusal leaves the ledger unchanged (records, receipts, index, fingerprint all identical); re-plan from scratch | Final |
| M13 | Export/restore after import | `preserved-testimony.json` | post-merge export re-imports losslessly (entries, receipts, per-target event order) AND preserves the imported/local event distinction (§2.3); snapshots without the marker restore exactly as today | Rule Final; distinction representation P1 (#31 box 3) |
| M14 | Unchanged direct search | `preserved-testimony.json` | literal AND, Japanese/short-term handling, newest-first, pagination, warnings, actor — byte-identical behavior on merged ledgers except explicitly accepted imported state | Final |
| M15 | Unchanged expanded discovery | `preserved-testimony.json` | Evidence→Assessment→Claim routing, `via`/`total_paths`/truncation markers, inactive audit path — unchanged except explicitly accepted imported state | Final |
| M16 | Stale plan | `merge-plan.json` | intervening write (fingerprint move, incl. receipt-only all-equal merge operations) or artifact byte change (incl. reformatting) refuses apply by a different operation (`merge.stale-plan`); an exact retry of the committed operation replays instead (M1); plan itself is non-mutating (repeatable byte-identical output) | Rule Final; plan identity P5 (#31 box 1) |
| M17 | Truncated plan | `merge-plan.json` | truncated reports carry `truncated: true` + exact totals and MUST NOT apply as approve-all (`merge.truncated-plan`) | Final until P4; selection mechanics P4 (#31 box 2) |
| M18 | Limits | `merge-plan.json` + §5 | artifact > 16 MiB refused (VALIDATION `merge.limit-exceeded`, exit 2, target untouched); > 200 admitted entries (content + events) refused; reports byte- and path-bounded; never partial | Final |

Implementation issues MUST encode every FINAL row as a behavior
test and MUST NOT implement any PROVISIONAL remainder until its
pending dependency lands accepted. Rows whose status cites P1–P5
ship first as refusal-path tests (the FINAL default), then gain
admission-path tests when the dependency unblocks them.

## 7. Provisional register

| ID | Clause | Decided (FINAL) | Pending (PROVISIONAL) | Blocks |
| --- | --- | --- | --- | --- |
| P1 | §1.3 event admission mechanism + §2.3 round-trip | imported events never advance effective state by arrival; every would-be-admitted event without an effect-free representation refuses; post-merge export preserves the imported/local distinction | read-time + export representation distinguishing imported vs local events | #31-final box 3 (origin preservation). Blocks event admission and the distinction representation; refusal path shippable. |
| P2 | §2.2 importer/operation record + §4.4 retry recognition | no importer stamp on entries; no foreign-receipt installation; retry-before-stale check order with the exact-retry vs different-operation distinction | operation record shape + identity fields + retry presentation | #31-final boxes 1+3. Blocks operation receipts and every apply path (§4.4 commits the operation record atomically with admission); content-admission validation rules stay FINAL but no application ships first. |
| P3 | §3.2 non-exact admission set | closure/validation rules; refuse-by-default; never restore; never overwrite | which needs-decision pairs admit under remap vs refuse | #30-follow-up collision-policy winner. Blocks non-exact admission; same-entry skip/classification rules shippable as plan-time reports only (application itself needs P2/P5); refusal paths shippable. |
| P4 | §4.3/§6-M9/M17 selection mechanics | truncated plans never approve-all; equal request strings never identify one operation | partial-selection request shape; receipt treatment across selections | #31-final box 2. Blocks scoped/truncated apply; complete-plan apply additionally needs P5 plan references + the P2 operation record; refusal paths shippable. |
| P5 | §4.4 plan identity | digest+fingerprint binding rule; atomicity; non-mutating plan | plan artifact identity, storage, reference form | #31-final box 1. Blocks plan references, stored plan artifacts, and every apply (no reference, no apply); binding rule constrains the design. |

No other clause in this ADR is provisional. In particular the
orderings (§1.1), testimony preservation (§2.1), combined-graph
validation (§3.1), the restore boundary (§4.1), error taxonomy
(§4.5), limits (§5.1–§5.2), binding (§5.3), and negative
permissions (§5.4) are FINAL as written.

## 8. Explicitly unsupported

- Any merge through `import`, any flag making `import` merge, any
  silent upgrade of restore into merge.
- Wall-clock ordering of the combined history; recency- or
  reputation-based automatic winners (also refused by ADR 0009 §7).
- Adopting foreign Reviews as local working state by insertion
  order (also refused by ADR 0009 §7); presenting imported
  Verifications as local anchor checks (same).
- Reinserting same-entry pairs to refresh `seq`; stamping the
  importer onto imported entries; trimming/rewriting imported
  testimony for any reason.
- Partial application, resume-from-middle, truncated-plan
  approve-all, default overwrite, inferred save permission,
  network/source-file access during merge.
- Truth adjudication, automatic acceptance, distributed
  synchronization, global identity service (inherited non-goals
  from #16/#30/#31).

## 9. Consequences

- Implementation issues (#34–#36 and planners) inherit fixed
  event-state semantics, a fixed validation target (G), a fixed
  plan→apply shape, fixed limits, and a fixed error taxonomy.
  They design command wiring, storage representation (within P1,
  P2, P5 constraints), remap minting (within §3.1.5), and
  selection UX (within P4) — not new meanings for "newest",
  "same", or "approved".
- Until P1–P5 resolve, the only shippable merge behavior is
  refusal paths plus plan-time classification reports
  (same-entry skips listed, conflicts inventoried, nothing
  applied): no ledger can be silently corrupted by an
  unanswered question, and no application path ships on
  provisional identity.
- Owner burden: one reviewable decision document now; #31-final
  and the #30-winner ADR later, each discharging its P-rows
  without reopening FINAL rules. Any drift between those ADRs and
  this one is resolved by amending this ADR, not by silent
  reinterpretation.

