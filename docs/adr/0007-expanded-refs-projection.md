# ADR 0007 — refs-v1 projection for expanded search

Status: Accepted / 2026-09-28 (issue #42, box 4)

## Context

Expanded search repeats the same Evidence, Assessment, and Source views on
every routed path. On the eval `38℃` case (4 Claims / 5 paths) the inline
response carries 15 view occurrences for 9 unique views. The cost is output
bytes, not retrieval quality: search targets, filters, ordering, and paging
stay exactly as they are.

## Decision

Add an explicit `--projection refs-v1` shape for expanded search only:

- Each `via` entry becomes ID references (`evidence_ref`,
  `assessment_ref`, `source_ref`) plus `match_fields`. Claims stay inline
  in `items` for readability.
- The full un-reduced RecordViews appear once under top-level `included`,
  keyed by existing record ID. No new short IDs, no field subset: review
  text, verification summaries, actor, scope, why, stance, and rationale
  are kept whole.
- The response is tagged `format: yurai.expanded.refs`, `version: 1` (a
  response-format version, unrelated to DB/snapshot versions) and carries
  the resolved `window` (offset, limit, path_offset, path_limit).
- Completeness: `included` keys always equal the union of all `*_ref` in
  the returned `via`. `included_complete` is always `true` and covers only
  reference resolution — not the whole ledger, all grounds, or source text.
  A missing view, a wrong record type, or two different views under one ID
  fails response construction; nothing is silently overwritten or dropped.
- Revision: the top-level `revision` binds `items` and `included`
  together. Paged refs reads use `--as-of` exactly like inline search and
  fail with CONFLICT after an intervening write. Each page carries the
  views its own `via` needs; references resolve inside the response only.
- Implementation: Core exposes `projection?: 'refs-v1'` on
  `Ledger.search` and projects via the pure function
  `toExpandedRefsV1(inlineResponse, resolvedWindow)` — no extra store
  reads or writes, no `show` re-fetch. CLI only adds the flag and
  serializes. Unknown projection values, projection without
  `--expand evidence`, and projection with direct/source search or `show`
  fail explicitly (VALIDATION/USAGE), never silently.
- The default flagless response is byte-identical to before.

## Rejected alternatives

- Canonical field subset: choosing a "minimal safe" view up front would
  fold an information-judgment call into output compression. There is no
  agreed subset that stays safe for every query (notes, quote context,
  edition pins, past rationale).
- Digest references with follow-up fetch: turns a self-contained read into
  fetch planning, revision pinning across calls, and cache management —
  too much machinery for removing duplication.
- Switching the default format, cross-response caching, history
  snapshots, direct-search/`show` projection, and MCP work are explicitly
  out of this slice.

## Measurements

Conditions: worktree at base `6527f6c` plus the uncommitted refs-v1
implementation; Node v24.19.0. The inline path is untouched, so inline
bytes are the baseline's bytes — confirmed by the minified eval-38C
inline figure matching the design's reported 9,864 bytes exactly. CLI
stdout bytes equal Core pretty bytes (17,354 / 11,349). Reduction is
`1 − refs / inline`; inactive filtering off except where noted.

| Fixture (query, revision, page) | Claims / paths | Pretty inline → refs | Minified inline → refs |
| --- | --- | --- | --- |
| eval 38℃ (`38℃`, rev 34, defaults) | 4 / 5 | 17,354 → 11,349 (−34.6%) | 9,864 → 7,529 (−23.7%) |
| high-sharing (`SHRTERM`, rev 15) | 6 / 7 | 19,449 → 10,249 (−47.3%) | 10,196 → 6,220 (−39.0%) |
| no-sharing (`NSHTERM`, rev 12) | 3 / 3 | 8,067 → 7,399 (−8.3%) | 4,099 → 4,479 (+9.3%) |
| review+verification (`RVTERM`, rev 6) | 1 / 1 | 4,041 → 3,745 (−7.3%) | 2,163 → 2,375 (+9.8%) |
| multi-page p0 (`MPGTERM`, rev 17, path 0/2) | 2 / 3 | 7,449 → 5,698 (−23.5%) | 3,721 → 3,442 (−7.5%) |
| multi-page p1 (path 2/2) | 2 / 2 | 5,400 → 4,476 (−17.1%) | 2,752 → 2,722 (−1.1%) |
| multi-page p2 (path 4/2) | 2 / 2 | 5,406 → 4,482 (−17.1%) | 2,758 → 2,728 (−1.1%) |
| multi-page total (3 responses) | 2 / 7 | 18,255 → 14,656 (−19.7%) | 9,231 → 8,892 (−3.7%) |

View duplication (via occurrences vs unique included, by record type):

| Fixture | Occurrences | Unique | Evidence / Assessment / Source |
| --- | --- | --- | --- |
| eval 38℃ | 15 | 9 | 2 / 5 / 2 |
| high-sharing | 21 | 9 | 1 / 7 / 1 |
| no-sharing | 9 | 9 | 3 / 3 / 3 |
| review+verification | 3 | 3 | 1 / 1 / 1 |
| multi-page p0/p1/p2 | 9 / 6 / 6 | 7 / 5 / 5 | 3+2+2 / 3+2+2 / 1+1+1 |

Reading all path pages to completion takes 3 responses in both shapes;
resolving refs needs 0 additional fetches. Small no-sharing responses
grow slightly in minified form (reference keys without duplication to
remove); this is reported as measured, with no fixed reduction gate.

Completeness verification: for every row above, the test-only inverse
`expandRefs` reproduces the inline response exactly (order, null vs
absent fields, warnings, review text, verification summary, attribution,
scope, why, stance, rationale, actor), the `*_ref` set equals the
`included` key set, and counts/order/`total_paths` match. Equivalence
also holds across `--include-inactive`, empty results, mid/end/out-of-range
path pages, same-timestamp records, and write-between-pages CONFLICT.
No tokenizer claim is made.

## Consequences

- Consumers that want smaller expanded payloads opt in per call; nothing
  else changes shape, order, or paging semantics.
- Future byte caps must never truncate `included` alone: a refs response
  is complete or it is an error.
- `test/refs-projection.test.mjs` locks the round-trip, dedup,
  completeness, paging, conflict, and CLI-parity behavior.
