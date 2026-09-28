import test from 'node:test';
import assert, { AssertionError } from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, LedgerError, SqliteStore } from '../dist/index.js';

const example = JSON.parse(readFileSync(new URL('../examples/capture.json', import.meta.url), 'utf8'));
const actor = { kind: 'agent', id: 'test-agent', model: 'synthetic' };
const code = expected => e => e instanceof LedgerError && e.code === expected;

function seed(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-ro-'));
  const path = join(dir, 'ledger.sqlite');
  const writable = new SqliteStore(path, true);
  new Ledger(writable, () => '2026-09-27T00:00:00.000Z').capture(example);
  writable.close();
  const stores = [];
  t.after(() => { for (const s of stores) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const close = s => { s.close(); stores.splice(stores.indexOf(s), 1); };
  // Opening a WAL-mode database may create -shm/-wal sidecars even
  // read-only; the guarantee covers main-file bytes plus WAL content.
  // -shm is transient shared-memory index state and stays out of scope.
  const snapshot = () => {
    let wal;
    try { wal = readFileSync(path + '-wal'); } catch { wal = Buffer.alloc(0); }
    return { main: readFileSync(path), wal };
  };
  return {
    dir, path, close, snapshot,
    open: readonly => {
      const s = new SqliteStore(path, false, readonly ? { readonly: true } : undefined);
      stores.push(s);
      return s;
    },
  };
}

test('readonly open serves reads and leaves the database untouched', t => {
  const s = seed(t);
  const before = s.snapshot();
  const store = s.open(true);
  const ledger = new Ledger(store);
  assert.equal(ledger.search('架空').items.length, 2);
  assert.equal(ledger.show('clm_demo').entry.id, 'clm_demo');
  assert.equal(store.entries().length, 6);
  assert.ok(ledger.exportSnapshot().entries.length > 0);
  s.close(store);
  assert.deepEqual(s.snapshot(), before);
});

test('writes through a readonly store fail before mutation', t => {
  const s = seed(t);
  const before = s.snapshot();
  const store = s.open(true);
  const ledger = new Ledger(store);
  assert.throws(() => ledger.capture({ version: 1, request_id: 'req_ro_write', actor,
    entries: [{ id: 'clm_ro', type: 'claim', data: { text: 'x', kind: 'assertion', attributed_to: 't' } }] }), code('READONLY'));
  assert.throws(() => store.insert({ id: 'clm_ro2', type: 'claim',
    data: { text: 'x', kind: 'assertion', attributed_to: 't' }, actor, created_at: '2026-09-27T00:00:00.000Z' }), code('READONLY'));
  assert.throws(() => store.insertReceipt({ request_id: 'req_ro', digest: '0', ids: [] }), code('READONLY'));
  s.close(store);
  assert.deepEqual(s.snapshot(), before);
});

test('readonly open refuses migration and leaves v1 bytes intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-ro-'));
  const path = join(dir, 'v1.sqlite');
  const v1 = new DatabaseSync(path);
  v1.exec(readFileSync(new URL('./fixtures/v1-schema.sql', import.meta.url), 'utf8'));
  v1.close();
  const before = readFileSync(path);
  assert.throws(() => new SqliteStore(path, false, { readonly: true }), e =>
    e instanceof LedgerError && e.code === 'SCHEMA' && /needs migration/.test(e.message));
  assert.deepEqual(readFileSync(path), before);
  const writable = new SqliteStore(path);
  // One hook with explicit order: Windows refuses to remove the directory
  // while the database file is still open.
  t.after(() => { writable.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(writable.schemaVersion(), 2);
});

test('readonly open refuses future schemas without a migration hint', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-ro-'));
  const path = join(dir, 'future.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA application_id = 0x59555249; PRAGMA user_version = 99;');
  raw.close();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => new SqliteStore(path, false, { readonly: true }), e =>
    e instanceof LedgerError && e.code === 'SCHEMA' && /Unsupported/.test(e.message) && !/needs migration/.test(e.message));
});

test('readonly open rejects missing, foreign, and contradictory targets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-ro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => new SqliteStore(join(dir, 'absent.sqlite'), false, { readonly: true }), code('NOT_FOUND'));
  const foreign = join(dir, 'foreign.sqlite');
  const raw = new DatabaseSync(foreign);
  raw.exec('CREATE TABLE t(x)');
  raw.close();
  assert.throws(() => new SqliteStore(foreign, false, { readonly: true }), code('SCHEMA'));
  assert.throws(() => new SqliteStore(join(dir, 'new.sqlite'), true, { readonly: true }), code('USAGE'));
  assert.throws(() => new SqliteStore(':memory:', false, { readonly: true }), code('USAGE'));
});

