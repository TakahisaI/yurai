# Roadmap

The initial build is not a "finished product" but a foundation for testing hypotheses in real-world use.
Meet each issue's acceptance criteria before moving to the next layer. Never build everything at once.

## 0. Foundation — this initial build

Five content types + Review, attribution and scope, atomic capture, request_id, immutable records, CLI, search, show, export/restore, CI, regression tests.
Source retrieval and matching and UI are out.

## 1. Dogfooding — top priority

Acceptance criteria: [Issue #1](https://github.com/TakahisaI/yurai/issues/1).

From existing CLI-capable AI, store at least three real investigations and retrieve them in separate sessions.
Include one case each of support-vs-doubt, source-claim-vs-own-inference, and old-version-vs-correction.
Identify where users must hand-assemble JSON. Keep anonymized fixtures with operation counts and missing-information notes.
Add no extensions beyond the CLI improvements this stage's issues require.

## 2. Anchor verification / source preservation

Acceptance criteria: [Issue #2](https://github.com/TakahisaI/yurai/issues/2).

Build an adapter that matches verbatim quotes with prefix/suffix against explicitly given files to read.
Store match, mismatch, multiple-match, and unreachable as distinct verification events, separate from adopted state.
Detect edition/hash/snapshot mismatches. Never infer claim truth from quote matches.
Network retrieval needs separate SSRF, size-limit, redirect, and confidentiality design, so start from explicitly given local input.

## 3. MCP adapter

Acceptance criteria: [Issue #3](https://github.com/TakahisaI/yurai/issues/3).

Implement after the CLI contract stabilizes through dogfooding. A thin stdio adapter around search / inspect / capture / review.
Uses the same Core, schema, limits, dry-run, idempotency, and actor. Provide a read-only setting and forbid implicit writes.
Confine MCP-specific errors, capabilities, and tool metadata to the adapter. Keep model-specific SDKs out of Core.

## 4. Retrieval evaluation

Acceptance criteria: [Issue #4](https://github.com/TakahisaI/yurai/issues/4).

Evaluate queries with anonymized fixtures covering Japanese short phrases, paraphrases, scope differences, counterevidence, and withdrawn grounds.
Write failing examples first, then add the minimal ranking/expansion/search improvements that solve them.
Measure summary→detail output volume, paging misses, and double-counting of one source.
Add embeddings later as an optional index only when proven necessary, never as the only search path.

## 5. Durable operation / privacy

Acceptance criteria: [Issue #5](https://github.com/TakahisaI/yurai/issues/5).

Versioned migrations, crash and multi-process tests, snapshot-limit improvements, merge-import, redaction/purge policy for sensitive data.
Never equate ordinary correction history with truly erasing private data. Never rank append-only above privacy.
Multi-user, sync, and GUI are not this plan's completion criteria.
