// Slice 1 of issue #23 (boxes 1-2): pure contract/fixture assertions.
// No DB, no destructive command, no migration: fixtures plus JSON rules only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LedgerError, parseSnapshot } from '../dist/core/model.js';

const dir = new URL('./fixtures/tombstone/', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const sha256hex = s => createHash('sha256').update(s, 'utf8').digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const code = expected => e => e instanceof LedgerError && e.code === expected;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
// ADR 0008 §13: order-insensitive entries/receipts/registry as sets, PLUS a
// per-target event-order gate. Latest-by-seq decides effective Review state
// and anchor warnings, and restore preserves snapshot array order as seq
// (Ledger.importSnapshot), so Review/Verification relative order must match.
function eventOrder(entries) {
  // Maps, not plain objects: target ids are arbitrary id-pattern strings and
  // `constructor` is a valid one — `{}` would throw or collide on it.
  const reviews = new Map(), verifications = new Map();
  const push = (map, target, id) => {
    const seq = map.get(target);
    if (seq) seq.push(id);
    else map.set(target, [id]);
  };
  for (const e of entries) {
    if (e.type === 'review') push(reviews, e.data.target_id, e.id);
    if (e.type === 'verification') push(verifications, e.data.target_evidence_id, e.id);
  }
  // Targets compare independent of first-encounter order: only the per-target
  // relative order of event IDs is significant (§13 gate b), so interleaving
  // events across targets must not change the result.
  const byTarget = map => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([byTarget(reviews), byTarget(verifications)]);
}
// Array order is seq order on restore: the last event per target decides.
function effectiveReviewState(entries, targetId) {
  const seq = entries.filter(e => e.type === 'review' && e.data.target_id === targetId);
  return seq.length ? seq[seq.length - 1].data.state : 'proposed';
}
function effectiveVerificationOutcome(entries, evidenceId) {
  const seq = entries.filter(e => e.type === 'verification' && e.data.target_evidence_id === evidenceId);
  return seq.length ? seq[seq.length - 1].data.outcome : null;
}
function logicalEquals(a, b) {
  if (a.format !== b.format || a.version !== b.version) return false;
  if (eventOrder(a.entries) !== eventOrder(b.entries)) return false;
  const byId = entries => new Map(entries.map(e => [e.id, JSON.stringify(canonical(e))]));
  const ea = byId(a.entries), eb = byId(b.entries);
  if (ea.size !== eb.size || [...ea].some(([id, body]) => eb.get(id) !== body)) return false;
  const ra = new Map(a.receipts.map(r => [r.request_id, JSON.stringify(canonical(r))]));
  const rb = new Map(b.receipts.map(r => [r.request_id, JSON.stringify(canonical(r))]));
  if (ra.size !== rb.size || [...ra].some(([id, body]) => rb.get(id) !== body)) return false;
  const da = [...(a.registry?.digests ?? [])].sort(), db = [...(b.registry?.digests ?? [])].sort();
  return JSON.stringify(da) === JSON.stringify(db);
}
// ADR 0008 §6: receipt + blocked digest of the same request_id is CONFLICT, never auto-resolved.
function receiptRegistryConflicts(snapshot) {
  const digests = new Set(snapshot.registry?.digests ?? []);
  return snapshot.receipts.map(r => r.request_id).filter(id => digests.has(sha256hex(id)));
}
// ADR 0008 §12: every Verification targeting a redacted Evidence must be in
// the redaction scope; returns the live stragglers an Evidence-only scope keeps.
function redactScopeGaps(scopeIds, verifications) {
  const scope = new Set(scopeIds);
  return verifications
    .filter(v => scope.has(v.data.target_evidence_id) && !scope.has(v.id))
    .map(v => v.id);
}
// ADR 0008 §12 restore backstop: a live Verification targeting tombstoned
// Evidence keeps exposing the removed quote's outcome, offsets, and passage
// hash through its own direct view, so future restore MUST refuse a snapshot
// carrying that combination whole, restoring nothing. Returns the offending
// live Verification IDs.
function liveVerificationsOnTombstonedEvidence(entries) {
  const tombstoned = new Set(entries
    .filter(e => e.type === 'evidence' && e.data.redacted === true)
    .map(e => e.id));
  return entries
    .filter(e => e.type === 'verification' && e.data.redacted !== true
      && tombstoned.has(e.data.target_evidence_id))
    .map(e => e.id);
}

test('registry digests are opaque sha256(request_id); fixtures leak no raw ids', () => {
  const { vectors } = load('request-digests.json');
  assert.ok(vectors.length >= 2);
  for (const { request_id, digest } of vectors) {
    assert.equal(sha256hex(request_id), digest);
    assert.match(digest, HEX64);
  }
  const wire = JSON.stringify(load('snapshot-with-registry.json').registry);
  for (const { request_id } of vectors) assert.ok(!wire.includes(request_id));
  assert.ok(!wire.includes('quote') && !wire.includes('SECRET') && !wire.includes('SYNTHETIC'));
});

test('legacy v1 snapshot without registry parses (empty restored registry)', () => {
  const snapshot = parseSnapshot(load('snapshot-legacy-v1.json'));
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.receipts.length, 1);
  assert.ok(!('registry' in snapshot));
});

