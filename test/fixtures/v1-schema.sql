-- Frozen v1 schema (six record types, no verification). New ledgers initialize at
-- v2 directly; this file exists only to prove v1 databases migrate forward.
CREATE TABLE records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('source','claim','evidence','assessment','relation','review')),
  body TEXT NOT NULL CHECK(json_valid(body)), actor TEXT NOT NULL CHECK(json_valid(actor)), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE links (
  from_id TEXT NOT NULL REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED,
  to_id TEXT NOT NULL REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL, PRIMARY KEY(from_id, role)
) STRICT;
CREATE INDEX links_target ON links(to_id);
CREATE INDEX review_target ON records(json_extract(body, '$.target_id'), seq) WHERE type='review';
CREATE TABLE receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, ids TEXT NOT NULL CHECK(json_valid(ids))) STRICT;
CREATE VIRTUAL TABLE lookup USING fts5(id UNINDEXED, kind UNINDEXED, text, tokenize='trigram');
CREATE TRIGGER records_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TRIGGER records_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TRIGGER links_update BEFORE UPDATE ON links BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TRIGGER links_delete BEFORE DELETE ON links BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TRIGGER receipts_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TRIGGER receipts_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
PRAGMA application_id = 0x59555249;
PRAGMA user_version = 1;
