# ADR 0003 — Task-first agency, inspectable persistence

Status: Accepted design decision / 2026-09-27

## Context and evidence limits

The owner supplied an Issue #1 progress report covering a staged exercise and
subsequent fresh-agent sessions. It reports working atomic captures/corrections,
agent-authored JSON as the dominant capture work, permission-seeking that displaced
verification, changed behavior after a skill edit, and an Evidence-only search miss.
The private ledgers and transcripts were not available to this review. These are
reported observations, not independently reproduced model benchmarks. A changed
prompt, topic, and session do not isolate causality. One conflict-free concurrent
append does not establish general concurrency safety (Issue #5 remains necessary).

The review checked main at fc306b7353c0a643a119b7975024d53418f0770c.
The reported local guide, memo, and skill were not on main. The supplied skill text
was available; the other local files were not. The committed guides are a new
adopted version, not a claim to have recovered or tested those local files.

## Decisions

### 1. Agency outside, substrate inside; integration still matters

Keep Core responsible for typed provenance, storage, retrieval, and bounded
inspection. It does not choose research goals, spend model budgets, browse, or
judge truth. The optional skill teaches safe use within the host agent's task;
it is part of the integration experience, not a new research engine.

Replace a compulsory research/ledger loop with a task-first contract. The host
agent should answer and investigate without waiting for instructions a tool can
resolve. Recall when useful, verify when materially necessary, and retain the
reusable delta. No requirement to search the ledger or capture on every turn.
A cache hit can still need verification; "present and not stale" is not sufficient
when the support was weak or the question now demands stronger evidence.

### 2. Persistence permission is independent of working state

`proposed` is stored immediately and appears in default searches. It is NOT a
consent mechanism, safely disposable staging area, or automatic human-review queue.
No authenticated writer identity or secure erasure exists in v0.

A user-authorized task may grant standing permission to save relevant findings to
a designated private ledger. Inside that scope, repeated "shall I record?" is
unnecessary. Mere skill discovery grants no such permission. Respect read-only
instructions, topic boundaries, confidentiality, and the host's authorization
rules. A request to investigate alone is not blanket permission to persist private
opinions. Ask once when a target/scope is genuinely missing; do not invent either.

### 3. Attribution tracks origin, not keyboard ownership

The existing Claim model can represent a hypothesis spanning multiple papers.
Keep its tentative force and scope; connect only genuinely relevant grounds.
Do not split it into per-paper copies just to satisfy the data model.

For a faithful agent paraphrase: `attributed_to` names the known originator;
`actor` identifies the agent recording it. This is neither verbatim wording nor
originator approval. Preserve a short exact passage as Evidence when authorized
and actually recoverable, not by inventing a conversation URI.

An additional mechanism, stronger quantifier, or deduction belongs to the agent.
Use a separate agent-attributed Claim only for a substantively different proposition.
No mandatory original/paraphrase duplicate pairs. No routine request for a handle
or one-line rewrite when attribution is clear. If meaning is materially ambiguous,
ask, leave it out, or retain an explicitly agent-owned interpretation without
assigning that stronger position to the user. A question is not an assertion.

### 4. Review the useful unit, not every plumbing record

Do not make real-world use wait for all proposed records to become accepted.
Review is an optional decision to retain a representation, not truth verification.
Prioritize important conclusions, questionable attribution, and corrections.
The number of Source/Evidence/Assessment records is not the number of decisions
we should demand of the human.

Expose the existing capture receipt through `show --request-id ID` (Core:
`inspectCapture`). It lists the records created in that request, with immediate
dependencies, current reviews/states, and pagination. It neither changes state
nor creates a new entity, schema, permission system, or approval gate.
Record membership is historical; presented states are current at inspection time.
Use `show ID` for later incoming relationships and full correction history.

The agent can summarize that unit in the current conversation and apply selected
Review records through the existing capture API. No implicit accept-all. An agent
executing a human's instruction remains the recorder; it must not impersonate a
human actor to suggest authenticated approval. A queue/UI/diff tool is deferred
until a concrete blocked review task remains after trying this smaller interface.

### 5. The Evidence-only miss is a retrieval gap, not a writing duty

Claim-first describes the result and semantic center, not an obligation to hide
related searchable evidence. Current literal search covers Claim and Source
fields only. Do not require keyword stuffing of scope/why or predicting all future
queries. Natural explanatory names are fine; changing meaning for indexing is not.

Prioritize an Evidence-to-Claim lexical discovery slice in Issue #4 before broad
semantic-search work. It must identify the matched record/field and preserve the
Assessment stance and inactive dependency states. A match is a discovery route,
not endorsement; a mention cannot become support or independent corroboration.
This review supplies a synthetic reproduction but does not change search behavior
or the storage schema. That separate change should remain bounded and testable.

### 6. Close Issue #1 with a bounded handoff, not an impact benchmark

The reported staged cases establish mechanical plausibility; fresh research from
an empty ledger does not demonstrate reuse of earlier knowledge. The report does
not establish the required earlier-session recall with retained scope/why and
correction history. Keep #1 open for that specific missing observation.

Adopt the guide/skill now; do not block them on indefinite "more real use."
Run one fresh-session handoff using an existing authorized private ledger and a
natural follow-up question, with expected results held separately from the agent.
The target may be configured and the generic skill registered, but no answer
summary, claim IDs, search keywords, or relevant source list may leak in.
Success is correct reuse with grounds, attribution, limits, and the relevant
correction trace, or an honestly reported limitation. A material failure is fixed
and retried; it is not silently marked successful. No demand for a changed decision,
quantified causal benefit, waiting period, or large benchmark. Details and the
completion checklist are in docs/dogfood.md.

## Non-decisions and consequences

No new ontology, Attribution entity, truth/confidence score, vector DB, MCP server,
review gate, background reviewer, parser, or model dependency. Public examples are
fully synthetic; private records, source passages, and the supplied report are not
published. Preserve local uncommitted work before integrating the adopted files.

This decision reduces mandatory agent bookkeeping but cannot guarantee the behavior
of every host/model. The skill is guidance, not an authorization sandbox. The
read-only inspection use case makes no ledger writes; v0's SQLite opening and
transaction behavior is unchanged and is not a filesystem read-only mode.

## Amendment — default-first persistence target (2026-09-27)

Section 2's "ask once when a target/scope is genuinely missing" proved to be
per-session friction without safety value: the CLI already defines a default
chain, so the target is rarely truly missing. Revised rule, now in the skill
and guide: use the default chain (explicit `--db`, else `$YURAI_DB`, else
`~/.yurai/ledger.sqlite`) without asking and state which ledger is in use;
ask only to narrow scope or for read-only/no-save tasks. The ban on invented
non-default paths and the permission/state separation stand unchanged.

## Amendment — read-only opening mode (2026-09-27)

The "not a filesystem read-only mode" sentence above is superseded by ADR
0006: read-only inspection now opens the store with SQLite read-only access
(`--readonly` on every call), which refuses creation, migration, journal-mode
changes, and all content writes. The skill and agent guide carry the rule;
this ADR's permission/state separation still stands.