test('current readers reject the registry extension instead of dropping it', () => {
  assert.throws(() => parseSnapshot(load('snapshot-with-registry.json')), code('VALIDATION'));
  const { registry } = load('snapshot-with-registry.json');
  assert.equal(registry.registry_version, 1);
  assert.deepEqual([...registry.digests].sort(), registry.digests);
  assert.equal(new Set(registry.digests).size, registry.digests.length);
  assert.ok(registry.digests.every(d => HEX64.test(d)));
});

test('live-receipt vs blocked-digest conflict is detected; clean restore is not', () => {
  assert.deepEqual(receiptRegistryConflicts(load('receipt-registry-conflict.json')), ['req_tmb_conflict']);
  assert.deepEqual(receiptRegistryConflicts(load('snapshot-with-registry.json')), []);
  assert.deepEqual(receiptRegistryConflicts(load('snapshot-legacy-v1.json')), []);
});

const TOMBSTONE_KEYS = {
  source: ['reason', 'redacted', 'redacted_at'],
  claim: ['reason', 'redacted', 'redacted_at'],
  evidence: ['reason', 'redacted', 'redacted_at', 'source_id'],
  assessment: ['claim_id', 'evidence_id', 'reason', 'redacted', 'redacted_at'],
  relation: ['from_claim_id', 'reason', 'redacted', 'redacted_at', 'to_claim_id'],
  review: ['reason', 'redacted', 'redacted_at', 'target_id'],
  verification: ['reason', 'redacted', 'redacted_at', 'target_evidence_id', 'target_source_id'],
};
const LIVE_ONLY_KEYS = ['title', 'text', 'quote', 'locator', 'paraphrase', 'stance', 'rationale',
  'relation', 'state', 'outcome', 'method', 'verified_at', 'detail', 'searched_sha256', 'passage_sha256'];

