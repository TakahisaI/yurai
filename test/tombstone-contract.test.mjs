// Slices 1-2 of issue #23 (boxes 1-4): pure contract/fixture assertions.
// No DB, no destructive command, no migration: fixtures plus JSON rules only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSnapshot, references } from '../dist/core/model.js';
import { code } from './helpers/assert.mjs';

const dir = new URL('./fixtures/tombstone/', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const sha256hex = s => createHash('sha256').update(s, 'utf8').digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
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

// --- Slice 2 (boxes 3-4; ADR 0013) ---

// ADR 0013 §19: admission under R is refused iff digest(R) sits in the registry.
function registryBlocked(requestId, digests) {
  return digests.includes(sha256hex(requestId));
}
// ADR 0013 §19 supply/matching: each doomed tombstone must match a redaction
// pre-delete export entry on the full retained envelope (record id, type,
// actor, created_at — exactly what a tombstone preserves per 0005), and each
// matched entry must be covered by an export receipt; the redaction-dropped
// request_ids are exactly the covering receipts' request_ids. Id-only
// matching is forbidden: a foreign export can reuse the same record id for
// a different original request, and accepting it would block the wrong
// request while re-admitting the real one. A missing, incomplete, or
// mismatched artifact refuses the purge proposal whole (fail-closed), never
// silently deriving from live receipts alone. Returns { ok, requestIds?, reason? }.
function redactionDroppedRequests(doomedTombstones, redactionExport) {
  const byId = new Map((redactionExport?.entries ?? []).map(e => [e.id, e]));
  const envelopeOf = e => JSON.stringify(canonical({ type: e.type, actor: e.actor, created_at: e.created_at }));
  for (const tombstone of doomedTombstones) {
    const entry = byId.get(tombstone.id);
    if (!entry)
      return { ok: false, reason: `no export entry for tombstone ${tombstone.id}` };
    if (envelopeOf(entry) !== envelopeOf(tombstone))
      return { ok: false, reason: `export entry envelope mismatch for tombstone ${tombstone.id}` };
  }
  const doomed = new Set(doomedTombstones.map(t => t.id));
  const covering = (redactionExport?.receipts ?? [])
    .filter(r => r.ids.some(id => doomed.has(id)));
  const covered = new Set(covering.flatMap(r => r.ids));
  const bare = [...doomed].filter(id => !covered.has(id));
  if (bare.length)
    return { ok: false, reason: `export entry without covering receipt: ${bare.join(',')}` };
  return { ok: true, requestIds: [...new Set(covering.map(r => r.request_id))].sort() };
}
// ADR 0013 §17: confirmation executes only when it is a distinct act matching
// the proposal exactly: the proposal comes from a completed separate step,
// and the confirmation binds to that returned proposal (proposal id plus a
// computed_at echo, explicitly unbundled), with strictly-after timestamps,
// doomed set equality, and no ledger drift. Omission of any binding refuses
// fail-closed: a later timestamp alone never establishes a later act.
function proposalExecutable(proposal, confirmation) {
  if (proposal.separate_step_completed !== true) return false;
  if (confirmation.bundled_with_redact_request !== false) return false;
  if (confirmation.proposal_computed_at !== proposal.computed_at) return false;
  if (confirmation.proposal_id !== proposal.proposal_id) return false;
  if (!(Date.parse(confirmation.confirmed_at) > Date.parse(proposal.computed_at))) return false;
  if (proposal.redact_requested_at &&
      !(Date.parse(confirmation.confirmed_at) > Date.parse(proposal.redact_requested_at))) return false;
  if (confirmation.ledger_state !== proposal.ledger_state) return false;
  const a = [...proposal.doomed].sort(), b = [...confirmation.doomed].sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

test('sensitive retained reference refuses redact whole and proposes a bearer-including purge scope', () => {
  const f = load('sensitive-reference-routing.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: f.live, receipts: f.receipts });
  const byId = new Map(f.live.map(e => [e.id, e]));
  // The redact as requested cannot be satisfied: refused whole, never split.
  assert.equal(f.sensitivity.length, 4);
  assert.equal(f.expected.redact_refused_whole, true);
  assert.equal(f.expected.implicit_split, false);
  // ADR 0013 §14: per-record inventory covers envelope + references + marker,
  // with the FULL retained actor object and all three marker fields.
  assert.deepEqual(Object.keys(f.routing_report).sort(), [...f.redact_scope].sort());
  for (const id of f.redact_scope) {
    const report = f.routing_report[id], live = byId.get(id);
    assert.deepEqual(Object.keys(report.envelope).sort(), ['actor', 'created_at', 'own_id', 'type']);
    assert.equal(report.envelope.own_id.value, live.id);
    assert.equal(report.envelope.type.value, live.type);
    assert.deepEqual(report.envelope.actor.value, live.actor);
    assert.equal(report.envelope.created_at.value, live.created_at);
    assert.deepEqual(Object.keys(report.marker).sort(), ['reason', 'redacted', 'redacted_at']);
    assert.equal(report.marker.redacted.sensitive, false);
    assert.equal(report.marker.redacted.value, true);
    assert.equal(report.marker.reason.sensitive, false);
    assert.equal(report.marker.redacted_at.sensitive, false);
  }
  assert.deepEqual(Object.keys(f.routing_report.asm_bx3_link.references).sort(), ['claim_id', 'evidence_id']);
  assert.deepEqual(Object.keys(f.routing_report.evd_bx3_span.references).sort(), ['source_id']);
  assert.equal(f.routing_report.clm_bx3_topic.references, 'none');
  // Every flagged item is marked in the report; the set exercises a reference
  // target plus sensitive own ID, actor, and timestamp.
  assert.deepEqual(f.sensitivity.map(s => `${s.section}.${s.item}`).sort(),
    ['envelope.actor', 'envelope.created_at', 'envelope.own_id', 'references.evidence_id']);
  const doomed = new Set(f.proposal.doomed);
  for (const { record, section, item, value } of f.sensitivity) {
    assert.equal(f.routing_report[record][section][item].sensitive, true, `${record}.${item}`);
    assert.deepEqual(f.routing_report[record][section][item].value, value);
    assert.ok(doomed.has(record), `${record} not doomed`);
    if (section === 'references') assert.ok(doomed.has(value), `bearer ${value} not doomed`);
    if (section === 'envelope' && item === 'own_id') assert.equal(value, record);
  }
  // Sensitivity is value-scoped (§15): every bearer of a flagged value is
  // doomed, and no survivor — including the narrowed-redact scope — retains
  // any flagged value anywhere in its envelope or references.
  const flaggedValues = new Set(f.sensitivity.map(s => JSON.stringify(s.value)));
  const retainedOf = e => [e.id, e.type, e.actor, e.created_at,
    ...references(e).map(r => r.id)];
  for (const e of f.live)
    if (!doomed.has(e.id))
      for (const item of retainedOf(e))
        assert.ok(!flaggedValues.has(JSON.stringify(item)),
          `${e.id} retains sensitive value ${JSON.stringify(item)}`);
  for (const id of f.narrowed_redact.scope)
    for (const item of retainedOf(byId.get(id)))
      assert.ok(!flaggedValues.has(JSON.stringify(item)),
        `narrowed scope ${id} retains sensitive value ${JSON.stringify(item)}`);
  // The purge scope holds the retaining record AND the sensitive-ID bearer:
  // purging only the retaining record would leave the string live under its own ID.
  assert.ok(doomed.has('evd_bx3_span'));
  // Every cascaded dependent really references its pulling target (real references()).
  for (const edge of f.proposal.cascade) {
    assert.ok(doomed.has(edge.dependent));
    const refs = references(byId.get(edge.dependent));
    assert.ok(refs.some(r => r.id === edge.via_target && r.role === edge.role),
      `${edge.dependent} does not reference ${edge.via_target} as ${edge.role}`);
  }
  // Transitive closure: no survivor outside the scope references into it.
  for (const e of f.live)
    if (!doomed.has(e.id))
      assert.deepEqual(references(e).filter(r => doomed.has(r.id)), [], `${e.id} dangles into the purge`);
  // Affected receipts are exactly those touching doomed records; the registry
  // gains every affected request digest and no unaffected one.
  const touched = f.receipts.filter(r => r.ids.some(id => doomed.has(id))).map(r => r.request_id).sort();
  assert.deepEqual([...f.proposal.affected_request_ids].sort(), touched);
  assert.deepEqual(f.proposal.registry_additions,
    [...new Set(touched.map(sha256hex))].sort());
  assert.ok(f.proposal.unaffected_receipts.every(id => !touched.includes(id)));
  // The narrowed redact is a new valid request over records outside the purge.
  assert.equal(f.narrowed_redact.valid, true);
  assert.deepEqual(f.narrowed_redact.scope.filter(id => doomed.has(id)), []);
  assert.ok(['sensitive', 'wrong-scope'].includes(f.narrowed_redact.reason));
  // Reason/marker and registry wire positions carry no live-only secret spans.
  const secrets = ['SYNTHETIC-QUOTE-SPAN', 'SYNTHETIC-LINK-RATIONALE', 'SYNTHETIC-VOTE-RATIONALE',
    'SYNTHETIC-TOPIC-TEXT', 'SYNTHETIC-UNRELATED-TEXT'];
  const wire = JSON.stringify({ narrowed: f.narrowed_redact, registry: f.proposal.registry_additions });
  for (const secret of secrets) assert.ok(!wire.includes(secret), `leaked: ${secret}`);
});

test('purge confirmation executes only on an exact distinct confirmation', () => {
  const { proposal, cases } = load('purge-scope-confirmation.json');
  assert.deepEqual([...proposal.doomed].sort(), proposal.doomed);
  assert.equal(new Set(proposal.doomed).size, proposal.doomed.length);
  assert.deepEqual(proposal.registry_additions,
    [...new Set(proposal.affected_request_ids.map(sha256hex))].sort());
  assert.deepEqual(cases.map(c => c.name).sort(),
    ['bundled-preconfirmation-invalid', 'exact-match-executes', 'ledger-drift-reproposes',
      'narrowed-scope-refuses', 'omitted-separate-step-binding-invalid', 'predated-confirmation-invalid']);
  assert.match(proposal.computed_at, TIMESTAMP);
  assert.match(proposal.redact_requested_at, TIMESTAMP);
  assert.ok(Date.parse(proposal.computed_at) > Date.parse(proposal.redact_requested_at));
  assert.equal(proposal.separate_step_completed, true);
  const byName = new Map(cases.map(c => [c.name, c]));
  for (const c of cases) {
    assert.match(c.confirmation.confirmed_at, TIMESTAMP, c.name);
    assert.equal(proposalExecutable(proposal, c.confirmation), c.executable, c.name);
    if (!c.executable) assert.ok(typeof c.reason === 'string' && c.reason.length > 0, c.name);
  }
  // Distinct-act evidence: the executing confirmation binds to the proposal
  // returned by the completed separate step (id + computed_at echo, explicitly
  // unbundled) and lands strictly after both the redact request and the
  // proposal computation.
  const exact = byName.get('exact-match-executes').confirmation;
  assert.equal(exact.proposal_id, proposal.proposal_id);
  assert.equal(exact.proposal_computed_at, proposal.computed_at);
  assert.equal(exact.bundled_with_redact_request, false);
  assert.ok(Date.parse(exact.confirmed_at) > Date.parse(proposal.computed_at));
  assert.ok(Date.parse(exact.confirmed_at) > Date.parse(proposal.redact_requested_at));
  // The predated case is after the redact request but before the proposal, so
  // only the after-proposal ordering refuses it; the bundled case is after the
  // proposal with a correct echo, so only the never-bundled rule refuses it.
  const predated = byName.get('predated-confirmation-invalid').confirmation;
  assert.ok(Date.parse(predated.confirmed_at) > Date.parse(proposal.redact_requested_at));
  assert.ok(!(Date.parse(predated.confirmed_at) > Date.parse(proposal.computed_at)));
  assert.equal(predated.proposal_computed_at, proposal.computed_at);
  assert.equal(predated.bundled_with_redact_request, false);
  const bundled = byName.get('bundled-preconfirmation-invalid').confirmation;
  assert.ok(Date.parse(bundled.confirmed_at) > Date.parse(proposal.computed_at));
  assert.equal(bundled.proposal_computed_at, proposal.computed_at);
  // The omitted-binding case is late, exact, and undrifted, so only the
  // missing separate-step binding refuses it: omission fails closed.
  const omitted = byName.get('omitted-separate-step-binding-invalid').confirmation;
  assert.ok(Date.parse(omitted.confirmed_at) > Date.parse(proposal.computed_at));
  assert.equal(omitted.proposal_id, proposal.proposal_id);
  assert.deepEqual([...omitted.doomed].sort(), [...proposal.doomed].sort());
  assert.equal(omitted.ledger_state, proposal.ledger_state);
  assert.ok(!('bundled_with_redact_request' in omitted));
  assert.ok(!('proposal_computed_at' in omitted));
});

test('multi-request purge blocks every affected original request_id', () => {
  const f = load('purge-multi-request.json');
  const doomed = new Set(f.doomed_ids);
  assert.deepEqual(f.live_ids.filter(id => doomed.has(id)), []);
  assert.deepEqual([...f.registry_digests].sort(), f.registry_digests);
  assert.deepEqual(f.registry_digests, [...new Set(f.affected_request_ids.map(sha256hex))].sort());
  // Cross-check: the affected list is exactly the receipts touching doomed IDs,
  // so dropping one request+digest from the fixture cannot stay green.
  const touched = f.bundle_receipts
    .filter(r => r.ids.some(id => doomed.has(id))).map(r => r.request_id).sort();
  assert.deepEqual([...f.affected_request_ids].sort(), touched);
  assert.deepEqual([...f.dropped_receipts].sort(), touched);
  for (const affected of f.affected_request_ids)
    assert.ok(registryBlocked(affected, f.registry_digests), `${affected} not blocked`);
  for (const survivor of f.surviving_receipts)
    assert.ok(!registryBlocked(survivor, f.registry_digests), `${survivor} wrongly blocked`);
  // Receipt bookkeeping is consistent: dropped iff touching doomed records.
  for (const r of f.bundle_receipts) {
    const touches = r.ids.some(id => doomed.has(id));
    assert.equal(f.dropped_receipts.includes(r.request_id), touches, r.request_id);
    assert.equal(f.surviving_receipts.includes(r.request_id), !touches, r.request_id);
  }
});

test('redact-then-purge still blocks the redaction-dropped request (§19 continuity)', () => {
  const f = load('redact-then-purge.json');
  const solo = f.original_request_id, other = f.purge_proposal.unaffected_receipts[0];
  // After redact: the tombstone ID survives and the receipt is gone, so the
  // request still fails closed on immutable-ID conflict with no digest yet.
  assert.deepEqual(f.after_redact.tombstoned_ids, f.original_ids);
  assert.deepEqual(f.after_redact.live_ids, f.original_ids);
  assert.equal(f.after_redact.redaction_drops_receipt, true);
  assert.equal(f.after_redact.id_conflict_still_blocks, true);
  assert.deepEqual(f.after_redact.registry_digests, []);
  assert.ok(f.after_redact.live_receipts.every(r => r.request_id !== solo));
  // The purge proposal derives zero live touches yet still blocks R via
  // redaction provenance: affected is the union both lists name, and the
  // dropped requests are DERIVED from the supplied redaction export —
  // matched by tombstone retained envelope to export entry with a covering
  // receipt — never taken as a bare pre-listed claim.
  parseSnapshot({ format: 'yurai.snapshot', version: 1,
    entries: f.redaction_export.entries, receipts: f.redaction_export.receipts });
  const doomed = new Set(f.purge_proposal.doomed);
  assert.deepEqual([...doomed], f.original_ids);
  // The live-side tombstones carry the retained envelope the export must
  // match: §8-exact bodies whose id/type/actor/created_at equal the good
  // export entry's, so the happy path passes on substance, not on id alone.
  const tombstones = f.doomed_tombstones;
  assert.deepEqual(tombstones.map(t => t.id), [...doomed]);
  for (const t of tombstones) {
    assert.deepEqual(Object.keys(t.data).sort(), [...TOMBSTONE_KEYS[t.type]].sort());
    assert.equal(t.data.redacted, true);
    const entry = f.redaction_export.entries.find(e => e.id === t.id);
    assert.equal(entry.type, t.type);
    assert.deepEqual(entry.actor, t.actor);
    assert.equal(entry.created_at, t.created_at);
  }
  const liveTouched = f.after_redact.live_receipts
    .filter(r => r.ids.some(id => doomed.has(id))).map(r => r.request_id);
  assert.deepEqual(liveTouched, []);
  assert.deepEqual(f.purge_proposal.live_receipt_touches, []);
  const derived = redactionDroppedRequests(tombstones, f.redaction_export);
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.requestIds, [solo]);
  assert.deepEqual(f.purge_proposal.redaction_dropped_request_ids, derived.requestIds);
  assert.deepEqual(f.purge_proposal.affected_request_ids, [solo]);
  assert.deepEqual([...new Set([...liveTouched, ...derived.requestIds])].sort(),
    [...f.purge_proposal.affected_request_ids].sort());
  // Missing, incomplete, or mismatched artifact refuses the purge proposal
  // whole: the tombstone id alone never authorizes a derivation.
  assert.deepEqual(f.refusal_cases.map(c => c.name).sort(),
    ['entry-without-receipt', 'missing-export', 'wrong-ledger-export']);
  for (const c of f.refusal_cases) {
    assert.equal(redactionDroppedRequests(tombstones, c.export).ok, false, c.name);
    assert.ok(typeof c.reason === 'string' && c.reason.length > 0, c.name);
  }
  // The wrong-ledger case is meaningful: its export covers the doomed id
  // with a receipt for a FOREIGN request, so id-only matching would accept
  // it and block the wrong request — envelope matching refuses instead.
  const wrongLedger = f.refusal_cases.find(c => c.name === 'wrong-ledger-export');
  assert.ok(wrongLedger.export.receipts.some(r => r.ids.some(id => doomed.has(id))));
  assert.ok(wrongLedger.export.receipts.every(r => r.request_id !== solo));
  const wrongEntry = wrongLedger.export.entries.find(e => doomed.has(e.id));
  assert.ok(wrongEntry.type !== tombstones[0].type
    || JSON.stringify(canonical(wrongEntry.actor)) !== JSON.stringify(canonical(tombstones[0].actor))
    || wrongEntry.created_at !== tombstones[0].created_at);
  // Each retained envelope field is load-bearing: mutating any one of type,
  // actor, or created_at away from the live tombstone refuses, even with a
  // covering receipt present.
  const mutate = fn => {
    const clone = JSON.parse(JSON.stringify(f.redaction_export));
    fn(clone.entries[0]);
    return clone;
  };
  const singleFieldMismatches = [
    ['type', mutate(e => { e.type = 'source'; })],
    ['actor', mutate(e => { e.actor = { kind: 'agent', id: 'synthetic-other', model: 'synthetic' }; })],
    ['created_at', mutate(e => { e.created_at = '2026-09-26T00:00:01.000Z'; })],
  ];
  for (const [field, badExport] of singleFieldMismatches)
    assert.equal(redactionDroppedRequests(tombstones, badExport).ok, false, `${field} mismatch accepted`);
  assert.deepEqual(f.purge_proposal.registry_additions,
    [...new Set(f.purge_proposal.affected_request_ids.map(sha256hex))].sort());
  assert.deepEqual(f.after_purge.registry_digests, f.purge_proposal.registry_additions);
  assert.deepEqual(f.after_purge.live_ids.filter(id => doomed.has(id)), []);
  assert.ok(registryBlocked(solo, f.after_purge.registry_digests), `${solo} re-admissible`);
  assert.ok(!registryBlocked(other, f.after_purge.registry_digests), `${other} wrongly blocked`);
  assert.equal(f.after_purge.resubmission_refused, true);
});

test('lookup order is registry-first on every admission path', () => {
  const f = load('registry-lookup-order.json');
  assert.deepEqual(f.orders.capture, ['validate', 'registry', 'receipt', 'references', 'write']);
  assert.deepEqual(f.orders.verify, ['evidence-content-prechecks', 'capture-sequence', 'registry-guarded-replay']);
  assert.deepEqual(f.orders.restore, ['validate', 'version-gates', 'section6-scan', 'section12-scan', 'write']);
  assert.deepEqual(f.orders.merge, ['validate', 'foreign-internal', 'local-registry', 'receipt', 'classification', 'remap']);
  assert.ok(f.definition.includes('UTF-8 bytes of the exact request_id string'));
  assert.ok(f.leakage.includes('unguessable request_ids'));
  const digests = f.registry.digests;
  assert.deepEqual(digests, [sha256hex('req_bx4_blocked')]);
  const byName = new Map(f.cases.map(c => [c.name, c]));
  assert.equal(registryBlocked(byName.get('blocked-request-refuses-even-dry-run').request_id, digests), true);
  assert.equal(byName.get('blocked-request-refuses-even-dry-run').registry_consulted, true);
  assert.equal(byName.get('receipt-plus-digest-surfaces-registry-first').error_first, 'registry');
  assert.equal(registryBlocked(byName.get('clean-retry-replays').request_id, digests), false);
  assert.equal(byName.get('verify-replay-never-resurrects-blocked').replay, false);
  for (const c of f.cases) assert.equal(c.writes ?? 'nothing', 'nothing', c.name);
  const wire = JSON.stringify(f.registry);
  assert.ok(!wire.includes('req_bx4_blocked') && !wire.includes('quote'));
});

test('merge admission runs C1, local request, then paired C9 before classification', () => {
  const f = load('merge-admission-lookup.json');
  assert.deepEqual(f.local_registry_phase, ['C1-scan', 'C2-C8-local-request', 'C9-paired-resupply']);
  const byName = new Map(f.cases.map(c => [c.name, c]));
  // P5: stored receipt plus blocked digest surfaces the registry refusal first.
  const c8 = byName.get('C8-stored-receipt-plus-blocked-digest-registry-first');
  assert.equal(c8.settles, 'P5');
  assert.equal(registryBlocked(c8.merge_request_id, c8.local_registry), true);
  assert.equal(c8.error_first, 'registry');
  assert.deepEqual(c8.reported, [c8.merge_request_id]);
  assert.deepEqual(c8.before, ['classification', 'remap']);
  // P8: paired foreign receipts are hashed against the local registry after the
  // local-request checks and before classification; the report names the hit.
  const c9 = byName.get('C9-paired-resupply-refuses-before-classification');
  assert.equal(c9.settles, 'P8');
  assert.equal(c9.shared_history_declared, true);
  const hits = c9.incoming_foreign_receipts
    .map(r => r.request_id).filter(id => registryBlocked(id, c9.local_registry));
  assert.deepEqual(hits, ['req_foreign_old']);
  assert.deepEqual(c9.reported, hits);
  assert.deepEqual(c9.before, ['classification', 'remap']);
  assert.deepEqual(c9.after, ['local-request-checks']);
  // Unpaired contrast: the strings are never compared.
  assert.equal(byName.get('C9-unpaired-strings-never-compared').strings_compared, false);
  // Foreign-internal identity before content; inconsistent local ledger first.
  assert.deepEqual(byName.get('foreign-internal-C4-before-C5').order,
    ['C4-receipt-registry-conflict', 'C5-tombstone-verification-violation']);
  const c1 = byName.get('C1-inconsistent-ledger-refuses-first');
  assert.equal(registryBlocked(c1.local_live_receipt, c1.local_registry), true);
  assert.equal(c1.order_first, 'C1-scan');
  // Reports name operator-supplied request strings, never digests or content.
  assert.ok(f.report.never.includes('digests-as-proof') && f.report.never.includes('content'));
  assert.equal(f.report.bounded_lists_with_totals, true);
  for (const listed of f.report.lists) assert.ok(!HEX64.test(listed), `digest leaked: ${listed}`);
});

test('plan previews the same barrier sequence apply enforces', () => {
  const { plan_apply_parity } = load('merge-admission-lookup.json');
  assert.equal(plan_apply_parity.plan_previews_same_sequence, true);
  assert.equal(plan_apply_parity.plan_writes_nothing, true);
  assert.equal(plan_apply_parity.apply_reruns_registry_phase_in_transaction, true);
  assert.equal(plan_apply_parity.fingerprint_covers_registry_appends, true);
});
