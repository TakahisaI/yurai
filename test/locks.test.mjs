import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { Ledger, SqliteStore } from '../dist/index.js';
import { CountingStore, ScanCollector } from '../dist/core/observe.js';

// OS-level lock-duration proxies + operation coverage (#44 slice 5).
// Pins exact Store-method counts for the newly covered operations, proves the
// transaction-hold proxy records one finite sample per transaction (including
// rollbacks) and exactly 0 when BEGIN fails before the callback runs, and
// characterizes WAL blocking with deterministic booleans.
// No timing assertions except bounded sanity (finite, >= 0, < 60s); bytes via
// Buffer.byteLength only, no token claims. All content is synthetic.
const AT = '2026-09-27T00:00:00.000Z';
const actor = { kind: 'agent', id: 'locks-test' };
const FIXTURE = { version: 1, request_id: 'req_fixture', actor, entries: [
  { id: 'src_i1', type: 'source', data: { title: 'Synthetic heat study', medium: 'experiment', uri: 'urn:yurai:synthetic:locks' } },
  { id: 'clm_i1', type: 'claim', data: { text: 'alpha beta', kind: 'assertion', attributed_to: 'synthetic' } },
  { id: 'clm_i2', type: 'claim', data: { text: 'alpha gamma', kind: 'assertion', attributed_to: 'synthetic' } },
  { id: 'evd_i1', type: 'evidence', data: { source_id: 'src_i1', quote: 'alpha passage with rareword', locator: 'tab0' } },
  { id: 'evd_i2', type: 'evidence', data: { source_id: 'src_i1', quote: 'unrelated words here', locator: 'tab1' } },
  { id: 'asm_i1', type: 'assessment', data: { claim_id: 'clm_i1', evidence_id: 'evd_i1', stance: 'supports', rationale: 'syn' } },
  { id: 'rev_i1', type: 'review', data: { target_id: 'clm_i1', state: 'accepted', rationale: 'syn' } },
] };

function setup(t, hooked = true) {
  const raw = new SqliteStore(':memory:', true);
  t.after(() => raw.close());
  if (!hooked) return { raw, ledger: new Ledger(raw, () => AT) };
  const counting = new CountingStore(raw);
  const scans = new ScanCollector();
  return { raw, counting, scans, ledger: new Ledger(counting, () => AT, scans) };
}

function costLockOf(counting, scans, fn, expectThrow = null) {
  counting.reset(); scans.reset();
  let errorCode = null;
  try { fn(); }
  catch (error) {
    errorCode = error?.code ?? 'UNKNOWN';
    if (expectThrow === null || errorCode !== expectThrow) throw error;
  }
  if (expectThrow !== null && errorCode === null)
    throw new Error(`expected ${expectThrow}, saw success`);
  const calls = {};
  for (const [method, s] of Object.entries(counting.snapshot()))
    if (s.calls) calls[method] = [s.calls, s.rowsReturned, s.rowsWritten];
  const txn = counting.txnTimings();
  return { calls, scans: scans.snapshot(), txn, errorCode };
}

function assertHoldSample(txn) {
  assert.equal(txn.length, 1);
  assert.equal(typeof txn[0], 'number');
  assert.ok(Number.isFinite(txn[0]));
  assert.ok(txn[0] >= 0);
  assert.ok(txn[0] < 60000);
}

const ZERO_SCANS = { 'supersedes-check': 0, 'expanded-evidence': 0, export: 0 };

test('dry-run capture validates without writing and records one hold sample', t => {
  const { raw, ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const before = raw.count();
  const { calls, scans: got, txn, errorCode } = costLockOf(counting, scans, () => ledger.capture({ version: 1,
    request_id: 'req_dry', actor, entries: [{ id: 'clm_dry', type: 'claim',
      data: { text: 'dry', kind: 'assertion', attributed_to: 'synthetic' } }] }, true));
  assert.equal(errorCode, null);
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], receipt: [1, 0, 0], get: [1, 0, 0], entries: [1, 7, 0],
  });
  assert.deepEqual(got, { ...ZERO_SCANS, 'supersedes-check': 8 });
  assertHoldSample(txn);
  assert.equal(raw.count(), before);
  assert.equal(raw.receipt('req_dry'), undefined);
});

