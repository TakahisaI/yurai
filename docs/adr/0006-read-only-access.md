# ADR 0006 — Read-only ledger access as a storage-opening mode

Status: Accepted / 2026-09-27

## Decision

Add a read-only opening mode to the storage adapter, exposed as CLI
`--readonly`. It opens an existing file ledger through SQLite read-only
access and refuses every mutation path before it can execute:

- No creation, no schema migration, no journal-mode change, no
  content/receipt/index write. Writes fail with `READONLY`.
- Multi-query reads keep a deferred `BEGIN`/`COMMIT` snapshot, so export
  and expanded search stay consistent under concurrent writers.
- A ledger needing migration fails and names a writable reopen; unknown
  and future schemas are refused exactly as on the writable path.
- doctor skips the FTS self-check write and reports `fts_integrity:
  skipped-readonly`; all other checks still run.

## Guarantees and limits

The guarantee is that the read-only handle performs no logical database or
WAL-frame writes: with no concurrent writer, main-file bytes plus WAL content
are byte-identical before and after any read-only session (a concurrent
writer's commits stay visible to readers and are outside this comparison).
Opening a WAL-mode ledger may still create `-shm`/`-wal` sidecars; sidecar
file creation and the transient shared-memory index are outside the guarantee.
`:memory:` and `init`
have no read-only form: there is no existing file to protect.

This mode protects against application writes. It is not a sandbox
against an OS user who can edit the file, and it does not change the
threat model for the DB owner. File-permission matrices, WAL races with
an active writer, long-lived readers across maintenance replacement,
and measured OS/filesystem limits belong to later #46 slices.

## Alternatives rejected

- `immutable=1` opens: they ignore WAL state, so a reader could miss
  committed captures. Rejected: unfaithful recall is worse than sidecars.
- File-permission-only enforcement: stops the OS user, not an in-process
  write path, and says nothing about migration or receipts. Rejected as
  the mechanism (still the user's responsibility as defense in depth).
- Hiding write tools while opening writable: a directly invoked write
  would still mutate. Rejected: the store itself must refuse.
