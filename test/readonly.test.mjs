import test from 'node:test';
import assert, { AssertionError } from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, chmodSync, openSync, closeSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, LedgerError, SqliteStore } from '../dist/index.js';
import { code } from './helpers/assert.mjs';

const example = JSON.parse(readFileSync(new URL('../examples/capture.json', import.meta.url), 'utf8'));
const actor = { kind: 'agent', id: 'test-agent', model: 'synthetic' };
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
test('readonly open needs readable existing sidecars; absent sidecars need a writable directory', t => {
  const s = seed(t);
  const sidecars = () => [existsSync(s.path + '-shm'), existsSync(s.path + '-wal')];
  const dropSidecars = () => { for (const suffix of ['-shm', '-wal']) { try { unlinkSync(s.path + suffix); } catch {} } };
  const dirDenied = () => {
    const probe = join(s.dir, 'writability.probe');
    try { closeSync(openSync(probe, 'w')); unlinkSync(probe); return false; }
    catch { return true; }
  };
  const denied = e => e instanceof Error && /readonly database|unable to open/i.test(e.message);
  // Phase 1: sidecars present and readable (writer held open past a
  // commit) — an unwritable directory still serves reads.
  const writer = s.open(false);
  new Ledger(writer).capture(bundle2('req_sidecar_seed', 'clm_sidecar_seed'));
  assert.deepEqual(sidecars(), [true, true]);
  chmodSync(s.dir, 0o555);
  if (!dirDenied()) {
    chmodSync(s.dir, 0o755);
    s.close(writer);
    t.skip('directory stays writable despite permission bits (root/Windows)');
    return;
  }
  try {
    const reader = s.open(true);
    assert.equal(new Ledger(reader).search('架空').items.length, 2);
    s.close(reader);
    // Phase 1b: sidecars present but unreadable with an unwritable directory
    // — the open fails, since SQLite must read the WAL index. Directory bits
    // are already proven enforced here, so file bits are enforced too: assert
    // the denial rather than silently skipping the phase. Observed on
    // macOS/node:sqlite as `unable to open database file`.
    chmodSync(s.path + '-shm', 0o000);
    chmodSync(s.path + '-wal', 0o000);
    try {
      closeSync(openSync(s.path + '-shm', 'r'));
      assert.fail('expected unreadable sidecars to deny reads');
    } catch (error) {
      if (error instanceof AssertionError) throw error;
      assert.throws(() => s.open(true), denied);
    } finally {
      chmodSync(s.path + '-shm', 0o644);
      chmodSync(s.path + '-wal', 0o644);
    }
  } finally {
    chmodSync(s.dir, 0o755);
  }
  // Phase 1c: sidecars present but unreadable with a WRITABLE directory — the
  // open still fails. A writable directory does not rescue unreadable existing
  // sidecars; it only lets SQLite create absent sidecars. Observed on
  // macOS/node:sqlite as `unable to open database file`.
  assert.equal(dirDenied(), false, 'expected a writable directory for the unreadable-sidecars phase');
  assert.deepEqual(sidecars(), [true, true]);
  chmodSync(s.path + '-shm', 0o000);
  chmodSync(s.path + '-wal', 0o000);
  try {
    try {
      closeSync(openSync(s.path + '-shm', 'r'));
      assert.fail('expected unreadable sidecars to deny reads');
    } catch (error) {
      if (error instanceof AssertionError) throw error;
      assert.throws(() => s.open(true), denied);
    }
  } finally {
    chmodSync(s.path + '-shm', 0o644);
    chmodSync(s.path + '-wal', 0o644);
  }
  // Phase 2: sidecars absent and directory unwritable — the open itself fails
  // with SQLite's own wording (surfaced unwrapped, not a yurai code). Observed
  // on macOS/node:sqlite as `attempt to write a readonly database`.
  s.close(writer);
  dropSidecars();
  assert.deepEqual(sidecars(), [false, false]);
  chmodSync(s.dir, 0o555);
  try {
    assert.throws(() => s.open(true), denied);
  } finally {
    // Restore before the seed hook removes the directory.
    chmodSync(s.dir, 0o755);
  }
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
function richSeed(t) {
  const s = seed(t);
  const writer = s.open(false);
  const ledger = new Ledger(writer, () => '2026-09-27T00:00:00.000Z');
  ledger.capture({ version: 1, request_id: 'req_parity_extra', actor, entries: [
    { id: 'clm_par_a', type: 'claim', data: { text: 'PARITY synthetic alpha', kind: 'assertion', attributed_to: 't' } },
    { id: 'clm_par_b', type: 'claim', data: { text: 'PARITY synthetic beta', kind: 'assertion', attributed_to: 't' } },
    { id: 'evd_par_bare', type: 'evidence', data: { source_id: 'src_demo', locator: 'synthetic locator, no quote' } },
  ] });
  ledger.capture({ version: 1, request_id: 'req_parity_review', actor, entries: [
    { id: 'rev_par_wd', type: 'review', data: { target_id: 'clm_demo', state: 'withdrawn', rationale: 'synthetic parity fixture' } },
  ] });
  // Two routed paths to one live claim: both quotes carry ROUTEPATH while no
  // claim text does, so the query is routed-only with a nonempty second page.
  ledger.capture({ version: 1, request_id: 'req_parity_paths', actor, entries: [
    { id: 'clm_par_path', type: 'claim', data: { text: 'Synthetic routing target with two anchored passages', kind: 'assertion', attributed_to: 't' } },
    { id: 'evd_par_p1', type: 'evidence', data: { source_id: 'src_demo', quote: 'ROUTEPATH alpha synthetic passage', locator: 'synthetic locator one' } },
    { id: 'evd_par_p2', type: 'evidence', data: { source_id: 'src_demo', quote: 'ROUTEPATH beta synthetic passage', locator: 'synthetic locator two' } },
    { id: 'asm_par_p1', type: 'assessment', data: { claim_id: 'clm_par_path', evidence_id: 'evd_par_p1', stance: 'reports', rationale: 'synthetic parity routing one' } },
    { id: 'asm_par_p2', type: 'assessment', data: { claim_id: 'clm_par_path', evidence_id: 'evd_par_p2', stance: 'reports', rationale: 'synthetic parity routing two' } },
  ] });
  // A persisted verification so show parity covers the verification record
  // type and the anchor warnings on its evidence are genuinely compared.
  ledger.verifyEvidence({ evidence_id: 'evd_demo',
    content: Buffer.from('lead 条件X: A=80, B=70（架空の値） tail', 'utf8'),
    actor, request_id: 'req_parity_verify' });
  s.close(writer);
  return s;
}

// Both handles must fail identically: same code and same message, never one
// side succeeding while the other throws.
const errOf = fn => {
  try { fn(); return { threw: false }; }
  catch (error) { return { threw: true, code: error.code ?? null, message: String(error?.message ?? error) }; }
};

test('readonly parity covers paging, projections, and empty results', t => {
  const s = richSeed(t);
  const now = () => '2026-09-27T00:00:00.000Z';
  const ro = new Ledger(s.open(true), now);
  const rw = new Ledger(s.open(false), now);
  // Non-vacuous fixture: two PARITY claims, one withdrawn claim, one quoteless
  // evidence, and a query term matching nothing.
  assert.equal(rw.search('PARITY').items.length, 2);
  assert.ok(!rw.search('架空').items.some(i => i.entry.id === 'clm_demo'));
  assert.ok(rw.search('架空', { includeInactive: true }).items.some(i => i.entry.id === 'clm_demo'));
  assert.equal(rw.search('存在しない用語ZZZ').items.length, 0);
  // Two routed paths with a nonempty second page: ROUTEPATH matches no claim
  // text, so the query is routed-only.
  const routed = rw.search('ROUTEPATH', { expand: 'evidence' });
  assert.equal(routed.items.length, 1);
  assert.equal(routed.items[0].direct_match, false);
  assert.equal(routed.items[0].total_paths, 2);
  assert.equal(routed.items[0].via.length, 2);
  assert.equal(rw.search('ROUTEPATH', { expand: 'evidence', pathLimit: 1, pathOffset: 0 }).items[0].via_next_offset, 1);
  const pathPage2 = rw.search('ROUTEPATH', { expand: 'evidence', pathLimit: 1, pathOffset: 1 }).items[0];
  assert.equal(pathPage2.via.length, 1);
  assert.equal(pathPage2.via_next_offset, null);
  const refsPage2 = rw.search('ROUTEPATH', { expand: 'evidence', projection: 'refs-v1', pathLimit: 1, pathOffset: 1 });
  assert.equal(refsPage2.items.length, 1);
  assert.equal(refsPage2.items[0].via.length, 1);
  // Verification and warnings are genuinely compared, not vacuous.
  const evd = rw.show('evd_demo');
  assert.equal(evd.verification.outcome, 'match');
  assert.ok(evd.warnings.includes('anchor_match'));
  assert.ok(rw.show('clm_demo').warnings.includes('inactive_record'));
  const vrfId = evd.verification.id;
  const reads = [
    ['claim search', l => l.search('架空')],
    ['one-char term', l => l.search('A')],
    ['two-char term', l => l.search('手法')],
    ['multi-term AND', l => l.search('架空 条件X')],
    ['条件X search', l => l.search('条件X')],
    ['no-match search', l => l.search('存在しない用語ZZZ')],
    ['source search', l => l.search('架空', { kind: 'source' })],
    ['source search empty', l => l.search('PARITY', { kind: 'source' })],
    ['includeInactive false', l => l.search('架空', { includeInactive: false })],
    ['includeInactive true', l => l.search('架空', { includeInactive: true })],
    ['claim page 1', l => l.search('PARITY', { limit: 1, offset: 0 })],
    ['claim page 2', l => l.search('PARITY', { limit: 1, offset: 1 })],
    ['claim past-end page', l => l.search('PARITY', { limit: 1, offset: 99 })],
    ['expanded routed two paths', l => l.search('ROUTEPATH', { expand: 'evidence' })],
    ['expanded path page 1', l => l.search('ROUTEPATH', { expand: 'evidence', pathLimit: 1, pathOffset: 0 })],
    ['expanded path page 2', l => l.search('ROUTEPATH', { expand: 'evidence', pathLimit: 1, pathOffset: 1 })],
    ['expanded path past-end', l => l.search('ROUTEPATH', { expand: 'evidence', pathLimit: 1, pathOffset: 99 })],
    ['expanded claim past-end', l => l.search('ROUTEPATH', { expand: 'evidence', limit: 1, offset: 99 })],
    ['expanded empty', l => l.search('存在しない用語ZZZ', { expand: 'evidence' })],
    ['expanded empty when routes withdrawn', l => l.search('条件X', { expand: 'evidence' })],
    ['expanded inactive audit', l => l.search('架空', { expand: 'evidence', includeInactive: true })],
    ['refs-v1 projection', l => l.search('ROUTEPATH', { expand: 'evidence', projection: 'refs-v1' })],
    ['refs-v1 path page 2', l => l.search('ROUTEPATH', { expand: 'evidence', projection: 'refs-v1', pathLimit: 1, pathOffset: 1 })],
    ['show claim', l => l.show('clm_demo')],
    ['show connections page', l => l.show('clm_demo', 1, 0)],
    ['show connections past-end', l => l.show('clm_demo', 1, 99)],
    ['show source', l => l.show('src_demo')],
    ['show evidence', l => l.show('evd_demo')],
    ['show quoteless evidence', l => l.show('evd_par_bare')],
    ['show assessment', l => l.show('asm_demo')],
    ['show relation', l => l.show('rel_limit')],
    ['show review', l => l.show('rev_par_wd')],
    ['show verification', l => l.show(vrfId)],
    ['inspectCapture seed', l => l.inspectCapture('req_synthetic_demo_v1')],
    ['inspectCapture page', l => l.inspectCapture('req_synthetic_demo_v1', 2, 2)],
    ['inspectCapture past-end', l => l.inspectCapture('req_synthetic_demo_v1', 2, 99)],
    ['inspectCapture extra', l => l.inspectCapture('req_parity_extra')],
    ['inspectCapture review', l => l.inspectCapture('req_parity_review')],
    ['inspectCapture paths', l => l.inspectCapture('req_parity_paths')],
    ['inspectCapture verify', l => l.inspectCapture('req_parity_verify')],
    ['exportSnapshot', l => l.exportSnapshot()],
  ];
  for (const [name, fn] of reads) assert.deepEqual(fn(ro), fn(rw), name);
  assert.equal(s.open(true).revision(), s.open(false).revision());
});

test('readonly parity covers read errors and stale revisions', t => {
  const s = richSeed(t);
  const now = () => '2026-09-27T00:00:00.000Z';
  const ro = new Ledger(s.open(true), now);
  const rw = new Ledger(s.open(false), now);
  const revBefore = rw.search('PARITY').revision;
  new Ledger(s.open(false), now).capture({ version: 1, request_id: 'req_parity_bump', actor, entries: [
    { id: 'clm_par_bump', type: 'claim', data: { text: 'PARITY synthetic bump', kind: 'assertion', attributed_to: 't' } },
  ] });
  const revAfter = rw.search('PARITY').revision;
  assert.notEqual(revBefore, revAfter);
  // Each case names its expected code: asserting same-code-only would let a
  // joint regression (both sides throwing the wrong code) pass.
  const errors = [
    ['show unknown', l => l.show('clm_no_such_record'), 'NOT_FOUND'],
    ['inspectCapture unknown', l => l.inspectCapture('req_no_such_capture'), 'NOT_FOUND'],
    ['inspectCapture malformed id', l => l.inspectCapture('1bad'), 'VALIDATION'],
    ['search empty', l => l.search(''), 'VALIDATION'],
    ['search blank', l => l.search('   '), 'VALIDATION'],
    ['search too many terms', l => l.search('a b c d e f g h i j k l m n o p q'), 'VALIDATION'],
    ['search too long', l => l.search('x'.repeat(501)), 'VALIDATION'],
    ['search NUL', l => l.search('a\0b'), 'VALIDATION'],
    ['search bad kind', l => l.search('x', { kind: 'evidence' }), 'VALIDATION'],
    ['search bad expand', l => l.search('x', { expand: 'claims' }), 'VALIDATION'],
    ['search expand source', l => l.search('x', { kind: 'source', expand: 'evidence' }), 'VALIDATION'],
    ['search path paging direct', l => l.search('x', { pathLimit: 1 }), 'VALIDATION'],
    ['search bad projection', l => l.search('x', { expand: 'evidence', projection: 'refs-v9' }), 'VALIDATION'],
    ['search projection direct', l => l.search('x', { projection: 'refs-v1' }), 'VALIDATION'],
    ['search limit 0', l => l.search('x', { limit: 0 }), 'VALIDATION'],
    ['search limit 101', l => l.search('x', { limit: 101 }), 'VALIDATION'],
    ['search offset -1', l => l.search('x', { offset: -1 }), 'VALIDATION'],
    ['show limit 0', l => l.show('clm_demo', 0), 'VALIDATION'],
    ['inspectCapture offset -1', l => l.inspectCapture('req_synthetic_demo_v1', 20, -1), 'VALIDATION'],
    ['search stale as-of', l => l.search('PARITY', { asOf: revBefore }), 'CONFLICT'],
    ['show stale as-of', l => l.show('clm_demo', 20, 0, revBefore), 'CONFLICT'],
    ['inspectCapture stale as-of', l => l.inspectCapture('req_synthetic_demo_v1', 20, 0, revBefore), 'CONFLICT'],
    ['search bad as-of', l => l.search('PARITY', { asOf: -1 }), 'VALIDATION'],
    ['verify unknown evidence', l => l.verifyEvidence({ evidence_id: 'evd_no_such', content: Buffer.from('x'), actor, request_id: 'req_par_v1' }), 'NOT_FOUND'],
    ['verify non-evidence', l => l.verifyEvidence({ evidence_id: 'clm_demo', content: Buffer.from('x'), actor, request_id: 'req_par_v2' }), 'VALIDATION'],
    ['verify quoteless', l => l.verifyEvidence({ evidence_id: 'evd_par_bare', content: Buffer.from('x'), actor, request_id: 'req_par_v3' }), 'VALIDATION'],
    ['verify oversize', l => l.verifyEvidence({ evidence_id: 'evd_demo', content: Buffer.alloc(4 * 1024 * 1024 + 1), actor, request_id: 'req_par_v4' }), 'VALIDATION'],
    ['verify bad utf8', l => l.verifyEvidence({ evidence_id: 'evd_demo', content: Buffer.from([0xff, 0xfe]), actor, request_id: 'req_par_v5' }), 'VALIDATION'],
    ['import invalid', l => l.importSnapshot({ nope: true }), 'VALIDATION'],
  ];
  for (const [name, fn, expected] of errors) {
    const a = errOf(() => fn(ro)), b = errOf(() => fn(rw));
    assert.equal(a.threw, true, `${name}: expected both handles to throw`);
    assert.equal(a.code, expected, `${name}: readonly code`);
    assert.equal(b.code, expected, `${name}: writable code`);
    assert.deepEqual(a, b, name);
  }
  // A fresh as-of succeeds identically on both handles.
  assert.deepEqual(ro.search('PARITY', { asOf: revAfter }), rw.search('PARITY', { asOf: revAfter }));
});

test('readonly dry-run writes match writable; real writes fail READONLY', t => {
  const s = richSeed(t);
  const now = () => '2026-09-27T00:00:00.000Z';
  const ro = new Ledger(s.open(true), now);
  const rw = new Ledger(s.open(false), now);
  const draft = id => ({ version: 1, request_id: id, actor, entries: [
    { id: 'clm_par_draft', type: 'claim', data: { text: 'PARITY synthetic draft', kind: 'assertion', attributed_to: 't' } },
  ] });
  // Dry-run capture persists nothing, so it succeeds identically on both.
  assert.deepEqual(ro.capture(draft('req_parity_draft'), true), rw.capture(draft('req_parity_draft'), true));
  // Dry-run verification pins the same fixed clock on both handles.
  const content = Buffer.from('lead 条件X: A=80, B=70（架空の値） tail', 'utf8');
  const dry = id => ({ evidence_id: 'evd_demo', content, actor, request_id: id, dryRun: true });
  const roDry = ro.verifyEvidence(dry('req_par_vdry')), rwDry = rw.verifyEvidence(dry('req_par_vdry'));
  assert.equal(roDry.outcome, 'match');
  assert.deepEqual(roDry, rwDry);
  // The same dry-run replays identically once the request exists.
  rw.capture(draft('req_parity_draft'));
  assert.deepEqual(ro.capture(draft('req_parity_draft'), true), rw.capture(draft('req_parity_draft'), true));
  // Real writes through the readonly handle fail before mutation.
  const before = s.snapshot();
  assert.throws(() => ro.verifyEvidence({ evidence_id: 'evd_demo', content, actor, request_id: 'req_par_vref' }), code('READONLY'));
  assert.throws(() => ro.verifyEvidence({ evidence_id: 'evd_demo', content: null, actor, request_id: 'req_par_vref2' }), code('READONLY'));
  assert.deepEqual(s.snapshot(), before);
});

test('readonly import refuses before mutation on an empty ledger', t => {
  const s = richSeed(t);
  const snapshot = new Ledger(s.open(false)).exportSnapshot();
  const dir = mkdtempSync(join(tmpdir(), 'yurai-ro-'));
  // One hook with explicit order: Windows refuses to remove the directory
  // while either database file is still open.
  const handles = {};
  t.after(() => { handles.store?.close(); handles.writable?.close(); rmSync(dir, { recursive: true, force: true }); });
  const empty = join(dir, 'empty.sqlite');
  new SqliteStore(empty, true).close();
  const before = readFileSync(empty);
  // A writable open restores the snapshot; the readonly open of an identical
  // empty ledger must refuse with READONLY instead of restoring anything.
  const writable = handles.writable = new SqliteStore(join(dir, 'control.sqlite'), true);
  assert.equal(new Ledger(writable).importSnapshot(snapshot).restored, snapshot.entries.length);
  const store = handles.store = new SqliteStore(empty, false, { readonly: true });
  assert.throws(() => new Ledger(store).importSnapshot(snapshot), code('READONLY'));
  assert.deepEqual(readFileSync(empty), before);
});

test('doctor matches writable except the documented FTS self-check', t => {
  const s = richSeed(t);
  const a = s.open(true).doctor();
  const b = s.open(false).doctor();
  assert.equal(a.fts_integrity, 'skipped-readonly');
  assert.equal(b.fts_integrity, 'checked');
  const { fts_integrity: _ro, ...restA } = a;
  const { fts_integrity: _rw, ...restB } = b;
  assert.deepEqual(restA, restB);
});

test('replace-while-open follows platform file-locking semantics', t => {
  const s = seed(t);
  const store = s.open(true);
  assert.equal(new Ledger(store).search('架空').items.length, 2);
  const moved = `${s.path}.moved`;
  if (process.platform === 'win32') {
    // Windows locks open files: renaming the ledger away while a reader is
    // attached fails, and the reader keeps serving the original bytes.
    // Replacement-at-path is unverified on Windows (L4): this branch installs
    // no replacement.
    assert.throws(() => renameSync(s.path, moved), /EPERM|EACCES|EBUSY/);
    assert.equal(new Ledger(store).search('架空').items.length, 2);
  } else {
    // POSIX renames while open succeed; the attached reader keeps the old
    // inode. Install a real checkpointed replacement at the path: later
    // opens see the replacement while the attached reader keeps serving
    // old bytes. Replacement with an active WAL is UNRESOLVED box-5 scope
    // (L4/L5) and is not covered here.
    renameSync(s.path, moved);
    assert.ok(!existsSync(s.path) && existsSync(moved));
    assert.equal(new Ledger(store).search('架空').items.length, 2);
    const replPath = join(s.dir, 'replacement.sqlite');
    const repl = new SqliteStore(replPath, true);
    new Ledger(repl).capture(bundle2('req_repl', 'clm_repl'));
    repl.close();
    // Drop the stale sidecars of the moved-away file so the replacement
    // opens clean; the attached reader holds its own descriptors.
    for (const suffix of ['-shm', '-wal']) { try { unlinkSync(s.path + suffix); } catch {} }
    renameSync(replPath, s.path);
    assert.equal(new Ledger(store).search('架空').items.length, 2);
    const later = new Ledger(s.open(true));
    assert.equal(later.search('架空').items.length, 0);
    assert.equal(later.search('WALTERM').items.length, 1);
  }
  s.close(store);
});

function bundle2(request_id, id) {
  return { version: 1, request_id, actor, entries: [
    { id, type: 'claim', data: { text: 'WALTERM synthetic', kind: 'assertion', attributed_to: 't' } },
  ] };
}
