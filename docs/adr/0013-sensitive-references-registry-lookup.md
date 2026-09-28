# ADR 0013 — Sensitive references, purge-scope confirmation, and registry lookup order (supplement to ADR 0005 / ADR 0008)

Status: Proposed / 2026-09-28 (issue #23, slice 2: boxes 3–4)

This ADR supplements ADR 0005 and ADR 0008; it does not reinterpret
either. It closes the next two persistence/identity points 0005
deferred: what happens when retained metadata is itself sensitive
(box 3), and in what order the replay registry is consulted on every
admission path (box 4). Boxes 5–6 of #23 (post-purge identity limits,
remaining fixtures) are the follow-up slice and are explicitly out of
scope here.

Coordination: issue #31 / ADR 0011 marks two provisional items
pending exactly these boxes (P5 registry-vs-receipt precedence, P8
shared-history lookup mechanics); this ADR settles the #23-owned
halves (§22–§23, mapping in §25). It settles neither P6
(merge-admission purge-overlap mechanics: 0011 §4.3 scopes it to a
#23-owned decision no current box covers) nor P7
(tombstone-transfer: likewise unscoped), and it renumbers nothing —
the mapping names 0011's markers verbatim. Issue #32 / ADR 0012 takes
plan/apply parity and the planning-fingerprint coverage from §24.
Rule numbering continues ADR 0008 (§§14–24) so cross-references stay
stable.

## Decision

### Box 3 — sensitive retained items and the purge-scope flow

14. Retained-items inventory (normative). A redact over scope S would
    leave, per record, exactly the 0008 §§8–9 remainder: the envelope
    (`id`, `type`, `actor`, `created_at`), the kind's reference
    targets (`source_id`; `claim_id` + `evidence_id`;
    `from_claim_id` + `to_claim_id`; `target_id`;
    `target_evidence_id` + `target_source_id`; none for Source/Claim),
    and the marker (`redacted`, `reason`, `redacted_at`). The future
    redact path MUST derive this list per record and show it to the
    operator before redacting anything. Sensitivity is operator
    judgment: the tool surfaces retained items, it never infers which
    are sensitive.
15. Sensitive routing refuses the redact whole. When the operator
    marks ANY retained item sensitive — a reference target ID, the
    record's own ID, actor, or timestamp — redact is the wrong tool
    (0005 rule 6): it cannot remove retained items while preserving
    links. The redact request is refused whole with a routing report
    listing, per record, the retained items and their sensitivity
    flags. There is no implicit split: the request as stated cannot
    be satisfied, and silently redacting a subset would change what
    was asked. The operator then issues a narrowed redact for the
    non-sensitive remainder (a new request) and, separately, a purge
    (§§16–17) for the sensitive part. The routing report is
    operator-held, like the 0005 pre-delete export: it is never
    written into the live ledger. Sensitivity attaches to the
    retained VALUE, not the reporting cell: flagging an item marks
    that value sensitive wherever the ledger retains it — the same
    string or actor object in another record's envelope or
    references is the same leak and joins the purge scope (§16b),
    while records retaining only unflagged values stay outside and
    may form the narrowed redact. The operator flags per-record
    cells; the flow expands to every bearer of each flagged value.
16. Proposed purge scope. Whether routed from a sensitive redact or
    requested directly, a purge starts from a PROPOSED scope P,
    computed and shown in full before anything executes:
    (a) the named records, PLUS (b) for routed purges, every record
    bearing a sensitive VALUE, flagged cell or not — purging only
    the flagging record would leave the value live under another
    bearer. PLUS
    (c) the transitive dependent closure: every surviving record
    whose `references()` target lands in P joins P, closed to a
    fixpoint (0005 rule 4: no dangling dependents; the cascade is
    computed, shown, and confirmed). The proposal lists doomed IDs,
    each cascaded dependent with the pulling reference
    (dependent ID, role, target ID), the affected receipts
    (request_ids whose `ids` intersect P — dropped per 0005 rule 5 —
    plus §19 redaction-dropped requests when P includes tombstones),
    and the registry additions (§19). Dependents that merely might
    quote the secret (Reviews, Assessments, Relations) join P like
    any other dependent: purge, unlike redact (0008 §12), has no
    surface-for-confirmation middle ground — the scope expands or
    the purge is abandoned. There is no keep-the-dependent-by-editing
    path: records are immutable.
17. Separately-confirmed semantics. The purge executes only on a
    confirmation act DISTINCT from both the original redact request
    and the proposal computation: propose shows, confirm executes,
    never one blind act. The proposal step completes separately and
    returns the proposal (proposal_id, computed_at, doomed set); a
    confirmation counts as a distinct act only when it binds to that
    returned proposal — naming the proposal_id, echoing the returned
    computed_at, and carrying bundled_with_redact_request explicitly
    false. Omission of any binding refuses fail-closed. The original
    redact request never implies purge consent, and no flag bundled
    with it can pre-confirm; a bundled or implied confirmation is
    invalid, and a later timestamp alone never establishes a later
    act. The confirmation MUST match the proposal exactly (doomed
    set equality); any drift — the ledger advanced, the recomputed
    scope differs — refuses and re-proposes for fresh confirmation.
    This is the stale-binding shape in spirit (cf. ADR 0012 §4.4):
    approving scope P never executes scope P′.
18. Reason hygiene. Tombstone `reason` stays the 0008 §8 enum
    (`sensitive | wrong-scope`): a marker, never free text. It MUST
    NOT copy, quote, paraphrase, hash-pin, or otherwise encode the
    removed secret, any removed ID, or any removed content. No
    `detail`-style free-text field is added to the tombstone variant;
    `redacted_at` carries only the redaction time. A second reason
    value needs an ADR amendment, like a second registry encoding.

### Box 4 — digest computation and lookup/admission order

19. Digest computation and affected requests. `digest(R)` is the
    lowercase hex SHA-256 over the UTF-8 bytes of the exact
    `request_id` string R — no prefix, salt, domain tag, or
    canonicalization (request_ids already match the ledger ID
    grammar; encoding evolution rides `registry_version`, not the
    preimage). One entry per AFFECTED original request_id: a request
    is affected when its live receipt references at least one doomed
    record, and a purge spanning several requests blocks every
    affected one. Unaffected requests are never added. Blocking
    semantic: admission under request_id R is refused iff
    `digest(R)` is in the registry. Redact-then-purge continuity:
    redaction drops affected receipts per 0005 rule 5 while the
    tombstone ID survives, so a redacted request still fails closed
    on immutable-ID conflict; purging that tombstone later removes
    the last ID barrier, so deriving affected requests from live
    receipts alone would add no digest and re-admit the original
    bundle. A purge whose doomed set includes a tombstoned record
    MUST therefore treat the redaction-dropped request_id(s) —
    recovered from the operator-held redaction pre-delete export
    (0005 rules 2–3), never from live receipts — as affected
    alongside live-receipt touches, and block every such original
    request_id. The proposal lists redaction-dropped requests
    separately from live-receipt touches. Supply and matching: the
    proposal step takes the operator-held redaction pre-delete
    export artifact(s) as input (0005 rule 2 shape: scope entries
    plus their receipts). Each doomed tombstone MUST match an export
    entry on the full retained envelope — record id, type, actor,
    and created_at — and each matched entry MUST be covered by an
    export receipt; the redaction-dropped request_ids are exactly
    the covering receipts' request_ids. Id-only matching is
    forbidden: an export from another ledger can reuse the same
    record id for a different original request, and matching it by
    id alone would block the wrong request while re-admitting the
    real one. A missing, incomplete, or mismatched artifact — a
    doomed tombstone with no export entry, an entry whose retained
    envelope differs, or a matched entry with no covering receipt —
    REFUSES the purge proposal whole (fail-closed): the proposal
    must never silently fall back to live receipts alone and add no
    digest. No registry entry is added at redact time and no removed
    ID is stored in the live ledger; broader post-purge identity
    limits stay with boxes 5–6.
20. Registry-first on capture and verify. The future capture path
    consults, in order: (1) parse + validate (existing VALIDATION —
    malformed input never reaches privacy state); (2) registry:
    `digest(request_id)` present → refuse CONFLICT (blocked; the
    request was purged), consulting no receipt and writing nothing;
    (3) receipt: existing replay-or-CONFLICT; (4) reference and
    immutable-ID checks; (5) write. The receipt-live-plus-digest-
    blocked combination therefore surfaces the registry refusal
    first (0008 §6 fails closed either way; this pins the order).
    A blocked request NEVER replays: neither capture replay nor the
    verify-specific replay consults a receipt before the registry
    clears, so `verifyReplay` MUST NOT resurrect a blocked
    verification request. `verify` inherits this order whole: it
    funnels through capture, and its evidence/content pre-checks
    (quoteless, unreadable, oversize) keep running before capture
    is reached. Dry-run runs the same ordered lookups and writes
    nothing — a dry-run previews the refusal, it never bypasses it.
21. Restore order. Future restore consults, in order: (1) parse +
    per-entry validation; (2) version gates (snapshot version,
    `registry_version` — uninterpretable input refuses before any
    combination is judged); (3) the 0008 §6 scan (receipt +
    blocked digest of the same request_id → CONFLICT, whole);
    (4) the 0008 §12 backstop scan (tombstoned Evidence + live
    Verification targeting it → refuse, whole); (5) write. Identity
    before content throughout: each stage refuses whole, restoring
    nothing, and the first hit in this order decides the surfaced
    error. Reports name offending request_ids (§6) or Verification
    IDs (§12) only.
22. Merge-admission lookup order (settles 0011 P5 and P8
    #23-owned halves). The future merge planner/admitter consults,
    in order: (1) validate (artifact parses, selection explicit,
    pairing declaration well-formed — malformed input refuses with
    VALIDATION before any registry is consulted); (2)
    foreign-internal consistency on artifact bytes: C4 (foreign
    receipt + foreign digest of the same R) then C5 (foreign §12
    violation), each refusing the artifact whole — identity before
    content, before local state is touched; (3) the local registry
    phase, registry-before-receipt throughout: (3a) C1 scan (local
    live receipt + local blocked digest — a ledger that already
    attests a contradiction refuses every merge); (3b) C2/C8 (the
    local merge-operation request_id: blocked digest → refuse whole,
    and when a stored merge-operation receipt ALSO matches, the
    registry refusal surfaces first — P5 settled: registry-first,
    no replay of a blocked request); (3c) C9 under an explicit
    shared-history pairing ONLY (each incoming foreign receipt
    request_id hashed against the LOCAL registry; any hit refuses
    the whole merge before classification and before any remap —
    P8 timing settled; without a pairing the strings are never
    compared, per 0011 §2.1 FINAL); (4) receipt handling for the
    merge request (replay-or-CONFLICT per 0011 §1.1, reached only
    when the registry clears); (5) classification (same-ID classes
    with the mandatory tombstone detector, C6/C7, closure); (6)
    remap/admission last, reached only when every barrier clears
    (0011 §4.1). Every refusal writes nothing.
23. Report shape, opacity, and leakage. Barrier reports name only
    request_id strings the operator already supplied (the merge
    request, the artifact's receipts under a declared pairing):
    never digests-as-proof, never content, never removed IDs beyond
    the request strings that name them. Multi-hit lists (C9 scans)
    are bounded with exact totals and explicit truncation markers,
    mirroring ADR 0012 §4.3 — a truncated report never authorizes
    a partial proceed. Digest comparison is constant-time per entry
    (no prefix early-exit); no stronger timing claim is made, since
    the purge count already leaks by design. Leakage restated
    unchanged from 0005 rule 5 / 0008 §2: deterministic digests leak
    the purge count plus membership for guessable request_ids via
    offline dictionary test — no IDs, no content — so
    privacy-sensitive captures AND merge operations use unguessable
    request_ids. The live registry and live audit carry digests
    only, never raw removed IDs or content.
24. Plan/apply parity (for #32's planning). The merge plan step runs
    the §22 sequence as a non-mutating preview and reports the same
    barrier inventory apply would enforce; plan writes nothing and
    repeats byte-identically on unchanged inputs (ADR 0012 §4.2).
    Apply re-runs the registry phase (§22 steps 1–3) inside the
    application transaction along with the 0012 §4.4
    digest+fingerprint binding — plan-time classification stands,
    but any barrier hit at apply time refuses. Registry appends are
    planning-relevant writes moving the target fingerprint (ADR 0012
    §5.3): a purge between plan and apply refuses the apply stale,
    never silently accommodates it.

## Fixtures (slice 2)

Synthetic fixtures under `test/fixtures/tombstone/`, asserted by pure
tests with no DB mutation (extensions to
`test/tombstone-contract.test.mjs`):

- `sensitive-reference-routing.json`: redact scope with a
  sensitivity-flagged retained reference target; the redact is
  refused whole (no implicit split), the routing report lists
  per-record retained items with the full actor object and all
  three marker fields (§14), sensitivity is value-scoped (§15: no
  survivor retains a flagged value), the narrowed redact is valid,
  and the proposed purge scope carries doomed IDs (flagging records
  AND every bearer of each sensitive value), transitive dependents
  with pulling references, affected receipts, and registry
  additions.
- `purge-scope-confirmation.json`: proposal/confirmation pairs —
  exact match executes, ledger drift or narrowed scope re-proposes,
  bundled/implied confirmation is invalid, and the confirmation
  binds to the issued proposal (computed_at echo, explicitly
  unbundled) with omission refusing fail-closed (§17).
- `purge-multi-request.json`: doomed records spanning several
  requests; the registry gains every affected request digest and no
  unaffected one, affected receipts drop, the untouched receipt
  survives (§19).
- `redact-then-purge.json`: request R creating only record C;
  redaction drops R's receipt while the tombstone ID survives (no
  registry entry yet), then the purge of C derives R as
  redaction-dropped affected from the supplied redaction export
  (tombstone-envelope match with covering receipt) and blocks its
  digest despite zero live touches; a missing, incomplete, or
  wrong-ledger export refuses the purge whole (§19 continuity).
- `registry-lookup-order.json`: ordered lookup sequences for
  capture/verify/restore/merge, registry-first precedence cases
  (blocked-never-replays incl. verify replay, dry-run consults),
  and the leakage-shape note (§§19–20, §23).
- `merge-admission-lookup.json`: C8 registry-first precedence (P5),
  C9 paired timing/precedence/report with its unpaired contrast
  (P8), foreign-internal C4→C5 order, C1-first local order,
  report wire opacity, and plan/apply parity markers (§§22–24).

## Provisional mapping for #31 / #32 (§25)

No marker is renumbered; 0011's register resolves at #31-final
integration. This slice supplies the #23-owned inputs:

| Marker | Clause awaiting #23 | This slice |
| --- | --- | --- |
| P5 | Registry-vs-receipt precedence on merge admission | SETTLED (§22 step 3b: registry-first; blocked never replays) |
| P8 | C9 lookup mechanics (timing, precedence, report) | SETTLED (§22 step 3c + §23: after local-request checks, before classification/remap; request_id-naming bounded reports) |
| P6 | Purge-overlap mechanics on admission | LEFT: merge-admission overlap evaluation is no current #23 box (0011 §4.3); the §16 scope representation is available for that decision to consume |
| P7 | Distinct-ID foreign-tombstone admission | LEFT: tombstone transfer is no current #23 box (0011 §6.2) |
| #32 planning | Barrier inventory at plan time | SUPPLIED (§24: plan previews the §22 sequence; registry appends move the fingerprint) |

## Reasons

- Refusing (not splitting) a sensitive redact keeps "silence is
  never admission": the operator sees the routing, then chooses a
  narrowed redact and a separately confirmed purge as two explicit
  acts.
- Pulling every bearer of each sensitive value into the purge scope closes the
  hole where purging only the flagging record leaves the sensitive
  value live under another bearer.
- Registry-first ordering is uniform across capture, verify,
  restore, and merge: one principle to audit, and a purged request
  can never slip through a lingering receipt on any path.
- Running C9 after local-request checks but before classification
  keeps every registry consult in one phase: classification never
  sees requests the registry already bars, and remap stays last.
- Deriving the tombstone-purge digest from the redaction pre-delete
  export closes the redact-then-purge hole without adding registry
  entries at redact time or storing removed IDs live: the 0005
  ID-conflict barrier hands off to the registry barrier exactly when
  the last ID vanishes.

## Alternatives considered

- Implicit split of a sensitive redact (redact the clean subset,
  purge the rest): rejected — it silently changes the requested
  operation; refusal plus explicit follow-ups keeps both acts
  deliberate.
- Receipt-first with registry as tiebreak: rejected — it would let
  replay semantics run on a purged request before the privacy
  barrier speaks, differing by path for no benefit.
- C9 before local-request checks: rejected — the operator's own
  request string is evaluated before foreign re-supply strings,
  giving request-specific errors before scan errors.
- C9 after classification: rejected — classification would spend
  work (and shape error output) on requests the registry already
  bars; barriers stay before judgment.
- Salted/domain-tagged digest preimage: rejected — request_ids are
  already opaque ledger-scoped strings, and versioning lives in
  `registry_version`; salting would complicate the snapshot
  extension without changing the leakage shape.
- Registry entry at redact time: rejected — 0005 already blocks a
  redacted request on immutable-ID conflict via the surviving
  tombstone ID, so an early digest adds no barrier while widening
  the registry beyond purged requests; the digest is derived at
  purge time from redaction provenance instead.

## Costs

Spec-only: no behavior change, no migration, no destructive path.
Future implementation cost is the ordered lookup wiring on four
admission paths plus the propose/confirm purge flow, owned by later
issues consuming this contract and its fixtures.

## Revisit when

- Boxes 5–6 land (post-purge identity limits, remaining fixtures)
  — expected as amendments here, not edits to 0005 or 0008.
- The #23-owned purge-overlap (P6) or tombstone-transfer (P7)
  decisions are scoped.
- A second registry encoding or tombstone reason is proposed.
