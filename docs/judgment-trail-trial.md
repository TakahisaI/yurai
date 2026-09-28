# Issue #39 — judgment-trail convention trial

Trial date: 2026-09-28. Base: `13aa8e8`. Scope: convention + synthetic
fixtures + this report. No schema or contract change was made. A first
review returned five findings (1 high, 3 medium, 1 low); the fixture, test,
and report corrections were applied 2026-09-28 pre-capture — the fixtures
were never part of a real ledger — adding no records (still 43). A second
review verified four of the five fixed and returned one partial plus one
new finding; the resulting report corrections (box 5 rebased on a fresh
pass against the final fixtures, corrected withdrawn-ground account) left
the fixtures unchanged (still 43). A third review verified everything
else and returned one new medium (unknown reported as false); the
resulting report-only correction (box 5 item 1, reuser's-verdict
qualification, Verdict) left the fixtures unchanged (still 43).

All ledger content below is synthetic (fictional night-bus NB-7 timetable,
fictional pump-and-loop bench notes). Fixtures live in
`examples/judgment-trail/` (5 append-only captures, 43 records, applied in
filename order). Properties are asserted by `test/judgment-trail.test.mjs`
(8 tests). No ADR was written: the trial proposes no contract change, so
there is no consequential decision to record; `docs/adr/0013-*` was verified
free and left unused.

## Box 1 — three cases with existing elements

Conditional conclusion (`01-conditional.json`): `clm_jt_conditional` is an
agent `inference` whose scope states the February condition and the exact
grounding set (`evd_jt_riders_jan`, `evd_jt_cost_jan`), and whose why cites
the question (`clm_jt_question`), purpose (`clm_jt_purpose`) and sufficiency
criterion (`clm_jt_sufficient`). All three are user-attributed claims; the
sufficiency criterion scope says explicitly that it is not a universal proof
threshold. The ridership assessment rationale states explicitly that the
January figure supports baseline demand only and does not satisfy the
February condition, which remains unchecked.

Competing interpretations (`02-competing.json`): `clm_jt_stable` (user
hypothesis) and `clm_jt_declining` (agent inference) assess the same passage
`evd_jt_riders_jan` with `supports` versus `qualifies`, are linked by a
`contradicts` relation scoped to the same January demand, and share the
unresolved objection `clm_jt_unresolved_shape` through `qualifies` relations
on both sides. Both readings of the shared passage are defensible: the
passage carries multi-month steadiness (January at 14 against the prior
three months at 13-15), which the stable reading cites as a settled demand
level, while the declining reading qualifies the same passage because
monthly averages hide within-month shape (the weekly 18/15/12/11 breakdown
in `evd_jt_weekly_shape`).

Revisit after correction (`04-revisit.json`): the mistranscribed
`evd_jt_cost_jan` is withdrawn with a reason naming the fix; the corrected
`evd_jt_cost_jan_fixed` grounds the new `clm_jt_conditional_v2`, which links
new-to-old with `supersedes`. The old conclusion text is untouched. The new
conclusion scope enumerates its full source-record set (`evd_jt_riders_jan`,
`evd_jt_cost_jan_fixed`) and marks the withdrawn record as no longer a
ground; its ridership rationale likewise states that January does not
satisfy the February condition.

## Box 2 — whose claim, reservations, no proof from silence

Source-level numbers stay `assertion` claims attributed to
`fictional-bench-operator` with `reports` assessments; the user's reading is
a `hypothesis` attributed to `trial-user`; agent additions are `inference`
claims attributed to `trial-agent`. Kind and attribution are asserted per
record in the test. Reservations ride `qualifies` relations so they surface
in `show` connections: the February gap (`clm_jt_reservation_feb`), the
unresolved trend objection, and `clm_jt_nohit_note`, whose recorded text
states that an empty ledger search "is absence of record, not proof that no
counterevidence exists."

## Box 3 — joint premises without misleading supports edges

