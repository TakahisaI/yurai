# ADR 0011 — Merge retries, origin receipts, and deletion barriers on merge admission

Status: Proposed for owner review / 2026-09-28 (issue #31, parent #16;
depends on #23 and #30 contracts; drafting in parallel)

Current `import` is whole-snapshot restore into an empty ledger only.
Before any operational merge exists, this ADR separates three things the
merge planner must never conflate: the local merge-operation request
(retry identity in the importing ledger), the immutable imported
artifact/selection (foreign bytes under an explicit selection), and
origin capture requests/receipts (foreign execution history). It then
pins the deletion barriers to the merge admission path, so that
namespacing foreign requests can never become a way to bypass a local
privacy decision. Spec only: no command, no migration, no record
rewriting, no activated merge, no schema change. The executable
companion is `test/merge-retries.test.mjs` plus synthetic fixtures
under `test/fixtures/merge-retries/`: pure JSON assertions, no DB, no
new `src` module. Where executable behavior already exists it is reused,
not redefined: `mergeIdentity.ts` classification (ADR 0009),
`model.ts` parsing, and the `request_id`/digest retry shape in
`ledger.ts`.

Vocabulary is reused verbatim, never redefined: local identity, origin
identity, origin label, exact-entry equality, exact-content equality,
the four same-ID classes, and the fork mapping from ADR 0009 (#30);
purge, redact, tombstone, replay-prevention registry, and
request-digest barriers from ADR 0005 / ADR 0008 (#23 boxes 1–2).

FINAL vs PROVISIONAL: every rule below is tagged. FINAL means decidable
from landed contracts (#30 / ADR 0009, #23 boxes 1–2 / ADR 0008, ADR
0005, architecture, contract). PROVISIONAL means written as far as
decidable, with the exact pending dependency named; an implementation
MUST NOT treat it as settled. The provisional register (§10) is
normative. This ADR invents no #23-owned behavior (registry lookup
order, purge-scope flow, sensitive-reference routing) and expands no
ADR 0005 guarantee (audit in §8).

## 1. Box 1 — three separate identities

### 1.1 Local merge-operation request [FINAL]

A merge attempt is a local operation carrying a ledger-scoped local
`request_id` minted in the importing ledger, in the same namespace and
grammar as capture request_ids. Retry mirrors architecture invariant 7
("the same request_id with the same input yields the same receipt;
different content is a CONFLICT"):

- Same local merge `request_id` + byte-identical normalized merge
  request (same artifact digest per §1.2, same selection per §1.2, same
  approved policy label, same import namespace per §2.4, same
  shared-history pairing declaration per §2.3 — including its absence)
  → replay: return the stored local merge-operation receipt and write
  nothing new.
- Same local merge `request_id` + any difference → CONFLICT, writing
  nothing. In particular, retrying the same local request_id with a
  different import namespace is a CONFLICT, not a replay: the
  namespace requests different local IDs for the same incoming IDs,
  so the stored receipt's membership cannot describe the retry. And
  retrying with a changed pairing declaration (paired↔unpaired, or a
  different declared peer) is a CONFLICT, not a replay: C9 evaluates
  paired and unpaired imports differently, so the pairing is
  safety-relevant input a replay must not silently drop.

The retry SHAPE above is FINAL. The exact fingerprint composition (how
artifact digest, selection, policy label, import namespace, and pairing
declaration encode into the digest preimage) is [PROVISIONAL P1:
pending #31-final integration (merge-request schema) and the
winner-selection ADR (ADR 0009 defers policy selection; no policy
label exists until a winner is selected)].

### 1.2 Imported artifact and selection [FINAL]

- Artifact identity is the SHA-256 digest over the exact imported
  snapshot bytes (a byte digest, deliberately NOT canonicalized: a
  canonical form would need a merge-request schema that does not exist
  yet, while a byte digest needs none). It is conservative in the safe
  direction: same bytes always mean the same artifact, while merely
  re-serialized bytes count as a different artifact for replay purposes
  and then classify pair-wise under key-order-forgiving exact-entry
  equality — no false replay, no false conflict.
- Selection identity is the sorted unique list of imported foreign IDs.
  The selection is always explicit; there is no implicit "rest of the
  snapshot".
- Artifact and selection are immutable inputs. Any remap produces NEW
  local IDs; the artifact itself is never rewritten.

### 1.3 Origin capture request and receipt [FINAL]

A foreign `request_id` + digest + `ids` triple as recorded in the
origin ledger, ledger-scoped to that origin. It is preserved as
provenance annotation only (§3.2): never installed as a local execution
receipt (§2.2), never consulted as local replay evidence, and never
matched against the local registry (§4.3 C3) — EXCEPT via the explicitly
paired shared-history check (§2.3 C9), which is the sole exception to
the never-compare rule and runs only under an operator pairing
declaration.

### 1.4 Transport IDs are not retry identifiers [FINAL]

JSON-RPC request IDs, process/thread IDs, CLI invocation IDs, and file
paths of the artifact take no part in replay/CONFLICT decisions. Only
the ledger `request_id` does.

### 1.5 Merge-operation receipt [FINAL created-IDs rule; PROVISIONAL zero-create and actor recording]

A merge mints fresh local receipt(s) under NEW local request ID(s) (ADR
0009 §6 receipts direction, verbatim: "do not reuse imported capture
receipts as local execution receipts"). When the merge creates local
records, the row shape reuses the existing receipts table
`(request_id, digest, ids)` with no new table:

- `request_id`: the local merge-operation request_id (§1.1);
- `digest`: the digest of the normalized merge request
  ([PROVISIONAL P1: preimage fields per §1.1]);
- `ids`: the actually-created local IDs in creation order (§2.6).

Two things the current row shape cannot record, so neither is claimed
here:

- Zero-create merges. An all-equal or fully-repeated merge creates no
  local IDs, but the receipts schema requires `ids` to hold 1–200 IDs
  (`model.ts`), so an empty-`ids` row is not writable today. Whether
  such a merge mints a receipt at all — and if so under what shape
  (relaxed `ids` constraint, merge-operation record, or no persisted
  receipt with operator re-drive) — is [PROVISIONAL P9: pending
  #31-final integration]. Until P9 settles, a merge that would create
  no local IDs MUST refuse as uncertain admission (§5.3) [FINAL
  interim]: succeeding without a stored receipt would leave a retry
  unable to replay and a changed-input retry undetectable as a
  conflict, and no receipt may be synthesized from foreign receipts
  (§2.2). (ADR 0009 §4 case 1 explicitly leaves this to #31.)
- Importer actor. Receipt rows carry no actor field, so the §3.1
  promise — the importer identity recorded on the merge operation —
  has no writable field in the current shape. The recording shape (a
  merge-operation bundle/record carrying the actor, or an equivalent
  decided at integration) is [PROVISIONAL P10: pending #31-final
  integration]. FINAL is only the placement rule: whatever the shape,
  the importer stays on the operation, never stamped onto imported
  entries (§3.1).

Whether one receipt covers a whole merge or one receipt covers each
admitted batch is [PROVISIONAL P2: pending #31-final integration].
Origin-mapping storage (a ledger table vs an operator-held artifact) is
[PROVISIONAL P3: pending #31-final integration] under FINAL
constraints: the mapping must never live as ordinary in-ledger content
that exports everywhere, must never reintroduce raw removed IDs into
live audit, and must be cut or withheld from exports that leave the
operator's control (ADR 0009 §6, verbatim). If ledger-stored, a schema
extension (new table) is REQUIRED: identified here (§7), not designed,
not implemented.

## 2. Box 2 — request strings, copies, repeats, overlaps, out-of-selection receipts

### 2.1 Equal request strings prove nothing [FINAL]

`request_id` strings are ledger-scoped, like record IDs. The same
string in two unrelated ledgers creates no relationship and authorizes
nothing. Cross-ledger `request_id` equality is never consulted for
replay, barriers, or identity — except under an explicit shared-history
pairing, where §2.3 C9 compares incoming foreign receipt strings against
the local registry before remapping (lookup mechanics PROVISIONAL P8).
Reusing a foreign string as a fresh
local merge request_id is allowed (it is just a string in a new
namespace) but gains nothing: the local receipt carries the local
digest, unrelated to any foreign receipt under that string.

### 2.2 Origin receipts are never installed as local capture receipts [FINAL]

Installation condition, exact: a receipt may stand as a local capture
receipt only when its membership AND digest both still describe local
creation byte-exactly — the same IDs created in THIS ledger under THAT
request_id with THAT digest. A merge never satisfies it:

- remapped imports rewrite IDs, so membership differs;
- disjoint-ID imports record a different actor (the importer) under a
  new local request_id, so the digest differs;
- exact-equal skips write nothing at all (ADR 0009 §4 case 1: no
  content record, no review, no foreign receipt).

Hence in a merge the conditional rule is effective never-install, and
the merge mints fresh local receipts (§1.5). Whole-snapshot restore
into an empty ledger is not a merge and keeps its own
receipt-restoration rule.

### 2.3 Copied ledgers sharing an origin [FINAL pair rule; PROVISIONAL shared-history barrier]

Exact-equal pairs skip (`copied-ledger-exact`); diverged same-IDs
conflict (`copied-ledger-diverged`) [FINAL; ADR 0009 §4 case 7,
verbatim rule]. The copy shares history but each ledger is now its own
authority: shared past picks no survivor.

Known shared-history purge bypass. Ledger B is copied from A, then A
purges the bundle recorded under request_id R. B still holds R's
receipt and body. B's artifact re-supplies them under a fresh local
merge request: the §4.1(a) check on the new merge request_id misses
(the string is new), while §2.1/§4.3 C3 forbid matching foreign
receipt strings against the local registry in the unrelated-ledger
case. Under an EXPLICIT operator pairing declaring the two artifacts
share history, the strings are not unrelated — they denote the same
historical recording act — so the decision rule is: before any
remap/admission step, each incoming foreign receipt request_id is
hashed and checked against the LOCAL registry, and any hit refuses
the whole merge. Without such a pairing the comparison MUST NOT run:
unknown origin never matches (ADR 0009 §1.2, verbatim), and running
it would refuse unrelated merges on coincidental strings while
proving nothing. The refusal direction above is written as far as
decidable, but the lookup mechanics (when the check runs relative to
classification, error precedence, report shape) belong to #23 box 4,
which owns merge-admission lookup semantics and has not settled
them — so the barrier rule is [PROVISIONAL P8: pending #23 box 4
(merge-admission lookup semantics)]. FINAL is only the pairing gate:
no declared shared history, no cross-ledger string comparison. §4.3
C9 pins the paired case and its unpaired contrast. The pairing
declaration is part of merge retry identity (§1.1): changing it under
the same local request_id is a CONFLICT.

### 2.4 Repeated import of the same artifact [FINAL mapping keys; FINAL interim zero-create refusal until P9]

- Same local merge request_id → replay per §1.1: no new writes.
- New local request_id + same artifact + same selection + SAME import
  namespace → the `(import namespace, incoming id)` mapping keys are
  already occupied, so no duplicates are minted — but every selected
  entry is already mapped, so the merge would create zero local IDs
  and MUST refuse as uncertain admission (§5.3) under the §1.5 interim
  rule [FINAL interim until P9 settles the zero-create receipt
  shape]. (Same known label + same id stays the idempotent replay
  key, ADR 0009 `sameForkMappingKey`: it is what makes the repeat a
  zero-create, not a success-with-skip.)
- New local request_id + same artifact + same selection + DIFFERENT
  import namespace → a distinct import under new local IDs: the
  operator explicitly asked twice. Labels must be known, nonempty,
  operator-supplied; origin-less repeats (`null`/empty) collide on one
  mapping slot and refuse until distinct namespaces are supplied (ADR
  0009 §3C, verbatim rule).

### 2.5 Overlapping imports [FINAL default; PROVISIONAL selective continuation]

An overlap is a merge selection intersecting already-imported mapping
keys under the same namespace. An intersected key skips ONLY when the
incoming entry still exactly equals the previously imported bytes for
that key (ADR 0009 exact-content equality: same type, body, actor,
`created_at` — the local remapped ID is expected to differ); a
changed body, actor, or timestamp is a conflict naming the key, and
any needs-decision or conflict anywhere in the selection fails the
WHOLE merge before anything is written (atomicity per #16; ADR 0009
Option A default). Membership alone never authorizes a skip: without
the equality check a re-supplied entry with edited bytes or a
swapped recorder would silently keep the stale local copy while the
merge reports success. The disjoint remainder is evaluated
pair-wise. Cutting the request down to exclude conflicts and then
proceeding (per-ID selective continuation) is [PROVISIONAL P4:
pending #32 selection/planning mechanics — ADR 0009 §3A explicitly
defers selection mechanics to #31/#32, and this spec-only issue does
not design them].

### 2.6 Receipts reaching outside the selection [FINAL]

A foreign receipt whose `ids` reference IDs outside the approved
selection is provenance about a foreign capture, never a local receipt:
it must not be installed (§2.2), and its out-of-selection members must
not be pulled in implicitly. The local merge-operation receipt lists
ONLY actually-created local IDs, in creation order — when the merge
creates any at all (zero-create merges cannot mint that row today;
§1.5 P9). Reference targets
keep the ADR 0009 §6 rule: a SELECTED record referencing an
out-of-scope target fails the merge — no silent re-pointing at a
same-ID local record, no dangling edges.

## 3. Box 3 — origin information vs importer identity

### 3.1 Importer identity [FINAL]

The importer is the actor of the local merge operation (the local
recording act). It is recorded on the merge operation (bundle/record
shape PROVISIONAL P10 — receipt rows carry no actor field; §1.5),
never stamped onto imported entries. Imported entries keep their
foreign actor and `created_at` byte-identical (ADR 0009 §6: the remap
changes addressing, not testimony).

### 3.2 Preserved origin information [FINAL content; PROVISIONAL storage]

Per imported record: the foreign actor, the foreign `created_at` (both
in the envelope, byte-identical), and the foreign ID plus the
operator-supplied origin label / import namespace (the mapping key).
All of it is self-reported declarations carried over, never verified at
import. The storage shape is [PROVISIONAL P3: pending #31-final
integration] under the §1.5 mapping-privacy constraints.

### 3.3 Content strings never prove origin [FINAL; ADR 0009 §1.2, verbatim rule]

"A ledger path, self-declared name, DOI, URI, or similar text is not
proof of origin." A raw URL/path or user-supplied origin string —
inside the artifact or alongside it — cannot prove historical sameness
and must never populate the comparison-time origin label. Only the
operator's explicit pairing of two ledger artifacts establishes a
shared origin, and even then it proves shared history, not the right to
unify diverged records.

### 3.4 Provenance is self-reported, not authentication [FINAL]

Foreign actor / `created_at` / origin strings are declarations, never
authenticated facts (mirrors "an actor is not a signed identity" and
"actors and digests recorded in a snapshot are not authenticated").
Imported views must never present them as verified, and accepted stays
a decision, never truth.

## 4. Box 4 — deletion barriers before remapping and admission

### 4.1 Barrier order [FINAL]

Local request-digest barriers are consulted BEFORE any remap/admission
step whose output could bypass them:

(a) the LOCAL merge-operation request_id is checked against the LOCAL
    registry before any write; a digest hit refuses the whole merge
    (ADR 0005 rule 5: the registry refuses re-submission under a
    purged request_id; ADR 0008 §6 fail-closed spirit);
(b) same-ID admission is classified (ADR 0009 classes with a mandatory
    explicit tombstone detector — no "assume not a tombstone" default)
    before any remap output is admitted;
(c) no remap output may resurrect an ID the merger CAN know is
    removed: a surviving tombstone, or a request replay the #23
    registry flags (ADR 0009 §6 constraint, verbatim scope). The
    guarantee ends where ADR 0009 §1.1's does (see Box 5).

Lookup precedence beyond fail-closed — registry-first vs receipt-first
ordering when one merge request hits BOTH a stored local
merge-operation receipt and a blocked digest — is [PROVISIONAL P5:
pending #23 box 4 (registry lookup semantics including merge
admission); ADR 0008 §6 explicitly defers "registry-first vs
receipt-first ordering, merge admission" to box 4, and this ADR does
not invent it]. Failing closed on the combination itself is FINAL
(§4.3 C8).

### 4.2 Same-ID tombstone and full-body conflicts [FINAL; ADR 0009 restatement]

A tombstone on EITHER side of a same-ID pair is a `tombstone-collision`:
privacy-sensitive, needs-decision, default refuse — even a
byte-identical tombstone pair, because the redaction marker carries its
own reason/time semantics owned by #23. Neither the body (into the
redacted ledger) nor the tombstone (as a silent delete of the full
account) may flow implicitly.

Cross-record reference refusal [FINAL]. A same-ID pair is not the only
tombstone meeting: an incoming live Verification whose
`target_evidence_id` resolves to a locally-tombstoned Evidence is a
different-ID pair, not a same-ID collision, and it refuses for its own
reason — admitting the Verification would keep a live view (outcome,
byte offsets, passage hash) over removed quote bytes (ADR 0008 §12
spirit). The refusal holds whether or not the targeted Evidence is
itself in the selection: a Verification-only selection still resolves
its target against local state, and a tombstoned local target still
refuses. The report names the incoming Verification ID and the
tombstoned local target ID (§5.3).

### 4.3 Snapshot / receipt / registry combination table [FINAL except C8 precedence and C9 mechanics]

Merge admission input = local state (L) + incoming artifact (F):

| # | Combination | Result |
| --- | --- | --- |
| C1 | Local live receipt R + local blocked digest(R), pre-existing or induced by the merge's own writes | CONFLICT; the merge writes nothing (ADR 0008 §6, verbatim rule, applied to merge admission) |
| C2 | Merge request reusing a locally-blocked request_id | Refuse the whole merge (ADR 0005 rule 5) |
| C3 | Incoming artifact carries a foreign registry | Foreign digests are NOT consulted for local admission (foreign namespace, §2.1) and NOT unioned into the local registry (non-goal: no automatic union of foreign blocklists). The local registry is unchanged |
| C4 | Foreign-internal conflict: incoming live receipt for foreign R + incoming foreign blocked digest(R) | Refuse the artifact whole: it attests both "R is live" and "R was purged" (ADR 0008 §6 logic as an artifact-consistency check) |
| C5 | Foreign-internal §12 violation: incoming tombstoned Evidence + incoming live Verification targeting it | Refuse whole (ADR 0008 §12 restore-backstop logic as an artifact-consistency check) |
| C6 | Incoming live Verification (its own ID) targeting locally-tombstoned Evidence | Refuse the whole merge: cross-record reference refusal (§4.2). Holds for an Evidence+Verification selection AND a Verification-only selection: the target always resolves against local state |
| C7 | Incoming tombstoned Evidence vs local live Evidence (same ID) with a local live Verification targeting it | Refuse the whole merge: `tombstone-collision` on the same-ID Evidence pair (§4.2), symmetric with C6 — neither the tombstone (as a silent delete of the live local account and its Verification) nor any body flows implicitly. The local Verification is untouched |
| C8 | Merge request matching BOTH a stored local merge-operation receipt and a blocked digest | Fail closed: refuse, write nothing [FINAL]; which error surfaces first [PROVISIONAL P5] |
| C9 | Copied-ledger re-supply (§2.3): incoming foreign receipt whose request_id digest sits in the LOCAL registry | With an explicit shared-history pairing: refuse the whole merge before remapping [PROVISIONAL P8: pending #23 box 4]. Without a pairing: the strings are never compared (FINAL, §2.1) — the merge is evaluated without that barrier, documenting the §5.1 limit |

Purge-scope overlap on admission (a merge selection intersecting IDs
with a purge/redact pending or decided) splits: refusing the overlap
as uncertain admission is FINAL per §5.3, while any scope/cascade
mechanics (scope representation, dependent recompute) are [PROVISIONAL
P6: pending a #23-owned purge-scope/cascade decision; no current #23
box scopes merge-admission cascade mechanics — box 3 owns sensitive
retained reference IDs, not this — and this ADR designs no cascade
here].

### 4.4 Imported deletion metadata grants no deletion power [FINAL]

Foreign tombstones and foreign registry digests never cause deletion of
local records and never silently invalidate unrelated local receipts.
They participate ONLY in conflict classification (§4.2, §4.3). In
particular, importing a foreign tombstone for ID X while local X is
live classifies as a conflict — it does not redact local X, and it
drops no local receipt.

## 5. Box 5 — what can and cannot be detected

### 5.1 Detection table [FINAL]

| Signal | Detectable? | Governing rule |
| --- | --- | --- |
| Locally blocked request_id reused (same ledger, same string) | Yes → refused | ADR 0005 rule 5 + ADR 0008 |
| Partial-purge survivor: same-ID live record re-imported | Yes → immutable-ID CONFLICT | Architecture invariants 2, 7 |
| Same-ID tombstone present on either side | Yes → `tombstone-collision` | ADR 0009 |
| Origin-less artifact claiming historical sameness | No: unknown origin never matches, including another unknown | ADR 0009 §1.2 |
| Rewritten request IDs (same content, new request_id) | No: a new recording act, not stopped | ADR 0005 rule 5, verbatim scope |
| Fully purged record IDs re-imported (foreign copy or fresh capture) | No — a record-ID reimport leaves no trace; the registry keys request IDs. Sole exception: an explicitly PAIRED shared-history re-supply of the purged request string refuses per C9 (P8 mechanics) | ADR 0009 §1.1 + §2.3 C9 |
| Newly keyed content (same bytes, new IDs, new request) | No: distinct records, never unified | ADR 0009 `different-ids-similar-text` |
| Foreign registry digest matching a local request_id string | Not consulted: different namespaces (unpaired). Under an explicit pairing, incoming foreign RECEIPT strings — not the foreign registry — are checked against the local registry per C9 | §2.1 + §4.3 C3/C9 |

### 5.2 No universal resurrection prevention [FINAL]

No universal resurrection prevention is claimed from a request-ID-only
registry (ADR 0005 rule 5 + the #23 box 5 direction + ADR 0009 §1.1).
Any merge documentation claiming otherwise is defective.

### 5.3 Uncertain admission refuses [FINAL]

Uncertain admission — any needs-decision classification, any §4.3
conflict — refuses the whole merge before anything is written and names
the colliding IDs and their classes (ADR 0009 §3A report requirement).
Silence is never admission.

### 5.4 Stronger memory needs its own amendment [FINAL requirement]

A record-ID-keyed purge log or equivalent content memory, with its own
retention-vs-privacy trade-off, requires a separately accepted privacy
amendment and is NOT designed here (ADR 0009 §6: "#23's to design —
not invented here"). This ADR adds no such memory.

## 6. Box 6 — privacy metadata across export and restore

### 6.1 Local registry survival [FINAL; ADR 0008 restatement]

A non-empty local registry MUST ride export; a registry-dropping export
is refused, never silently written; an empty registry is omitted; old
readers reject snapshots carrying `registry`; an unknown
`registry_version` is refused whole; legacy snapshots restore with an
empty registry and no backfill.

### 6.2 Imported privacy metadata [FINAL defaults; PROVISIONAL admission and pairing shapes]

- Any tombstone present locally exports as its tombstone body and
  restores under ADR 0008 rules. Export is total: no carving.
- Foreign registry digests never enter the local registry (§4.3 C3),
  hence never export as local registry entries. Their non-survival is
  explicit and FINAL: no in-ledger copy, no export row, no
  cross-attempt memory — so no merge decision may depend on
  remembering them across attempts. Each attempt's foreign-internal
  consistency check (§4.3 C4) runs only on the bytes that attempt
  presents; an operator who discards the artifact loses nothing the
  ledger ever promised to keep, and a later attempt is evaluated from
  its own bytes, never from recalled foreign digests.
- Distinct-ID foreign tombstone bodies: default REFUSE import [FINAL
  default, on this ADR's own §5.3 uncertain-admission rule: no
  settled rule admits a merge-carried tombstone, so none is
  admitted]. ADR 0008 rule 7 is cited only for what it decides —
  tombstones arise only from the redact path, and direct capture of
  `redacted: true` bodies is rejected — which neither permits nor
  forbids TRANSFER of an existing foreign tombstone. Any future
  merge-carried tombstone path is [PROVISIONAL P7: pending a
  #23-owned tombstone-transfer decision plus #31-final integration]:
  no current #23 box designs merge-carried tombstone admission, so
  P7 waits on a decision no box has yet scoped, not on "boxes 3–6"
  as a whole. Same-ID cases stay conflicts per §4.2 regardless.
  Until P7 settles, distinct-ID foreign tombstones are excluded from
  admitted imports: the merge refuses rather than carrying them
  (survival ledger below).
- Origin-mapping / preserved origin annotations, if operator-held, sit
  outside snapshot scope and must never leak into exports (ADR 0009 §6
  mapping privacy). Preservation-or-refusal [FINAL direction;
  PROVISIONAL pairing mechanics P11]: the operator MUST back up and
  restore the mapping atomically with the ledger it describes — a
  restore that cannot locate the mapping for prior imports MUST
  refuse repeated-import skip/replay decisions as uncertain (§5.3)
  rather than re-minting duplicates or skipping blindly. The pairing
  mechanics (backup binding, restore discovery, multi-ledger
  disambiguation) are [PROVISIONAL P11: pending #31-final
  integration], under FINAL privacy constraints: the paired backup
  must never live as ordinary in-ledger content that exports
  everywhere, must never reintroduce raw removed IDs into live
  audit, and must be cut or withheld from exports leaving the
  operator's control (§1.5 P3 constraints apply verbatim).
- Imported privacy-metadata survival ledger [FINAL]. Box 6 asks how
  imported privacy metadata survives; the answer per class:
  - Foreign registry digests: EXCLUDED — never admitted, never
    retained, never exported (above).
  - Distinct-ID foreign tombstone bodies: EXCLUDED from admitted
    imports until P7 settles — the merge refuses rather than
    carrying them (above).
  - Per-record origin annotation for ADMITTED records (foreign actor,
    foreign `created_at`): RETAINED in the entry envelope itself,
    byte-identical, surviving export/restore as ordinary entry bytes
    under total export (§3.2, §6.3).
  - Origin mapping (foreign ID + origin label → local ID) and any
    origin-receipt annotation beyond the envelope: retained ONLY in
    the P3 storage shape with P11 backup pairing. §3.2/P3 promise no
    other representation, so no other survival is claimed: a restore
    that cannot locate the mapping refuses repeat/import decisions
    as uncertain (§5.3) rather than re-minting or skipping blindly.

### 6.3 Partial selection [FINAL]

Merge selection is explicit; unselected records and edges are never
pulled in (§2.6); a selected record referencing an out-of-scope target
fails the merge (ADR 0009 §6). Export stays total (ADR 0005: no silent
or lossy export) — there is no partial export that carves tombstones
or registry entries.

### 6.4 Retention leakage [FINAL; restatements]

- The registry leaks the purge count plus membership for guessable
  request_ids (ADR 0005 rule 5, verbatim); privacy-sensitive merges
  therefore use unguessable local merge request_ids.
- The origin mapping reveals imported IDs, including IDs the foreign
  ledger later purges (ADR 0009 §6); it is cut or withheld from exports
  that leave the operator's control.

### 6.5 Malformed and future-version input [FINAL]

Strict validation refuses malformed merge input whole (existing
VALIDATION behavior; ADR 0008 matrix spirit). An unknown
`registry_version` — local or incoming — refuses whole, never
partially. There is no downgrade path that drops privacy metadata.

### 6.6 Adversarial cases [FINAL deliverable]

Synthetic adversarial cases with required expected results live in
`test/fixtures/merge-retries/adversarial-cases.json` and are asserted
by `test/merge-retries.test.mjs` (§9). Later implementation tests MUST
reproduce these expectations; any implementation that admits a
must-refuse case, or silently drops a must-preserve artifact, is
non-conformant.

## 7. Schema-extension watchlist (identified, not designed, not implemented)

1. Origin-mapping storage IF ledger-stored (new table) — shape
   PROVISIONAL P3 (§1.5).
2. Merge-request fingerprint preimage schema (artifact digest +
   selection + policy-label + import-namespace + pairing-declaration
   encoding) — PROVISIONAL P1 (§1.1).
3. Zero-create merge receipt persistence — shape PROVISIONAL P9
   (§1.5): the current receipts row requires 1–200 IDs and cannot
   record an all-equal or fully-repeated merge. Candidates (relaxed
   `ids`, merge-operation record, no persisted receipt) are listed,
   not selected. The interim rule is FINAL: such merges refuse until
   P9 settles.
4. Merge-operation bundle/record carrying the importer actor — shape
   PROVISIONAL P10 (§1.5, §3.1): receipt rows have no actor field.

Beyond the four identified items: no record-type change, no
snapshot-version bump, no registry-encoding change. The earlier
"no other schema change" conclusion is revised: items 3–4 are now
explicitly identified because §1.5 previously promised a receipt
shape that cannot record zero-create merges or the importer actor.

## 8. No-expansion audit vs ADR 0005 [FINAL]

This ADR adds NO new deletion power and NO new memory:

- No new purge/redact path; no in-ledger purge audit — purged IDs still
  vanish, including from audit.
- No content-remembering and no record-ID-keyed blocking — the Box 5
  limits stand.
- No silent invalidation of local receipts (§4.4); no automatic union
  of foreign blocklists (§4.3 C3).
- No weakening either: barriers apply BEFORE remap (§4.1), and
  tombstone conflicts stay conflicts (§4.2).

Any implementation reading this ADR as permission to delete, to
remember content, to auto-union foreign blocklists, or to admit
uncertain material is non-conformant.

## 9. Fixtures (this issue)

Synthetic fixtures under `test/fixtures/merge-retries/`, asserted by
pure tests with no DB mutation (`test/merge-retries.test.mjs`). Every
ledger ID, request_id, actor, and text below is synthetic.

- `merge-requests.json`: Box 1 retry pairs — same request + same
  artifact/selection/policy/namespace/pairing replays, any difference
  conflicts (including changed-namespace and changed-pairing pairs),
  transport/process IDs excluded from retry identity, and the
  receipt-shape limits (zero-create unwritable under the 1–200 `ids`
  schema with a FINAL refuse-until-P9 interim, P9; no actor field on
  receipt rows, P10).
- `receipt-namespaces.json`: Box 2 — equal request strings in unrelated
  ledgers, copied-ledger exact/diverged pairs, repeated-import
  same-namespace zero-create refusal (FINAL interim, P9) and
  different-namespace outcomes, overlapping selections with the
  equality gate (skip only on exact-content match, changed entries
  conflict), and foreign receipts reaching outside the selection.
- `origin-preservation.json`: Box 3 — importer identity on the merge
  operation only, byte-identical foreign actor/`created_at` on imported
  entries, and URL/path/DOI strings proving no origin.
- `barrier-order.json`: Box 4 — local-registry-before-admission checks,
  the §4.3 C1–C9 combination table, same-ID tombstone/full-body
  conflicts plus the cross-record Verification reference refusal
  (C6, both selection shapes — the Evidence+Verification shape
  supplying the selected Evidence) and its C7 symmetric case, the
  shared-history barrier with its unpaired contrast (C9, P8), and
  imported deletion metadata granting no deletion power. C8
  precedence is asserted as fail-closed only (P5).
- `detection-limits.json`: Box 5 — the §5.1 table as machine-checkable
  cases, including the must-NOT-claim universal-prevention row, with
  the C9 paired-ledger exception qualified on the fully-purged and
  foreign-registry rows.
- `privacy-survival.json`: Box 6 — registry export/restore survival,
  unknown-version refusal, total-export (no carving), leakage-shape
  notes, malformed-input refusal, foreign-digest explicit
  non-survival, the imported privacy-metadata survival ledger
  (per-class retained/excluded), and the operator-held mapping
  preservation-or-refusal rule (P11 mechanics).
- `adversarial-cases.json`: Box 6 — adversarial synthetic cases with
  required expected results: request-string reuse, receipt smuggling,
  namespace spoofing via content strings, body restoration via a
  foreign full copy, verification-straggler import (Evidence+Verification
  and Verification-only selections), foreign-registry smuggling, and
  laundered replay under a new request_id (expected: admitted-as-new,
  documenting the §5.1 limit).

Where a fixture encodes a PROVISIONAL clause, it asserts only the
decidable part and carries a `provisional` marker naming the exact
pending dependency (P1–P11); the test fails if the marker is missing or
names an unknown dependency.

## 10. Provisional register (normative)

| # | Clause | Pending on |
| --- | --- | --- |
| P1 | Merge-request fingerprint composition (artifact digest + selection + policy-label + import-namespace + pairing-declaration encoding) | #31-final integration (merge-request schema) + winner-selection ADR (ADR 0009-deferred policy) |
| P2 | One receipt per merge vs one receipt per admitted batch | #31-final integration |
| P3 | Origin-mapping + preserved-origin storage shape (ledger table vs operator-held artifact) | #31-final integration |
| P4 | Per-ID selective continuation after conflict (cut-down-and-proceed mechanics) | #32 selection/planning mechanics |
| P5 | Registry-vs-receipt lookup precedence on merge admission (beyond fail-closed C8) | #23 box 4 (registry lookup semantics incl. merge admission) |
| P6 | Purge-scope overlap mechanics on admission (scope representation, dependent recompute; the overlap refusal itself is FINAL) | #23-owned purge-scope/cascade decision (no current #23 box scopes merge-admission cascade mechanics; box 3 owns sensitive retained reference IDs) |
| P7 | Distinct-ID foreign-tombstone admission shape (default refuse is FINAL) | #23-owned tombstone-transfer decision (no current box scopes it; 0008 rule 7 covers direct capture only) + #31-final integration |
| P8 | Shared-history (copied-ledger) receipt-vs-registry barrier lookup mechanics (timing vs classification, precedence, report shape) | #23 box 4 (merge-admission lookup semantics) |
| P9 | Zero-create merge receipt persistence (relaxed ids vs merge-operation record vs no persisted receipt) | #31-final integration |
| P10 | Merge-operation bundle/record shape carrying the importer actor | #31-final integration |
| P11 | Operator-held mapping backup/restore pairing mechanics (binding, discovery, disambiguation; fail-closed direction FINAL) | #31-final integration |

Per-box status: Box 1 FINAL except P1–P3, P9–P10; Box 2 FINAL except
P4, P8; Box 3 FINAL except P3, P10; Box 4 FINAL except P5–P6, P8;
Box 5 FINAL; Box 6 FINAL except P7, P11.

## Reasons

- Three identities keep three failure modes apart: retry confusion
  (wrong replay/CONFLICT), artifact confusion (rewriting foreign
  bytes), and history confusion (forged local execution via foreign
  receipts).
- Ledger-scoped request_ids plus never-install make equal foreign
  strings harmless by construction, instead of relying on global
  uniqueness that does not exist.
- Barriers-before-remap closes the laundering path where a rewrite
  step could wash a blocked request into an admittable shape.
- Stating detection limits as FINAL rules (not aspirations) keeps the
  later implementation honest: Box 5 rows are testable refusals to
  claim.

## Alternatives considered

- Global request-ID uniqueness across ledgers: rejected — unenforceable
  without a global ID service, which is an explicit non-goal.
- Installing foreign receipts when IDs happen to coincide: rejected —
  §2.2 shows the condition never holds in a merge, and installing them
  would forge local execution history.
- Automatic union of foreign registry digests into the local registry:
  rejected — a non-goal that would let a foreign ledger veto unrelated
  local request strings and silently expand ADR 0005's memory.
- Checking foreign receipt request_ids against the local registry:
  rejected in the unrelated-ledger case — different namespaces (§2.1);
  string equality across ledgers proves nothing, so the check would
  refuse unrelated merges and miss real replays alike. The sole
  exception is the explicitly paired shared-history case (§2.3 C9),
  where the operator's pairing declaration makes the strings denote
  one historical act; its lookup mechanics are PROVISIONAL P8.
- Merge-minted local tombstones for distinct-ID foreign tombstones:
  not selected — ADR 0008 rule 7 reserves tombstone creation to the
  redact path; any exception needs #23-owned semantics (P7), not a
  silent side door here.

## Costs

Spec-only: no behavior change, no migration, no new CLI surface. Cost
is review time plus the later #31-final integration ADR that settles
P1–P4, P7, and P9–P11, the #23-owned purge-scope/cascade decision that
settles P6, the #23 box 4 slice that settles P5 and P8, and the
#23-owned tombstone-transfer decision behind P7. Until then every
conflict and
every uncertain admission refuses, so no merge can silently corrupt a
ledger or bypass a privacy decision.

## Revisit when

- #31-final integration lands (settles P1–P4, P7, P9–P11), the
  #23-owned purge-scope/cascade decision lands (settles P6), #23 box
  4 lands (settles P5, P8), or the #23-owned tombstone-transfer
  decision lands (unblocks P7) —
  expected as amendments resolving the register, not silent
  reinterpretation.
- A winner-selection ADR is accepted (fills the policy-label half of P1).
- A second registry encoding or tombstone reason is proposed.