test('doctor works readonly with the skipped FTS self-check stated', t => {
  const s = seed(t);
  const report = s.open(true).doctor();
  assert.equal(report.ok, true);
  assert.equal(report.fts_integrity, 'skipped-readonly');
  assert.equal(s.open(false).doctor().fts_integrity, 'checked');
});
test('readonly open works on read-only files; writable writes fail', t => {
  const s = seed(t);
  const before = s.snapshot();
  chmodSync(s.path, 0o444);
  try {
    // Root and CAP_DAC_OVERRIDE bypass permission bits; without an enforced
    // denial there is no write failure to assert.
    closeSync(openSync(s.path, 'r+'));
    chmodSync(s.path, 0o644);
    t.skip('process can write despite read-only permission bits');
    return;
  } catch { /* permission enforced: proceed */ }
  const store = s.open(true);
  assert.equal(new Ledger(store).search('架空').items.length, 2);
  s.close(store);
  // SQLite may fall back to a read-only connection when read-write access is
  // unavailable (failure on first write), or refuse the open itself; either
  // is valid enforcement, but only with SQLite's own permission/open wording
  // so unrelated regressions cannot slip through.
  const denied = e => e instanceof Error && /readonly database|unable to open/i.test(e.message);
  try {
    const writable = new SqliteStore(s.path);
    try {
      assert.throws(() => new Ledger(writable).capture(bundle2('req_perm', 'clm_perm')), denied);
    } finally {
      writable.close();
    }
  } catch (error) {
    if (error instanceof AssertionError) throw error;
    assert.ok(denied(error), `expected a permission/open refusal, got: ${error}`);
  } finally {
    // Restore before the seed hook removes the directory (Windows refuses
    // to remove read-only files).
    chmodSync(s.path, 0o644);
  }
  assert.deepEqual(s.snapshot(), before);
});
test('readonly readers see committed WAL frames and later commits', t => {
  const s = seed(t);
  const writer = s.open(false);
  const ledger = new Ledger(writer);
  ledger.capture(bundle2('req_wal_1', 'clm_wal_1'));
  const first = s.open(true);
  assert.ok(new Ledger(first).search('WALTERM').items.some(i => i.entry.id === 'clm_wal_1'));
  ledger.capture(bundle2('req_wal_2', 'clm_wal_2'));
  const second = s.open(true);
  const ids = new Ledger(second).search('WALTERM').items.map(i => i.entry.id);
  assert.ok(ids.includes('clm_wal_1') && ids.includes('clm_wal_2'));
  // The earlier reader must see the later commit too: reads never pin a
  // snapshot across operations.
  const firstAgain = new Ledger(first).search('WALTERM').items.map(i => i.entry.id);
  assert.ok(firstAgain.includes('clm_wal_1') && firstAgain.includes('clm_wal_2'));
  s.close(first);
  s.close(second);
});
test('readonly and writable modes return identical read results', t => {
  const s = seed(t);
  const ro = new Ledger(s.open(true));
  const rw = new Ledger(s.open(false));
  for (const q of ['架空', '条件X']) {
    assert.deepEqual(ro.search(q), rw.search(q));
    assert.deepEqual(ro.search(q, { expand: 'evidence' }), rw.search(q, { expand: 'evidence' }));
  }
  assert.deepEqual(ro.show('clm_demo'), rw.show('clm_demo'));
  const a = s.open(true).doctor();
  const b = s.open(false).doctor();
  assert.equal(a.ok, b.ok);
  assert.equal(a.records, b.records);
  assert.equal(a.search_index_consistent, b.search_index_consistent);
});
test('capture inspection works through the readonly path', t => {
  const s = seed(t);
  const writer = s.open(false);
  new Ledger(writer).capture(bundle2('req_ro_inspect', 'clm_ro_inspect'));
  s.close(writer);
  const ledger = new Ledger(s.open(true));
  const page = ledger.inspectCapture('req_synthetic_demo_v1', 20, 0);
  assert.equal(page.total, 6);
  assert.deepEqual(page.items.map(e => e.entry.id).sort(),
    ['asm_demo', 'clm_demo', 'clm_limit', 'evd_demo', 'rel_limit', 'src_demo']);
  const other = ledger.inspectCapture('req_ro_inspect', 20, 0);
  assert.equal(other.total, 1);
  assert.deepEqual(other.items.map(e => e.entry.id), ['clm_ro_inspect']);
  assert.throws(() => ledger.inspectCapture('req_no_such_capture'), code('NOT_FOUND'));
});
test('readonly open racing a migration fails safe, then succeeds after commit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-ro-'));
  const path = join(dir, 'race.sqlite');
  // Register cleanup first so an early assertion failure cannot leak the
  // temporary directory. Close both handles before removing the directory
  // (Windows refuses to remove open database files).
  const handles = {};
  t.after(() => { handles.store?.close(); handles.writable?.close(); rmSync(dir, { recursive: true, force: true }); });
  const v1 = new DatabaseSync(path);
  v1.exec(readFileSync(new URL('./fixtures/v1-schema.sql', import.meta.url), 'utf8'));
  v1.exec(`INSERT INTO records(id,type,body,actor,created_at) VALUES(` +
    `'clm_race_seed','claim','{"text":"RACETERM synthetic","kind":"assertion","attributed_to":"t"}',` +
    `'{"kind":"agent","id":"test-agent"}','2026-09-27T00:00:00.000Z')`);
  v1.close();
  const before = readFileSync(path);
  // Deterministic race: hold an uncommitted migration-shaped transaction open
  // on a separate connection across the readonly open. BEGIN IMMEDIATE plus
  // the v1->v2 rebuild and version bump mirrors migrateV1toV2 and the
  // registry version update in src/storage/sqlite.ts; no threads or sleeps.
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;');
  writer.exec('BEGIN IMMEDIATE');
  writer.exec(`CREATE TABLE records_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('source','claim','evidence','assessment','relation','review','verification')),
  body TEXT NOT NULL CHECK(json_valid(body)), actor TEXT NOT NULL CHECK(json_valid(actor)), created_at TEXT NOT NULL
) STRICT;
INSERT INTO records_new(seq,id,type,body,actor,created_at) SELECT seq,id,type,body,actor,created_at FROM records;
DROP TABLE records;
ALTER TABLE records_new RENAME TO records;
CREATE INDEX review_target ON records(json_extract(body, '$.target_id'), seq) WHERE type='review';
CREATE TRIGGER records_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
CREATE TRIGGER records_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;
PRAGMA user_version = 2;`);
  try {
    // The racing open must fail with the actionable writable-reopen error:
    // never migrate, never retry writable, never see a half-migrated schema.
    assert.throws(() => new SqliteStore(path, false, { readonly: true }), e =>
      e instanceof LedgerError && e.code === 'SCHEMA' &&
      /needs migration/.test(e.message) && /reopen without --readonly/.test(e.message));
    // Concurrent readers still see the pre-commit snapshot: v1 with no
    // half-migrated remainder.
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(probe.prepare('PRAGMA user_version').get()?.user_version, 1);
      const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all().map(r => r.name);
      assert.ok(names.includes('records') && !names.includes('records_new'));
    } finally {
      probe.close();
    }
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
  // The failed race migrated nothing and retried nothing writable.
  assert.deepEqual(readFileSync(path), before);
  assert.throws(() => new SqliteStore(path, false, { readonly: true }), e =>
    e instanceof LedgerError && e.code === 'SCHEMA' && /needs migration/.test(e.message));
  // Post-migration the same readonly path succeeds on the migrated schema.
  const writable = handles.writable = new SqliteStore(path);
  assert.equal(writable.schemaVersion(), 2);
  assert.ok(writable.entries().some(e => e.id === 'clm_race_seed'));
  new Ledger(writable).capture(bundle2('req_race_post', 'clm_race_post'));
  const store = handles.store = new SqliteStore(path, false, { readonly: true });
  assert.equal(store.schemaVersion(), 2);
  const ledger = new Ledger(store);
  assert.ok(ledger.search('WALTERM').items.some(i => i.entry.id === 'clm_race_post'));
  assert.ok(store.entries().some(e => e.id === 'clm_race_seed'));
});
function bundle2(request_id, id) {
  return { version: 1, request_id, actor, entries: [
    { id, type: 'claim', data: { text: 'WALTERM synthetic', kind: 'assertion', attributed_to: 't' } },
  ] };
}