test('replayed capture hits the receipt with no scan and one hold sample', t => {
  const { ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const bundle = { version: 1, request_id: 'req_replay', actor,
    entries: [{ id: 'clm_replay', type: 'claim', data: { text: 'replay', kind: 'assertion', attributed_to: 'synthetic' } }] };
  ledger.capture(bundle);
  const { calls, scans: got, txn, errorCode } = costLockOf(counting, scans, () => ledger.capture(bundle));
  assert.equal(errorCode, null);
  assert.deepEqual(calls, { transaction: [1, 0, 0], receipt: [1, 1, 0] });
  assert.deepEqual(got, ZERO_SCANS);
  assertHoldSample(txn);
});

test('supersedes capture exercises the replacement path with one hold sample', t => {
  const { ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const { calls, scans: got, txn } = costLockOf(counting, scans, () => ledger.capture({ version: 1,
    request_id: 'req_sup', actor, entries: [
      { id: 'clm_sup', type: 'claim', data: { text: 'sup', kind: 'assertion', attributed_to: 'synthetic' } },
      { id: 'rel_sup', type: 'relation', data: { from_claim_id: 'clm_sup', to_claim_id: 'clm_i1',
        relation: 'supersedes', rationale: 'syn' } },
    ] }));
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], receipt: [1, 0, 0], get: [3, 1, 0], entries: [1, 7, 0],
    insert: [2, 0, 2], insertReceipt: [1, 0, 1],
  });
  assert.deepEqual(got, { ...ZERO_SCANS, 'supersedes-check': 9 });
  assertHoldSample(txn);
});

test('batch capture holds one transaction over N records', t => {
  const { ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const { calls, scans: got, txn } = costLockOf(counting, scans, () => ledger.capture({ version: 1,
    request_id: 'req_batch', actor, entries: [
      { id: 'clm_b0', type: 'claim', data: { text: 'b0', kind: 'assertion', attributed_to: 'synthetic' } },
      { id: 'clm_b1', type: 'claim', data: { text: 'b1', kind: 'assertion', attributed_to: 'synthetic' } },
    ] }));
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], receipt: [1, 0, 0], get: [2, 0, 0], entries: [1, 7, 0],
    insert: [2, 0, 2], insertReceipt: [1, 0, 1],
  });
  assert.deepEqual(got, { ...ZERO_SCANS, 'supersedes-check': 9 });
  assertHoldSample(txn);
});

test('refs-v1 projection issues the same Store calls as expanded discovery', t => {
  const { ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const { calls, scans: got, txn } = costLockOf(counting, scans,
    () => ledger.search('rareword', { expand: 'evidence', projection: 'refs-v1' }));
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], revision: [1, 0, 0], search: [1, 0, 0], entries: [1, 7, 0],
    incoming: [1, 1, 0], get: [2, 2, 0], latestReview: [8, 2, 0], latestVerification: [2, 0, 0],
  });
  assert.deepEqual(got, { ...ZERO_SCANS, 'expanded-evidence': 7 });
  assertHoldSample(txn);
});

test('capture-path inspection reports exact calls with one hold sample', t => {
  const { ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const { calls, scans: got, txn } = costLockOf(counting, scans, () => ledger.inspectCapture('req_fixture'));
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], revision: [1, 0, 0], receipt: [1, 1, 0],
    get: [13, 13, 0], latestReview: [13, 3, 0], latestVerification: [3, 0, 0],
  });
  assert.deepEqual(got, ZERO_SCANS);
  assertHoldSample(txn);
});

