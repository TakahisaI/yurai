# ADR 0005 — Deletion and redaction policy for an append-only ledger

Status: Proposed / 2026-09-27

yurai is append-only by default: records are immutable, UPDATE/DELETE are
refused by triggers, and export/import stay total. That default exists to
prevent silent loss — so any deletion path must be loud, deliberate, and
verifiable, or it undermines the core promise. This ADR specifies the
vocabulary, guarantees, and design rules. It specifies no implementation:
no CLI surface, flags, or destructive export/import variants live here.

## Decision

Ordinary correction is not deletion: a factual mistake stays append-only —
a new record plus `supersedes`, with a withdrawn Review on the old state
when appropriate — and the old record stays readable. Purge and redact
are reserved for sensitive data (secrets, private information) or
wrong-scope ingestion (another person's data, wrong database), never for
rewriting history to flatter it.

Two operations, distinct by what survives:

- **purge** removes whole records — bodies, links touching them, lookup
  rows, and receipts referencing them — for "this should never have been
  recorded" (wrong database, someone else's data, secret committed by
  mistake). Purged IDs vanish, including from in-ledger audit.
- **redact** replaces a record body with a tombstone while preserving
  id, type, actor, created_at, and links, for "the record stands but its
  content must go" (a secret span inside live context). Dependents keep
  resolving against tombstoned content; that degradation is accepted and
  visible.

Guarantees, by kind:

- redaction: a secret span inside an otherwise live record.
- purge: whole records, including their IDs, must vanish from the live file.
- explicit non-goals: erasure from already-shared exports or backup files
  outside operator control (impossible — the procedure lists known copies
  for manual destruction instead); forensic recovery from disk blocks (use
  OS disk encryption); compliance certification; in-place byte surgery on
  the live file; silent or lossy export/import; per-field ACL and TTL.

Design rules, normative for the future implementation issue:

1. Offline, exclusive copy-first: deletion runs with no other handles
   on the ledger and refuses when the file is locked. Snapshot the
   source consistently — checkpoint and close first, or use the SQLite
   online backup API / `VACUUM INTO` — so WAL-committed pages are
   included; never copy the bare main file while `-wal`/`-shm` hold
   committed data. The original file is untouched until the replacement
   verifies; replacement swaps in the new file only after every handle
   closes, and stale sidecars go away with the old file instead of
   being carried over.
2. Export-before-delete: the operator first exports the doomed scope, and
   the flow takes that export artifact as input — proof of deliberation
   and a recovery path. Accidental deletion must never be reframable as
   privacy. (For ledgers near the 16 MiB snapshot cap, the implementation
   issue must define how the scope export is cut.)
3. Atomic replacement: rebuild into a NEW file, regenerating links and
   lookup rows from the resulting bodies and preserving survivors' `seq`
   order (the v1→v2 precedent); gate replacement on `doctor`, an exact
   link-set verification, and a re-export comparison against a computed
   expectation — for purge, the pre-delete export minus the doomed scope
   (entries, their links and lookup rows, and affected receipts gone;
   everything else byte-identical); for redaction, the same entry IDs
   with tombstoned bodies, preserved links, regenerated lookup, and
   dropped affected receipts. Snapshots carry entries and receipts only
   and `doctor` checks FK validity rather than link exactness, so a
   missing or wrong-but-FK-valid link would pass both: the link table
   must be compared against `references(entry)` over all entries, in
   `doctor` or a dedicated verifier, before replacement.
4. Refuse dangling dependents: purge refuses when surviving records
   reference the doomed scope unless the scope expands to include them;
   the cascade is computed, shown, and confirmed.
5. Receipts: drop receipts referencing purged or redacted records, which
   no longer describe live content. Re-submission under the same
   `request_id` then fails closed on immutable-ID conflict whenever any
   ID of that capture survives (a partial purge, or any redact). If
   every ID was purged, the identical bundle is re-admissible: true
   vanishing and replay prevention are in tension, since prevention
   requires remembering — and the mandated pre-delete export is itself
   the resurrection bundle. The implementation issue must close this;
   the recommended direction is a tombstone registry of purged
   `request_id` digests (opaque: no IDs or content), consulted on
   capture and verify. Scope: it refuses re-submission under a purged
   `request_id` only — re-creation of the same content under a NEW
   `request_id` (new IDs, new receipt) is a new recording act,
   indistinguishable without remembering content, and is not stopped.
   Leakage: digests are deterministic SHA-256, so the registry leaks
   the purge count plus membership for any guessable `request_id`
   (offline dictionary test) — no IDs or content, but more than a bare
   count. Privacy-sensitive captures should therefore use unguessable
   `request_id` values. Registry entries must survive export/restore,
   or a restored ledger forgets purged IDs and admits their replay;
   the mechanism (snapshot extension or companion artifact) is deferred
   to the implementation issue.
6. Audit without resurrection: no in-ledger audit record carries purged
   IDs or content — that would defeat the purge. The pre-delete export
   is the audit artifact, held by the operator. A redaction tombstone
   replaces the body with a marker carrying reason, timestamp, and the
   reference targets the type needs to preserve links (`source_id`,
   `claim_id`, `evidence_id`, `from_claim_id`/`to_claim_id`,
   `target_id`, `target_evidence_id`/`target_source_id` as applicable);
   all other content fields are removed. Snapshot v1 needs no format
   change: restore regenerates links from the retained references. When
   a reference ID itself is sensitive, redact is the wrong tool — purge
   the scope instead. Tombstone bodies need a schema-valid representation
   for typed import validation; deferred to the implementation issue.
7. Backups: the procedure requires enumerating known backup and export
   copies and destroying or re-cutting them. The tool cannot reach
   copies it never held; that limit is stated, not solved.

## Reasons

- Mistakes are certain: pasted secrets, wrong database, private notes in
  a shared export. Even a single-user local tool needs a deliberate
  erasure path for handover, shared machines, and export screening.
- Hashes do not leak content, but IDs, URIs, and timestamps are metadata
  that can themselves be sensitive — hence purge removes IDs and audit
  lives outside the ledger.
- Rebuild-into-a-new-file beats DELETE-plus-VACUUM: no forensic residue
  in freelist pages, no partial-file states, and the same verification
  story as restore.

## Alternatives considered

- In-ledger tombstone records for purge: rejected — purged IDs must
  vanish, including from audit.
- In-place DELETE plus VACUUM: rejected — residue risk and no atomic
  replacement story.
- Silent filtering in export: rejected — export/import stay total; lossy
  transfer breaks restore verification and masquerades as privacy.
- Per-record encryption with key destruction (crypto-shredding):
  rejected for now — key management exceeds single-user local scope.

## Costs

Spec-only: no behavior change. Future implementation cost is a new
offline command family with cascade computation and verification gating.
Purge drops receipt history for affected `request_id` values: partial
scopes fail closed on re-submission, while fully-purged bundles need
the tombstone registry from rule 5 to stay non-resurrectable.

## Revisit when

- A real ledger first needs erasure, compliance pressure appears, or a
  shared/multi-user deployment is proposed.
- Destructive export/import is specifically requested.
