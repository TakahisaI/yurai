// Issue #24 slice 1: pure purge/redact planner mechanics (boxes 1-6), including
// the box-4 plan digest bound to source identity/schema/revision/selection,
// exact expected results, and exact state transitions. No DB, no ledger
// mutation, no clock: the planner consumes a detached read-only snapshot
// plus source identity, schema, registry, and logical revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LedgerError, references } from '../dist/core/model.js';
import { canonicalJson } from '../dist/core/mergeIdentity.js';
import { REDACT_SCOPE_NOTE, canonicalReferences, isPlanStale, planPurge, planRedact,
  sourceFingerprint, verifyPlanApproval, verifyPlanDigest } from '../dist/core/planPurge.js';

const actor = { kind: 'agent', id: 'synthetic-planner' };
const at = '2026-09-27T00:00:00.000Z';
const redactedAt = '2026-09-28T00:00:00.000Z';

const entry = (id, type, data) => ({ id, type, data, created_at: at, actor });
const source = id => entry(id, 'source', { title: `synthetic ${id}`, medium: 'note', uri: `urn:yurai:synthetic:${id}` });
const claim = id => entry(id, 'claim', { text: `synthetic ${id}`, kind: 'assertion', attributed_to: 'synthetic' });
const evidence = (id, sourceId, extra = {}) =>
  entry(id, 'evidence', { source_id: sourceId, quote: `SYNTHETIC-QUOTE-${id}`, ...extra });
const assessment = (id, claimId, evidenceId) =>
  entry(id, 'assessment', { claim_id: claimId, evidence_id: evidenceId, stance: 'supports', rationale: 'synthetic' });
const relation = (id, from, to, kind = 'supports') =>
  entry(id, 'relation', { from_claim_id: from, to_claim_id: to, relation: kind, rationale: 'synthetic' });
const review = (id, target, state = 'accepted') =>
  entry(id, 'review', { target_id: target, state, rationale: 'synthetic' });
const verification = (id, evidenceId, sourceId) => entry(id, 'verification', {
  target_evidence_id: evidenceId, target_source_id: sourceId, outcome: 'match', method: 'verbatim',
  verified_at: at, searched_sha256: 'a'.repeat(64), searched_bytes: 10, passage_sha256: 'b'.repeat(64),
  byte_offset: 0, byte_length: 4, occurrences: 1,
});
const tombstoned = (id, type, retained) =>
  entry(id, type, { redacted: true, reason: 'sensitive', redacted_at: redactedAt, ...retained });
const snapshot = (entries, receipts = [], revision = 7) =>
  ({ revision, entries, receipts, source_id: 'synthetic-ledger', schema_version: 2 });
const receipt = (request_id, ids) => ({ request_id, digest: 'c'.repeat(64), ids });

test('purge refuses when dependents survive and proposes the expanded scope with reasons', () => {
  const src = source('pln_src_1'), clm = claim('pln_clm_1');
  const evd = evidence('pln_evd_1', 'pln_src_1');
  const asm = assessment('pln_asm_1', 'pln_clm_1', 'pln_evd_1');
  const src_ = snapshot([src, clm, evd, asm]);
  const plan = planPurge(src_, ['pln_src_1']);
  assert.equal(plan.status, 'refused');
  assert.equal(plan.refusal, 'dependents-survive');
  assert.equal(plan.scope.length, 0);
  assert.deepEqual(plan.proposed_scope, ['pln_asm_1', 'pln_evd_1', 'pln_src_1']);
  assert.deepEqual(plan.survivors.map(s => s.id), ['pln_asm_1', 'pln_evd_1']);
  const byId = new Map(plan.survivors.map(s => [s.id, s]));
  assert.deepEqual(byId.get('pln_evd_1').via, [{ target: 'pln_src_1', role: 'source', kind: 'source' }]);
  assert.deepEqual(byId.get('pln_asm_1').via, [{ target: 'pln_evd_1', role: 'evidence', kind: 'evidence' }]);
  assert.equal(byId.get('pln_asm_1').depth, 2);
  assert.equal(plan.revision, 7);
});

test('purge with the confirmed full closure is ready and removes nothing silently', () => {
  const src_ = snapshot([source('pln_src_1'), claim('pln_clm_1'), evidence('pln_evd_1', 'pln_src_1')]);
  const plan = planPurge(src_, ['pln_src_1', 'pln_evd_1']);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.scope, ['pln_evd_1', 'pln_src_1']);
  assert.deepEqual(plan.unknown_ids, []);
});

test('closure handles relation cycles and reports each dependent once', () => {
  const a = claim('pln_cyc_a'), b = claim('pln_cyc_b');
  const r1 = relation('pln_cyc_r1', 'pln_cyc_a', 'pln_cyc_b');
  const r2 = relation('pln_cyc_r2', 'pln_cyc_b', 'pln_cyc_a');
  const v = review('pln_cyc_rev', 'pln_cyc_r1');
  const plan = planPurge(snapshot([a, b, r1, r2, v]), ['pln_cyc_a']);
  assert.equal(plan.status, 'refused');
  // Both relations reference A, so both join; B survives honestly since it
  // references nothing removed.
  assert.deepEqual(plan.proposed_scope, ['pln_cyc_a', 'pln_cyc_r1', 'pln_cyc_r2', 'pln_cyc_rev']);
  assert.equal(new Set(plan.proposed_scope).size, plan.proposed_scope.length);
});

test('closure terminates on a true dependent-graph cycle', () => {
  const m1 = entry('pln_loop_m1', 'memo', { about_id: 'pln_loop_m2' });
  const m2 = entry('pln_loop_m2', 'memo', { about_id: 'pln_loop_m1' });
  const loop = {
    references: e => e.type === 'memo'
      ? [{ id: e.data.about_id, role: 'about', kind: 'memo' }]
      : canonicalReferences(e),
  };
  const plan = planPurge(snapshot([m1, m2]), ['pln_loop_m1'], loop);
  assert.equal(plan.status, 'refused');
  assert.deepEqual(plan.proposed_scope, ['pln_loop_m1', 'pln_loop_m2']);
});

test('duplicate paths merge into one dependent with combined reasons', () => {
  const src_ = snapshot([
    source('pln_dup_src'), claim('pln_dup_clm'), evidence('pln_dup_evd', 'pln_dup_src'),
    assessment('pln_dup_asm', 'pln_dup_clm', 'pln_dup_evd'),
  ]);
  const plan = planPurge(src_, ['pln_dup_clm', 'pln_dup_evd']);
  assert.equal(plan.status, 'refused');
  assert.equal(plan.survivors.length, 1);
  const [asm] = plan.survivors;
  assert.equal(asm.id, 'pln_dup_asm');
  assert.deepEqual(asm.via, [
    { target: 'pln_dup_clm', role: 'claim', kind: 'claim' },
    { target: 'pln_dup_evd', role: 'evidence', kind: 'evidence' },
  ]);
});

