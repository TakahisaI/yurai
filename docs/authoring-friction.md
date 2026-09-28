# Authoring friction baseline (yurai #40 box 1)

Date: 2026-09-28. Base: `13aa8e8` (branch `TakahisaI/40-authoring-measure`).
Harness: `scripts/measure-authoring.mjs` (run after build; exit nonzero when a
baseline fixture stops capturing green). Baseline pinned by
`test/authoring-friction.test.mjs`.

Box 1 measures authoring cost on the EXISTING synthetic fixtures with the
CURRENT diagnostics. No helper, no schema change, no production change:
strict rejection behavior is observed, never altered. There is no "after"
yet; the tables below record the baseline the verdict compares against.

`docs/validation.md` was checked first: it logs environment/CI verification,
not authoring measurements, so this standalone note carries the box-1 report.

## Method

- Replay fixture authoring deterministically over `examples/capture.json`
  (initial capture), `examples/dogfood/01-capture.json` (larger capture), and
  `examples/dogfood/02-correct.json` (correction: new claim, supersedes
  relation, withdrawn review). Count mechanical steps: IDs minted, references
  wired, fields filled.
- Split fields into judgment-bearing (semantic content a helper must never
  invent: text, quote, stance, rationale, attribution, scope, ...) versus
  mechanical (reference IDs copied from minted IDs, plus ID minting itself).
- Inject 18 single faults across the realistic error set (unknown field, bad
  reference, malformed data, oversize) and capture dry-run each against an
  in-memory ledger. Rate each diagnostic: does it name the entry, the
  field/key/role/family, and the violated rule? Reruns to green are measured:
  each fault's recorded fix restores the original fixture content and the
  bundle is recaptured to green; the harness fails if a fix does not reach
  green, and fails earlier if a fixed bundle differs from its clean base
  (replacement prose that merely validates is not a successful replay).
  Diagnosis steps are a
  rating (generic shape message: one schema-diff step; rule-stating message:
  zero), not a timing.
- Simulate fail-fast multi-fault (one fault per category), fixed strictly in
  validator-reported order: every round's fix touches the entry the
  diagnostic names (entries[i] position or entry id); among same-entry
  faults, the fix whose lone application moves the diagnostic is chosen
  (same-entry same-message faults are indistinguishable and fall back to
  picked order, disclosed per round). A diagnostic naming an entry no
  remaining fault touches fails the harness instead of misattributing.
- Privacy: check every nonblank judgment-bearing string (any length) in the
  fixture entries plus every fault- and fix-introduced value against every
  diagnostic message: 259 values. Short ASCII tokens match on word
  boundaries; all else by substring. Structural IDs (entry ids and
  reference-ID values) are out of scope by design: identifying the entry is
  required behavior. The result is observed-none over this stated set, not
  proof against unlisted values.

Replay measures counts and simulated fix-recaptures. It does not measure
assembly time or effort, and user-side intervention versus agent-side JSON
assembly cannot be observed by a replay harness; the split below quantifies
what each side COULD own, and the verdict cross-checks it against the
Issue #1 session evidence in `docs/dogfood.md` — a small owner-reported
sample (session A: 3 staged bundles; session C: attribution wording; closing
handoff: no captures, hence no retry signal either way).

## Mechanical steps (baseline)

| Fixture | Entries | IDs minted | Refs wired | Fields filled (req/opt) | Judgment fields | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| examples/capture.json | 6 | 7 | 5 | 25 (17/8) | 20 | 1650 |
| examples/dogfood/01-capture.json | 10 | 11 | 10 | 42 (29/13) | 32 | 2558 |
| examples/dogfood/02-correct.json | 5 | 6 | 7 | 20 (18/2) | 13 | 1321 |
| Total | 21 | 24 | 22 | 87 (64/23) | 65 | 5529 |

Per entry: ~1.1 IDs minted, ~1.0 references wired, ~4.1 fields filled, of
which ~3.1 (75%) are judgment-bearing. A prepare-only helper (local aliases
to IDs plus reference wiring) could remove only the mechanical share: about
2 items per entry out of about 5 authored items, and none of the semantic
work. These are item counts, not timings: they bound what a helper could
remove, not how long assembly takes. The correction fixture wires the most
references per entry (7 refs / 5 entries) because supersedes + review +
assessments converge there.

## Validation retries (baseline)

| Injected fault | Code | Diagnostic | Entry? | Field? | Rule? | Reruns to green | Diagnosis steps |
| --- | --- | --- | --- | --- | --- | ---: | ---: |
| unknown-field/entry-key | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| unknown-field/data-synonym | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| bad-ref/dangling | NOT_FOUND | `asm_demo: missing claim clm_no_such` | yes | yes | yes | 1 | 0 |
| bad-ref/wrong-type | VALIDATION | `evd_demo: source has wrong record type` | yes | yes | yes | 1 | 0 |
| bad-ref/duplicate-id | CONFLICT | `Duplicate ID in input: src_demo` | yes | yes | yes | 1 | 0 |
| bad-ref/existing-id | CONFLICT | `Immutable ID already exists: src_demo` | yes | yes | yes | 1 | 0 |
| malformed/blank-text | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| malformed/bad-enum | VALIDATION | `bundle.entries[3]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| malformed/bad-id | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| malformed/missing-required | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| malformed/bad-uri | VALIDATION | `src_demo: expected absolute URI; it will not be fetched` | yes | yes | yes | 1 | 0 |
| malformed/evidence-bare | VALIDATION | `evd_demo: evidence needs quote or locator` | yes | yes | yes | 1 | 0 |
| malformed/self-relation | VALIDATION | `rel_limit: self-relations are not allowed` | yes | yes | yes | 1 | 0 |
| malformed/source-no-anchor | VALIDATION | `src_demo: source needs uri or at least one identifier` | yes | yes | yes | 1 | 0 |
| malformed/review-bad-state | VALIDATION | `bundle.entries[4]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| oversize/text | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| oversize/quote | VALIDATION | `bundle.entries[2]: must match exactly one documented record shape (check type, required and unknown fields)` | yes | no | no | 1 | 1 |
| oversize/entries | VALIDATION | `bundle.entries: invalid item count` | no | yes | yes | 1 | 0 |

