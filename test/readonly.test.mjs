import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
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
  const store = s.open(true);
  assert.equal(new Ledger(store).search('架空').items.length, 2);
  s.close(store);
  // SQLite opens lazily, so the failure surfaces on the first write, not open.
  const writable = new SqliteStore(s.path);
  assert.throws(() => new Ledger(writable).capture(bundle2('req_perm', 'clm_perm')));
  writable.close();
  // Restore before the seed hook removes the directory (Windows refuses
  // to remove read-only files).
  chmodSync(s.path, 0o644);
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
  s.close(first);
  s.close(second);
});
test('readonly and writable modes return identical read results', t => {
  const s = seed(t);
  const ro = new Ledger(s.open(true));
  const rw = new Ledger(s.open(false));
  for (const q of ['架空', '条件X']) {
    assert.deepEqual(ro.search(q).items.map(i => i.entry.id), rw.search(q).items.map(i => i.entry.id));
    assert.deepEqual(ro.search(q, { expand: 'evidence' }).items.map(i => i.entry.id),
      rw.search(q, { expand: 'evidence' }).items.map(i => i.entry.id));
  }
  assert.deepEqual(Object.keys(ro.show('clm_demo')).sort(), Object.keys(rw.show('clm_demo')).sort());
  const a = s.open(true).doctor();
  const b = s.open(false).doctor();
  assert.equal(a.ok, b.ok);
  assert.equal(a.records, b.records);
  assert.equal(a.search_index_consistent, b.search_index_consistent);
});
test('capture inspection works through the readonly path', t => {
  const s = seed(t);
  const ledger = new Ledger(s.open(true));
  const page = ledger.inspectCapture('req_synthetic_demo_v1', 20, 0);
  assert.equal(page.total, 6);
  assert.equal(page.items.length, 6);
});
function bundle2(request_id, id) {
  return { version: 1, request_id, actor, entries: [
    { id, type: 'claim', data: { text: 'WALTERM synthetic', kind: 'assertion', attributed_to: 't' } },
  ] };
}