test('source-only selection pulls the transitive chain across all record types', () => {
  const entries = [
    source('pln_all_src'), claim('pln_all_clm'), evidence('pln_all_evd', 'pln_all_src'),
    assessment('pln_all_asm', 'pln_all_clm', 'pln_all_evd'),
    relation('pln_all_rel', 'pln_all_clm', 'pln_all_clm2'), claim('pln_all_clm2'),
    review('pln_all_rev', 'pln_all_asm'), verification('pln_all_ver', 'pln_all_evd', 'pln_all_src'),
  ];
  const plan = planPurge(snapshot(entries), ['pln_all_src']);
  assert.equal(plan.status, 'refused');
  assert.deepEqual(plan.proposed_scope, [
    'pln_all_asm', 'pln_all_evd', 'pln_all_rev', 'pln_all_src', 'pln_all_ver',
  ]);
  assert.ok(!plan.proposed_scope.includes('pln_all_rel'));
});

test('closure traverses already-redacted events via their retained links', () => {
  const entries = [
    source('pln_red_src'), evidence('pln_red_evd', 'pln_red_src'),
    tombstoned('pln_red_rev', 'review', { target_id: 'pln_red_evd' }),
    review('pln_red_rev2', 'pln_red_evd'),
  ];
  const plan = planPurge(snapshot(entries), ['pln_red_src']);
  assert.equal(plan.status, 'refused');
  assert.deepEqual(plan.proposed_scope, ['pln_red_evd', 'pln_red_rev', 'pln_red_rev2', 'pln_red_src']);
});

test('unknown kinds fail closed until a resolver handles the variant', () => {
  const memo = entry('pln_var_memo', 'memo', { about_id: 'pln_var_clm' });
  const base = snapshot([claim('pln_var_clm'), memo]);
  // Fail-closed: the canonical resolver knows no memo edges, so the closure
  // may miss dependents — the plan halts incomplete, never ready.
  const canonical = planPurge(base, ['pln_var_clm']);
  assert.equal(canonical.status, 'incomplete');
  assert.equal(canonical.closure_complete, false);
  assert.equal(canonical.truncated, true);
  assert.deepEqual(canonical.unresolved_ids, ['pln_var_memo']);
  assert.equal(canonical.unresolved_ids_total, 1);
  assert.deepEqual(canonical.scope, []);
  assert.deepEqual(canonical.proposed_scope, []);
  assert.equal(canonical.expected, null);
  assert.equal(verifyPlanDigest(canonical), true);
  const variant = {
    references: e => e.type === 'memo'
      ? [{ id: e.data.about_id, role: 'about', kind: 'claim' }]
      : canonicalReferences(e),
  };
  const withVariant = planPurge(base, ['pln_var_clm'], variant);
  assert.equal(withVariant.status, 'refused');
  assert.deepEqual(withVariant.proposed_scope, ['pln_var_clm', 'pln_var_memo']);
  assert.deepEqual(withVariant.unresolved_ids, []);
  // A resolver that explicitly declines the kind halts the same way.
  const declining = planPurge(base, ['pln_var_clm'], {
    references: e => {
      if (e.type === 'memo') throw new LedgerError('UNKNOWN_KIND', 'no memo table');
      return canonicalReferences(e);
    },
  });
  assert.equal(declining.status, 'incomplete');
  assert.deepEqual(declining.unresolved_ids, ['pln_var_memo']);
  // Redact halts on unresolvable kinds too.
  const redacted = planRedact(base, ['pln_var_clm'], { reason: 'sensitive', redactedAt });
  assert.equal(redacted.status, 'incomplete');
  assert.deepEqual(redacted.unresolved_ids, ['pln_var_memo']);
});

test('no-op selection plans nothing; unknown IDs refuse and are named', () => {
  const src_ = snapshot([claim('pln_noop_clm')]);
  const noop = planPurge(src_, []);
  assert.equal(noop.status, 'ready');
  assert.deepEqual(noop.scope, []);
  assert.deepEqual(noop.proposed_scope, []);
  assert.equal(noop.counts.closure, 0);
  const unknown = planPurge(src_, ['pln_noop_clm', 'pln_missing']);
  assert.equal(unknown.status, 'refused');
  assert.equal(unknown.refusal, 'unknown-ids');
  assert.deepEqual(unknown.unknown_ids, ['pln_missing']);
  assert.equal(unknown.scope.length, 0);
});

test('partial receipts remove the receipt, not the surviving records', () => {
  const dir = new URL('./fixtures/tombstone/', import.meta.url);
  const { vectors } = JSON.parse(readFileSync(new URL('request-digests.json', dir), 'utf8'));
  const [{ request_id, digest }] = vectors;
  const src_ = snapshot(
    [claim('pln_rcpt_doomed'), claim('pln_rcpt_keep')],
    [receipt(request_id, ['pln_rcpt_doomed', 'pln_rcpt_keep'])],
  );
  const plan = planPurge(src_, ['pln_rcpt_doomed']);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.affected_receipts.length, 1);
  const [aff] = plan.affected_receipts;
  assert.equal(aff.request_id, request_id);
  assert.equal(aff.blocked_digest, digest);
  assert.equal(aff.blocked_digest_provisional, true);
  assert.equal(aff.disposition, 'remove-receipt');
  assert.deepEqual(aff.removed_ids, ['pln_rcpt_doomed']);
  assert.deepEqual(aff.surviving_ids, ['pln_rcpt_keep']);
  assert.equal(plan.counts.surviving_records_in_removed_receipts, 1);
});

test('bounded output never succeeds on a partially computed closure', () => {
  const entries = [claim('pln_bnd_root')];
  for (let i = 0; i < 20; i++) entries.push(review(`pln_bnd_rev_${String(i).padStart(2, '0')}`, 'pln_bnd_root'));
  const src_ = snapshot(entries);
  const cut = planPurge(src_, ['pln_bnd_root'], { limits: { maxClosure: 5 } });
  assert.equal(cut.status, 'incomplete');
  assert.equal(cut.closure_complete, false);
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.scope, []);
  assert.deepEqual(cut.proposed_scope, []);
  const reasons = planPurge(src_, ['pln_bnd_root'], { limits: { maxReasons: 3 } });
  assert.equal(reasons.status, 'incomplete');
  assert.equal(reasons.survivors.length, 3);
  assert.equal(reasons.survivors_total, 20);
});

