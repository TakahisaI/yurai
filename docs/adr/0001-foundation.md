# ADR 0001 — Start small; pin only the distinctions that would be lost

Status: Accepted / 2026-09-27

## Decision

Build one package with TypeScript + Node.js standard SQLite + CLI.
The logical model is Source / Claim / Evidence / Assessment / Relation; the operations history is Review.
The primary storage boundary is atomic, idempotent capture, not repeated primitives.
Records are immutable; states append. Include search and export/restore in the first vertical slice.

## Reasons

Pointing at a source passage differs from judging that the passage supports a claim.
That distinction, claim attribution, recorder, conditions, and source edition would become fabricated information if estimated and backfilled later.
So the containers exist from the start. Meanwhile, a full ontology, normalization, entity resolution, and truth scores wait until usage demands them.

TypeScript shares contracts easily between the CLI and future agent adapters, and Node standard SQLite removes runtime native addons and external services.
Runtime API differences stay isolated in storage; CI targets 22.16 and 24.x.
A synchronous implementation keeps control simple and completion boundaries explicit for a small local ledger.

## Alternatives considered

- Keep the original four entities: interpretation and evidence locations mix, and claim ownership blurs.
- Separate entities for SourceRevision / Agent / Activity: too much input and implementation burden for early operation. Versioned Sources and actor values cover it.
- Always require human approval: breaks conversation flow. Store as proposed and explicitly review what matters.
- Forbid Claims without Evidence: loses hypotheses and original inferences. Allow them with explicit type and attribution.
- Neo4j / RDF / vector DB: unnecessary for this usage scale and these queries. Provenance holds without dedicated products.
- Python: adequate for SQLite and CLI, but this time keep typed contracts and future adapters in one language.
- Rust: attractive for single-binary distribution, but contract and usage-flow exploration comes first.
- Finish MCP first: protocol/tool design would drag before operations settle.

## Costs

Assessment and Review add volume. A lightweight hand-written schema validator stays, sharing definitions with the public JSON Schema; extending the covered subset adds tests.
No cryptographic tamper resistance or authentication. Immutability guards against mistakes and history loss, not against the DB owner.
The SQLite adapter uses JSON payloads with reference tables, so complex analytical SQL may later need index/column additions.

## Revisit when

Concrete examples arrive from real-world use: costly writes, heavy short-term search, visible lock waits under parallel agents, needed source-edition aggregation, inexpressible multi-premise inference.
Never add layers or services for abstract future extensibility alone.