test('tombstoned bodies keep envelope + reference targets + marker; nothing else', () => {
  const { pairs, supporting } = load('tombstones.json');
  assert.deepEqual(pairs.map(p => p.live.type).sort(), Object.keys(TOMBSTONE_KEYS).sort());
  // Live halves are valid records (proving the fixture starts from real shapes).
  parseSnapshot({ format: 'yurai.snapshot', version: 1,
    entries: [...pairs.map(p => p.live), ...supporting], receipts: [] });
  for (const { live, tombstoned } of pairs) {
    assert.equal(tombstoned.id, live.id);
    assert.equal(tombstoned.type, live.type);
    assert.deepEqual(tombstoned.actor, live.actor);
    assert.equal(tombstoned.created_at, live.created_at);
    assert.deepEqual(Object.keys(tombstoned.data).sort(), [...TOMBSTONE_KEYS[live.type]].sort());
    assert.equal(tombstoned.data.redacted, true);
    assert.ok(['sensitive', 'wrong-scope'].includes(tombstoned.data.reason));
    assert.match(tombstoned.data.redacted_at, TIMESTAMP);
    assert.ok(Number.isFinite(Date.parse(tombstoned.data.redacted_at)));
    for (const key of TOMBSTONE_KEYS[live.type])
      if (!['redacted', 'reason', 'redacted_at'].includes(key))
        assert.equal(tombstoned.data[key], live.data[key]);
    for (const key of LIVE_ONLY_KEYS) assert.ok(!(key in tombstoned.data), `${live.type} leaks ${key}`);
    // No fabrication: removed required live fields stay absent, and the tombstone
    // is not a valid live body under the current schema (variant still to implement).
    assert.throws(() => parseSnapshot({ format: 'yurai.snapshot', version: 1,
      entries: [tombstoned], receipts: [] }), code('VALIDATION'));
  }
});

test('no live secret, verdict, quote, or pin survives in any tombstoned body', () => {
  const { pairs } = load('tombstones.json');
  const tombstonedJson = JSON.stringify(pairs.map(p => p.tombstoned));
  const secrets = new Set();
  for (const { live } of pairs)
    for (const [key, value] of Object.entries(live.data))
      if (typeof value === 'string' && !TOMBSTONE_KEYS[live.type].includes(key)) secrets.add(value);
  assert.ok(secrets.size > 5);
  for (const secret of secrets) assert.ok(!tombstonedJson.includes(secret), `leaked: ${secret}`);
  assert.ok(!tombstonedJson.includes('accepted'));
});

test('partial purge keeps a conflicting survivor; full purge leaves registry-only refusal', () => {
  const partial = load('purge-partial.json'), full = load('purge-full.json');
  for (const f of [partial, full]) {
    assert.equal(f.receipt_present, false);
    assert.deepEqual(f.registry_digests, [sha256hex(f.request_id)]);
    assert.deepEqual(f.live_ids.filter(id => f.purged_ids.includes(id)), []);
    assert.deepEqual(f.bundle_ids.filter(id => f.live_ids.includes(id) !== !f.purged_ids.includes(id)), []);
  }
  assert.ok(partial.live_ids.length > 0); // re-submission fails on immutable-ID conflict
  assert.deepEqual(full.live_ids, []); // re-submission refused by registry digest only
});

test('logical equality ignores bytes/order but never a dropped registry or flipped events', () => {
  const { a, b_reordered, c_registry_dropped,
    e_base, e_reviews_flipped, e_verifications_flipped } = load('logical-equality.json');
  assert.notEqual(JSON.stringify(a), JSON.stringify(b_reordered)); // bytewise different
  assert.equal(logicalEquals(a, b_reordered), true);
  assert.equal(logicalEquals(a, c_registry_dropped), false);
  assert.equal(logicalEquals(b_reordered, c_registry_dropped), false);
  // Event-order gate (§13): same entry sets, but the latest event — hence the
  // effective state — differs, so the snapshots are NOT logically equal.
  parseSnapshot(e_base); // base is a real live shape
  assert.equal(effectiveReviewState(e_base.entries, 'clm_tmb_ord'), 'withdrawn');
  assert.equal(effectiveReviewState(e_reviews_flipped.entries, 'clm_tmb_ord'), 'accepted');
  assert.equal(logicalEquals(e_base, e_reviews_flipped), false);
  assert.equal(effectiveVerificationOutcome(e_base.entries, 'evd_tmb_ord'), 'mismatch');
  assert.equal(effectiveVerificationOutcome(e_verifications_flipped.entries, 'evd_tmb_ord'), 'match');
  assert.equal(logicalEquals(e_base, e_verifications_flipped), false);
});