test('redact computes tombstoned bodies preserving IDs and the exact reference set', () => {
  const live = [
    source('pln_tmb_src'), claim('pln_tmb_clm'), evidence('pln_tmb_evd', 'pln_tmb_src'),
    assessment('pln_tmb_asm', 'pln_tmb_clm', 'pln_tmb_evd'),
    relation('pln_tmb_rel', 'pln_tmb_clm', 'pln_tmb_clm2'), claim('pln_tmb_clm2'),
    review('pln_tmb_rev', 'pln_tmb_clm'), verification('pln_tmb_ver', 'pln_tmb_evd', 'pln_tmb_src'),
  ];
  const ids = live.map(e => e.id);
  const plan = planRedact(snapshot(live), ids, { reason: 'sensitive', redactedAt });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.scope, [...ids].sort());
  assert.equal(plan.tombstones.length, 7 + 1);
  const expectedKeys = {
    source: ['reason', 'redacted', 'redacted_at'],
    claim: ['reason', 'redacted', 'redacted_at'],
    evidence: ['reason', 'redacted', 'redacted_at', 'source_id'],
    assessment: ['claim_id', 'evidence_id', 'reason', 'redacted', 'redacted_at'],
    relation: ['from_claim_id', 'reason', 'redacted', 'redacted_at', 'to_claim_id'],
    review: ['reason', 'redacted', 'redacted_at', 'target_id'],
    verification: ['reason', 'redacted', 'redacted_at', 'target_evidence_id', 'target_source_id'],
  };
  const byId = new Map(live.map(e => [e.id, e]));
  for (const t of plan.tombstones) {
    const original = byId.get(t.id);
    assert.equal(t.type, original.type);
    assert.deepEqual(Object.keys(t.body).sort(), expectedKeys[t.type].slice().sort());
    assert.equal(t.body.reason, 'sensitive');
    assert.equal(t.body.redacted_at, redactedAt);
    assert.deepEqual(t.references, references(original));
    assert.deepEqual(references({ id: t.id, type: t.type, data: t.body }), references(original));
  }
  assert.deepEqual(plan.affected_receipts, []);
  assert.equal(plan.scope_note, REDACT_SCOPE_NOTE);
});

test('redact refuses an evidence-only scope until verifications join it', () => {
  const entries = [source('pln_cas_src'), evidence('pln_cas_evd', 'pln_cas_src'),
    verification('pln_cas_ver', 'pln_cas_evd', 'pln_cas_src')];
  const src_ = snapshot(entries);
  const refused = planRedact(src_, ['pln_cas_evd'], { reason: 'sensitive', redactedAt });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.refusal, 'verification-cascade');
  assert.deepEqual(refused.cascade_required, ['pln_cas_ver']);
  assert.equal(refused.scope.length, 0);
  const joint = planRedact(src_, ['pln_cas_evd', 'pln_cas_ver'], { reason: 'sensitive', redactedAt });
  assert.equal(joint.status, 'ready');
  assert.deepEqual(joint.scope, ['pln_cas_evd', 'pln_cas_ver']);
});

test('redact reports degraded dependents and event state impact without claiming content deletion', () => {
  const entries = [
    source('pln_deg_src'), claim('pln_deg_clm'), evidence('pln_deg_evd', 'pln_deg_src'),
    assessment('pln_deg_asm', 'pln_deg_clm', 'pln_deg_evd'),
    review('pln_deg_rev', 'pln_deg_clm'),
  ];
  const plan = planRedact(snapshot(entries), ['pln_deg_clm', 'pln_deg_rev'],
    { reason: 'wrong-scope', redactedAt });
  assert.equal(plan.status, 'ready');
  const degraded = new Map(plan.degraded.map(d => [d.id, d]));
  assert.equal(degraded.get('pln_deg_asm').impact, 'grounds-degraded');
  assert.ok(degraded.has('pln_deg_rev') === false);
  assert.deepEqual(plan.state_impact, [{
    target: 'pln_deg_clm', event: 'pln_deg_rev', event_type: 'review',
    before: 'accepted', after: 'proposed',
  }]);
  assert.equal(plan.state_impact_total, 1);
  assert.match(plan.scope_note, /not content discovery/);
});

test('redact refuses already-tombstoned and unknown IDs explicitly', () => {
  const src_ = snapshot([claim('pln_tmb_live'), tombstoned('pln_tmb_old', 'claim', {})]);
  const again = planRedact(src_, ['pln_tmb_old'], { reason: 'sensitive', redactedAt });
  assert.equal(again.status, 'refused');
  assert.equal(again.refusal, 'already-tombstoned');
  assert.deepEqual(again.already_tombstoned, ['pln_tmb_old']);
  const unknown = planRedact(src_, ['pln_tmb_live', 'pln_nowhere'], { reason: 'sensitive', redactedAt });
  assert.equal(unknown.status, 'refused');
  assert.equal(unknown.refusal, 'unknown-ids');
  assert.throws(() => planRedact(src_, ['pln_tmb_live'], { reason: 'typo', redactedAt }),
    e => e instanceof LedgerError && e.code === 'VALIDATION');
  assert.throws(() => planRedact(src_, ['pln_tmb_live'], { reason: 'sensitive', redactedAt: 'not-a-time' }),
    e => e instanceof LedgerError && e.code === 'VALIDATION');
});

test('a plan carries its revision; concurrent appends read as stale input', () => {
  const src_ = snapshot([claim('pln_rev_clm')], [], 11);
  const plan = planPurge(src_, ['pln_rev_clm']);
  assert.equal(plan.revision, 11);
  assert.equal(isPlanStale(plan, src_), false);
  assert.equal(isPlanStale(plan, 11), false);
  assert.equal(isPlanStale(plan, { ...src_, revision: 12 }), true);
  assert.equal(isPlanStale(plan, 12), true);
});

test('planning never mutates the source snapshot', () => {
  const src_ = snapshot(
    [source('pln_mut_src'), evidence('pln_mut_evd', 'pln_mut_src')],
    [receipt('req_mut_demo', ['pln_mut_src', 'pln_mut_evd'])],
    3,
  );
  const before = JSON.parse(JSON.stringify(src_));
  planPurge(src_, ['pln_mut_src']);
  planRedact(src_, ['pln_mut_src'], { reason: 'sensitive', redactedAt });
  assert.deepEqual(src_, before);
});

test('redact drops receipts referencing redacted records, keeping mixed-receipt survivors live', () => {
  const src_ = snapshot(
    [claim('pln_rdr_doomed'), claim('pln_rdr_keep')],
    [receipt('req_rdr_mixed', ['pln_rdr_doomed', 'pln_rdr_keep']), receipt('req_rdr_only', ['pln_rdr_doomed'])],
  );
  const plan = planRedact(src_, ['pln_rdr_doomed'], { reason: 'sensitive', redactedAt });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.affected_receipts.length, 2);
  assert.equal(plan.affected_receipts_total, 2);
  const byReq = new Map(plan.affected_receipts.map(r => [r.request_id, r]));
  assert.deepEqual(byReq.get('req_rdr_mixed').removed_ids, ['pln_rdr_doomed']);
  assert.deepEqual(byReq.get('req_rdr_mixed').surviving_ids, ['pln_rdr_keep']);
  assert.deepEqual(byReq.get('req_rdr_only').surviving_ids, []);
  for (const aff of plan.affected_receipts) {
    assert.equal(aff.disposition, 'drop-receipt');
    assert.ok(!('blocked_digest' in aff), 'redact predicts no registry block');
  }
  assert.equal(plan.counts.removed_receipts, 2);
  assert.equal(plan.counts.surviving_records_in_removed_receipts, 1);
  assert.deepEqual(plan.expected.dropped_receipts, ['req_rdr_mixed', 'req_rdr_only']);
  assert.deepEqual(plan.expected.scope_ids, ['pln_rdr_doomed']);
});

