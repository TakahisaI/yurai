# ADR 0010 — Assess-only Core instrumentation hooks

Status: Accepted / 2026-09-28 (issue #44, Store-method calls / returned rows / Ledger-level scans)

## Context

Issue #44 needs per-operation Store/DB calls, logical records touched, and
scans performed where instrumentable, to find the first real bottleneck at
scale. The likely cost centers are already visible in Core:
`checkReferences` loads the whole ledger for the supersedes-cycle check on
every capture, expanded discovery scans every stored record for Evidence
candidates, and each rendered view issues its own `latestReview` /
`latestVerification` lookups. None of this is measured yet, and any
measurement must not change behavior, results, ordering, or the performance
characteristics of normal operation.

## Decision

Add two assess-only observation points in Core, both inert by default:

- `Ledger` takes an optional third constructor argument, a
  `LedgerObserver` that receives `scan(kind, recordsExamined)` reports from
  exactly three full-ledger read sites: the supersedes check in
  `checkReferences` (`supersedes-check`, stored plus input records), the
  Evidence-candidate loop in expanded discovery (`expanded-evidence`), and
  `exportSnapshot` (`export`). These are Ledger-level records examined, not
  SQL statements issued or rows examined inside SQLite. Ledger never branches
  on the observer and swallows any throw from it; every report site is one
  guarded call, so the hooks-off path adds a single predictable branch per
  site and assess-only code can never alter control flow or errors.
- `CountingStore` (`src/core/observe.ts`) is a `Store` decorator that
  delegates every call verbatim and counts per-method Store-method calls
  plus rows returned and rows written (array length, 1/0 on single-lookup
  hit/miss, 0 for scalar calls; each void write contributes 1 row written
  and 0 rows returned) — never SQL statements or SQLite rows examined. It
  lives in Core behind the `Store` port — no storage imports — and
  production paths (CLI, MCP) never wrap the store; only the measurement
  harness opts in. Normal operation therefore keeps one predictable branch
  per observer report site and no decorator cost.
- `ScanCollector` collects the observer reports for one measurement window.

The measurement script (`scripts/measure-scale.mjs`) runs timings on the
same unwrapped store as pre-instrumentation baselines (no decorator, no
observer), so warm/cold comparisons and baseline continuity hold; counting
runs in a separate deterministic pass per operation that snapshots
`{ store_method_calls, rows_returned, rows_written, calls, scans }` into a
new per-shape `cost` section (per-method `calls` entries are
`[calls, rows returned, rows written]`). The cost pass runs on a separately
built pristine-shape DB, so each entry describes the advertised counts
(read/export scans report the shape base; `capture_single` runs last within
the pass and its supersedes-check scan is base + 1 input record) while the
main DB stays at the advertised base for the capture timing probes. Cold
paths are not re-counted; they run the same Ledger code over the same rows,
so warm counts apply.

Counts are Store-method calls, rows returned and rows written by Store
methods, and Ledger-level scan reports — not SQL statements issued or rows
examined inside SQLite, so the known SQL bottleneck stays unmeasured at this
layer.
True statement-level counting is an explicit follow-up, alongside OS-level
lock durations.

## Consequences

- `test/instrumentation.test.mjs` pins exact expected counts on a synthetic
  fixture (direct search, capture, expanded discovery, export) and proves
  behavior parity: identical results and export bytes with hooks on vs off,
  and identical results, errors, and bytes with a throwing observer vs
  hooks-off.
- The cost pass runs on its own pristine-shape DB, so the capture timing
  probes scan the same base as the pre-instrumentation harness
  (prior-harness parity; the script comment carries the probe offsets),
  and the capture-delta heap boundary includes the cost pass plus the
  probes.
- Follow-ups: SQL-statement / SQLite-rows-examined counting, OS-level lock
  duration, workload-specific budgets from the measured baseline, and the
  ship/defer report.

## Amendment — transaction-hold proxy + operation coverage (2026-09-28, #44 slice 5)

Status: Accepted. Measurement only; no optimization, migration, or ranking change.

`CountingStore` additionally records each `transaction()` hold via
`txnTimings()` (one finite sample per call, including rolled-back attempts;
`reset()` clears it; `snapshot()` keeps the count-only shape). Each sample
approximates how long that call held the SQLite RESERVED lock (writable
`BEGIN IMMEDIATE` to `COMMIT`/`ROLLBACK`): the hold clock starts inside a
wrapped callback that the inner store invokes only after `BEGIN` succeeds,
so the sample covers callback entry to `COMMIT`/`ROLLBACK` return —
including SQLite CPU and commit fsync, excluding pre-txn validation,
post-txn work, and `BEGIN`-acquisition waits — and explicitly not kernel
lock tracing or WAL-lock introspection. A call whose `BEGIN` fails records
exactly 0 (the callback never ran, so no hold occurred), distinctly from
any real hold. The decorator still delegates verbatim, lives behind the
`Store` port, and is never wrapped on production paths, so the assess-only,
inert-by-default, parity-tested contract holds; `test/locks.test.mjs` pins
the new behavior, including a real-contention regression test (held
`BEGIN IMMEDIATE` elsewhere, contended attempt waits out the 5s
busy-timeout, records 0).

The harness gains a per-shape `locks` section: `txn_ms` (single-sample hold
per operation from a separate pristine-shape pass — same seeded shape,
different DB and run from the timed medians, so it illustrates hold
magnitude and pins the one-txn-per-op structure but never decomposes a
median; cold holds are UNMEASURED — never sampled, with no claim they
equal warm holds) and `blocking` (functional two-connection
WAL probe, no timing — a held `BEGIN IMMEDIATE` still lets readonly
deferred/SHARED reads proceed while a second `BEGIN IMMEDIATE` with
`busy_timeout=0` fails fast with `SQLITE_BUSY`; production retries 5s, the
probe observes the signal without waiting). All writable-mode Ledger
transactions take `RESERVED`, reads included, so writable reads serialize
like writes; only readonly reads proceed concurrently.

Coverage additions (current vs added enumerated in the script header): timed
`expanded_refs_v1`, `inspect_capture`, `doctor` (each warm+cold),
`capture_dry_run`, `capture_replay`, `capture_supersedes`, and
`import_nonempty_refusal` (expected `CONFLICT`, required — success throws);
cost+hold for the same set except doctor (internal SQL bypasses the `Store`
port, so no Store-method counts — its hold is recorded via a one-call
transaction proxy with the same post-`BEGIN` clock), plus `capture_batch_20`
and `import_empty` (fresh-DB pristine-base restore). `env` now records git
revision identity (HEAD commit resolved from the harness checkout, never
caller CWD, plus a dirty flag and a sha256 over the tracked `git diff
HEAD` excluding `docs/validation.md` — the file recording the hash, so
the record cannot move the value — plus worktree status names and sorted
untracked-file bytes, reproducible via `--print-identity`; or
unknown-with-reason outside git) and the SQLite version. Timed medians
stay the robust latency readings; each `txn_ms` is an unpaired single
sample, not a hold share of any median.
Bytes stay UTF-8 bytes; no token estimates.

Remaining follow-ups move to the next slice: workload-specific budgets from
the measured baseline and the ship/defer report. SQL-statement /
SQLite-rows-examined counting stays open.