test('empty restore reports exact counts with one hold sample', t => {
  const hooked = setup(t);
  hooked.ledger.capture(FIXTURE);
  const snapshot = hooked.ledger.exportSnapshot();
  const raw2 = new SqliteStore(':memory:', true);
  t.after(() => raw2.close());
  const counting2 = new CountingStore(raw2);
  const scans2 = new ScanCollector();
  const ledger2 = new Ledger(counting2, () => AT, scans2);
  const { calls, scans: got, txn, errorCode } =
    costLockOf(counting2, scans2, () => ledger2.importSnapshot(snapshot));
  assert.equal(errorCode, null);
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], count: [1, 0, 0], receipts: [1, 0, 0], get: [7, 0, 0],
    entries: [1, 0, 0], insert: [7, 0, 7], insertReceipt: [1, 0, 1],
  });
  assert.deepEqual(got, { ...ZERO_SCANS, 'supersedes-check': 7 });
  assertHoldSample(txn);
});

test('non-empty restore fails fast on the count check with hold-to-rollback', t => {
  const { ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const tinyRaw = new SqliteStore(':memory:', true);
  t.after(() => tinyRaw.close());
  const tinyLedger = new Ledger(tinyRaw, () => AT);
  tinyLedger.capture({ version: 1, request_id: 'req_tiny', actor,
    entries: [{ id: 'clm_tiny', type: 'claim', data: { text: 'tiny', kind: 'assertion', attributed_to: 'synthetic' } }] });
  const tiny = tinyLedger.exportSnapshot();
  const { calls, scans: got, txn, errorCode } =
    costLockOf(counting, scans, () => ledger.importSnapshot(tiny), 'CONFLICT');
  assert.equal(errorCode, 'CONFLICT');
  assert.deepEqual(calls, { transaction: [1, 0, 0], count: [1, 0, 0] });
  assert.deepEqual(got, ZERO_SCANS);
  assertHoldSample(txn);
});

test('failed captures still record hold-to-rollback', t => {
  const { ledger, counting, scans } = setup(t);
  ledger.capture(FIXTURE);
  const { txn, errorCode } = costLockOf(counting, scans, () => ledger.capture({ version: 1,
    request_id: 'req_dup', actor, entries: [{ id: 'clm_i1', type: 'claim',
      data: { text: 'dup', kind: 'assertion', attributed_to: 'synthetic' } }] }), 'CONFLICT');
  assert.equal(errorCode, 'CONFLICT');
  assertHoldSample(txn);
});

test('contended BEGIN records zero hold despite the seconds-long busy wait', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-locks-'));
  // Single hook with explicit order: close the handle before removing the
  // directory (Windows refuses to remove open database files).
  const handles = {};
  t.after(() => { handles.store?.close(); rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, 'ledger.sqlite');
  const seed = new SqliteStore(dbPath, true);
  new Ledger(seed, () => AT).capture(FIXTURE);
  seed.close();
  // Open the contended store before the holder takes the lock, so only the
  // measured BEGIN IMMEDIATE contends (stores retry 5s via busy_timeout).
  const contendedRaw = handles.store = new SqliteStore(dbPath);
  const counting = new CountingStore(contendedRaw);
  const contended = new Ledger(counting, () => AT, new ScanCollector());
  const holder = new DatabaseSync(dbPath);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const started = performance.now();
    assert.throws(() => contended.search('alpha', { limit: 1 }), /busy|locked/i);
    const waited = performance.now() - started;
    // The wait really happened (busy_timeout=5000 with wide margin), yet no
    // hold occurred: the callback never ran, so the sample is exactly 0 —
    // distinctly reported, not the seconds spent waiting.
    assert.ok(waited >= 4000, `expected a ~5s busy wait, saw ${waited}ms`);
    assert.deepEqual(counting.txnTimings(), [0]);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
});

test('reset clears timings and snapshot keeps the count-only shape', t => {
  const { ledger, counting } = setup(t);
  ledger.capture(FIXTURE);
  ledger.search('alpha');
  assert.equal(counting.txnTimings().length, 2);
  counting.reset();
  assert.deepEqual(counting.txnTimings(), []);
  const snap = counting.snapshot();
  assert.deepEqual(Object.keys(snap.transaction).sort(), ['calls', 'rowsReturned', 'rowsWritten']);
});

test('doctor hold proxy records one finite sample without changing the result', t => {
  const { raw } = setup(t);
  new Ledger(raw, () => AT).capture(FIXTURE);
  const orig = raw.transaction.bind(raw);
  let ms = null;
  raw.transaction = (fn) => {
    let holdStart = null;
    const wrapped = () => { holdStart ??= performance.now(); return fn(); };
    try {
      const result = orig(wrapped);
      ms = holdStart === null ? 0 : performance.now() - holdStart;
      return result;
    } catch (error) {
      ms = holdStart === null ? 0 : performance.now() - holdStart;
      throw error;
    }
  };
  let result;
  try { result = raw.doctor(); }
  finally { raw.transaction = orig; }
  assert.equal(result.ok, true);
  assert.equal(typeof ms, 'number');
  assert.ok(Number.isFinite(ms) && ms >= 0 && ms < 60000);
  assert.equal(raw.doctor().ok, true);
});

test('held IMMEDIATE lets readonly reads proceed while second writers serialize', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-locks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'ledger.sqlite');
  const seed = new SqliteStore(dbPath, true);
  new Ledger(seed, () => AT).capture(FIXTURE);
  seed.close();
  const holder = new DatabaseSync(dbPath);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const reader = new SqliteStore(dbPath, false, { readonly: true });
    try {
      const found = new Ledger(reader, () => AT).search('alpha', { limit: 1 });
      assert.ok(found.items.length >= 1);
    } finally { reader.close(); }
    const contended = new DatabaseSync(dbPath);
    try {
      contended.exec('PRAGMA busy_timeout=0;');
      assert.throws(() => contended.exec('BEGIN IMMEDIATE'), /busy|locked/i);
    } finally { contended.close(); }
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  const check = new SqliteStore(dbPath);
  try { assert.equal(check.doctor().ok, true); }
  finally { check.close(); }
});