test('redact cascade scope drops the receipts of the required verifications too', () => {
  const entries = [source('pln_rdc_src'), evidence('pln_rdc_evd', 'pln_rdc_src'),
    verification('pln_rdc_ver', 'pln_rdc_evd', 'pln_rdc_src')];
  const src_ = snapshot(entries, [receipt('req_rdc_ver', ['pln_rdc_ver'])]);
  const refused = planRedact(src_, ['pln_rdc_evd'], { reason: 'sensitive', redactedAt });
  assert.equal(refused.status, 'refused');
  assert.deepEqual(refused.cascade_required, ['pln_rdc_ver']);
  assert.equal(refused.affected_receipts.length, 1);
  assert.equal(refused.affected_receipts[0].request_id, 'req_rdc_ver');
});

test('changed source at the same revision reads as stale', () => {
  const base = snapshot([claim('pln_stl_clm'), source('pln_stl_src')], [], 7);
  const plan = planPurge(base, ['pln_stl_clm']);
  assert.equal(isPlanStale(plan, base), false);
  assert.equal(isPlanStale(plan, JSON.parse(JSON.stringify(base))), false);
  // Same revision, edited body.
  const edited = snapshot(
    [entry('pln_stl_clm', 'claim', { text: 'synthetic edited', kind: 'assertion', attributed_to: 'synthetic' }),
      source('pln_stl_src')], [], 7);
  assert.equal(isPlanStale(plan, edited), true);
  // Same revision, concurrent append.
  const appended = snapshot([...base.entries, claim('pln_stl_new')], [], 7);
  assert.equal(isPlanStale(plan, appended), true);
  // Same revision, registry changed.
  const reged = snapshot(base.entries, [], 7);
  const regPlan = planPurge({ ...reged, registry: ['d'.repeat(64)] }, ['pln_stl_clm']);
  assert.equal(isPlanStale(regPlan, { ...reged, registry: ['d'.repeat(64)] }), false);
  assert.equal(isPlanStale(regPlan, { ...reged, registry: ['e'.repeat(64)] }), true);
  assert.equal(isPlanStale(regPlan, reged), true);
  // Same revision, different source identity or schema.
  const idPlan = planPurge({ ...base, source_id: 'ledger-a', schema_version: 2 }, ['pln_stl_clm']);
  assert.equal(isPlanStale(idPlan, { ...base, source_id: 'ledger-a', schema_version: 2 }), false);
  assert.equal(isPlanStale(idPlan, { ...base, source_id: 'ledger-b', schema_version: 2 }), true);
  assert.equal(isPlanStale(idPlan, { ...base, source_id: 'ledger-a', schema_version: 3 }), true);
  assert.equal(isPlanStale(idPlan, base), true);
  // Revision movement still reads as stale, with or without the source.
  assert.equal(isPlanStale(plan, { ...base, revision: 8 }), true);
  assert.equal(isPlanStale(plan, 8), true);
  assert.equal(isPlanStale(plan, 7), false);
});

test('plan digests bind source, selection, mode, and confirmation parameters', () => {
  const src_ = snapshot([claim('pln_dig_a'), claim('pln_dig_b')], [receipt('req_dig', ['pln_dig_a'])]);
  const opts = { reason: 'sensitive', redactedAt };
  const a = planRedact(src_, ['pln_dig_a'], opts);
  const b = planRedact(src_, ['pln_dig_a'], opts);
  assert.equal(a.digest, b.digest);
  assert.equal(a.source_fingerprint, sourceFingerprint(src_));
  assert.equal(verifyPlanDigest(a), true);
  assert.match(a.digest, /^[a-f0-9]{64}$/);
  // Every confirmation-relevant input moves the digest.
  assert.notEqual(planRedact(src_, ['pln_dig_b'], opts).digest, a.digest);
  assert.notEqual(planRedact(src_, ['pln_dig_a'], { reason: 'wrong-scope', redactedAt }).digest, a.digest);
  assert.notEqual(
    planRedact(src_, ['pln_dig_a'], { reason: 'sensitive', redactedAt: '2026-09-29T00:00:00.000Z' }).digest, a.digest);
  assert.notEqual(planRedact(src_, ['pln_dig_a'], { ...opts, limits: { maxReasons: 5 } }).digest, a.digest);
  assert.notEqual(planPurge(src_, ['pln_dig_a']).digest, a.digest);
  assert.notEqual(planRedact(snapshot([...src_.entries, claim('pln_dig_c')]), ['pln_dig_a'], opts).digest, a.digest);
  // A tampered artifact fails verification instead of executing.
  for (const tamper of [
    p => ({ ...p, scope: [] }),
    p => ({ ...p, selection: ['pln_dig_b'] }),
    p => ({ ...p, affected_receipts: [] }),
    p => ({ ...p, digest: '0'.repeat(64) }),
  ]) {
    assert.equal(verifyPlanDigest(tamper(JSON.parse(JSON.stringify(a)))), false);
  }
  assert.equal(verifyPlanDigest(null), false);
});

test('purge expected results name the exact post-purge outcome', () => {
  const src_ = snapshot(
    [source('pln_exp_src'), evidence('pln_exp_evd', 'pln_exp_src'), claim('pln_exp_keep')],
    [receipt('req_exp_doom', ['pln_exp_src', 'pln_exp_evd']), receipt('req_exp_keep', ['pln_exp_keep'])],
  );
  const plan = planPurge(src_, ['pln_exp_src', 'pln_exp_evd']);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.expected.scope_ids, ['pln_exp_evd', 'pln_exp_src']);
  assert.deepEqual(plan.expected.removed_receipts, ['req_exp_doom']);
  const wantDigest = createHash('sha256').update('req_exp_doom', 'utf8').digest('hex');
  assert.deepEqual(plan.expected.blocked_digests, [wantDigest]);
  assert.equal(plan.expected.live_count, 1);
  assert.equal(plan.expected.live_ids_digest,
    createHash('sha256').update(canonicalJson(['pln_exp_keep']), 'utf8').digest('hex'));
});

