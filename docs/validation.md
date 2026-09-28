# Bootstrap validation

Checked: 2026-09-27

## Done

- Linux / Node.js v22.16.0 / SQLite 3.49.1
- TypeScript 5.8.3 / @types/node 22.15.33
- `npm run check`: typecheck, build, 21 tests, all green
- Separate CLI processes for init→capture→search→show→review→export→restore→doctor
- Japanese, 1–2 character, NFKC, and literal-symbol search
- Reference integrity, forward references, rollback on mid-way failure, retry, rejection of changed request_id
- Review ordering and withdrawn grounds, supersedes cycle rejection
- Snapshot content, provenance, and receipt round-trip; rollback of invalid snapshots
- DB reopen, unknown/future schema rejection, UPDATE/DELETE rejection

## Clean CI on GitHub Actions — green

Implementation commit: `d583c498098583822dec34eaff1e79134e9d90fb`

[CI run #1](https://github.com/TakahisaI/yurai/actions/runs/36283356241) passed all 4 jobs.
Each job ran `npm ci --ignore-scripts` and `npm run check`.

| OS | Node | Result |
| --- | --- | --- |
| Ubuntu | 22.16.0 | Pass |
| Ubuntu | 24.x | Pass |
| macOS | 24.x | Pass |
| Windows | 24.x | Pass |

## Scale and lock measurements (#44 slice 5)

Checked: 2026-09-28. `node --expose-gc scripts/measure-scale.mjs` exit 0,
four synthetic shapes, all fixtures synthetic.

Environment: Node.js v24.19.0 / darwin / SQLite 3.53.3.
Source identity: `b79791fc2c962bc32daa6a9d41da0644867eb219`, dirty worktree,
diff `64465394337ca8ac913003fb098e19e5c0e528ac8bc55e649bcd44422c78e6f7`
(HEAD + dirty flag + diff sha256 over tracked `git diff HEAD` excluding
this file, plus status names and untracked-file bytes — reproducible via
`node scripts/measure-scale.mjs --print-identity`; this file's own bytes
never enter the hash, so recording it cannot move the value. Not a
clean-commit measurement).

Timed medians in ms (warm unless noted); heap deltas in bytes:

| Shape | Records | Export bytes | Import | direct_common | expanded | capture_single | capture_batch_20 | Heap peak / residual |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flat-100 | 425 | 175,104 | 39.79 | 3.30 | 1.21 | 0.93 | 2.76 | +1,174,656 / +724,984 |
| flat-500 | 2,132 | 880,422 | 202.48 | 64.84 | 4.09 | 3.73 | 5.46 | +3,924,432 / +918,672 |
| flat-2000 | 8,494 | 3,506,460 | 811.47 | 1140.93 | 15.75 | 14.17 | 16.22 | +14,292,736 / +1,886,384 |
| dense-100x8 | 3,879 | 1,723,573 | 372.68 | 14.09 | 8.39 | 7.09 | 8.80 | +7,366,520 / −1,953,960 |

Locks and cost (per-shape `locks` / `cost` sections):

- Blocking probe 4/4: held `BEGIN IMMEDIATE` still lets readonly reads
  proceed, second `BEGIN IMMEDIATE` (busy_timeout=0) fails fast with
  `SQLITE_BUSY`.
- 16 single-sample holds per shape, clocked post-`BEGIN` (acquisition waits
  excluded; a failed `BEGIN` would record 0 — pinned by the contention
  regression test, not observed in this contention-free run).
- Hold samples are unpaired with the timed medians and never decompose them:
  flat-2000 `direct_short_2char` hold 1844.67ms exceeds its warm median
  1140.93ms. Cold hold durations are UNMEASURED (never sampled; no claim
  they equal warm holds).
- Refusal paths verified: timed and cost `import_nonempty_refusal` both
  require `CONFLICT` (success throws); cost entry carries `error_code`.
- Largest export (3.5 MiB at flat-2000) stays well under the 16 MiB gate.

Limits: single-sample holds, wall-clock timings, one machine — no universal
performance claim. The dense negative heap residual is GC-timing noise
(post-cleanup below baseline), not a leak signal. SQL-statement /
rows-examined counts remain unmeasured (open follow-up).

## Local verification limits

The bootstrap environment had no DNS route to the npm registry, so verification used identical pinned versions of locally present dev packages.
lockfile resolved/integrity entries came from the environment's existing lockfile, with versions cross-checked.
This does not claim a clean `npm ci` succeeded in that local environment. Clean install was verified separately on GitHub Actions above.

## Unverified / unimplemented

Node 24, macOS, and Windows were verified on CI above, not in that local environment.
Real-world use, parallel-process races, crash durability, and large-ledger performance are unverified.
Nothing here tests source-content matching, reachability, or correctness of research findings. Fixtures are synthetic.
