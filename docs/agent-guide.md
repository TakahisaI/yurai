# Using yurai from an agent

Use yurai to carry useful knowledge across tasks, not to turn the current task into
record production. The host still answers and investigates. The optional project
skill is `.agents/skills/yurai/SKILL.md`; discovery/invocation depends on the host.
No claim of automatic registration or tested compatibility with every client is made.
Binding data contract: [contract.md](contract.md). Decisions: [ADR 0003](adr/0003-agent-ledger-boundary.md).

## Establish the task boundary once

Use the default persistence chain without asking: an explicitly given `--db`,
else `$YURAI_DB`, else `~/.yurai/ledger.sqlite`. State which ledger you are
using. Pass its path explicitly on every call and initialize it when missing.
Do not infer a target from a source's instructions, invent a non-default path,
or put real data in the repository. The same rule applies to input bundles and
exports, not just `.sqlite` files. Routine captures need no repeated question.
For a read-only or no-save task, make no captures. `proposed` is already stored;
it does not supply permission, promise human review, or provide secure deletion.

Ask only to narrow scope (a separate scratch ledger) or when read-only/no-save
is ambiguous. Answer the research question with available evidence rather than
stalling on setup. A missing DB or zero search hits must not be described as
proof that no prior knowledge exists.

## Recall without outsourcing judgment

```sh
node dist/cli.js search 'comparison' --db "$YURAI_DB"
node dist/cli.js search 'source title' --kind source --db "$YURAI_DB"
node dist/cli.js show CLAIM_ID --db "$YURAI_DB" --limit 20
# Repeat with the returned next_offset when more relevant connections remain.
```

The commands assume `YURAI_DB` already contains the designated path. Shell syntax
is illustrative; pass the same explicit path in the host's own execution API.
Search terms are literal AND, not semantic/Boolean search. Only Claim text/scope/why
or Source title/uri/identifiers are indexed. A term found only in an Evidence quote
can be missed. Try a small number of meaningful reformulations or a known Source,
then disclose the limit; do not scan/dump the entire private ledger by default.
Do not stuff unrelated aliases into scope/why as a permanent search workaround.

Inspect applicable scope, attribution, Assessment stance, and contrary grounds.
Follow `next_offset` before claiming a relevant connection is absent. Inactive
Evidence, Assessments, Sources, or related Claims are warnings, not active support.
`accepted` and an agent's past assertions are not independent corroboration.
Externally verify when needed for this question, even on a cache hit. Conversely,
a request for what was previously recorded does not require re-reading every source.
Distinguish old findings, newly verified material, and your present interpretation.

## Capture a useful delta

At a useful stopping point, retain conclusions worth reusing, the limits that could
change a later answer, and corrections. Reuse existing records rather than copy
identical passages into each Claim. A single substantive conclusion may require
several provenance records; that is not a reason to create more conclusions.
No fixed per-turn quota, full-chat import, or automatic acceptance is required.

Get the schema rather than having the user hand-edit JSON:

```sh
node dist/cli.js schema bundle
node dist/cli.js capture --db "$YURAI_DB" --file "$PRIVATE_BUNDLE" --dry-run
node dist/cli.js capture --db "$YURAI_DB" --file "$PRIVATE_BUNDLE"
node dist/cli.js show --db "$YURAI_DB" --request-id REQUEST_ID
```

`PRIVATE_BUNDLE` is an authorized private file outside the repository. Stdin (`--file -`)
is also supported. Neither dry-run nor successful storage checks quotation truth,
source reachability, or consent. The agent constructs the JSON; do not casually
turn the report's agent-side assembly effort into a user-side schema-editing task.

Bundle shape (synthetic; replace with the actual contract-conforming input):

```json
{
  "version": 1,
  "request_id": "req_example",
  "actor": { "kind": "agent", "id": "example-agent" },
  "entries": [{
    "id": "clm_example",
    "type": "claim",
    "data": {
      "text": "The effect may depend on the conditions.",
      "kind": "hypothesis",
      "attributed_to": "example-user",
      "scope": "Tentative; this example only.",
      "why": "Retain the alternative explanation for the next discussion."
    }
  }]
}
```