test('redact expected results pin the tombstoned bodies and surviving IDs', () => {
  const src_ = snapshot([claim('pln_rex_clm'), claim('pln_rex_keep')]);
  const plan = planRedact(src_, ['pln_rex_clm'], { reason: 'wrong-scope', redactedAt });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.expected.scope_ids, ['pln_rex_clm']);
  const bodies = [['pln_rex_clm', { redacted: true, reason: 'wrong-scope', redacted_at: redactedAt }]];
  assert.equal(plan.expected.tombstones_digest,
    createHash('sha256').update(canonicalJson(bodies), 'utf8').digest('hex'));
  assert.equal(plan.expected.live_count, 2);
  assert.equal(plan.expected.live_ids_digest,
    createHash('sha256').update(canonicalJson(['pln_rex_clm', 'pln_rex_keep']), 'utf8').digest('hex'));
});

test('state transitions report exact before/after review and anchor states', () => {
  const first = review('pln_trn_rev1', 'pln_trn_clm', 'accepted');
  const latest = review('pln_trn_rev2', 'pln_trn_clm', 'rejected');
  const src_ = snapshot([claim('pln_trn_clm'), first, latest]);
  // Redacting the latest review falls back to the earlier verdict.
  const redacted = planRedact(src_, ['pln_trn_rev2'], { reason: 'sensitive', redactedAt });
  assert.equal(redacted.status, 'ready');
  assert.deepEqual(redacted.state_impact, [{
    target: 'pln_trn_clm', event: 'pln_trn_rev2', event_type: 'review',
    before: 'rejected', after: 'accepted',
  }]);
  // Purging the latest review while its target survives transitions the same way.
  const purged = planPurge(src_, ['pln_trn_rev2']);
  assert.equal(purged.status, 'ready');
  assert.deepEqual(purged.state_transitions, [{
    target: 'pln_trn_clm', event: 'pln_trn_rev2', event_type: 'review',
    before: 'rejected', after: 'accepted',
  }]);
  // Purging the target alongside its reviews leaves no surviving transition.
  const full = planPurge(src_, ['pln_trn_clm', 'pln_trn_rev1', 'pln_trn_rev2']);
  assert.equal(full.status, 'ready');
  assert.deepEqual(full.state_transitions, []);
  // Redacting evidence plus its verification drops the anchor back to unverified.
  const anchored = snapshot([
    source('pln_trn_src'), evidence('pln_trn_evd', 'pln_trn_src'),
    verification('pln_trn_ver', 'pln_trn_evd', 'pln_trn_src'),
  ]);
  const joint = planRedact(anchored, ['pln_trn_evd', 'pln_trn_ver'], { reason: 'sensitive', redactedAt });
  assert.equal(joint.status, 'ready');
  assert.deepEqual(joint.state_impact, [{
    target: 'pln_trn_evd', event: 'pln_trn_ver', event_type: 'verification',
    before: 'anchor_match', after: 'anchor_not_verified',
  }]);
});

test('executor rejects stale sources and altered scopes instead of recomputing silently', () => {
  const live = snapshot([claim('pln_exe_clm')], [], 9);
  const approved = planPurge(live, ['pln_exe_clm']);
  assert.equal(approved.status, 'ready');
  const approvedDigest = approved.digest;
  const execute = (artifact, source) => {
    if (!verifyPlanApproval(artifact, approvedDigest)) return 'reject:altered-artifact';
    if (isPlanStale(artifact, source)) return 'reject:stale-source';
    const fresh = planPurge(source, approved.selection);
    if (fresh.digest !== approvedDigest) return 'reject:altered-scope';
    return 'execute';
  };
  assert.equal(execute(approved, live), 'execute');
  assert.equal(execute({ ...approved, scope: [] }, live), 'reject:altered-artifact');
  const appended = snapshot([...live.entries, review('pln_exe_rev', 'pln_exe_clm')], [], 9);
  assert.equal(execute(approved, appended), 'reject:stale-source');
  const moved = snapshot(live.entries, [], 10);
  assert.equal(execute(approved, moved), 'reject:stale-source');
});

test('many unknown IDs truncate honestly instead of reporting whole', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `pln_unk_${String(i).padStart(3, '0')}`);
  const src_ = snapshot([claim('pln_unk_keep')]);
  const tiny = { maxClosure: 1, maxReasons: 1, maxReceipts: 1, maxVia: 1 };
  const purged = planPurge(src_, ['pln_unk_keep', ...ids], { limits: tiny });
  assert.equal(purged.unknown_ids.length, 1);
  assert.equal(purged.unknown_ids_total, 100);
  assert.equal(purged.truncated, true);
  assert.equal(purged.status, 'incomplete');
  assert.deepEqual(purged.scope, []);
  const redacted = planRedact(src_, ids, { reason: 'sensitive', redactedAt, limits: tiny });
  assert.equal(redacted.unknown_ids.length, 1);
  assert.equal(redacted.unknown_ids_total, 100);
  assert.equal(redacted.truncated, true);
  assert.equal(redacted.status, 'incomplete');
});

test('redact cascade and state-impact lists truncate honestly with exact totals', () => {
  const entries = [source('pln_trc_src'), evidence('pln_trc_evd', 'pln_trc_src'),
    verification('pln_trc_v1', 'pln_trc_evd', 'pln_trc_src'),
    verification('pln_trc_v2', 'pln_trc_evd', 'pln_trc_src')];
  const cascade = planRedact(snapshot(entries), ['pln_trc_evd'],
    { reason: 'sensitive', redactedAt, limits: { maxReasons: 1 } });
  assert.deepEqual(cascade.cascade_required, ['pln_trc_v1']);
  assert.equal(cascade.cascade_required_total, 2);
  assert.equal(cascade.truncated, true);
  assert.equal(cascade.status, 'incomplete');
  const impacts = planRedact(
    snapshot([claim('pln_trc_c1'), claim('pln_trc_c2'),
      review('pln_trc_r1', 'pln_trc_c1'), review('pln_trc_r2', 'pln_trc_c2')]),
    ['pln_trc_r1', 'pln_trc_r2'],
    { reason: 'sensitive', redactedAt, limits: { maxReasons: 1 } });
  assert.equal(impacts.state_impact.length, 1);
  assert.equal(impacts.state_impact_total, 2);
  assert.equal(impacts.truncated, true);
  assert.equal(impacts.status, 'incomplete');
});