test('redacting Evidence requires redacting its Verifications (scope cascade)', () => {
  const { evidence, verifications, invalid_scope_evidence_only, valid_scope } = load('redact-evidence-scope.json');
  assert.equal(verifications.length, 1);
  const [live] = verifications;
  assert.equal(live.data.target_evidence_id, evidence.id);
  // The live Verification pins quote-derived bytes: the leak an Evidence-only scope would keep.
  assert.equal(live.data.outcome, 'match');
  assert.match(live.data.passage_sha256, HEX64);
  assert.ok(Number.isInteger(live.data.byte_offset));
  assert.deepEqual(redactScopeGaps(invalid_scope_evidence_only, verifications), [live.id]);
  assert.deepEqual(redactScopeGaps(valid_scope, verifications), []);
});

test('invalid tombstone shapes are rejected today and marked for the future schema', () => {
  const { cases } = load('tombstone-invalid.json');
  assert.deepEqual(cases.map(c => c.name).sort(),
    ['invalid-reason', 'invalid-timestamp', 'missing-retained-reference', 'retained-content']);
  for (const c of cases) {
    assert.throws(() => parseSnapshot({ format: 'yurai.snapshot', version: 1,
      entries: [c.entry], receipts: [] }), code('VALIDATION'), c.name);
    for (const key of c.absent ?? []) assert.ok(!(key in c.entry.data), `${c.name}: ${key} present`);
    for (const key of c.present ?? []) assert.ok(key in c.entry.data, `${c.name}: ${key} absent`);
    if (c.reason_not_in) assert.ok(!c.reason_not_in.includes(c.entry.data.reason), c.name);
    if (c.redacted_at_invalid) assert.ok(!TIMESTAMP.test(c.entry.data.redacted_at ?? ''), c.name);
    assert.ok(typeof c.future_defect === 'string' && c.future_defect.length > 0, c.name);
  }
});

test('unknown registry_version is refused whole, never partially restored', () => {
  assert.throws(() => parseSnapshot(load('snapshot-registry-v99.json')), code('VALIDATION'));
  const { registry } = load('snapshot-registry-v99.json');
  assert.notEqual(registry.registry_version, 1);
  // Well-formed apart from the version: the refusal is about support, not shape.
  assert.deepEqual([...registry.digests].sort(), registry.digests);
  assert.equal(new Set(registry.digests).size, registry.digests.length);
  assert.ok(registry.digests.every(d => HEX64.test(d)));
});

