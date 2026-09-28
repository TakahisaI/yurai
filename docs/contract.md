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
On a read-only file a writable open may still succeed — SQLite can fall
back to a read-only connection when read-write access is unavailable — and
fail only on the first write; other setups may refuse the open itself. Reads
of such files must still use `--readonly`.
Read-only opens see committed WAL frames, including frames committed after an
earlier read; they never use an immutable-file shortcut that ignores WAL state.
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
Routed Evidence views carry the same verification summary and anchor
warnings as direct reads.
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

### Expanded search projection (`--projection refs-v1`)

`search QUERY --expand evidence --projection refs-v1` returns the same
expanded result with path views factored out: each `via` entry carries
`evidence_ref`, `assessment_ref`, `source_ref`, and `match_fields`, while
the full un-reduced views appear once under top-level `included`, keyed by
existing record ID. Claims stay inline in `items`. The response tag is
`format: yurai.expanded.refs`, `version: 1` (a response-format version, not
a DB/snapshot version), plus the resolved `window` (`offset`, `limit`,
`path_offset`, `path_limit`).

Deduplication is by record ID only: same-text records under different IDs,
distinct Assessments, and opposing stances keep separate entries. Review
text and verification summaries ride the included views untouched.

Completeness: the `included` keys always equal the union of all `*_ref` in
the returned `via` — every reference resolves within the response, with no
missing and no extra views. `included_complete` is always `true`; it covers
only reference resolution, not the whole ledger or all grounds, and must not
be confused with `paths_truncated` (lexical path paging) or `next_offset`
(claim paging). Each page carries the views its own `via` needs; there is no
cross-response cache and no follow-up fetch.

Revision: the top-level `revision` binds `items` and `included` together.
Paged refs reads take `--as-of` exactly like inline expanded search and fail
with CONFLICT after an intervening write. The projection is a pure
transformation of the inline response: no extra reads, no `show` re-fetch.

Unknown projection values, `--projection` without `--expand evidence`, and
`--projection` with direct search, source search, or `show` fail explicitly
(VALIDATION/USAGE); a request is never silently answered in another shape.
Without the flag every response is byte-identical to before.

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

`show --request-id REQUEST_ID [--limit N] [--offset N] [--as-of REV]` selects a persisted receipt;
it cannot be combined with a positional record ID. Core exposes
`Ledger.inspectCapture(requestId, limit = 20, offset = 0, asOf?)`. Existing `show ID`
behavior is unchanged. The schema contract remains v1; the Store contract is v2,
adding `revision()` so paged reads can bind with `--as-of`.

Returns `request_id`, `digest`, `total`, `items`, `next_offset`, `revision`,
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

## Tombstones and replay registry (proposed contract; no destructive path yet)

Proposed future contract from ADR 0008 — not current behavior.
Today's readers reject `redacted: true` bodies and the `registry`
snapshot member under strict validation; the rules below define what
a future implementation must accept and enforce.

Redaction replaces a record body with a tombstone keeping the original
`id`/`type`/`actor`/`created_at`, the reference targets its kind needs
(`source_id`, `claim_id`+`evidence_id`, `from_claim_id`+`to_claim_id`,
`target_id`, `target_evidence_id`+`target_source_id`, or none for
Source/Claim), plus `redacted: true`, a `reason` marker
(`sensitive | wrong-scope`), and `redacted_at`. All other content —
verdicts, quotes, stances, outcomes, offsets, hashes — is removed and
never backfilled; tombstoned Reviews/Verifications contribute nothing to
effective state or anchor warnings. Redacting an Evidence also redacts
every Verification targeting it; an Evidence-only scope is refused.
Restore refuses a snapshot pairing tombstoned Evidence with a live
Verification targeting it, restoring nothing.
Direct capture of `redacted: true` bodies is rejected; tombstones arise
only from the future redact path.

Purge digests live in the same SQLite ledger and ride snapshots as an
optional versioned `registry` extension (`registry_version`, sorted
unique SHA-256 hex of purged `request_id` values; never raw IDs or
content). Snapshot-format version and SQLite schema version are
independent counters. Readers that do not understand the extension, or a
`registry_version` they do not support, refuse the snapshot rather than
restoring without it; snapshots without `registry` restore with an empty
registry. A receipt plus a blocked digest of the same `request_id` fails
closed with CONFLICT. Logical snapshot equality compares entries (exact
per-ID), receipts, and registry digests as sets, plus a per-target
Review/Verification event-order gate; bytewise SQLite-file equality is
not required. See ADR 0008.

## Merge retries vs origin receipts (proposed contract; no merge yet)

Proposed future contract from ADR 0011 — not current behavior. `import`
stays whole-snapshot restore into an empty ledger; no merge entry point
exists.

A future merge keeps three identities apart: the local merge-operation
request (ledger-scoped retry identity: same request plus same
artifact/selection/policy/namespace/pairing replays, any difference
conflicts — including a retried request under a different import
namespace or a changed shared-history pairing declaration;
JSON-RPC/process IDs never count), the immutable imported
artifact/selection, and origin capture requests/receipts (foreign
execution history, provenance only). Origin receipts are never installed
as local capture receipts; the merge mints fresh local receipts. Equal
request strings in unrelated ledgers prove nothing; origin-less repeats
refuse until the operator supplies distinct import namespaces.

The importer identity lives on the merge operation; imported entries
keep their foreign actor/`created_at` byte-identical. Paths, DOIs, URIs,
and user-supplied origin strings never prove historical sameness, and
provenance is self-reported, never authentication.

Local request-digest barriers run before any remap/admission step.
Same-ID tombstone/full-body pairs conflict in both directions; foreign
registries are neither consulted nor unioned; foreign-internal
receipt/registry and tombstone/verification contradictions refuse the
artifact whole; imported deletion metadata never deletes local records
or drops local receipts. No universal resurrection prevention is claimed:
rewritten request IDs, fully purged record IDs, and newly keyed content
are undetectable (except an explicitly paired shared-history re-supply
of the purged request string, refused per C9), and uncertain admission
refuses. Zero-create merges
refuse until their receipt shape settles (P9), and the importer-actor
recording awaits a bundle shape that the current receipts row cannot
hold. See ADR 0011, including the
PROVISIONAL register (P1–P11) for clauses awaiting #23 boxes 3–4
decisions, a #23-owned tombstone-transfer decision, #31-final
integration, or #32 selection mechanics.

## Snapshot

`format=yurai.snapshot`, `version=1`, entries, receipts, and — once ADR 0008 is implemented — the optional `registry` extension (above; rejected by current readers). Each entry carries created_at and actor.
CLI restore caps at 16 MiB. The 100,000 entries/receipts cap assumes small-scale operation; it is a safety bound, not a performance guarantee at that scale.
export writes everything for small ledgers. Output beyond the current CLI restore limit errors out with no output, so unrestorable backups are never created. Large ledgers need streaming transfer plus SQLite backup operations.
OS file permissions, disk encryption, and a safe location are the user's responsibility. Never commit DBs or snapshots to a public repository.