test('truncated receipt detail keeps exact survivor counts and drops the expectation', () => {
  const src_ = snapshot(
    [claim('pln_sur_d1'), claim('pln_sur_d2'), claim('pln_sur_k1'), claim('pln_sur_k2')],
    [receipt('req_sur_1', ['pln_sur_d1', 'pln_sur_k1']), receipt('req_sur_2', ['pln_sur_d2', 'pln_sur_k2'])],
  );
  const cut = planPurge(src_, ['pln_sur_d1', 'pln_sur_d2'], { limits: { maxReceipts: 1 } });
  assert.equal(cut.status, 'incomplete');
  assert.equal(cut.affected_receipts.length, 1);
  assert.equal(cut.affected_receipts_total, 2);
  assert.equal(cut.counts.removed_receipts, 2);
  assert.equal(cut.counts.surviving_records_in_removed_receipts, 2);
  assert.equal(cut.expected, null);
  const whole = planPurge(src_, ['pln_sur_d1', 'pln_sur_d2']);
  assert.equal(whole.status, 'ready');
  assert.equal(whole.counts.surviving_records_in_removed_receipts, 2);
  assert.deepEqual(whole.expected.removed_receipts, ['req_sur_1', 'req_sur_2']);
});

test('ready requires source identity and schema; unbound plans halt incomplete', () => {
  const bare = { revision: 7, entries: [claim('pln_rdy_clm')], receipts: [] };
  const purged = planPurge(bare, ['pln_rdy_clm']);
  assert.equal(purged.status, 'incomplete');
  assert.equal(purged.truncated, true);
  assert.deepEqual(purged.scope, []);
  assert.equal(purged.expected, null);
  assert.equal(verifyPlanDigest(purged), true);
  const redacted = planRedact(bare, ['pln_rdy_clm'], { reason: 'sensitive', redactedAt });
  assert.equal(redacted.status, 'incomplete');
  assert.equal(redacted.truncated, true);
  assert.equal(redacted.expected, null);
  // Half-bound still halts: both identity and schema are required.
  assert.equal(planPurge({ ...bare, source_id: 'synthetic-ledger' }, ['pln_rdy_clm']).status, 'incomplete');
  assert.equal(planPurge({ ...bare, schema_version: 2 }, ['pln_rdy_clm']).status, 'incomplete');
  assert.equal(planRedact({ ...bare, source_id: 'synthetic-ledger' }, ['pln_rdy_clm'],
    { reason: 'sensitive', redactedAt }).status, 'incomplete');
  // Fully bound is ready with an expectation.
  const bound = planPurge({ ...bare, source_id: 'synthetic-ledger', schema_version: 2 }, ['pln_rdy_clm']);
  assert.equal(bound.status, 'ready');
  assert.notEqual(bound.expected, null);
  // Refusals keep their refusal without binding: they are already
  // unexecutable forecasts, not approvals.
  const refused = planPurge(bare, ['pln_rdy_clm', 'pln_missing']);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.refusal, 'unknown-ids');
});

test('receipt membership order and registry version bind the source fingerprint', () => {
  const base = snapshot([claim('pln_fp_a'), claim('pln_fp_b')], [receipt('req_fp', ['pln_fp_a', 'pln_fp_b'])]);
  const plan = planPurge(base, ['pln_fp_a', 'pln_fp_b']);
  assert.equal(plan.status, 'ready');
  // Same revision, reordered receipt membership reads as stale: capture
  // preserves bundle order and inspectCapture pages in it.
  const reordered = snapshot(base.entries, [receipt('req_fp', ['pln_fp_b', 'pln_fp_a'])]);
  assert.notEqual(sourceFingerprint(reordered), plan.source_fingerprint);
  assert.equal(isPlanStale(plan, reordered), true);
  assert.equal(isPlanStale(plan, base), false);
  // Registry version binds alongside the digest set.
  const reg = { ...snapshot([claim('pln_fp_c')]), registry: ['d'.repeat(64)], registry_version: 1 };
  const regPlan = planPurge(reg, ['pln_fp_c']);
  assert.equal(regPlan.status, 'ready');
  assert.equal(isPlanStale(regPlan, { ...reg }), false);
  assert.equal(isPlanStale(regPlan, { ...reg, registry_version: 2 }), true);
  const unversioned = { ...reg };
  delete unversioned.registry_version;
  assert.equal(isPlanStale(regPlan, unversioned), true);
  assert.throws(() => planPurge({ ...reg, registry_version: -1 }, ['pln_fp_c']),
    e => e instanceof LedgerError && e.code === 'VALIDATION');
});

test('execution compares against the retained approval digest, not the artifact itself', () => {
  const live = snapshot([claim('pln_app_a'), claim('pln_app_b')]);
  const approved = planPurge(live, ['pln_app_a']);
  assert.equal(approved.status, 'ready');
  // The executor retains the approval out-of-band: the digest plus the
  // parameters a re-plan for comparison must reuse.
  const approvedDigest = approved.digest;
  const approvedSelection = [...approved.selection];
  const approvedLimits = approved.limits;
  const execute = (artifact, source) => {
    if (!verifyPlanApproval(artifact, approvedDigest)) return 'reject:unapproved-or-altered';
    if (isPlanStale(artifact, source)) return 'reject:stale-source';
    const fresh = planPurge(source, approvedSelection, { limits: approvedLimits });
    if (fresh.digest !== approvedDigest) return 'reject:altered-scope';
    return 'execute';
  };
  assert.equal(execute(approved, live), 'execute');
  // Substitution: a fresh self-consistent plan for a different selection
  // verifies against itself, reads fresh, and re-plans to itself — a
  // self-comparison gate would execute it.
  const substituted = planPurge(live, ['pln_app_b']);
  assert.equal(verifyPlanDigest(substituted), true);
  assert.equal(isPlanStale(substituted, live), false);
  assert.equal(planPurge(live, substituted.selection).digest, substituted.digest);
  assert.equal(execute(substituted, live), 'reject:unapproved-or-altered');
  assert.equal(verifyPlanApproval(substituted, approvedDigest), false);
  // Tampering with the approved artifact fails the same gate.
  assert.equal(execute({ ...approved, scope: [] }, live), 'reject:unapproved-or-altered');
  assert.equal(verifyPlanApproval(approved, '0'.repeat(64)), false);
  assert.equal(verifyPlanApproval(approved, 'not-a-digest'), false);
  assert.equal(verifyPlanApproval(null, approvedDigest), false);
});

