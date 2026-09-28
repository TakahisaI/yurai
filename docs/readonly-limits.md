# Read-only parity contract and OS/filesystem limits

#46 box 6. The storage guarantee is decided in
[ADR 0006](adr/0006-read-only-access.md) and summarized in
[contract.md](contract.md); this note pins the exact parity contract and the
measured OS/runtime/filesystem limitations. Every claim below names its test
or its explicit manual-verification status — there are no untested parity
claims. Box 5 (DB pinning across maintenance replacement) stays blocked on
#28 and is out of scope here.

Parity means: the same database, readonly handle vs writable handle,
identical outputs — values, warnings, states, pagination, `revision`, and
error codes/messages. The tests live in `test/readonly.test.mjs` (plus CLI
cases in `test/cli.test.mjs`) and run on the CI matrix — ubuntu-latest ×
Node 22.16.0/24, macos-latest × Node 24, windows-latest × Node 24 — so
"tested" below means covered by that suite. The new and changed assertions
in this slice have so far run on macOS/Node 24 only; their cross-platform
CI result is pending.

## Read parity

| # | Claim | Verification |
| --- | --- | --- |
| P1 | `search` is identical: claim/source kinds, 1–2-char and 3+-char terms, multi-term AND, `--include-inactive` both ways, limit/offset pages, past-end pages, and empty results | Tested: `readonly parity covers paging, projections, and empty results` |
| P2 | Expanded evidence search is identical: direct and routed-only matches, a two-path query with a nonempty second page, path past-end, empty queries, and the inactive audit | Tested: same test |
| P3 | `--projection refs-v1` is identical incl. a nonempty path page 2 | Tested: same test |
| P4 | `show` is identical for every record type incl. verification; evidence views carry the verification summary and anchor warnings; connection pages incl. past-end; warnings pinned non-vacuous (`anchor_match`, `inactive_record`) | Tested: same test |
| P5 | `inspectCapture` is identical for every receipt; pages incl. past-end | Tested: same test |
| P6 | `exportSnapshot` is identical | Tested: same test |
| P7 | `revision` is identical; a fresh `--as-of` succeeds identically; a stale `--as-of` fails with an identical CONFLICT on search/show/inspectCapture | Tested: same test + `readonly parity covers read errors and stale revisions` |
| P8 | Read errors are identical code+message with the expected code asserted per case: NOT_FOUND (unknown show/inspect/verify target), CONFLICT (stale as-of on search/show/inspectCapture), VALIDATION (bad query shapes, bad kind/expand/projection, path paging or projection without expand, bad page bounds, bad as-of, verify pre-write validation, invalid snapshot) | Tested: `readonly parity covers read errors and stale revisions` |
| P9 | Dry-run capture and dry-run verification persist nothing and succeed identically on a readonly handle | Tested: `readonly dry-run writes match writable; real writes fail READONLY` |
| P10 | Real capture/verify/import through a readonly handle fail with READONLY before mutation; bytes unchanged | Tested: same test + `writes through a readonly store fail before mutation` + `readonly import refuses before mutation on an empty ledger` + `CLI --readonly serves reads and refuses writes without touching bytes` |
| P11 | `doctor` is identical except `fts_integrity`: `skipped-readonly` vs `checked`. The FTS self-check is a write, so the readonly path skips it and says so | Tested: `doctor matches writable except the documented FTS self-check` |
| P12 | Readers see committed WAL frames, including frames committed after an earlier read; no immutable-file shortcut that ignores WAL state | Tested: `readonly readers see committed WAL frames and later commits` |
| P13 | Open refusals: absent → NOT_FOUND; foreign/future schema → SCHEMA; migration-needing → SCHEMA naming a writable reopen; readonly+create and readonly+`:memory:` → USAGE; `init --readonly` rejected | Tested: `readonly open refuses migration and leaves v1 bytes intact`, `readonly open refuses future schemas without a migration hint`, `readonly open rejects missing, foreign, and contradictory targets`, `CLI rejects init --readonly as contradictory` |
| P14 | A readonly open racing a concurrent migration fails safe with the writable-reopen error, migrates nothing, and succeeds after the migration commits | Tested: `readonly open racing a migration fails safe, then succeeds after commit` |
| P15 | No logical writes by the read handle: with no concurrent writer, main-file bytes plus WAL content are identical before and after any readonly session — no creation, migration, journal-mode switch, or content/receipt/index write by the handle. Commits from a concurrent writer stay visible to readers (P12) and are outside this comparison, as is sidecar file creation (L1) | Tested: snapshot comparisons in every mutation-adjacent readonly test, each with no concurrent writer |