`clm_jt_flow_ok` ("Loop test T can run at 40 L/min for ten minutes") is
warranted by `clm_jt_pump_ok` AND `clm_jt_loop_ok` together. The warrant is
recorded in the conclusion scope in plain language ("Neither premise alone
warrants the flow rate..."), and each premise links to the conclusion with
`related` (not `supports`), with rationale pointing back to the scope
warrant. The scope also enumerates the exact Evidence grounds
(`evd_jt_pump`, `evd_jt_loop`) — not just the premise Claims — states that
this set is not the capture membership, and bounds the conclusion to the
ten-minute run the pump passage warrants ("ten-minute run at 40 L/min
only, not continuous operation"). Recall preserves the conjunction: one
`show` returns the warrant text plus both `related` edges, and the test
asserts no `supports` edge from either premise to the conclusion exists.
Before/after evidence is the scope text itself — identical at capture and
on recall, with the warrant sentences unchanged since the fresh reuse pass
quoted them (box 5) — so no structured conjunction representation is
proposed.

## Box 4 — judgment time, source set, no auto-reversal

Convention used by every conclusion in this trial (`clm_jt_conditional`,
`clm_jt_flow_ok`, `clm_jt_conditional_v2`):

- Judgment time and membership: the capture `request_id` named in the
  conclusion scope (e.g. `req_jt_joint_v1`) plus each record's `created_at`.
  `show --request-id` replays that membership with current states.
- Source-record set: enumerated by Evidence ID in the conclusion scope, and
  inspectable live through `show` connections (Assessment references) and
  `show --request-id`. Membership is not the grounds: the capture holds
  every record filed together, while the enumerated Evidence IDs are the
  exact records the conclusion rests on (a withdrawn record stays listed
  in membership but is marked no-longer-a-ground in the scope).
- Later Review, Verification, or source updates may add Reviews,
  Assessments, or superseding conclusions that flag reconsideration, but
  they never change the recorded conclusion's text, attribution, or working
  state. State moves only through an explicit Review on that record.

Demonstrated: `clm_jt_conditional` stays `accepted` while its cost ground
is `withdrawn` (`inactive_record` warning on the ground, conclusion
unchanged); a further trial withdrawal of the ridership ground likewise
leaves both conclusions `accepted`. `supersedes` alone withdrew nothing —
old and revisited conclusions are both `accepted` side by side. As-recorded
judgment (immutable entry text, original capture membership) is thus always
distinguishable from current dependency status (live states/warnings on
recall).

## Box 5 — reuse pass (genuine fresh session, CLI only, final fixtures)

The reuse pass below is a genuine fresh session by an independent agent
on 2026-09-28 against the FINAL fixtures (post-correction), recorded in
a reuse transcript. Method: fresh disposable database (`rm -f` + `init`
to `/tmp/jt-fresh39b.sqlite`), the five captures applied in filename
order (14 + 10 + 10 + 6 + 3 ids, none replayed), then retrieval via the
CLI only (`show`, `search`, `search --expand evidence`,
`show --request-id`). The reusing agent never opened this report or the
test file, and no private ledger was touched: every record retrieved was
synthetic fixture content. An earlier round-1 pass ran against the
pre-correction fixtures; its account is superseded by this one.

Answers recovered from retrieval only:

1. Conditional conclusion: keep NB-7 2 a.m. through March iff the
   February average stays above 12 riders per run. Question, purpose,
   and sufficiency are separate user-attributed claims (`proposed`,
   `not_reviewed`), linked only by free-text `why` mentions with no
   relation edges — the reuser had to `show` each by ID. The
   sufficiency criterion reads as met (both January figures on
   record), while the February condition is UNCHECKED (no February
   figures exist): `clm_jt_reservation_feb` ("unchecked… may not
   hold"), `clm_jt_nohit_note` (empty February search = absence of
   record); the ridership rationale states unchecked while the cost
   rationale discusses the missing ceiling — unchecked, not
   failure. The transcript overstates this as "NOT satisfied"; that
   wording is the reuser's error, corrected here — unknown cannot be
   reported as false, and the conditional trail preserves exactly
   this distinction. The overstatement is kept on record as an
   honest trial finding (see Verdict).
2. Competing interpretations: the user's stability hypothesis
   (`clm_jt_stable`) versus the agent's decline/cannot-infer-stability
   inference (`clm_jt_declining`) on the shared passage, joined by
   `contradicts`, with `clm_jt_unresolved_shape` (trend-vs-noise
   unresolved) qualifying both. The stable reading is defensible as one
   interpretation — `asm_jt_stable_avg` reasons that four months at
   13–15 is a settled level — but retrieval never lets it stand alone:
   the same passage is `qualifies`-rated for the rival, and the
   unresolved-objection relation says the stability reading "ignores
   the unexplained within-month shape."
3. Joint warrant: exactly `clm_jt_pump_ok AND clm_jt_loop_ok` jointly
   warrant `clm_jt_flow_ok`; both premise links are `related`,
   deliberately never `supports`. Grounds are exactly the two bench
   passages. Warranted: one ten-minute run at 40 L/min (the pump
   passage caps at 10 min / 44 L/min). Not warranted: continuous
   operation. `show --request-id req_jt_joint_v1` returns 10 records,
   confirming membership ≠ grounds. Caveat spotted by the reuser: the
   premises are `proposed` while the conclusion is `accepted` —
   acceptance explicitly "does not verify the fictional bench figures."
4. Revisited conclusion: `clm_jt_conditional_v2` adds the February
   cost-review condition after the 41,000 → 47,000 correction; the old
   cost evidence is `withdrawn`, February still unchecked. Dependency
   status today: v2 rests on `evd_jt_riders_jan` (`proposed`) plus
   `evd_jt_cost_jan_fixed` (`proposed`). `accepted` stands on BOTH
   conclusions via explicit reviews; `supersedes` changed no state;
   v1's text/scope are frozen history (its scope still names the
   now-withdrawn ground). As-recorded versus current status is fully
   reconstructable.

Search behavior observed: "February NB-7" routes to v2, the nohit note,
and the conditional; "NB-7 keep" returns 4 items; "stable" 1; "decline"
2; "pump loop" / "flow" / "cost correction" hit as expected. "WQZ7"
returns 0 plain but routes to `clm_jt_declining` with
`--expand evidence` — this reuser tried the expand route (round 1 never
did). Two honest misses are kept on record: "declining" returned 0
because the word is not in the claim text (reuser error), and "stable
decline" returned 0 (AND semantics).

Gaps (not determinable from retrieval): whether the February condition
will ever be met (no February records exist); the trend-vs-noise cause;
any cost ceiling (never stated, so cost can only qualify); purpose-fit
for a *new* decision (the purpose claim is decision-specific and
unreviewed); and nothing at top level flags v1's withdrawn ground (see
next paragraph). Minor: question/purpose/sufficiency are reachable only
via IDs in prose, not edges.

