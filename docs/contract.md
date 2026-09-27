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
| search | Claim-centered literal AND search. kind=source searches Sources |
| show | Display the target, latest Review, direct references, connections, and each Evidence's Source |
| export | Write a ledger snapshot to stdout |
| import | Restore a snapshot into an empty ledger. Not a merge with existing data |
| doctor | Structural integrity of SQLite/FKs/search index. Not truth adjudication of content |

`--db` works on every command. Other flags work only on the operations shown in `--help`.
search/show limit defaults to 20, max 100. offset is 0–1,000,000. next_offset=null ends that search/connection page.
Search terms allow up to 500 chars and 16 whitespace-separated terms. FTS OR/NOT and SQL wildcards are not interpreted.

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
An accepted Review still leaves `anchor_not_verified` on the Evidence.

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
