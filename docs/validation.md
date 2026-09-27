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

## Local verification limits

The bootstrap environment had no DNS route to the npm registry, so verification used identical pinned versions of locally present dev packages.
lockfile resolved/integrity entries came from the environment's existing lockfile, with versions cross-checked.
This does not claim a clean `npm ci` succeeded in that local environment. Clean install was verified separately on GitHub Actions above.

## Unverified / unimplemented

Node 24, macOS, and Windows were verified on CI above, not in that local environment.
Real-world use, parallel-process races, crash durability, and large-ledger performance are unverified.
Nothing here tests source-content matching, reachability, or correctness of research findings. Fixtures are synthetic.