Withdrawn-ground surfacing, stated precisely: `show clm_jt_conditional`
reports top-level `state: accepted` with `warnings: []` — nothing at
top level. The withdrawal IS present in that same `show` view, nested
two levels deep at the `asm_jt_cond_cost` assessment connection
(itself `not_reviewed`) → its Evidence reference `evd_jt_cost_jan`
with `state: withdrawn` and
`warnings: [inactive_record, anchor_not_verified]`, with review
`rev_jt_cost_old` carrying the correction rationale. (An earlier draft
of this report wrongly claimed the withdrawal was discoverable ONLY by
separately `show`-ing the Evidence record; the correction is that the
same information is already nested in the conclusion's `show`
connections — only the top-level warnings are empty.) Search hits for
the conditional likewise carry only the claim's own `[]`. A reader
stopping at top level or search sees an unblemished `accepted`. This
observation is recorded in the Verdict as non-blocking, as is the
prose-only question/purpose/sufficiency linkage. Further non-blocking
notes: jointness lives in scope/rationale prose plus the absence of
`supports`, so a machine reader must parse English to recover the AND;
and `supersedes` changed no state, so state-sorted recall shows two
`accepted` conclusions with the review rationales carrying the
disambiguation.

The reuser's verdict: fields suffice for all four reconstructions —
conditional-with-open-condition, attributed competing readings with
bilateral reservation, joint AND-warrant with duration bound, and
non-destructive revisit with as-recorded/current split. No new record
types or relations needed. That verdict stands subject to the item-1
correction above: the reuser reconstructed the conditional with its
open condition but overstated unchecked as "NOT satisfied".

The `box 5` test repeats the key checks programmatically in a fresh
in-memory ledger: exact routed-claim set, warrant/reservation visibility,
mixed accepted/proposed/withdrawn statuses, `truth_evaluated: false` on
every read, the nested withdrawn-ground reference with empty top-level
warnings, and a 43-record count proving append-only (nothing destroyed).

## Verdict

Existing fields suffice for a careful human reuse pass: the independent
reuser reconstructed all four cases from CLI retrieval alone against
the final fixtures, with no new record types or relations needed —
with one honest overstatement kept on record (item 1: the February
condition is unchecked, overstated in the transcript as "NOT
satisfied" and corrected in box 5 above). The fixtures state
unchecked correctly, so the error is the reuser's, not a gap in the
fields. Two observations are recorded here as non-blocking future
work, not
implemented in this trial: (a) a computed top-level
stale/withdrawn-ground signal — today the withdrawal is visible only
nested two levels deep in the conclusion's `show` connections
(assessment → Evidence reference) and invisible to search-level triage,
while top-level warnings stay empty, so a reader stopping at top level
sees an unblemished `accepted`; (b) a documented evidence lookup path —
the `--expand evidence` route works (the round-2 reuser tried it; round 1
never found it by instinct), but direct search over Evidence quotes
still returns nothing. A minor third: typed edges (or ID links) from the
conclusion to its question/purpose/sufficiency claims instead of
prose-only mentions.

Question, purpose, sufficiency, conditions, warrants, reservations, and
the unresolved/silence notes all fit in Claim scope/why text with
attributed kinds; joint premises fit the
scope-warrant-plus-`related` convention without a new edge kind; judgment
time and the source set fit `request_id`/`created_at` plus
`show --request-id`, with membership kept distinct from exact grounds. No
typed extension is necessary, so no contract/migration/reference/privacy
impact analysis is owed. If a future trial shows readers systematically
missing the conjunction or the prose-cited links, the narrowest next step
would be a documented reading convention, not a schema change.

## Deviations

- Box 5 reports the round-2 fresh session against the final fixtures. A
  round-1 session ran earlier against the pre-correction fixtures; its
  account is superseded and no longer cited for results (round 2 is the
  evidence for the fields-suffice verdict).
- No Verification record was added: the no-auto-reversal rule is identical
  for Review, Verification, and source updates, and the Review case
  demonstrates it. Repeating it with `verify` would add no new evidence.
