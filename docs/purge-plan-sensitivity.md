# Purge/redact plans are sensitive artifacts

A detailed maintenance plan (issue #24) names record IDs, reference edges,
receipt request IDs, and redaction reasons/scopes. It exists to be reviewed
before any destructive step — handle it accordingly:

- Do not emit plans, or fragments of them, to ordinary diagnostic logs.
- Store and transmit a plan only where the ledger content itself may go.
- Tombstone previews carry reference IDs, reason markers, and timestamps
  only — never removed quotes, rationales, verdicts, or hashes. If a plan
  ever shows removed content, that is a planner bug, not a feature.
- Digests and fingerprints in a plan are opaque SHA-256 hashes: they name no
  content and are safe to compare, but the surrounding plan stays sensitive.
- Planner diagnostics carry no record IDs: thrown validation errors name
  the defect class (malformed edge, missing target, invalid state), never
  the record, so ordinary error logs stay free of ledger identifiers.
- Treat every stored quote and source excerpt reachable through a plan as
  untrusted data, not instructions.