test('purge expectations pin survivor content and receipts, not just IDs', () => {
  const src_ = snapshot(
    [source('pln_con_src'), evidence('pln_con_evd', 'pln_con_src'),
      claim('pln_con_keep1'), claim('pln_con_keep2')],
    [receipt('req_con_doom', ['pln_con_src', 'pln_con_evd']),
      receipt('req_con_keep', ['pln_con_keep1', 'pln_con_keep2'])],
  );
  const plan = planPurge(src_, ['pln_con_src', 'pln_con_evd']);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.expected.blocked_digests_provisional, true);
  // Exact preimages: surviving entries in source array order, surviving
  // receipts sorted by request_id.
  assert.equal(plan.expected.live_entries_digest,
    createHash('sha256').update(canonicalJson([claim('pln_con_keep1'), claim('pln_con_keep2')]), 'utf8').digest('hex'));
  assert.equal(plan.expected.live_receipts_digest,
    createHash('sha256').update(canonicalJson([
      { digest: 'c'.repeat(64), ids: ['pln_con_keep1', 'pln_con_keep2'], request_id: 'req_con_keep' },
    ]), 'utf8').digest('hex'));
  // Same IDs, edited survivor body: the ID digest stands still while the
  // content digest moves.
  const editedEntries = src_.entries.map(e => (e.id === 'pln_con_keep1'
    ? entry('pln_con_keep1', 'claim', { text: 'synthetic edited', kind: 'assertion', attributed_to: 'synthetic' })
    : e));
  const edited = planPurge({ ...src_, entries: editedEntries }, ['pln_con_src', 'pln_con_evd']);
  assert.equal(edited.status, 'ready');
  assert.equal(edited.expected.live_ids_digest, plan.expected.live_ids_digest);
  assert.notEqual(edited.expected.live_entries_digest, plan.expected.live_entries_digest);
  // Same ID set, reordered surviving-receipt membership moves the receipts digest.
  const reordered = snapshot(src_.entries,
    [receipt('req_con_doom', ['pln_con_src', 'pln_con_evd']),
      receipt('req_con_keep', ['pln_con_keep2', 'pln_con_keep1'])]);
  const moved = planPurge(reordered, ['pln_con_src', 'pln_con_evd']);
  assert.equal(moved.expected.live_ids_digest, plan.expected.live_ids_digest);
  assert.notEqual(moved.expected.live_receipts_digest, plan.expected.live_receipts_digest);
});

test('redact expectations pin untouched bodies and surviving receipts', () => {
  const src_ = snapshot([claim('pln_rcn_doom'), claim('pln_rcn_keep')],
    [receipt('req_rcn_doom', ['pln_rcn_doom']), receipt('req_rcn_keep', ['pln_rcn_keep'])]);
  const plan = planRedact(src_, ['pln_rcn_doom'], { reason: 'sensitive', redactedAt });
  assert.equal(plan.status, 'ready');
  // Exact preimage: the scope entry tombstoned in place, untouched entries
  // byte-identical, in source array order.
  const tombstonedDoom = { id: 'pln_rcn_doom', type: 'claim',
    data: { redacted: true, reason: 'sensitive', redacted_at: redactedAt }, created_at: at, actor };
  assert.equal(plan.expected.live_entries_digest,
    createHash('sha256').update(canonicalJson([tombstonedDoom, claim('pln_rcn_keep')]), 'utf8').digest('hex'));
  assert.equal(plan.expected.live_receipts_digest,
    createHash('sha256').update(canonicalJson([
      { digest: 'c'.repeat(64), ids: ['pln_rcn_keep'], request_id: 'req_rcn_keep' },
    ]), 'utf8').digest('hex'));
  // Same IDs, edited untouched body: the tombstone and ID digests stand
  // still while the content digest moves.
  const editedEntries = src_.entries.map(e => (e.id === 'pln_rcn_keep'
    ? entry('pln_rcn_keep', 'claim', { text: 'synthetic edited', kind: 'assertion', attributed_to: 'synthetic' })
    : e));
  const edited = planRedact({ ...src_, entries: editedEntries }, ['pln_rcn_doom'],
    { reason: 'sensitive', redactedAt });
  assert.equal(edited.status, 'ready');
  assert.equal(edited.expected.tombstones_digest, plan.expected.tombstones_digest);
  assert.equal(edited.expected.live_ids_digest, plan.expected.live_ids_digest);
  assert.notEqual(edited.expected.live_entries_digest, plan.expected.live_entries_digest);
});

test('incomplete plans carry no expectation and stay bounded', () => {
  const entries = Array.from({ length: 30 }, (_, i) => claim(`pln_inc_${String(i).padStart(2, '0')}`));
  const src_ = snapshot(entries);
  const cut = planRedact(src_, entries.map(e => e.id),
    { reason: 'sensitive', redactedAt, limits: { maxClosure: 1 } });
  assert.equal(cut.status, 'incomplete');
  assert.equal(cut.closure_complete, false);
  assert.equal(cut.truncated, true);
  assert.equal(cut.expected, null);
  assert.deepEqual(cut.scope, []);
  assert.deepEqual(cut.tombstones, []);
  // Purge mirrors: incomplete through truncated reasons carries no
  // expectation even though the closure itself completed.
  const many = [claim('pln_inr_root')];
  for (let i = 0; i < 20; i++) many.push(review(`pln_inr_rev_${String(i).padStart(2, '0')}`, 'pln_inr_root'));
  const cutPurge = planPurge(snapshot(many), ['pln_inr_root'], { limits: { maxReasons: 3 } });
  assert.equal(cutPurge.status, 'incomplete');
  assert.equal(cutPurge.closure_complete, true);
  assert.equal(cutPurge.expected, null);
});

test('planner diagnostics never carry record IDs', () => {
  const src_ = snapshot([claim('pln_sdi_clm')]);
  const noId = id => e => {
    assert.ok(e instanceof LedgerError && e.code === 'VALIDATION');
    assert.ok(!String(e.message).includes(id), `diagnostic leaked a record ID: ${e.message}`);
    return true;
  };
  // A malformed resolver edge names the defect, not the entry.
  assert.throws(() => planPurge(src_, ['pln_sdi_clm'], {
    references: () => [{ id: '', role: 'about', kind: 'claim' }],
  }), noId('pln_sdi_clm'));
  // A malformed source entry names the defect class, not the record.
  const badState = entry('pln_sdi_rev', 'review',
    { target_id: 'pln_sdi_clm', state: 'rubbish', rationale: 'synthetic' });
  assert.throws(() => planPurge(snapshot([claim('pln_sdi_clm'), badState]), ['pln_sdi_rev']),
    noId('pln_sdi_rev'));
});

test('nonempty registry under a missing or unsupported version halts incomplete', () => {
  const base = snapshot([claim('pln_rgv_clm')]);
  const digests = ['d'.repeat(64)];
  const opts = { reason: 'sensitive', redactedAt };
  for (const src of [
    { ...base, registry: digests },
    { ...base, registry: digests, registry_version: 99 },
  ]) {
    const purged = planPurge(src, ['pln_rgv_clm']);
    assert.equal(purged.status, 'incomplete');
    assert.equal(purged.truncated, true);
    assert.deepEqual(purged.scope, []);
    assert.equal(purged.expected, null);
    assert.equal(verifyPlanDigest(purged), true);
    const redacted = planRedact(src, ['pln_rgv_clm'], opts);
    assert.equal(redacted.status, 'incomplete');
    assert.equal(redacted.truncated, true);
    assert.deepEqual(redacted.scope, []);
    assert.equal(redacted.expected, null);
    assert.equal(verifyPlanDigest(redacted), true);
  }
  // Controls: version 1 stays plannable, and an empty registry needs no version.
  const supported = { ...base, registry: digests, registry_version: 1 };
  assert.equal(planPurge(supported, ['pln_rgv_clm']).status, 'ready');
  assert.notEqual(planPurge(supported, ['pln_rgv_clm']).expected, null);
  assert.equal(planRedact(supported, ['pln_rgv_clm'], opts).status, 'ready');
  assert.equal(planPurge({ ...base, registry: [] }, ['pln_rgv_clm']).status, 'ready');
  assert.equal(planRedact({ ...base, registry: [] }, ['pln_rgv_clm'], opts).status, 'ready');
});

