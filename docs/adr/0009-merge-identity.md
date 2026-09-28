# ADR 0009 — Foreign identity, exact equality, and collision options

Status: Proposed for owner review / 2026-09-28 (issue #30, parent #16, coordination #22, sibling #23)

Current `import` is whole-snapshot restore into an empty ledger only. Before
any merge exists, this ADR defines what it means for two records from
different ledgers to be the same, classifies every collision the merge
planners (#31, #32, #34–#36) must handle, and compares the resolution
options. **The final same-ID/different-content winner is NOT selected here:**
`needs-decision` rows refuse by default until the owner picks a policy in a
later accepted ADR. Spec only: no command, no migration, no record rewriting,
no activated policy. The executable companion is the pure module
`src/core/mergeIdentity.ts` plus `test/merge-identity.test.mjs`; both
classify only and resolve nothing.

Shared vocabulary with the deletion track is reused, not redefined: purge,
redact, tombstone, and the replay-prevention registry keep the meaning of
ADR 0005. Issue #23 owns the tombstoned-body representation and the registry
contract; this ADR only names the collision cases where those artifacts meet
a merge, and defers registry interaction on merge admission to #31. No
snapshot-format renumbering, no new record types, no schema change.

## 1. Definitions

### 1.1 Local identity

A record's local identity is its bare ledger ID (contract grammar:
leading letter, 2–128 chars of `A-Za-z0-9_.:-`). It is meaningful only
inside its own ledger. An ID that survives — live or tombstoned — is
immutable once written and never reassigned: the storage triggers still
reject UPDATE/DELETE, and no merge outcome below overwrites an existing
ID. That guarantee ends at purge: a truly purged ID leaves no record-ID
trace (the #23 replay registry keys blocked request IDs, not record
IDs), so recreation under a purged ID cannot be ruled out. This ADR
promises no global historical uniqueness and no content-based
anti-resurrection, per the #23 box 5 direction; new recordings should
use fresh IDs, but an absent record ID proves nothing about the past.

### 1.2 Origin identity

A record's origin identity is the comparison-time pair `(origin, id)`:

- `origin` is an out-of-band ledger label established by the operator at
  merge time (for example "the ledger file I exported yesterday"), NOT a
  stored field. Snapshots carry no origin field, so any snapshot without
  operator-supplied provenance compares as origin-unknown (`null`).
- An unknown origin never matches anything, including another unknown:
  two origin-less snapshots cannot prove they are the same ledger even
  when their IDs coincide (see §4 copied-ledger and legacy cases). A
  missing or empty label is unknown: only a known, nonempty
  operator-supplied label can match, and two missing/empty labels never
  compare as the same origin.
- **A ledger path, self-declared name, DOI, URI, or similar text is not
  proof of origin.** Those strings are content claims inside records, and
  content claims can be copied, mistyped, or forged. The design already
  refuses to merge sources on matching DOI/URL alone (design §4); the same
  holds for ledger identity. Only the operator's explicit pairing of two
  ledger artifacts establishes a shared origin, and even then it proves
  shared history, not the right to unify diverged records.

### 1.3 Exact-entry equality

Two entries are exactly equal when ALL of these hold:

1. same ID, same record type;
2. same body — every content field, including `attributed_to`, `scope`,
   `why`, quotes, locators, rationale, stance, and reference targets;
3. same actor (recorder identity: kind, id, and model/run qualifiers);
4. same `created_at`.

Bodies and actors compare under canonical JSON: object keys sorted
recursively, so key ORDER is forgiven. Nothing else is forgiven:

- **Strings compare byte-identically.** No trimming, no case folding, no
  Unicode normalization (NFC vs NFD differ), no fullwidth/halfwidth
  folding, no quote rewriting, no whitespace collapsing. `canonicalJson`
  matches the ledger receipt digest's treatment of stored strings.
- **Search normalization must never feed an equality test.** The ledger
  lowercases and NFKC-folds for retrieval (`normalize` in model.ts), so
  `CO2` and `ＣＯ２` retrieve together — but as stored entries they are
  different bytes and therefore NOT exactly equal.
- **A body match with a different recorder or time is NOT silently
  identical.** Matching bytes recorded by a different actor, or at a
  different instant, classify as `different-provenance`: a conflict with
  the same handling as `different-body` (§3, §4). Recorder and time are
  provenance, and provenance is part of what the ledger preserves.
- Attribution is part of the body: a claim text match with a different
  `attributed_to` (or a different `scope`) is a different body, not an
  equal entry.

Exact-content equality (same comparison ignoring the ID) exists only to
analyze cross-ledger pairs; an equal result NEVER authorizes unification
(§5, `different-ids-similar-text`).

## 2. Collision classes for a same-ID pair

| Class | Meaning | Default |
| --- | --- | --- |
| `same-entry` | Exactly equal (§1.3) | Allowed: skip byte-identically |
| `different-body` | Same ID, different type or body bytes | Conflict → needs-decision |
| `different-provenance` | Same body, different actor or `created_at` | Conflict → needs-decision |
| `tombstone-collision` | A redaction tombstone on EITHER side | Privacy-sensitive conflict → needs-decision |

A tombstone on either side short-circuits every other comparison: even a
byte-identical tombstone pair is a `tombstone-collision`, because the
redaction marker carries its own reason/time semantics owned by #23, and
even a full-body-vs-tombstone pair must never resolve by copying the
surviving body across (restore-the-body is refused, §4). Classification
therefore requires an explicit caller-supplied tombstone detector; there
is no "assume not a tombstone" default, so a pair that cannot be checked
fails closed instead of silently passing as `same-entry`.

Examples (synthetic; `T`/`U` are distinct timestamps, `R`/`S` distinct actors):

- `same-entry`: local `(clm_a, claim, {text:"X",…}, R, T)` vs incoming
  `(clm_a, claim, {text:"X",…}, R, T)` with keys in any order → skip.
- `different-body`: same IDs, incoming `text:"X!"` (one byte differs) →
  conflict. Also: same bytes but `attributed_to` differs, or `scope`
  differs, or record type differs (a claim vs a review sharing one ID).
- `different-provenance`: same IDs, byte-identical bodies, incoming actor
  `S` instead of `R` (or `created_at` `U` instead of `T`) → conflict, not
  a silent skip. The incoming copy attests a different recording act.
- `tombstone-collision`: local `clm_a` is a tombstone (reason: pasted
  secret) while incoming `clm_a` still carries the full body → conflict;
  the body must not flow back into the redacted ledger, and the tombstone
  must not silently delete the incoming account either.

Failure cases each class must survive:

- NFC/NFD doppelgangers (`é` composed vs decomposed), fullwidth digits,
  trailing spaces, and reordered keys: only reordered keys compare equal.
- Clock skew and re-exports: equal timestamps never prove equal recorders,
  and equal recorders never prove equal instants; both must match.
- Type confusion: same ID, same `target_id`-shaped payload, but one side a
  review and the other a relation → `different-body` (type participates).

## 3. Option comparison

Three options, each with an explicit worked example and its failure cases.
"Incoming" below is the foreign ledger's account of ID `clm_k`; "local" is
the existing immutable record under `clm_k`. In every example the bodies
differ (local text `"dose X"`, incoming text `"dose Y"`).

### Option A — Refuse the whole conflicting merge

Behavior: any `needs-decision` pair fails the merge before anything is
written (one transaction, nothing partial). Exact-equal pairs and
collision-free imports may still proceed only if the merge request is cut
down to exclude the conflict; the refused IDs are reported explicitly.

- Benefit: no hidden loss, no rebinding, smallest predictable policy. The
  user resolves the conflict outside the ledger (new IDs, explicit
  supersedes, corrected re-export) and retries.
- Cost: every meaningful conflict needs user resolution; large merges
  with one collision refuse wholesale unless the request supports
  explicit per-ID selection (selection mechanics belong to #31/#32, not here).
- Failure cases: none data-corrupting by construction — but a refusal
  report that omits WHICH ids collided, or that rolls back without naming
  the winning bytes on each side, strands the user. The report format is
  deferred to the planner (#34); this ADR only requires that refusal names
  the colliding IDs and their classes.

### Option B — Prefer local / prefer incoming

Two asymmetric sub-options with different hazards.

**Prefer local (keep `clm_k` = `"dose X"`, skip the incoming `"dose Y"`):**

- Benefit: existing records stay immutable; local dependents keep meaning.
- Failure case 1 — silent loss: reporting success while discarding the
  incoming `"dose Y"` account. Refused unconditionally (§5
  `silent-prefer-local`): a local preference must name every skipped ID
  and return a qualified (partial) result, never an unqualified "merged".
- Failure case 2 — misbinding: the incoming ledger's assessments,
  relations, reviews, or verifications that target `clm_k` meant `"dose Y"`.
  Rebinding those dependents onto the local `"dose X"` record silently
  changes what they attest. Any supported local preference must either
  import those dependents against an explicit new record carrying the
  incoming account (converging toward fork, §3C) or refuse them loudly —
  never re-point them at a different meaning without a trace.

**Prefer incoming (make `"dose Y"` available):**

- Benefit: the selected incoming account becomes usable locally.
- Hard boundary: **overwriting the existing immutable ID is prohibited.**
  UPDATE of `clm_k`'s body violates the immutability every other feature
  relies on (receipts, review history, verification pins) and is refused
  unconditionally (§5 `overwrite-immutable-id`).
- The only supportable shape is an explicit new-record/history mechanism:
  the incoming account arrives under a NEW local ID (fresh history), with
  a `supersedes` relation and/or reviews recording the succession — the
  same correction pattern the contract already uses for ordinary fixes
  (contract §"States and corrections"). The old record stays readable;
  nothing is rewritten. That mechanism's exact shape (ID minting, required
  relations, receipt linkage) is NOT designed here; it belongs to the
  planner issues once a winner is selected.
- Failure case: minting the "new" record under the SAME id after deleting
  or hiding the old one. That is overwrite with extra steps and is equally
  refused. Fresh history means a fresh ID.

### Option C — Fork / remap (retain both accounts)

Behavior: both accounts survive. The incoming graph is imported with its
IDs systematically rewritten into fresh local IDs, plus an explicit origin
mapping `(incoming origin, incoming id) → local id` preserved alongside
the import. Local `clm_k` (`"dose X"`) is untouched; the incoming account
arrives as e.g. `clm_k_m1` (`"dose Y"`) with all its references re-pointed
inside the remapped graph.

Mapping keys require distinct incoming origins. The key `(incoming
origin, incoming id)` collides whenever two unrelated imports share both
halves — in particular, two legacy origin-less snapshots containing
`clm_k` both produce `(null, clm_k)`, and one slot cannot preserve both
mappings. Such a fork refuses until the operator supplies a distinct
import namespace (a known, nonempty label per import, like any other
origin label) so the keys no longer collide. The namespace mechanics
(how it is supplied, recorded, and replayed) belong to #31; this ADR
only fixes the refusal rule.

- Benefit: no loss on either side; competing accounts stay comparable.
- Costs and obligations (normative for any future fork design):
  1. **Rewritten fields** — every outbound reference in the imported graph
     must be rewritten, with no silent dangling (§6 inventory).
  2. **ID grammar and collisions** — remapped IDs stay inside the contract
     grammar; any collision with a live local ID refuses the merge (§6).
  3. **Event targets** — Review and Verification targets are references
     and rewrite like any other; imported reviews/verifications never
     silently change local effective state or anchor summaries (§6).
  4. **Receipts** — original foreign receipts are never forged or reused
     as local execution receipts; the import mints fresh local receipts
     under new request IDs (§6).
  5. **Origin-mapping privacy** — the mapping reveals which foreign IDs
     were imported and may leak purged IDs; it must never reintroduce raw
     removed IDs into live audit (§6, coordinated with #23).
- Failure cases: a fork that rewrites bodies but misses one reference
  field silently rebinds that edge onto a same-ID local record with
  different meaning (the prefer-local misbinding, laundered through new
  IDs); a fork that copies foreign receipts lets a replayed foreign
  request ID claim local execution history it never had; a fork that
  embeds raw purged IDs in its mapping resurrects what purge removed.
  Each is refused by the rules above.

### Comparison summary

| Option | Loss | Rebinding risk | Immutability | User burden |
| --- | --- | --- | --- | --- |
| Refuse | None (nothing written) | None | Untouched | Resolves every conflict externally |
| Prefer local | Silent unless loudly qualified | Foreign dependents misbind unless refused/redirected | Untouched | Must audit skipped IDs |
| Prefer incoming | Local account hidden unless history kept | Local dependents now read new meaning unless succession explicit | Violated if UPDATE; kept only via new-record/history | Must follow succession links |
| Fork/remap | None | None IF the whole graph rewrites consistently | Untouched (new IDs) | Must navigate duplicate accounts + mapping |

No option is selected by this ADR. The adopted option(s), defaults, and
the unresolved-case refusal rule belong to a later owner-accepted ADR
after #31/#32 complete.

## 4. Case coverage

Every case from issue #30, with the governing rule:

1. **Same ID / same entry** → `same-entry` → allowed; skip without
   writing. The incoming copy adds no content record, no review, and no
   foreign receipt. That is about the skipped pair only: whether the
   merge run itself mints a local operation receipt (so an all-equal
   request keeps a stored identity for retry rejection) belongs to #31.
2. **Same ID / different body** → `different-body` → needs-decision
   (default refuse). Includes type mismatches and one-byte body edits.
3. **Different provenance** → `different-provenance` → needs-decision.
   Identical bodies under different actors/times attest different
   recording acts; treating them as one silently merges provenance.
4. **Same text / different scope** → allowed as DISTINCT records with
   DIFFERENT IDs. `"dose X works"` scoped to "adults" vs "children" are
   two claims that import side by side; unification is refused
   (`auto-unify-similar`). The same ID with a different scope is
   `different-body`, a conflict — this row never covers a same-ID pair.
5. **Different IDs / similar text** → allowed as DISTINCT records.
   Shared DOI/URI, paraphrases, or fuzzy similarity never unify; each ID
   keeps its own dependents. Exact-content equality may FLAG candidates
   for human review but never merges them.
6. **Legacy origin-less snapshots** → origin `null` on both sides. Exact-
   equal pairs skip (`legacy-origin-less-exact`); any same-ID divergence
   conflicts (`legacy-origin-less-diverged`). No origin label may be
   invented from paths, names, or DOI text to break the tie.
7. **Duplicate origins after copying a ledger** → the copy shares history
   but each ledger is now its own authority. Exact-equal pairs skip
   (`copied-ledger-exact`); diverged same-IDs conflict
   (`copied-ledger-diverged`). Shared past does not pick the survivor.
8. **Redacted / full versions of one ID** → `redacted-vs-full` →
   privacy-sensitive needs-decision. Neither the body (into the redacted
   ledger) nor the tombstone (as a silent delete of the full account) may
   flow implicitly. Tombstone body shape and reason hygiene ("reasons must
   not copy the removed secret") stay owned by #23.
9. **Tombstone collision** → `tombstone-collision` → privacy-sensitive
   needs-decision. A tombstone meeting any same-ID counterpart — full body
   OR another tombstone — is a conflict, never an invitation to restore
   the removed body. Tombstone-vs-tombstone still conflicts because
   redaction reason/time are themselves significant and #23-owned.

Cross-cutting: malformed or future-version snapshots, partial selections,
and repeated requests are #31/#32 territory; #23 owns the replay registry
consulted on merge admission and the limits of detecting newly-keyed
resurrection. This ADR only requires that none of those mechanisms
reintroduce raw removed IDs into live audit or silently delete local data
on foreign say-so (per #16 gates).

## 5. Outcomes

Allowed / refused / needs-decision table (executable copy:
`MERGE_IDENTITY_OUTCOMES` in `src/core/mergeIdentity.ts`):

| Case | Outcome | Notes |
| --- | --- | --- |
| same-id-same-entry | allowed | Skip byte-identically; no content write (operation receipt owned by #31) |
| same-id-different-body | needs-decision | Default refuse; winners unselected |
| same-id-different-provenance | needs-decision | Never silently identical |
| same-text-different-scope | allowed | As distinct records with different IDs; unification refused |
| different-ids-similar-text | allowed | As distinct records; auto-merge refused |
| legacy-origin-less-exact | allowed | Skip; unknown origin proves nothing more |
| legacy-origin-less-diverged | needs-decision | No invented origin breaks the tie |
| copied-ledger-exact | allowed | Shared history skips; no identity claimed |
| copied-ledger-diverged | needs-decision | Shared past picks no survivor |
| redacted-vs-full | needs-decision (privacy) | Never restore the body |
| tombstone-collision | needs-decision (privacy) | Never restore-the-body |
| auto-unify-similar | refused | Similarity is not identity, unconditionally |
| overwrite-immutable-id | refused | No UPDATE of existing IDs, unconditionally |
| silent-prefer-local | refused | No silent discard/misbind, unconditionally |

"Allowed" never means "rewrite": allowed same-entry pairs write no
content records for the skipped pair (no record, no review, no foreign
receipt), and allowed distinct-ID rows import side by side. A local
merge-operation receipt for retry identity is not a content write and is
not precluded here — its shape belongs to #31. "Refused" rows fail the
merge even after a policy is selected. "Needs-decision" rows refuse by
default until the owner accepts a winner.

## 6. Fork inventory (normative for any future fork design)

If fork/remap is ever selected, the design MUST specify all of the
following; anything unspecified refuses the merge.

**Rewritten reference fields** (executable copy:
`FORK_REWRITTEN_REFERENCE_FIELDS`, cross-checked against `references()`):

| Record type | Fields rewritten |
| --- | --- |
| source | — (no outbound references) |
| claim | — (no outbound references) |
| evidence | `source_id` |
| assessment | `claim_id`, `evidence_id` |
| relation | `from_claim_id`, `to_claim_id` |
| review | `target_id` |
| verification | `target_evidence_id`, `target_source_id` |

Each imported reference points at the remapped ID of its target; a target
outside the import scope fails the merge (no silent re-pointing at a
same-ID local record, no dangling edges). Bodies otherwise stay
byte-identical, including quotes, scope, rationale, and actor/created_at:
the remap changes addressing, not testimony.

**ID length / collision handling:** remapped IDs MUST satisfy the ledger
ID grammar (leading letter, 2–128 chars; `isLedgerId` states the check).
The minting scheme is deferred to the merge planner (#34), but every
scheme must guarantee: no truncation or coercion into grammar (refuse
instead), no collision with a live local ID (refuse instead), and
deterministic re-derivation so that re-running the same approved import
replays instead of duplicating (idempotency per #16).

**Event targets:** Review and Verification records are events against
targets, and their target fields rewrite exactly like other references.
Two further rules: (a) an imported Review lands as history inside the
remapped graph — it must not silently change any LOCAL record's effective
working state (no adopting a foreign accept/reject by insertion order);
(b) an imported Verification is provenance about a foreign check — it must
not present as a new local anchor check, and anchor warnings on local
records derive only from local verification history. Effective-state
ordering across the combined graph is owned by #32.

**Receipts:** foreign capture receipts describe foreign executions. A fork
must never copy them as local receipts (that would forge local execution
history and let a replayed foreign request ID claim work this ledger never
did). The import mints fresh local receipts under NEW request IDs, per the
#16 direction ("do not reuse imported capture receipts as local execution
receipts"). The exact receipt linkage for replays of one approved import
belongs to #31 (local retry identity vs origin receipts).

**Origin-mapping privacy:** the `(incoming origin, incoming id) → local id`
mapping reveals which foreign records were imported — including, over
time, IDs the foreign ledger later purged. The mapping therefore must not
live as ordinary in-ledger content that exports everywhere, must never
reintroduce raw removed IDs into live audit, and must be cut or withheld
from exports that leave the operator's control. The storage shape (ledger
table vs operator-held artifact) and its interplay with the #23 replay
registry are deferred to #31; this ADR only fixes the constraint within
what the merger can know: no fork design passes review if it resurrects
an ID the merger can know is removed — a surviving tombstone, or a
request replay the #23 registry flags — or if it silently ships the
mapping. That guarantee ends where §1.1's does: a truly purged ID
re-imported under a NEW request ID is undetectable to the merger, because
the #23 replay registry keys blocked request IDs, not record IDs. No fork
design can promise to block what it cannot see; claiming otherwise would
need a record-ID-keyed purge log or equivalent, with its own
retention-vs-privacy trade-off, which is #23's to design — not invented
here.

## 7. Explicitly unsupported (unselected alternatives)

The following are NOT supported by this ADR and must fail explicitly if
requested; selecting any of them needs a new owner-accepted ADR:

- silent prefer-local (success reported while discarding conflicts);
- prefer-incoming by UPDATE/overwrite of an immutable ID (including
  delete-then-recreate under the same ID);
- credibility-, recency-, or reputation-based automatic winners;
- automatic near-duplicate / fuzzy / DOI/URI-based merging or unification;
- global identity service, cross-ledger ID registry, or content-addressed
  deduplication across ledgers;
- adopting foreign Reviews as local working state by insertion order;
- presenting imported Verifications as local anchor checks;
- a fork that skips any §6 obligation (partial rewrites, forged receipts,
  mapping that leaks purged IDs).

## 8. Consequences

- Merge planners (#31, #32, #34–#36) inherit fixed vocabulary
  (local/origin identity, exact-entry equality, the four same-ID classes),
  a fixed outcome table, and fixed fork obligations. They design selection,
  retry identity, ordering, planning, application, and CLI — not new
  meanings for "same".
- The pure module + conformance tests give #33 an executable oracle for
  classification without pre-empting any resolution behavior.
- Owner burden: one reviewable decision document now, plus one later
  winner-selection ADR after #31/#32. Until then every conflict refuses,
  so no merge can silently corrupt a ledger.

## 9. Costs and revisit

Spec-only: no behavior change, no migration, no new CLI surface. Cost is
review time plus the later winner-selection ADR. Revisit when #31/#32
complete (winner selection), when the first real cross-ledger merge is
attempted (case coverage gaps), or when #23's tombstone/registry contract
lands (confirm the privacy-sensitive rows still line up — any drift is
resolved by amending this ADR, not by silent reinterpretation).