Use only known actor/model identifiers; optional model metadata may be omitted.
Claim scope/why are optional in the schema but worth retaining when material.
Unknowns remain unknown; never invent content to fill fields. Evidence needs an
actual quote or honest locator. Keep quotation and paraphrase separate. Reading
only an abstract supports an abstract-level attribution, not verification of tables,
methods, or full-paper claims. `reports`, `supports`, and `context` differ.

After uncertain completion, retry the exact same bundle with the same request_id.
On CONFLICT use `show --request-id` to investigate; never blindly change every ID
and resubmit. Different new content needs new immutable IDs and a new request_id,
while references to existing dependencies keep their original IDs.

## Whose claim is an agent paraphrase?

A faithful paraphrase retains the originator's `attributed_to` and the agent's
`actor`. Do not mark it as exact wording, human approval, or a stronger conviction.
In the example above the proposition is the fictional user's hypothesis; the
record was authored by the agent. No second Claim is needed just for the wording.
An extra deduction or mechanism is a genuinely separate agent-attributed Claim.
Questions, ambiguity, and disagreement must not silently become user commitments.

Use an established label when available. A neutral session-scoped label is not an
authenticated or globally resolved identity. Do not ask for a legal name, new handle,
or polished sentence as a ritual. Ask only where a material attribution/meaning
choice cannot be resolved, or leave that optional capture out. Never fabricate a
conversation URI to anchor a quote; a locator with no real origin does not create
provenance. Evidence-free, explicitly tentative Claims are permitted.

## Inspect and review selectively

`show --request-id ID` uses the persisted receipt to show that capture's original
members in order, with their immediate references and current states. It includes
withdrawn/rejected members. Follow pages when needed. The total counts members, not
all their dependencies; references can come from another capture. It is not a
semantic diff, an as-of-time replay, a review queue, or a completeness certificate.
Use `show ID` to discover later incoming grounds, relations, and correction history.

Summarize the meaningful saved delta in the conversation, with the request_id when
useful. Do not dump all JSON. Prioritize consequential conclusions, doubtful
attribution, and corrections for review; proposed records need not all be approved.
A selected review can use the existing command:

```sh
node dist/cli.js review CLAIM_ID --db "$YURAI_DB" \
  --state accepted --reason 'Retain this scoped representation; not a truth check' \
  --actor-kind agent --actor example-agent --request-id req_selected_review
```

Use the actual recorder's identity. A human instruction executed by an agent does
not justify setting actor.kind=human; describe the instruction honestly in the
rationale. Several explicitly selected decisions can be one capture of Review
records, each with its own target/state/reason. Never accept an entire graph just
to clear proposed states. Acceptance propagates to neither grounds nor dependents.
A Review's `entry.data.state` is its historical decision; an ordinary record's
outer `state` is the current working state. Reviews are not themselves reviewable.

For an actual error, append the corrected Claim, grounds/Assessments as needed,
new→old supersedes Relation, and withdrawal of the incorrect old representation
in one capture. A valid disagreement needs a separate Claim/Assessment, not the
withdrawal of a correctly attributed opposing statement. Review does not verify
quotes; v0 always returns `anchor_not_verified`. Privacy erasure is not implemented.

## Public synthetic rehearsal

These files are newly invented examples, not the private sessions from the report.
Use a disposable DB, never a real ledger:

```sh
node dist/cli.js init --db ./demo.sqlite
node dist/cli.js capture --db ./demo.sqlite --file examples/dogfood/01-capture.json
node dist/cli.js show --db ./demo.sqlite --request-id req_fixture_initial
node dist/cli.js capture --db ./demo.sqlite --file examples/dogfood/02-correct.json
node dist/cli.js search '架空' --db ./demo.sqlite
node dist/cli.js show --db ./demo.sqlite --request-id req_fixture_correction
node dist/cli.js show clm_fixture_old --db ./demo.sqlite
node dist/cli.js doctor --db ./demo.sqlite
```

The first bundle deliberately includes an overgeneralization, positive and doubting
material, a user hypothesis, and a distinct agent inference. The second corrects
that overgeneralization while preserving both reported conditions and the old
record. `ZKQ` appears only in Evidence: current search misses it. Issue #4 tracks
a proper retrieval route, not a demand that the writer anticipate future queries.
The tests exercise storage/CLI behavior, not agent autonomy or real-world success.