test('event-order gate ignores target interleave and reserved-word target ids', () => {
  const review = (id, target_id, state) => ({ id, type: 'review',
    data: { target_id, state, rationale: 'SYNTHETIC-RATIONALE' },
    created_at: '2026-09-27T00:00:00.000Z',
    actor: { kind: 'agent', id: 'synthetic-recorder', model: 'synthetic' } });
  const snap = entries => ({ format: 'yurai.snapshot', version: 1, entries, receipts: [] });
  // Same per-target order (r1 before r2; r3 before r4), different interleave
  // across targets: logically equal, since each target's latest event matches.
  const interleaveA = snap([
    review('rev_tmb_i1', 'clm_tmb_inter_a', 'accepted'),
    review('rev_tmb_i3', 'clm_tmb_inter_b', 'accepted'),
    review('rev_tmb_i2', 'clm_tmb_inter_a', 'withdrawn'),
    review('rev_tmb_i4', 'clm_tmb_inter_b', 'withdrawn'),
  ]);
  const interleaveB = snap([
    review('rev_tmb_i3', 'clm_tmb_inter_b', 'accepted'),
    review('rev_tmb_i1', 'clm_tmb_inter_a', 'accepted'),
    review('rev_tmb_i4', 'clm_tmb_inter_b', 'withdrawn'),
    review('rev_tmb_i2', 'clm_tmb_inter_a', 'withdrawn'),
  ]);
  for (const s of [interleaveA, interleaveB]) parseSnapshot(s); // real shapes
  assert.equal(effectiveReviewState(interleaveA.entries, 'clm_tmb_inter_a'), 'withdrawn');
  assert.equal(effectiveReviewState(interleaveB.entries, 'clm_tmb_inter_a'), 'withdrawn');
  assert.equal(logicalEquals(interleaveA, interleaveB), true);
  // `constructor` is a schema-valid target_id (id pattern) and must behave
  // like any other target: no throw, per-target order still decides.
  const ctorFlipped = snap([ // same entry set as ctorInterleaveA, per-target order flipped
    review('rev_tmb_c2', 'constructor', 'withdrawn'),
    review('rev_tmb_o1', 'clm_tmb_other', 'accepted'),
    review('rev_tmb_c1', 'constructor', 'accepted'),
  ]);
  const ctorInterleaveA = snap([
    review('rev_tmb_c1', 'constructor', 'accepted'),
    review('rev_tmb_o1', 'clm_tmb_other', 'accepted'),
    review('rev_tmb_c2', 'constructor', 'withdrawn'),
  ]);
  const ctorInterleaveB = snap([
    review('rev_tmb_o1', 'clm_tmb_other', 'accepted'),
    review('rev_tmb_c1', 'constructor', 'accepted'),
    review('rev_tmb_c2', 'constructor', 'withdrawn'),
  ]);
  for (const s of [ctorFlipped, ctorInterleaveA, ctorInterleaveB]) parseSnapshot(s);
  assert.equal(effectiveReviewState(ctorInterleaveA.entries, 'constructor'), 'withdrawn');
  assert.equal(effectiveReviewState(ctorFlipped.entries, 'constructor'), 'accepted');
  assert.equal(logicalEquals(ctorInterleaveA, ctorInterleaveB), true);
  assert.equal(logicalEquals(ctorInterleaveA, ctorFlipped), false);
});

test('restore refuses tombstoned Evidence paired with a live Verification (§12 backstop)', () => {
  const { snapshot, offending_verification_ids, future_defect } =
    load('snapshot-tombstoned-evidence-live-verification.json');
  // Invalid today (no tombstone variant exists yet) and invalid under the
  // future rule (forbidden combination): refused whole, never partially
  // restored, so the survivor's direct view can never expose the removed quote.
  assert.throws(() => parseSnapshot(snapshot), code('VALIDATION'));
  assert.deepEqual(liveVerificationsOnTombstonedEvidence(snapshot.entries), offending_verification_ids);
  assert.deepEqual(offending_verification_ids, ['ver_tmb_straggler']);
  assert.ok(typeof future_defect === 'string' && future_defect.length > 0);
  // The survivor pins quote-derived bytes: the leak a partial restore would keep.
  const survivor = snapshot.entries.find(e => e.id === 'ver_tmb_straggler');
  assert.equal(survivor.data.outcome, 'match');
  assert.match(survivor.data.passage_sha256, HEX64);
  assert.ok(Number.isInteger(survivor.data.byte_offset));
  // The tombstoned half is a §8-exact body: only the combination is defective.
  const tombstoned = snapshot.entries.find(e => e.type === 'evidence');
  assert.deepEqual(Object.keys(tombstoned.data).sort(), [...TOMBSTONE_KEYS.evidence].sort());
  assert.equal(tombstoned.data.redacted, true);
  // Clean shapes flag nothing: all-live pairs and all-tombstoned pairs.
  const { pairs } = load('tombstones.json');
  assert.deepEqual(liveVerificationsOnTombstonedEvidence(pairs.map(p => p.live)), []);
  assert.deepEqual(liveVerificationsOnTombstonedEvidence(pairs.map(p => p.tombstoned)), []);
});
