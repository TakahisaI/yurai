# ADR 0005 — Deletion and redaction policy for an append-only ledger

Status: Accepted / 2026-09-27

yurai is append-only by default: records are immutable, UPDATE/DELETE are
refused by triggers, and export/import stay total. That default exists to
prevent silent loss — so any deletion path must be loud, deliberate, and
verifiable, or it undermines the core promise. This ADR specifies the
vocabulary, guarantees, and design rules. It specifies no implementation:
no CLI surface, flags, or destructive export/import variants live here.

## Decision

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

1. Copy-first: operate on a copy; the original file is untouched until
   the replacement verifies.
2. Export-before-delete: the operator first exports the doomed scope, and
   the flow takes that export artifact as input — proof of deliberation
   and a recovery path. Accidental deletion must never be reframable as
   privacy. (For ledgers near the 16 MiB snapshot cap, the implementation
   issue must define how the scope export is cut.)
3. Atomic replacement: rebuild into a NEW file, regenerating lookup rows
   from the resulting bodies and preserving survivors' `seq` order (the
   v1→v2 precedent); gate replacement on `doctor` plus a re-export
   comparison against the computed expectation (pre-delete export minus
   the doomed scope).
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
   capture and verify.
6. Audit without resurrection: no in-ledger audit record carries purged
   IDs or content — that would defeat the purge. The pre-delete export
   is the audit artifact, held by the operator. A redaction tombstone
   replaces the body with a marker carrying reason and timestamp only;
   id, type, actor, created_at, and links survive as the Decision
   states. Tombstone bodies need a schema-valid representation for
   typed import validation; deferred to the implementation issue.
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