## OS/runtime/filesystem limits

| # | Claim | Verification |
| --- | --- | --- |
| L1 | Opening a WAL-mode ledger readonly may create `-shm`/`-wal` sidecars. The guarantee is no logical database or WAL-frame writes by the handle (P15); sidecar file creation and the transient shared-memory index stay outside the guarantee, and a `-wal` created this way carries no new frames | Guarantee covered on the CI matrix (P15); this slice's cross-platform result pending (see above). Sidecar creation by a readonly open is manual-observation only on macOS/node:sqlite (a 32KiB `-shm` plus an empty `-wal` appear, main bytes unchanged, left behind after close) — the L8 test asserts sidecar presence only as a writer-produced precondition, not creation by the readonly open; occurrence varies by SQLite build/VFS — unverified on other platforms beyond the main-bytes-plus-WAL-content guarantee |
| L2 | On a read-only file, a readonly open serves reads (subject to the L8 sidecar/directory condition); a writable open either refuses at open or fails on the first write — both accepted, with SQLite's own permission/open wording matched so unrelated regressions cannot slip through | Covered on the CI matrix: `readonly open works on read-only files; writable writes fail`. Skips with reason when the process can write despite the bits (root/CAP_DAC_OVERRIDE). On Windows the 0o444 bit maps to the readonly attribute; the same test runs on windows-latest |
| L3 | No parity claim is made for network filesystems (NFS/SMB): SQLite locking semantics there vary by mount and OS, and failures surface as SQLite errors, not yurai guarantees | Unverified: no network-filesystem CI; manual only. Keep ledgers on local disks when the guarantees above matter |
| L4 | Replace-while-open follows the platform: on Windows renaming an open ledger away fails (EPERM/EACCES/EBUSY) and the attached reader keeps serving, while replacement-at-path is unverified on Windows (the Windows branch installs no replacement); on POSIX the rename succeeds, a checkpointed replacement installed at the path (old sidecars removed, as tested) is what later opens see, and the attached reader keeps the old inode. Replacement alongside a live WAL is UNRESOLVED (see L5) | Tested with a platform branch in `replace-while-open follows platform file-locking semantics`; each branch is covered on its CI platform. The Windows branch covers rename-away refusal only — replacement-at-path on Windows is unverified. The POSIX branch removes the old sidecars before installing the replacement, so only the checkpointed case is tested |
| L5 | Readonly does not pin the path: on POSIX a concurrent checkpointed replacement changes what later opens see while attached handles keep old bytes (tested in L4). Replacement with an active WAL is explicitly UNRESOLVED: observed on macOS/node:sqlite that with a live ~49KB WAL a new read-only open after replacement returned the old ledger's claims, not the replacement's — WAL state is persistent state bound to its main file. Startup pinning, #28 maintenance-guard cooperation, and active-WAL replacement semantics are the remaining box 5 scope | Pinning/guard/active-WAL replacement untested by design: box 5 scope, blocked on #28 |
| L6 | `:memory:` and `init` have no readonly form: there is no existing file to protect | Tested: USAGE refusals (P13) |
| L7 | SQLite's permission-denial wording varies by setup (refuse-at-open vs fail-on-first-write); both are accepted explicitly, never silently | Tested: message-matched variance in the L2 test |
| L8 | A WAL-mode readonly open needs any existing `-shm`/`-wal` sidecars readable, and when sidecars are absent a writable parent directory to create them (SQLite must create, map, and read the WAL index; per SQLite WAL docs every reader needs read access to the sidecars). Unreadable existing sidecars fail even with a writable directory — observed on macOS/node:sqlite as `ERR_SQLITE_ERROR: unable to open database file` — and absent sidecars with an unwritable directory fail as `ERR_SQLITE_ERROR: attempt to write a readonly database`, both surfaced unwrapped rather than as a yurai code; with sidecars present and readable the same unwritable directory serves reads | Tested: `readonly open needs readable existing sidecars; absent sidecars need a writable directory` (readable-present-serve, unreadable-present-fail with writable and unwritable directories, and absent-unwritable-fail phases; absent-writable-serve is the normal case covered throughout). Skips with reason where permission bits are not enforced (root/Windows) |

## What this slice did not change

No behavior change: the parity suite above passed against the existing
implementation with no divergence found, so no production code was touched.
Dry-run capture/verify succeeding identically on readonly handles (P9) is
pinned here as specified behavior, not a fix.
