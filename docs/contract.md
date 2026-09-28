# CLI / Data Contract v1

## Canonical input

TypeScript types and the runtime schema live in `src/core/model.ts`. Emit machine-readable JSON Schema with:

```sh
node dist/cli.js schema bundle
node dist/cli.js schema record
node dist/cli.js schema snapshot
```

Reference target types, the quote/locator rule, URIs, realness of timestamps, and supersedes cycles exceed what schema expresses; Core validates them additionally.
Unknown keys, blank-only strings, NUL, and out-of-range arrays and strings are rejected.
Stored strings including quotes are never trimmed or rewritten. IDs start with a letter, 2–128 chars of `A-Z a-z 0-9 _ . : -`.

## Single-record example

```json
{
  "id": "clm_my_hypothesis",
  "type": "claim",
  "data": {
    "text": "この条件では別の説明が成立するかもしれない。",
    "kind": "hypothesis",
    "attributed_to": "me",
    "scope": "現在検討している事例のみ",
    "why": "次に検証したい仮説"
  }
}
```

Store with `add --file record.json`. To re-run with the same ID, pass the same `--request-id`.
New content gets a new ID and request_id. In `capture` the bundle itself carries actor and request_id, so CLI actor overrides are rejected.
Up to 200 records / 1 MiB. `--file -` reads stdin too.

## Main operations

| Operation | Meaning |
| --- | --- |
| init | Create a ledger that does not exist yet. Idempotent on an existing yurai ledger |
| capture | Validate and store the whole bundle. dry-run writes neither content nor receipts |
| add | Wrap a single record into capture |
| review | Generate a Review record and capture it |
| verify | Match an Evidence quote against a local file; store the outcome as history |
| search | Claim-centered literal AND search. kind=source searches Sources. --expand evidence also routes Evidence matches to Claims |
| show ID | Display the target, latest Review, direct references, connections, and each Evidence's Source |
| show --request-id ID | Inspect records created by one persisted capture, their immediate grounds, and current states |
| export | Write a ledger snapshot to stdout |
| import | Restore a snapshot into an empty ledger. Not a merge with existing data |
| doctor | Structural integrity of SQLite/FKs/search index. Not truth adjudication of content |

`--db` works on every command. Other flags work only on the operations shown in `--help`.
`--readonly` opens an existing file ledger through SQLite read-only access: no creation,
migration, journal-mode change, or content/receipt/index write. Writes fail with `READONLY`
before mutation; a schema needing migration fails and names a writable reopen. `init
--readonly` is rejected. doctor under `--readonly` reports `fts_integrity:
skipped-readonly` because the FTS self-check is a write; writable doctor reports `checked`.
Opening a WAL-mode ledger may still create `-shm`/`-wal` sidecars; the guarantee covers
main-file bytes and WAL content, not the transient shared-memory index.
search/show limit defaults to 20, max 100. offset is 0–1,000,000. next_offset=null ends that search/connection page.
Responses carry `revision`, the current ledger change marker. Repeating a paged
read with `--as-of REV` fails with CONFLICT when the ledger changed since that
revision, so callers restart instead of skipping or duplicating rows.
Search terms allow up to 500 chars and 16 whitespace-separated terms. FTS OR/NOT and SQL wildcards are not interpreted.

## Expanded discovery

`search QUERY --expand evidence` (claims only; rejected with `--kind source`)
unions direct Claim matches with Claims routed from matching Evidence through
their Assessments. Every normalized token must occur in the Evidence `quote`
or `paraphrase`; locators are pointers, not content, and stay out. Traversal
is strictly Evidence→Assessment→Claim: sharing a Source never routes a Claim.

Each item carries `direct_match`, plus `via` entries with the matching
Evidence (and matched fields), the linking Assessment with its stance, and
the Evidence's Source — each with current state, review, and warnings.
`total_paths` counts routed paths (never independent corroboration) and
`paths_truncated` marks a cut per-claim window: true whenever earlier or
later paths fall outside it, so `false` always means `via` is complete. The per-claim window is
independent of the claim page: `--path-limit` (1..100, default: `--limit`)
and `--path-offset` page it, with `via_next_offset` continuing truncated
paths to their end. Paths order deterministically by Assessment recency,
then Evidence ID, then Assessment ID. An intervening write can shift
newest-first positions, so path pages bind with `--as-of` exactly like claim
pages: pass the first page's `revision` and a changed ledger fails explicitly.
`via` holds lexical matching paths only; `show` pages all inspected grounds.
Claims page by newest first with the usual `next_offset`; ties on recorded
time break by ascending ID, so same-capture direct matches may order
differently than in direct search. The response tag is
`match: expanded_evidence_routed`.

Withdrawn/rejected Claims stay out by default and return in the
`--include-inactive` audit path. Paths through withdrawn/rejected Evidence,
Assessment, or Source are dropped by default and kept for audit with full
states. A `context` or `reports` match never becomes `supports`.

Discovery scans Evidence records per query (no new index or migration) and
suits small ledgers only. Finding a passage verifies neither the quotation
nor the claim: `anchor_not_verified` still applies and truth stays unevaluated.

## Verifying a quotation

