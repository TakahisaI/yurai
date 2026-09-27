# ADR 0004 — Quote verification as append-only history plus the v1→v2 migration

Status: Accepted / 2026-09-27

## Decision

Add a seventh record type, `verification`, holding one quote check: target
Evidence and Source, outcome (`match`/`mismatch`/`multiple`/`unreachable`),
method (`verbatim`/`normalized`), verification time, checked-bytes hash, and —
for verbatim hits only — passage hash with byte offsets. Verification events
are history like Reviews: immutable, never review targets, excluded from
`not_reviewed`. Evidence views show the latest event with edition/bytes
agreement against the Source's declared `version`/`content_sha256`, and anchor
warnings read `anchor_match`/`anchor_mismatch`/`anchor_multiple`/
`anchor_unreachable`, falling back to `anchor_not_verified` when never checked.

Matching is a pure Core function over caller-supplied bytes; reading files
stays in the CLI adapter, which persists outcomes only through atomic capture
with an event ID derived from the `request_id` (replay-safe like `review`).
Verbatim matching is exact substring search with prefix/suffix adjacency;
`normalized` folds NFKC, lowercase, and whitespace runs on both sides and
stores counts without byte offsets, which would not map to the source.
Originals are never rewritten. Only UTF-8 up to 4 MiB is checkable; a missing
or unreadable file records `unreachable` with the reason instead of failing
silently. A match verifies the passage, never the claim.

Schema v2 admits the record type by rebuilding `records` (SQLite cannot drop a
CHECK) with `seq` preserved. Known v1 ledgers migrate automatically on open:
integrity pre-check, foreign keys off around a single transaction (DROP TABLE
under enforced deferred FKs always fails at commit), integrity post-check. A
crash leaves v1 data with version 1, so reopening retries. Unknown and future
versions are still refused. The frozen v1 DDL ships as a test fixture.

## Reasons

Anchor state was the one provenance promise v0 could not keep: every Evidence
read `anchor_not_verified` forever. A separate event type keeps verification
history apart from adopted state and claim truth, while reusing the existing
capture/export/restore machinery losslessly. Keeping file reads outside Core
preserves the Core/adapter boundary; keeping the matcher pure keeps it testable
without a filesystem.

## Alternatives considered

- Riding the `review` type for verification results: rejected; it would mix
  working state with match outcomes and pollute review lookups.
- Auto-fetching URIs or discovering files: rejected; Issue #2 scopes to
  explicitly given local bytes, with network design deferred.
- Indexing verification text for search: rejected; match provenance surfaces
  through views, not a new search path.
- Editable/mutable verification state: rejected; corrections are new events,
  with latest-wins display.

## Costs

One more record type, one migration procedure to maintain, and per-query
verification lookups on Evidence views. The 4 MiB UTF-8-only limit excludes
binary and huge sources until a later issue justifies more.

## Revisit when

Real use demands other encodings, larger files, snapshot-backed verification,
or HTTP retrieval with its own SSRF/redirect/size/confidentiality design.
