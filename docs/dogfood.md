# Issue #1 — findings, decisions, and bounded completion

Review date: 2026-09-27. Base inspected: fc306b7353c0a643a119b7975024d53418f0770c.
Decision: [ADR 0003](adr/0003-agent-ledger-boundary.md). Usage: [agent guide](agent-guide.md).

## Evidence available to this review

The owner-supplied working-agent report describes Sessions A/B/C and supplies the
full draft skill. The private ledgers, original conversations, and unpublished
local guide/memo were NOT available. We do not claim to have rerun those sessions,
measured their token use, or established model-level causal effects. The report
itself and its private subject matter are not published here. The following is a
process-only summary with reported facts separated from reproducible checks.

| Exercise | Reported observation | What this establishes / does not establish |
| --- | --- | --- |
| A: staged exercise with real sources | Support/doubt, attribution, and correction rehearsed; 3 bundles of 10/6/4 records; 0 validation retries; JSON assembled by the agent; a scope overclaim corrected | Evidence of the workflow's use, not independent fresh-session recall |
| B: fresh research session | Autonomous initial capture, later agreement/permission-seeking instead of verification; one concurrent append without a conflict | A concrete integration failure; not proof that all model or concurrency behavior is known |
| C: another fresh session with edited skill | More initiative, caveats and honest stance choices; still asked for user attribution wording | Motivation for a narrower task/attribution contract; not a controlled comparison |
| Search observation | An acronym confined to an Evidence quote yielded no Claim search hit | Consistent with the current implementation's indexed fields; a real discovery limitation |

The report names agent-authored JSON as the dominant assembly work. It does not
provide token/latency measurements or show that the user manually edited every
bundle. Instrument those separately before choosing a new input DSL or attributing
the cost to the user. Record count is not a success metric or a review quota.

## Changes adopted now

- A small optional skill and worked guide: answer the task, retain useful deltas
  inside authorized scope, preserve originator/recorder separation, do not treat
  proposed as consent, avoid compulsory ledger-first/record-every-turn behavior.
- `show --request-id ID`: inspect a capture's existing receipt without a new
  schema or review gate. It exposes immutable membership and current state,
  references, and pagination. Selected Review records still use existing writes.
- Two fully synthetic fixtures and regression tests for disagreement, attribution,
  correction, inspection, restore, pagination, and the known Evidence-only miss.
  No real quotations, conversations, DBs, or private paths are embedded.
- Issue #4 is the next bounded discovery improvement: lexical Evidence-to-Claim
  retrieval with match provenance, not keyword stuffing, embeddings, or a new
  general research engine. Search behavior is unchanged in this patch.

No implicit acceptance, blanket permission, new truth score, mandatory human queue,
MCP server, auto-parser, or full-chat ingestion has been introduced.

## Acceptance status

| Original #1 criterion | Status from available evidence |
| --- | --- |
| Supporting and doubting material retrieved in another session | Staged retrieval reported; earlier-knowledge fresh-session reuse still to document |
| Source claim / own hypothesis / AI inference distinguished | Reported in A/C; mechanically exercised by synthetic examples; verify at handoff |
| Old record, withdrawal reason, corrected grounds traceable | Reported in A; synthetic regression; verify at handoff |
| Operations, manual work, retries, retrieval failures recorded | Partial reported counts above; distinguish user actions from agent JSON work in final run |
| why/scope survive into the next conversation | Present in reported reads, but the required independent handoff is not demonstrated in the report |
| Minimal guide/worked example | Adopted files supplied now, not blocked on indefinite additional use |
| Fixtures/regression tests and check | Synthetic additions included; actual test/CI results belong in the implementing PR |

**Update 2026-09-27: the handoff below passed and #1 is closed.** It stayed open
for the missing handoff evidence, not an unbounded research phase.

## One bounded fresh-session handoff

Use an existing authorized private ledger containing knowledge from earlier work.
One handoff may include a few related follow-up questions so all three cases are
covered. No need to wait days, collect many unrelated topics, or require a changed
decision. If the ledger lacks a required case, first record a genuine instance;
do not dress a deliberately fabricated case as natural use.

1. The evaluator privately records the expected relevant supporting/doubting
   materials, attribution distinctions, why/scope, and correction trace. Keep this
   checklist out of the fresh agent's prompt, skill, repo docs, and shared memory.
2. Start a genuinely fresh host session: no forked transcript, automatic memory of
   that investigation, or prior answer summary. Register only the generic skill,
   authorized DB target, and persistence boundary. Give a natural follow-up question,
   not claim IDs, hand-picked search tokens, or a relevant source list. If the host
   cannot exclude memory leakage, label the run assisted instead of calling it blind.
3. Let the agent answer with its normal tools and budget. Do not prohibit external
   verification when needed. Observe whether it finds and actually uses earlier
   records instead of reconstructing everything from the original chat or web.
4. Compare the answer to the held-out checklist. Check both sides, attribution,
   why/scope, active vs withdrawn grounds, and the relevant correction history.
   Record missed items, material misstatements, source re-reads, user interventions,
   agent capture work, validation retries, and any permission-seeking that displaced
   answering. Honest failure is useful evidence, but not an automatic pass.
5. Post a short sanitized outcome to #1. Preserve private data locally. Merge the
   guide/implementation independently of this evaluation; close #1 only when its
   handoff criteria are evidenced and no material failure remains. For a miss, make
   the smallest fix and repeat that case. Do not add a "decision must change" gate.

A compact outcome template (do not send the filled evaluator section to the agent):

```text
Date / code SHA / host-model / skill revision:
Freshness and authorized ledger configuration (no private paths):
Follow-up question, sanitized:
Expected properties (evaluator only until completion):
Earlier records actually reused / supporting and doubting material:
Attribution, why, scope, inactive grounds, correction trace:
External reads and why still needed:
User interventions / agent assembly / retries / misses:
Result per acceptance criterion / remaining bounded fix:
```

## Handoff outcome (2026-09-27)

Fresh host session, existing private ledger (26 records, three staged cases),
three natural follow-up questions, no IDs/quotes/source lists disclosed.
The session correctly reused supporting, doubting, and qualifying material
with attributions; distinguished hypothesis/inference from source claims with
their relations; traced the withdrawn cost claim, its reason (an unverified
figure exceeding its evidence), and the superseding qualitative claim without
reviving the figure; and declared working states, anchor limits, and missing
items. No external re-reads, no user interventions, no captures, no retries.
All three Issue #1 cases evidenced; #1 closed with a sanitized summary comment.

## How to interpret completion

A correct answer that demonstrably reuses earlier grounds and retained limits is
sufficient; it need not change the eventual decision. Rediscovery from scratch,
fluent answers without the relevant reservations, or new research in an empty DB
cannot substitute for the missing reuse observation. Deterministic fixture tests
verify mechanics only. The quoted report's improvement after a prompt edit remains
an observation, not proof of general reliability. Issue #5 retains its separate
migration, concurrency, crash, backup, and privacy obligations.
