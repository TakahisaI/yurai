# Architecture

## Boundaries

```text
src/cli.ts                  arguments, files, stdin/stdout
      │
src/core/ledger.ts           capture / search / show / export / restore
      │                     provenance, reference types, invariants, review states
src/core/ports.ts            a small Store interface
      │
src/storage/sqlite.ts       SQL, transactions, persistence, search index

src/core/model.ts            types, input schema, local validation
```

Core depends on neither CLI, MCP, file retrieval, model APIs, nor SQLite.
It uses Node's standard cryptographic hash and URL parsing. Model independence is not the same as runtime independence.
New entry points delegate to the same Ledger. Writing to the Store directly from an adapter is forbidden.
Quote matching is a pure Core function over caller-supplied bytes; reading files stays in the CLI adapter, which persists outcomes only through atomic capture.

## Why this size

One TypeScript package, one SQLite DB. No monorepo, ORM, dependency injection framework, graph database, or web server.
CLI and MCP share use cases and the data contract, not protocol-specific conveniences.
Zero runtime dependencies. Node's `node:sqlite` stays isolated in one storage adapter.
Node 22.16 is the compatibility floor and 24.x the normal development environment; CI checks both.

## Physical model

- `records`: the five content types plus Review. Typed validation applies to JSON data/actor; ID, type, order, and time stay in columns.
- `links`: searchable directed references. FKs and type checks combine. FKs allow forward references within one capture.
- `receipts`: request_id, SHA-256 of normalized input, created ID list. Prevents double writes on retry.
- `lookup`: FTS5 trigram search index regenerable from Claims/Sources.

This is not a general graph engine for adding arbitrary types or edges. The fixed discriminated union and Store API are the public contract.
JSON columns exist so a small adapter can round-trip a few types with natural-language metadata losslessly.
Reference and state queries are indexed; only concretely needed fields graduate to columns and indexes.

## Storage invariants

1. actor and created_at stay on every record. An actor is not a signed identity.
2. IDs are immutable. Never overwrite an existing ID. Never auto-merge similar texts.
3. Evidence references a Source; Assessment references a Claim and an Evidence. Both Relation ends are Claims.
4. Evidence needs a quote or locator. Never store a bare summary as an evidence location.
5. Reviews never target Reviews. Never mix working state with truth and quote matching.
6. All records, references, indexes, and receipts commit in one SQLite transaction.
7. The same request_id with the same input yields the same receipt. Different content is a CONFLICT.
8. supersedes cycles are forbidden. No mechanical inference from other semantic relations.

Triggers reject UPDATE/DELETE. That is no defense against tampering by the DB owner.
No cryptographic signatures, hash chains, or event-sourcing platform.

## Search and expansion

Stored originals never change; only the search text is NFKC-normalized and lowercased.
Input is whitespace-separated literal AND search, never executed as search expressions, SQL, or regex.
Terms of 3+ characters use trigrams; 1–2 character terms use substring search over the same normalized text.
Handles "出生率", "出生", and "AI" alike. No morphological analysis or semantic search.

Search defaults to Claims. rejected/withdrawn stay out of default search but remain via ID lookup and include-inactive.
Expanded discovery (`--expand evidence`) additionally scans Evidence quotes and paraphrases per query and routes strict Evidence→Assessment→Claim paths to union with direct matches. The scan needs no index or schema migration; it suits small ledgers only and never verifies quotations.
show expands direct connections and the needed Evidence→Source hops. It never traverses the graph unboundedly.
When a relation target is unaccepted or withdrawn, include that state in the response. Never describe missing-page counterevidence as "nonexistent."

## Integrity, migration, backup

`application_id` and `user_version` identify our own DB. Never silently initialize an unknown or future-version DB.
The v1 migration is the initial schema only. v2 admits the `verification` record
type by rebuilding the `records` table (SQLite cannot drop a CHECK), preserving
`seq` so insertion order survives. Known v1 ledgers migrate automatically on
open. Migrations run as a numbered chain from the stored version to current;
the registry owns each step's transaction and commits its DDL, integrity
checks, and version update as one atomic unit, so any failure rolls everything
back for a retry. Foreign keys stay off around the chain (DROP TABLE under
enforced deferred FKs fails at commit, and the pragma cannot flip inside a
transaction); steps verify integrity explicitly instead. Unknown or future
versions are still refused. Each migration ships with a frozen old-schema
fixture and a test proving lossless forward movement, and a frozen
current-schema fixture guards fresh initialization against drift.
WAL, foreign_keys, busy_timeout, and synchronous=FULL are set.

export reads all records and receipts from one transaction, preserving Review insertion order.
restore targets an empty ledger only, checking schema and references before committing everything. It is not a merge with an existing ledger.
Source blobs and the far side of external URIs are out of export scope. Actors and digests recorded in a snapshot are not authenticated.

## Deliberate limits of the initial implementation

capture's supersedes check and export/restore read everything, sized for small ledgers.
Synchronous waits with BEGIN IMMEDIATE serialize writes; blocked writers retry for 5s (busy_timeout), then fail with exit 1 (`IO_OR_RUNTIME`, 'database is locked') and persist nothing partial. Not tuned for long-lived servers or heavy parallel writes.
Search order is newest-first, not relevance ranking. No full Unicode case folding or morphological processing.
show pages include Reviews, so reading all grounds requires following next_offset.
Quote truth, locator validity, and source independence are unevaluated.
Large ledgers, redaction, merge-import, quote matching, and privilege separation are later issues; never display them as implemented.
