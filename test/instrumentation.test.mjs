import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, SqliteStore } from '../dist/index.js';
import { CountingStore, ScanCollector } from '../dist/core/observe.js';

// Assess-only Core hooks (#44): exact Store-method-call / returned-row /
// Ledger-scan counts on a synthetic fixture, plus behavior parity proving the
// hooks observe without changing results. All content is synthetic.
const AT = '2026-09-27T00:00:00.000Z';
const actor = { kind: 'agent', id: 'instrumentation-test' };
const FIXTURE = { version: 1, request_id: 'req_fixture', actor, entries: [
  { id: 'src_i1', type: 'source', data: { title: 'Synthetic heat study', medium: 'experiment', uri: 'urn:yurai:synthetic:instrumentation' } },
  { id: 'clm_i1', type: 'claim', data: { text: 'alpha beta', kind: 'assertion', attributed_to: 'synthetic' } },
  { id: 'clm_i2', type: 'claim', data: { text: 'alpha gamma', kind: 'assertion', attributed_to: 'synthetic' } },
  { id: 'evd_i1', type: 'evidence', data: { source_id: 'src_i1', quote: 'alpha passage with rareword', locator: 'tab0' } },
  { id: 'evd_i2', type: 'evidence', data: { source_id: 'src_i1', quote: 'unrelated words here', locator: 'tab1' } },
  { id: 'asm_i1', type: 'assessment', data: { claim_id: 'clm_i1', evidence_id: 'evd_i1', stance: 'supports', rationale: 'syn' } },
  { id: 'rev_i1', type: 'review', data: { target_id: 'clm_i1', state: 'accepted', rationale: 'syn' } },
] };

function setup(t, hooked) {
  const raw = new SqliteStore(':memory:', true);
  t.after(() => raw.close());
  if (!hooked) return { ledger: new Ledger(raw, () => AT) };
  const counting = new CountingStore(raw);
  const scans = new ScanCollector();
  return { ledger: new Ledger(counting, () => AT, scans), counting, scans };
}

// Nonzero per-method [store-method calls, rows returned, rows written] plus
// Ledger-level scan totals, for exact comparison.
function costOf(counting, scans, fn) {
  counting.reset(); scans.reset();
  const result = fn();
  const calls = {};
  for (const [method, s] of Object.entries(counting.snapshot()))
    if (s.calls) calls[method] = [s.calls, s.rowsReturned, s.rowsWritten];
  return { result, calls, scans: scans.snapshot() };
}

const ZERO_SCANS = { 'supersedes-check': 0, 'expanded-evidence': 0, export: 0 };

test('direct search reports exact store-method calls and rows returned', t => {
  const { ledger, counting, scans } = setup(t, true);
  ledger.capture(FIXTURE);
  const { calls, scans: got } = costOf(counting, scans, () => ledger.search('alpha'));
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], revision: [1, 0, 0], search: [1, 2, 0], latestReview: [2, 1, 0],
  });
  assert.deepEqual(got, ZERO_SCANS);
});

test('capture reports one supersedes scan over stored plus input records', t => {
  const { ledger, counting, scans } = setup(t, true);
  ledger.capture(FIXTURE);
  const { calls, scans: got } = costOf(counting, scans, () => ledger.capture({ version: 1,
    request_id: 'req_probe', actor, entries: [{ id: 'clm_i3', type: 'claim',
      data: { text: 'probe', kind: 'assertion', attributed_to: 'synthetic' } }] }));
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], receipt: [1, 0, 0], get: [1, 0, 0], entries: [1, 7, 0],
    insert: [1, 0, 1], insertReceipt: [1, 0, 1],
  });
  assert.deepEqual(got, { ...ZERO_SCANS, 'supersedes-check': 8 });
});

test('expanded discovery reports the full evidence-candidate scan', t => {
  const { ledger, counting, scans } = setup(t, true);
  ledger.capture(FIXTURE);
  const { result, calls, scans: got } = costOf(counting, scans,
    () => ledger.search('rareword', { expand: 'evidence' }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].total_paths, 1);
  assert.deepEqual(calls, {
    transaction: [1, 0, 0], revision: [1, 0, 0], search: [1, 0, 0], entries: [1, 7, 0],
    incoming: [1, 1, 0], get: [2, 2, 0], latestReview: [8, 2, 0], latestVerification: [2, 0, 0],
  });
  assert.deepEqual(got, { ...ZERO_SCANS, 'expanded-evidence': 7 });
});

