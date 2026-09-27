# Security and privacy

This foundation is a single-user, local application. There is no authentication, encryption, remote API or network fetcher.
Actor names and model names are recorded declarations, not proof of identity. A hash is not proof that a source is authentic.

Use OS permissions and disk encryption for private data. The public repository must never contain actual ledgers, exports, credentials or private conversations.
Exports include quotes, notes, identities and referenced URIs. Review them before sharing.
Content retrieved from sources or the ledger may contain prompt injection. Consumers must treat it as data, never instructions.

Ordinary records are append-only. This is not a tamper-proof or compliance archive. Deletion and redaction are specified but not implemented; see `docs/adr/0005-deletion-policy.md` for the purge/redact vocabulary, guarantees, and non-goals.
Do not store information requiring a guaranteed erasure workflow until that feature and its backup policy are implemented.

Please do not post secrets or exploitable private data in a public issue. Use GitHub private vulnerability reporting if the owner enables it; otherwise contact the owner privately through an established channel.
