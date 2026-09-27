# yurai — A ledger of claims and provenance

Decided: 2026-09-27 / Status: adopted as the v0 design

## 1. Product core

> **Carry knowledge gained in conversation into the next conversation without losing attribution, conditions, interpretations, or the path to sources.**

The unit of storage is not materials or conversation logs but the claims worth reusing and the provenance needed to understand them.
Users do not want to organize papers or edit schemas. "Keep this discussion" and "show what I looked up before" are the primary operations.

Presence in the ledger does not mean something is true. The asserter, recorder, and interpreter may differ.
What AI said can be recorded, but that alone is no ground for facts about the outside world.
Meanwhile, for a claim like "that AI made that statement," the conversation itself can serve as the source. Keep the two distinct.

## 2. What the rework keeps from the original draft

Keep Claim-centered modeling, separation from Sources, natural-language claims, SQLite, CLI-first, MCP as a thin adapter, and single-user local operation.
Do not bring PDF layout or highlight colors into the ledger schema. Do not start material management for format normalization.
Do not define a large ontology up front, and do not do automatic integration of relations or truth adjudication.

## 3. What the rework changes from the original draft

| Gap in the original draft | Reworked decision |
| --- | --- |
| No place to store "who" | Separate Claim `attributed_to` from each record's `actor` |
| Evidence doubles as the link to a Claim and the source location | Limit Evidence to source locations; move interpretation to Assessment |
| "The material states it" and "it supports the claim" are mixed | Separate `reports` from `supports` |
| Source URLs change | Record Source as the consulted edition, optionally holding version, accessed_at, hash, snapshot_uri |
| "Adding provenance later" loses past provenance | Hold recorder, time, and Review history from the start |
| Running primitives in sequence leaves partial state | Make atomic, idempotent `capture` the primary write operation |
| Deferring search hides practical value | Include Japanese and short-term search in v0 |
| Edits and migrations lose records | Include immutable records, append-only Review, and export/restore in v0 |

This normalization does not add complexity for its own sake. **Store now only the distinctions that cannot be recovered later.**

## 4. Semantic model

### Claim — what is asserted

`text`, `kind`, and `attributed_to` are required. `kind` is assertion / hypothesis / inference.
`scope` holds applicable conditions and `why` holds why it mattered in this conversation. Plain natural language is fine.
When attribution is unknown, state `unknown` explicitly; do not guess the source's author.
Claims can be stored unverified and even without grounds. Losing hypotheses means losing the fruits of conversation.

### Source — which edition was consulted

Papers, web pages, books, datasets, code, experiments, and conversations share one container.
One Source record is not the entity-resolved abstract work but a description of the consulted material and edition.
Seeing a revised edition of the same URL gets a new ID. Do not merge on matching DOI or URL alone.

`uri` or `identifiers` is required. An ISBN suffices for a printed book.
`version`, `accessed_at`, `snapshot_uri`, and `content_sha256` hold only what is known.
Retrieval time and ledger recording time are different things; do not fill in the same value automatically.

**A hash is a clue to sameness of content, not the content itself nor a guarantee of authenticity.**
A URL alone cannot reverify after link rot. v0 surfaces that limit instead of pretending to have fetched.
A source-preservation adapter comes later; the ledger never becomes a PDF management app.

### Evidence — which part of the source

One Source plus a quote or locator. Figures, tables, or dataset rows need no prose quotation.
Hold verbatim text in quote and summaries in paraphrase, separately. prefix/suffix around the quoted passage can be stored.
A locator may start as any string a human can use to rediscover the passage; typed selectors come later.

v0 does not match quotations against sources. Evidence always returns as `anchor_not_verified`.
An "accepted Evidence" is not the same as an "Evidence matched against its source."

### Assessment — how that passage is interpreted

Links a Claim and an Evidence, with stance and rationale. The interpreter stays in the record's actor.

- `reports`: the source states the claim. Truth of the content is not assessed.
- `supports` / `challenges`: interpreted as supporting material / counterevidence or doubts for the claim.
- `qualifies` / `context`: gives conditions or limits / is background information.

Multiple Assessments may attach to one passage. Do not treat paper or citation counts as counts of independent evidence.
An Assessment is itself a human or AI assertion. Do not promote it to fact with numeric confidence.

### Relation — how two claims relate

Both ends are Claims. Holds supports / contradicts / qualifies / extends / related / supersedes.
Relations also require rationale and actor. Do not blindly trust bare "AI-drawn links."
Direction reads: from acts on to. Keep the stored direction for contradicts and related too; traverse both ways when displaying.
supersedes runs new → old. Cycles are forbidden, but old claims are never auto-deleted or auto-withdrawn.

Do not propagate supports or contradicts transitively. Do not conflate different populations or experimental conditions.
Do not introduce whole-inference expressions needing multiple premises until concrete demand appears.

### Review — how to treat a record

Append-only events against the five content record types. States are proposed / accepted / rejected / withdrawn.
Content starts in proposed. The latest Review by insertion order is the effective working state.
accepted means "a decision to keep this record," not "correct," "quote-checked," or "human-approved."
AI may review too, but always display whose judgment it is. There is no authentication infrastructure.

## 5. The closed loop of use

1. **Capture**: build a bundle from a conversation with an existing AI, check it with dry-run, store it at once.
2. **Recall**: search Claims and read the needed Assessments, Evidence, Sources, and Relations.
3. **Revisit**: when doubts arise, recheck the source externally and add or withdraw interpretations and claims.

Re-reading the source can come last but must always be reachable. When turning search results into a final answer, keep grounds, reservations, and unverified states.
Automatic access to conversations, automatic saving inside chat apps, and automatic re-feeding into models are not v0 features.

## 6. First success criteria

Reproduce three cases in real-world use.

- For one topic, retrieve supporting and doubting materials without the original chat.
- Retrieve one's own hypothesis, an AI inference, and a source's claim without confusion, with saved reasons and conditions.
- On finding a wrong quotation or a revised material, keep the correction and its history without deleting the old record.

Observe the burden of interrupting conversation to store, the accuracy of retrieved content, and the reachability of sources.
Do not build a large benchmark up front. But never confuse passing unit tests with proving practical value.

## 7. Explicit non-goals

Material viewers, full-chat management, note editing, citation formatting, universal KG, RDF compatibility, LLM runtimes, fully automatic extraction, automatic truth adjudication, team sharing, cloud sync.
Do not build a new harness or RAG platform disguised as a knowledge-storing app.

## 8. Primary sources consulted

These are design references, not papers proving yurai's effectiveness.

- W3C PROV-DM: a provenance model distinguishing entity / activity / agent. Does not implement the full text or adopt RDF. https://www.w3.org/TR/prov-dm/
- W3C Web Annotation Data Model: TextQuoteSelector exact/prefix/suffix and the state of changing sources. v0 borrows the concepts without claiming W3C conformance. https://www.w3.org/TR/annotation-model/
- SQLite FTS5: trigram substring search and the sub-3-character limitation. https://www.sqlite.org/fts5.html
- Node.js SQLite API: the standard SQLite boundary and sync API. https://nodejs.org/api/sqlite.html

Individual recent study names from the original draft are not inherited: unverified summaries must not ground product design. Add them after checking sources when needed.