test('export reports one full-ledger scan', t => {
  const { ledger, counting, scans } = setup(t, true);
  ledger.capture(FIXTURE);
  const { calls, scans: got } = costOf(counting, scans, () => ledger.exportSnapshot());
  assert.deepEqual(calls, { transaction: [1, 0, 0], entries: [1, 7, 0], receipts: [1, 1, 0] });
  assert.deepEqual(got, { ...ZERO_SCANS, export: 7 });
});

test('hooks on vs off produce identical results and bytes', t => {
  const plain = setup(t, false);
  const hooked = setup(t, true);
  const seen = { plain: [], hooked: [] };
  for (const [name, { ledger }] of [['plain', plain], ['hooked', hooked]]) {
    seen[name].push(ledger.capture(FIXTURE));
    seen[name].push(ledger.search('alpha'));
    seen[name].push(ledger.search('alpha 気孔', { includeInactive: true }));
    seen[name].push(ledger.search('rareword', { expand: 'evidence' }));
    seen[name].push(ledger.show('clm_i1'));
    seen[name].push(ledger.capture({ version: 1, request_id: 'req_probe', actor,
      entries: [{ id: 'clm_i3', type: 'claim',
        data: { text: 'probe', kind: 'assertion', attributed_to: 'synthetic' } }] }));
    seen[name].push(ledger.exportSnapshot());
  }
  assert.equal(JSON.stringify(seen.plain), JSON.stringify(seen.hooked));
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(plain.ledger.exportSnapshot(), null, 2)}\n`, 'utf8'),
    Buffer.byteLength(`${JSON.stringify(hooked.ledger.exportSnapshot(), null, 2)}\n`, 'utf8'));
});

test('a throwing observer leaves results, errors, and bytes identical to hooks-off', t => {
  const throwing = { scan() { throw new Error('observer boom'); } };
  const rawThrowing = new SqliteStore(':memory:', true);
  const rawPlain = new SqliteStore(':memory:', true);
  t.after(() => { rawThrowing.close(); rawPlain.close(); });
  const throwingLedger = new Ledger(rawThrowing, () => AT, throwing);
  const plainLedger = new Ledger(rawPlain, () => AT);
  // The cycle capture fails VALIDATION after the supersedes-check report
  // fires, so it proves an observer throw neither masks the real error nor
  // rolls back a success path.
  const CYCLE = { version: 1, request_id: 'req_cycle', actor, entries: [
    { id: 'clm_c1', type: 'claim', data: { text: 'cycle one', kind: 'assertion', attributed_to: 'synthetic' } },
    { id: 'clm_c2', type: 'claim', data: { text: 'cycle two', kind: 'assertion', attributed_to: 'synthetic' } },
    { id: 'rel_c1', type: 'relation', data: { from_claim_id: 'clm_c1', to_claim_id: 'clm_c2', relation: 'supersedes', rationale: 'syn' } },
    { id: 'rel_c2', type: 'relation', data: { from_claim_id: 'clm_c2', to_claim_id: 'clm_c1', relation: 'supersedes', rationale: 'syn' } },
  ] };
  const run = ledger => {
    const out = [];
    const step = fn => {
      try { out.push({ ok: true, value: fn() }); }
      catch (error) { out.push({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) }); }
    };
    step(() => ledger.capture(FIXTURE));
    step(() => ledger.search('alpha'));
    step(() => ledger.search('rareword', { expand: 'evidence' }));
    step(() => ledger.show('clm_i1'));
    step(() => ledger.capture({ version: 1, request_id: 'req_probe', actor,
      entries: [{ id: 'clm_i3', type: 'claim',
        data: { text: 'probe', kind: 'assertion', attributed_to: 'synthetic' } }] }));
    step(() => ledger.capture(CYCLE));
    step(() => ledger.exportSnapshot());
    return out;
  };
  const throwingSeen = run(throwingLedger);
  const plainSeen = run(plainLedger);
  assert.equal(JSON.stringify(throwingSeen), JSON.stringify(plainSeen));
  // The cycle error must be the real VALIDATION failure on both sides, and
  // the failed capture must have rolled back identically.
  assert.equal(plainSeen[5].ok, false);
  assert.equal(plainSeen[5].code, 'VALIDATION');
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(throwingLedger.exportSnapshot(), null, 2)}\n`, 'utf8'),
    Buffer.byteLength(`${JSON.stringify(plainLedger.exportSnapshot(), null, 2)}\n`, 'utf8'));
});