test('hooks on vs off stay identical across the newly covered operations', t => {
  const plain = setup(t, false);
  const hooked = setup(t, true);
  const seen = { plain: [], hooked: [] };
  for (const [name, { ledger }] of [['plain', plain], ['hooked', hooked]]) {
    seen[name].push(ledger.capture(FIXTURE));
    seen[name].push(ledger.capture({ version: 1, request_id: 'req_dry', actor,
      entries: [{ id: 'clm_dry', type: 'claim', data: { text: 'dry', kind: 'assertion', attributed_to: 'synthetic' } }] }, true));
    const replay = { version: 1, request_id: 'req_replay', actor,
      entries: [{ id: 'clm_replay', type: 'claim', data: { text: 'replay', kind: 'assertion', attributed_to: 'synthetic' } }] };
    seen[name].push(ledger.capture(replay));
    seen[name].push(ledger.capture(replay));
    seen[name].push(ledger.capture({ version: 1, request_id: 'req_sup', actor, entries: [
      { id: 'clm_sup', type: 'claim', data: { text: 'sup', kind: 'assertion', attributed_to: 'synthetic' } },
      { id: 'rel_sup', type: 'relation', data: { from_claim_id: 'clm_sup', to_claim_id: 'clm_i1',
        relation: 'supersedes', rationale: 'syn' } },
    ] }));
    seen[name].push(ledger.search('rareword', { expand: 'evidence', projection: 'refs-v1' }));
    seen[name].push(ledger.inspectCapture('req_fixture'));
    seen[name].push(ledger.exportSnapshot());
  }
  assert.equal(JSON.stringify(seen.plain), JSON.stringify(seen.hooked));
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(plain.ledger.exportSnapshot(), null, 2)}\n`, 'utf8'),
    Buffer.byteLength(`${JSON.stringify(hooked.ledger.exportSnapshot(), null, 2)}\n`, 'utf8'));
});