test('oversized selections echo bounded with the true total', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `pln_sele_${String(i).padStart(3, '0')}`);
  const src_ = snapshot([claim('pln_sele_keep')]);
  const tiny = { maxClosure: 1, maxReasons: 1, maxReceipts: 1, maxVia: 1 };
  const purged = planPurge(src_, ids, { limits: tiny });
  assert.equal(purged.status, 'incomplete');
  assert.equal(purged.truncated, true);
  assert.equal(purged.selection.length, 1);
  assert.equal(purged.counts.selected, 100);
  assert.equal(purged.expected, null);
  assert.equal(verifyPlanDigest(purged), true);
  const redacted = planRedact(src_, ids, { reason: 'sensitive', redactedAt, limits: tiny });
  assert.equal(redacted.status, 'incomplete');
  assert.equal(redacted.truncated, true);
  assert.equal(redacted.selection.length, 1);
  assert.equal(redacted.counts.selected, 100);
  assert.equal(redacted.expected, null);
  // Within bounds the echo stays whole: 100 unknown IDs under default
  // limits refuse (unknown-ids) with the full confirmation selection.
  const whole = planPurge(src_, ids);
  assert.equal(whole.status, 'refused');
  assert.equal(whole.refusal, 'unknown-ids');
  assert.equal(whole.selection.length, 100);
  assert.equal(whole.counts.selected, 100);
  const wholeRedact = planRedact(src_, ids, { reason: 'sensitive', redactedAt });
  assert.equal(wholeRedact.status, 'refused');
  assert.equal(wholeRedact.selection.length, 100);
});

test('explicit empty registry under an unsupported version halts incomplete', () => {
  const base = snapshot([claim('pln_rgx_clm')]);
  const src = { ...base, registry: [], registry_version: 99 };
  const opts = { reason: 'sensitive', redactedAt };
  const purged = planPurge(src, ['pln_rgx_clm']);
  assert.equal(purged.status, 'incomplete');
  assert.equal(purged.truncated, true);
  assert.deepEqual(purged.scope, []);
  assert.equal(purged.expected, null);
  assert.equal(verifyPlanDigest(purged), true);
  assert.equal(verifyPlanApproval(purged, purged.digest), false);
  const redacted = planRedact(src, ['pln_rgx_clm'], opts);
  assert.equal(redacted.status, 'incomplete');
  assert.equal(redacted.truncated, true);
  assert.deepEqual(redacted.scope, []);
  assert.equal(redacted.expected, null);
  assert.equal(verifyPlanDigest(redacted), true);
  assert.equal(verifyPlanApproval(redacted, redacted.digest), false);
  // Controls: an empty registry with no version or a supported version
  // stays plannable; only the explicit unsupported version refuses.
  assert.equal(planPurge({ ...base, registry: [] }, ['pln_rgx_clm']).status, 'ready');
  assert.equal(planPurge({ ...base, registry: [], registry_version: 1 }, ['pln_rgx_clm']).status, 'ready');
  assert.equal(planRedact({ ...base, registry: [] }, ['pln_rgx_clm'], opts).status, 'ready');
  assert.equal(planRedact({ ...base, registry: [], registry_version: 1 }, ['pln_rgx_clm'], opts).status, 'ready');
});

test('truncated selections bind the full array and never approve as whole', () => {
  const src_ = snapshot([claim('pln_sel_aa'), claim('pln_sel_yy'), claim('pln_sel_zz')]);
  const limits = { maxClosure: 1 };
  const selA = ['pln_sel_aa', 'pln_sel_zz'];
  const selB = ['pln_sel_aa', 'pln_sel_yy'];
  const digestOf = sel => createHash('sha256').update(canonicalJson(sel), 'utf8').digest('hex');
  // Purge pair: same echo, different omitted tail.
  const purgeA = planPurge(src_, selA, { limits });
  const purgeB = planPurge(src_, selB, { limits });
  for (const p of [purgeA, purgeB]) {
    assert.equal(p.status, 'incomplete');
    assert.equal(p.truncated, true);
    assert.deepEqual(p.selection, ['pln_sel_aa']);
    assert.equal(p.counts.selected, 2);
    assert.match(p.selection_digest, /^[a-f0-9]{64}$/);
    assert.equal(verifyPlanDigest(p), true);
    assert.equal(verifyPlanApproval(p, p.digest), false);
  }
  assert.equal(purgeA.selection_digest, digestOf(selA));
  assert.equal(purgeB.selection_digest, digestOf(selB));
  assert.notEqual(purgeA.selection_digest, purgeB.selection_digest);
  assert.notEqual(purgeA.digest, purgeB.digest);
  assert.equal(verifyPlanApproval(purgeA, purgeB.digest), false);
  assert.equal(verifyPlanApproval(purgeB, purgeA.digest), false);
  // Redact pair mirrors.
  const redactA = planRedact(src_, selA, { reason: 'sensitive', redactedAt, limits });
  const redactB = planRedact(src_, selB, { reason: 'sensitive', redactedAt, limits });
  for (const p of [redactA, redactB]) {
    assert.equal(p.status, 'incomplete');
    assert.equal(p.truncated, true);
    assert.deepEqual(p.selection, ['pln_sel_aa']);
    assert.equal(p.counts.selected, 2);
    assert.match(p.selection_digest, /^[a-f0-9]{64}$/);
    assert.equal(verifyPlanDigest(p), true);
    assert.equal(verifyPlanApproval(p, p.digest), false);
  }
  assert.equal(redactA.selection_digest, digestOf(selA));
  assert.equal(redactB.selection_digest, digestOf(selB));
  assert.notEqual(redactA.selection_digest, redactB.selection_digest);
  assert.notEqual(redactA.digest, redactB.digest);
  assert.equal(verifyPlanApproval(redactA, redactB.digest), false);
  assert.equal(verifyPlanApproval(redactB, redactA.digest), false);
  // Only ready plans are approvable: refusals fail the approval gate too.
  const refused = planPurge(src_, ['pln_sel_aa', 'pln_missing']);
  assert.equal(refused.status, 'refused');
  assert.equal(verifyPlanDigest(refused), true);
  assert.equal(verifyPlanApproval(refused, refused.digest), false);
});