Reruns above are measured fix-recaptures (each fix recaptured to green).
Pinpoint means entry + (field, key, role, or field family) + rule, with
disclosed approximations: dangling/wrong-type name the role plus the bad id
rather than the exact key, and bad-uri narrows to the uri-family (uri,
snapshot_uri) rather than one key. The entries-count row is its own class:
it names the collection and the rule but no single entry, so it is not
counted as pinpoint.

Fail-fast multi-fault (4 faults, one per category): 5 attempts, 4 retries to
green — one retry per fault, as expected from fail-fast validation. Shape
errors mask reference errors: both entries[1] faults clear first (their
generic messages are indistinguishable, so picked order decides), then the
entries[3] shape fault, then the unmasked dangling reference:

| Attempt | Code | Diagnostic | Fix applied | Reported entry | Fixed entry |
| ---: | --- | --- | --- | --- | --- |
| 1 | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | unknown-field/data-synonym | entries[1] | entries[1] |
| 2 | VALIDATION | `bundle.entries[1]: must match exactly one documented record shape (check type, required and unknown fields)` | oversize/text | entries[1] | entries[1] |
| 3 | VALIDATION | `bundle.entries[3]: must match exactly one documented record shape (check type, required and unknown fields)` | malformed/bad-enum | entries[3] | entries[3] |
| 4 | NOT_FOUND | `asm_demo: missing claim clm_no_such` | bad-ref/dangling | asm_demo | entries[3] |

(Round 4 reports the entry by id; asm_demo is entries[3], the fixed fault's
entry.)

Boundary note: the 1 MiB CLI input cap sits outside Core. Verified live:
`capture --file` over the cap fails with `USAGE: input exceeds 1048576
bytes` (exit 2), naming the cap without echoing content.

## Before/after mechanics (after TBD)

| Measure | Before (this baseline) | After (box 2 or box 3, if accepted) |
| --- | --- | --- |
| Mechanical items per entry (IDs + refs) | ~2.1 (count, not timing) | TBD |
| Judgment fields per entry (untouchable by any helper) | ~3.1 (75% of fields) | unchanged by construction |
| Single-fault reruns to green | 1 measured fix-recapture (all 18 faults) | TBD |
| Faults needing a schema-diff diagnosis step | 9 of 18 (generic shape message; rating) | TBD |
| Diagnostics echoing content | 0 of 259 values | must stay 0 |
| Reported retries in Issue #1 sessions | 0 over 3 staged bundles (session A); handoff had no captures | TBD |

## Privacy

All 259 checked values (every nonblank judgment-bearing string in the
fixture entries at any length, plus every fault- and fix-introduced value;
reference-ID values and entry ids out of scope by design) checked against
every diagnostic message: none echoed. Diagnostics name structural IDs and
paths only. Strict rejection is untouched: all 18 faults rejected, all 3
baseline fixtures green.

## Verdict: conditionally defer the box-3 helper; propose a box-2 diagnostics micro-improvement

On the evidence below, a new input format is not justified now. This is a
conditional deferral, not a proof that boilerplate is immaterial: replay
counts authoring items, it does not time assembly or observe user
intervention, and the session evidence is a small owner-reported sample.
Revisit if timed assembly data, intervention logs, or retry reports show
mechanical friction the counts below hide.

1. The mechanical share is small in count (~2 items per entry: one ID plus
   one reference wiring) against ~3.1 judgment fields per entry (75%) that
   no helper may touch. Counts bound what a prepare-only helper could
   remove, not how long assembly takes. The session report names
   agent-authored JSON as the dominant assembly work and user wording on
   attribution (`docs/dogfood.md` sessions A/C), but it provides no
   token/latency measurements — see the caveat at `docs/dogfood.md:22-25`.
2. Session A reported 0 validation retries over 3 staged bundles; the
   closing handoff performed no captures, so it carries no retry signal
   either way. The simulated worst case is 1 measured fix-recapture per
   fault (18/18 reach green on the first recapture). Existing schemas and
   examples already carry these simulated authors to green; no timing or
   intervention data exists to compare against.
3. The one localized friction is the generic `oneOf` diagnostic: all 9
   per-entry shape faults (unknown fields, enum typos, blank text, bad IDs,
   missing required fields, oversize strings) report only `entries[i]` plus
   "check type, required and unknown fields", forcing a schema-diff step.
   Of the other 9, 8 already pinpoint entry, field/role, and rule, and 1
   (entries-count) names the collection and the rule but no single entry.

Box-2 micro-improvement proposal (proposal only, no implementation in this
slice): when an entry's `type` names a known record type but the entry fails
the `oneOf` match, re-validate against that type's branch and report the
branch-specific path and rule (for example,
`bundle.entries[1].data.stance: must be one of reports, supports, ...`),
keeping strict rejection and keeping values out of messages. A mistyped
`type` itself keeps the generic message. Expected effect: the 9 generic rows
above drop to 0 diagnosis steps with no new input format.

No ADR in this slice: measurement only, no contract or behavior change. If
box 2 is accepted, its implementation slice records the decision.