`verify EVIDENCE_ID --file PATH [--edition LABEL] [--method verbatim|normalized]`
checks the Evidence quote against explicitly given local bytes (UTF-8, up to
4 MiB; `--file -` reads stdin) and stores one append-only `verification`
record through the usual atomic capture. Nothing is fetched: URIs stay inert
and only the designated bytes are read. The event ID derives from the
`request_id`, so re-running with the same `--request-id` replays.

Outcomes: `match` (exactly one affix-qualified occurrence), `mismatch` (none),
`multiple` (more than one; offsets capped at 50 with a total count),
`unreachable` (the file could not be read; no byte fields, reason required).
Verbatim matching is exact substring search with optional prefix/suffix
adjacency; `normalized` instead folds NFKC, lowercase, and whitespace runs to
single spaces on both sides, records `method: normalized`, and stores counts
without byte offsets, which would not map to the source. Originals are never
rewritten: a normalized match leaves the stored quote untouched.

Each checked outcome pins `searched_sha256`/`searched_bytes` of the examined
bytes; verbatim matches additionally pin `passage_sha256`, `byte_offset`, and
`byte_length`. Evidence views carry the latest verification with
edition/bytes agreement against the Source's declared `version` and
`content_sha256` (`match`, `mismatch`, or `unknown` when either side is
undeclared). Warnings read `anchor_match`, `anchor_mismatch`,
`anchor_multiple`, `anchor_unreachable`, or `anchor_not_verified` when never
checked. A match verifies the passage, never the claim: `truth_evaluated`
stays false and adopted state is untouched. Reviews never target verifications.

Locator-only Evidence has no quote to match and fails validation even when
the file is unreadable, as do non-UTF-8 bytes and oversize input. Direct
capture of a verification against quoteless Evidence fails the same way.
Verification history rides the normal
export/restore path losslessly. Schema v2 admits the record type; v1 ledgers
migrate forward automatically on first writable open (see architecture).
A `--readonly` open of a migration-needing ledger fails and names a writable
reopen instead of migrating.

## Inspecting one capture

`show --request-id REQUEST_ID [--limit N] [--offset N]` selects a persisted receipt;
it cannot be combined with a positional record ID. Core exposes
`Ledger.inspectCapture(requestId, limit = 20, offset = 0)`. Existing `show ID`
behavior is unchanged, and schema/Store contracts remain v1.

Returns `request_id`, `digest`, `total`, `items`, `next_offset`,
`states_as_of: "inspection"`, and `truth_evaluated: false`. Each item includes its
original entry, current review/state/warnings, direct references, and the Source
of referenced Evidence. Items follow the receipt's original ID order; inactive
members are not filtered. Total counts members, not expanded dependencies.

This is a view of what that request created, not every later relationship touching
those records. Use `show ID` and its connection pages for that history. Membership
and Review event bodies are immutable; effective states are current at inspection
time, not a historical replay. A Review's decision is `entry.data.state`; its target's
current working state can now differ. No capture-level accepted state is inferred.

The operation writes no records, reviews, receipts, or index data. Without
`--readonly` the SQLite connection still opens writable (migration and journal
behavior may apply); with `--readonly` the storage guarantee above applies.
No full-ledger scan is required. Limits are the same as show/search. Past-end
pages contain an empty items array and null next_offset. Unknown receipts (including
uncommitted dry-runs) return NOT_FOUND; malformed selectors/page bounds return
VALIDATION or USAGE. Receipts restored from v1 snapshots remain inspectable;
their digests are replay metadata, not authenticated proof of origin.

## States and corrections

Content starts in proposed. The latest Review by insertion order decides the working state. Never infer order from equal timestamps or ingestion-time reversals.
Changing the working state never deletes records or past Reviews.

```sh
node dist/cli.js review clm_my_hypothesis --state withdrawn --reason '条件を誤っていた' --request-id req_withdraw_v1
```

A correction bundles a new Claim + a new→old supersedes Relation +, when needed, a withdrawn Review on the old Claim into one capture.
supersedes alone does not withdraw. No state substitutes for true/false/verified.
Withdraw a wrong old Evidence and add a corrected location under a new ID with its Assessment.

## Reading relations

`from_claim_id --relation--> to_claim_id`. from supports/limits/extends/replaces to.
`Assessment.claim_id` is the interpretation target; `evidence_id` is the grounding passage; rationale is why they connect.
Never implicitly convert `reports` into `supports`. contradicts keeps comparable-scope reasons in rationale.
An accepted Review never changes the Evidence anchor state; only a verification outcome does.

## Output and errors

Successful output other than help is JSON. schema/export structures pass to other tools as-is.
Errors go to stderr as `{"error":{"code":"...","message":"..."}}`. Node runtime warnings may also appear on stderr.
Exit codes: 0=success, 1=IO/runtime/schema/doctor failure, 2=input/usage, 3=no target, 4=conflict.
Never build an adapter that drops states and warnings and treats bare content as grounds.

## Snapshot

`format=yurai.snapshot`, `version=1`, entries, receipts. Each entry carries created_at and actor.
CLI restore caps at 16 MiB. The 100,000 entries/receipts cap assumes small-scale operation; it is a safety bound, not a performance guarantee at that scale.
export writes everything for small ledgers. Output beyond the current CLI restore limit errors out with no output, so unrestorable backups are never created. Large ledgers need streaming transfer plus SQLite backup operations.
OS file permissions, disk encryption, and a safe location are the user's responsibility. Never commit DBs or snapshots to a public repository.
