import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ledger, SqliteStore } from '../dist/index.js';
import { LedgerError, parseSnapshot, references } from '../dist/core/model.js';
import { classifySameId, exactEntryEquals, isLedgerId, outcomeFor } from '../dist/core/mergeIdentity.js';

// Synthetic conformance cases for issue #32 / ADR 0012. Fixture
// assertions plus read-path behavior pins on synthetic ledgers only:
// nothing here merges, plans, applies, migrates, or activates a
// merge policy. Every fixture below is synthetic.
//
// Test-local helpers (specEffectiveState, supersedesCycle, missingRefs,
// planStale, ...) are spec oracles restating ADR 0012 rules for the
// implementation issues; they are not shipped behavior.

const dir = new URL('./fixtures/merge-semantics/', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const code = expected => e => e instanceof LedgerError && e.code === expected;
const noTombstones = () => false;

/** ADR 0012 §1: naive latest-by-arrival — the trap an old foreign event sets. */
function naiveLatestState(arrival, targetId) {
  const seq = arrival.filter(e => e.type === 'review' && e.data.target_id === targetId);
  return seq.length ? seq[seq.length - 1].data.state : 'proposed';
}

/** ADR 0012 §1.1.3: imported events never advance effective state by arrival. */
function specEffectiveState(arrival, importedIds, targetId) {
  const seq = arrival.filter(e => e.type === 'review' && e.data.target_id === targetId && !importedIds.has(e.id));
  return seq.length ? seq[seq.length - 1].data.state : 'proposed';
}

/** ADR 0012 §2.1.4: anchor warnings derive from local verification history only. */
function specAnchorWarning(localVerifications, evidenceId) {
  const seq = localVerifications.filter(e => e.type === 'verification' && e.data.target_evidence_id === evidenceId);
  return seq.length ? `anchor_${seq[seq.length - 1].data.outcome}` : 'anchor_not_verified';
}

/** ADR 0012 §3.1.7c: tombstoned events contribute no effective state over G. */
function specEffectiveStateSkippingTombstones(arrival, importedIds, isTomb, targetId) {
  const seq = arrival.filter(e => e.type === 'review' && e.data.target_id === targetId
    && !importedIds.has(e.id) && !isTomb(e));
  return seq.length ? seq[seq.length - 1].data.state : 'proposed';
}
function specAnchorWarningSkippingTombstones(localVerifications, isTomb, evidenceId) {
  const seq = localVerifications.filter(e => e.type === 'verification'
    && e.data.target_evidence_id === evidenceId && !isTomb(e));
  return seq.length ? `anchor_${seq[seq.length - 1].data.outcome}` : 'anchor_not_verified';
}
/** ADR 0012 §3.1.7b: the cross-ledger tombstone backstop — a live
 *  verification targeting tombstoned evidence, whatever its ID. */
function tombstoneBackstopHit(entries) {
  const tombstoned = new Set(entries.filter(e => e.data?.redacted === true).map(e => e.id));
  return entries.filter(e => e.type === 'verification' && e.data?.redacted !== true
    && tombstoned.has(e.data.target_evidence_id)).map(e => e.id);
}
/** ADR 0012 §4.4/M12: pre-write refusal oracle — every refusing fixture
 *  maps to its kind before anything is written. */
function planRefusalKind(local, artifactEntries) {
  const combined = new Map([...local, ...artifactEntries].map(e => [e.id, e]));
  if (missingRefs(artifactEntries, new Set(combined.keys())).length) return 'merge.missing-dependency';
  if (supersedesCycle([...combined.values()])) return 'merge.supersedes-cycle';
  if (tombstoneBackstopHit([...combined.values()]).length) return 'merge.tombstone-conflict';
  return null;
}
/** Synthetic-ledger helpers for the M12–M15 behavior pins. */
const bundleActor = { kind: 'agent', id: 'synthetic-local-recorder', model: 'synthetic' };
const toInputs = entries => entries.map(({ id, type, data }) => ({ id, type, data }));
function setup(t) {
  const store = new SqliteStore(':memory:', true);
  t.after(() => store.close());
  return { store, ledger: new Ledger(store, () => '2026-09-27T00:00:00.000Z') };
}
function reviewOrder(entries) {
  const order = new Map();
  for (const e of entries) {
    if (e.type !== 'review') continue;
    order.set(e.data.target_id, [...(order.get(e.data.target_id) ?? []), e.id]);
  }
  return [...order.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** ADR 0012 §3.1.3: supersedes acyclicity over the combined graph. */
function supersedesCycle(entries) {
  const next = new Map();
  for (const e of entries) {
    if (e.type !== 'relation' || e.data.relation !== 'supersedes') continue;
    next.set(e.data.from_claim_id, [...(next.get(e.data.from_claim_id) ?? []), e.data.to_claim_id]);
  }
  for (const start of next.keys()) {
    const stack = [...(next.get(start) ?? [])], visited = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === start) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      stack.push(...(next.get(id) ?? []));
    }
  }
  return false;
}

/** ADR 0012 §3.1.1–§3.1.2: references of admitted entries resolving nowhere in G. */
function missingRefs(admitted, knownIds) {
  const missing = [];
  for (const input of admitted) {
    for (const ref of references(input)) {
      if (!knownIds.has(ref.id)) missing.push(ref.id);
    }
  }
  return [...new Set(missing)].sort();
}

/** ADR 0012 §4.4: plan binding re-check (raw-byte digest + planning fingerprint, inside the transaction). */
function planStale(plan, liveSourceDigest, liveTargetFingerprint) {
  return plan.source_digest !== liveSourceDigest || plan.target_fingerprint !== liveTargetFingerprint;
}
const sha256hex = bytes => createHash('sha256').update(bytes).digest('hex');

/** ADR 0012 §4.5: the stable merge detail-kind taxonomy. */
const MERGE_KINDS = new Set([
  'merge.missing-dependency', 'merge.supersedes-cycle', 'merge.remap-conflict',
  'merge.tombstone-conflict', 'merge.collision', 'merge.ambiguous-overlap',
  'merge.stale-plan', 'merge.truncated-plan', 'merge.limit-exceeded', 'merge.empty-selection',
]);

function deepKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach(v => deepKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); deepKeys(v, out); }
  }
  return out;
}

test('merge-semantics: old remote review never becomes newest by arrival (M3/M4)', () => {
  const { local, foreign_snapshot, adoption, expected, admission_mechanism } = load('old-remote-review.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  parseSnapshot(foreign_snapshot);
  const foreign = foreign_snapshot.entries;

  // The shared claim is history both sides agree on: it skips, never reinserts.
  const localClaim = local.find(e => e.id === 'clm_mrg_old');
  const foreignClaim = foreign.find(e => e.id === 'clm_mrg_old');
  assert.equal(exactEntryEquals(localClaim, foreignClaim), true);

  // Origin order vs arrival order diverge: the foreign rejected (T1) is OLDER
  // than the local accepted (T2) but arrives LAST.
  const localReview = local.find(e => e.id === 'rev_mrg_old_local');
  const foreignReview = foreign.find(e => e.id === 'rev_mrg_old_foreign');
  assert.ok(Date.parse(foreignReview.created_at) < Date.parse(localReview.created_at));
  assert.equal(localReview.data.state, 'accepted');
  assert.equal(foreignReview.data.state, 'rejected');

  const arrival = [...local, ...foreign];
  const importedIds = new Set(foreign.map(e => e.id));
  // The trap: naive latest-by-arrival flips to the old foreign rejection.
  assert.equal(naiveLatestState(arrival, 'clm_mrg_old'), 'rejected');
  // The rule: effective state ignores imported events until local adoption.
  assert.equal(specEffectiveState(arrival, importedIds, 'clm_mrg_old'), expected.effective_state_without_adoption);
  assert.equal(expected.effective_state_without_adoption, 'accepted');

  // Explicit adoption is a NEW local event with a local actor and a rationale
  // citing the foreign review — only it advances the state.
  parseSnapshot({ format: 'yurai.snapshot', version: 1,
    entries: [...local, ...adoption.entries], receipts: [] });
  const [adopt] = adoption.entries;
  assert.equal(adopt.actor.id, 'synthetic-local-recorder');
  assert.ok(adopt.data.rationale.includes('rev_mrg_old_foreign'));
  assert.equal(
    specEffectiveState([...arrival, ...adoption.entries], importedIds, 'clm_mrg_old'),
    expected.effective_state_after_local_adoption);
  assert.equal(expected.effective_state_after_local_adoption, 'rejected');

  // M4: the foreign match leaves the local anchor warning unchanged.
  const foreignVerification = foreign.find(e => e.id === 'vrf_mrg_old_foreign');
  assert.equal(foreignVerification.data.outcome, 'match');
  assert.equal(specAnchorWarning(local, 'evd_mrg_old'), expected.anchor_without_local_verify);
  assert.equal(expected.anchor_without_local_verify, 'anchor_not_verified');
  // M4 admission stays provisional like M3: until #31 box 3 supplies the
  // effect-free representation, the foreign verification itself refuses.
  assert.match(admission_mechanism, /PROVISIONAL P1/);
  assert.match(admission_mechanism, /Verification/);
  assert.match(admission_mechanism, /#31-final box 3/);
});

test('merge-semantics: the event gate covers targets with no local events (M3)', () => {
  const { local, foreign_snapshot, expected } = load('imported-event-no-local.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  parseSnapshot(foreign_snapshot);
  const foreign = foreign_snapshot.entries;
  // No local events at all on the target — yet arrival alone would flip it.
  assert.equal(local.filter(e => e.type === 'review' && e.data.target_id === 'clm_mrg_quiet').length, 0);
  const arrival = [...local, ...foreign];
  const importedIds = new Set(foreign.map(e => e.id));
  assert.equal(naiveLatestState(arrival, 'clm_mrg_quiet'), expected.naive_latest_by_arrival);
  assert.equal(expected.naive_latest_by_arrival, 'accepted');
  assert.equal(specEffectiveState(arrival, importedIds, 'clm_mrg_quiet'), expected.spec_effective_without_admission);
  assert.equal(expected.spec_effective_without_admission, 'proposed');
  assert.equal(expected.refusal_until_p1, 'merge.ambiguous-overlap');
  assert.ok(MERGE_KINDS.has(expected.refusal_until_p1));
  assert.equal(expected.written, 0);
});

test('merge-semantics: imported testimony arrives byte-identical, importer unstamped (M2)', () => {
  const { foreign_snapshot, expected } = load('preserved-testimony.json');
  const snapshot = parseSnapshot(foreign_snapshot);
  assert.equal(snapshot.entries.length, 5);
  for (const field of expected.byte_identical_fields) {
    const holders = snapshot.entries.filter(e =>
      Object.hasOwn(e.data, field) || Object.hasOwn(e, field));
    assert.ok(holders.length > 0, `no entry carries ${field}`);
  }
  const keys = deepKeys(snapshot.entries);
  for (const banned of expected.importer_stamp_keys_absent_from_entries) {
    assert.ok(!keys.includes(banned), `importer stamp leaked: ${banned}`);
  }
  // §2.1.1 exception: only reference-target fields rewrite, only under an
  // explicit approved remap; every other field stays byte-identical.
  assert.match(expected.remap_exception, /explicit approved remap/);
  // M13: the fixture carries an imported event with effective-state content
  // whose distinction must survive a post-merge export round-trip.
  const { round_trip } = expected;
  assert.deepEqual(round_trip.imported_event_ids, ['rev_mrg_txt_foreign']);
  const importedEvent = snapshot.entries.find(e => e.id === 'rev_mrg_txt_foreign');
  assert.equal(importedEvent.type, 'review');
  assert.equal(importedEvent.data.state, 'accepted');
  assert.match(round_trip.representation, /#31-final box 3/);
  assert.equal(round_trip.legacy_snapshots_restore_exactly_as_today, true);
  // M14/M15 fixture sanity: Japanese claim text plus a short ASCII term in
  // the evidence quote, with the full source→evidence→assessment→claim chain.
  const claim = snapshot.entries.find(e => e.id === 'clm_mrg_txt');
  assert.match(claim.data.text, /合成データ/);
  const evidence = snapshot.entries.find(e => e.id === 'evd_mrg_txt');
  assert.ok(evidence.data.quote.includes('AI'));
  const assessment = snapshot.entries.find(e => e.id === 'asm_mrg_txt');
  assert.equal(assessment.data.claim_id, 'clm_mrg_txt');
  assert.equal(assessment.data.evidence_id, 'evd_mrg_txt');
  assert.equal(evidence.data.source_id, 'src_mrg_txt');
});

test('merge-semantics: individually valid supersedes DAGs can cycle when combined (M5)', () => {
  const { local, foreign_snapshot, expected } = load('overlapping-corrections.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  parseSnapshot(foreign_snapshot);
  assert.equal(supersedesCycle(local), false);
  assert.equal(supersedesCycle(foreign_snapshot.entries), false);
  assert.equal(expected.each_side_acyclic, true);
  const combined = new Map();
  for (const e of [...local, ...foreign_snapshot.entries]) combined.set(e.id, e);
  assert.equal(supersedesCycle([...combined.values()]), true);
  assert.deepEqual(expected.cycle_members.sort(), ['clm_mrg_a', 'clm_mrg_b']);
  assert.equal(expected.kind, 'merge.supersedes-cycle');
  assert.ok(MERGE_KINDS.has(expected.kind));
  assert.equal(expected.written, 0);
});

test('merge-semantics: missing dependencies refuse whole with missing IDs named (M6)', () => {
  const { local, foreign_snapshot, expected } = load('missing-dependency.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  parseSnapshot(foreign_snapshot);
  const known = new Set([...local, ...foreign_snapshot.entries].map(e => e.id));
  assert.deepEqual(missingRefs(foreign_snapshot.entries, known), expected.missing);
  assert.deepEqual(expected.missing, ['evd_mrg_gone']);
  assert.equal(expected.kind, 'merge.missing-dependency');
  assert.ok(MERGE_KINDS.has(expected.kind));
  assert.equal(expected.written, 0);
});

test('merge-semantics: remap targets must not collide or leave the grammar (M7)', () => {
  const { local, foreign_snapshot, cases, expected } = load('remap-conflict.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  parseSnapshot(foreign_snapshot);
  const localIds = new Set(local.map(e => e.id));
  const foreignIds = new Set(foreign_snapshot.entries.map(e => e.id));
  const [collision, grammar] = cases;
  const [[fromId, toId]] = Object.entries(collision.proposed_remap);
  assert.ok(foreignIds.has(fromId));
  assert.ok(localIds.has(toId), 'remap target collides with a live local ID');
  const [[, badId]] = Object.entries(grammar.proposed_remap);
  assert.equal(isLedgerId(badId), grammar.grammar_valid);
  assert.equal(grammar.grammar_valid, false);
  assert.ok(isLedgerId(toId), 'the colliding target is grammatical: grammar alone would admit it');
  for (const never of expected.never) assert.ok(never.length > 0);
  assert.equal(expected.kind, 'merge.remap-conflict');
  assert.ok(MERGE_KINDS.has(expected.kind));
  assert.equal(expected.written, 0);
});

test('merge-semantics: inactive targets stay informational, closure still holds (M8)', () => {
  const { local, foreign_snapshot, expected } = load('inactive-target.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  parseSnapshot(foreign_snapshot);
  assert.equal(naiveLatestState(local, 'clm_mrg_retired'), 'withdrawn');
  const assessment = foreign_snapshot.entries.find(e => e.id === 'asm_mrg_on_retired');
  assert.equal(assessment.data.claim_id, 'clm_mrg_retired');
  const known = new Set([...local, ...foreign_snapshot.entries].map(e => e.id));
  assert.deepEqual(missingRefs(foreign_snapshot.entries, known), []);
  assert.equal(expected.allowed, true);
  assert.equal(expected.inactive_state_rides_every_view, true);
  assert.equal(expected.default_search_still_excludes_inactive, true);
});

test('merge-semantics: equal request strings never identify one operation (M9)', () => {
  const { local, local_receipt, foreign_snapshot, expected } = load('duplicate-request-ids.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  const foreign = parseSnapshot(foreign_snapshot);
  const [foreignReceipt] = foreign.receipts;
  assert.equal(foreignReceipt.request_id, local_receipt.request_id);
  assert.notEqual(foreignReceipt.digest, local_receipt.digest);
  assert.notDeepEqual([...foreignReceipt.ids].sort(), [...local_receipt.ids].sort());
  assert.equal(expected.same_operation, false);
  assert.equal(expected.install_foreign_receipt_as_local, false);
});

test('merge-semantics: local tombstone meets foreign body as a privacy-sensitive conflict (M10)', () => {
  const { local_tombstone, foreign_full, expected } = load('local-tombstone.json');
  // #23 owns the representation: invalid today, with an exact tombstone body
  // (envelope + marker, no content) and a recorded future defect.
  assert.throws(() => parseSnapshot({ format: 'yurai.snapshot', version: 1,
    entries: [local_tombstone], receipts: [] }), code('VALIDATION'));
  assert.deepEqual(Object.keys(local_tombstone.data).sort(), ['reason', 'redacted', 'redacted_at']);
  assert.equal(local_tombstone.data.redacted, true);
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: [foreign_full], receipts: [] });
  assert.equal(local_tombstone.id, foreign_full.id);

  const isTomb = candidate => candidate.data.redacted === true;
  assert.equal(classifySameId(local_tombstone, foreign_full, isTomb), expected.same_id_class);
  assert.equal(expected.same_id_class, 'tombstone-collision');
  const row = outcomeFor('tombstone-collision');
  assert.equal(row.outcome, 'needs-decision');
  assert.equal(row.privacySensitive, true);
  assert.equal(expected.restore_body_into_redacted_ledger, false);
  assert.equal(expected.delete_foreign_account, false);
  assert.equal(expected.kind, 'merge.tombstone-conflict');
  assert.ok(MERGE_KINDS.has(expected.kind));
});

test('merge-semantics: distinct-ID live verification meets tombstoned evidence as a backstop refusal (M10)', () => {
  const { local_source, local_tombstoned_evidence, foreign_live_verification, expected } =
    load('tombstoned-evidence-foreign-verification.json');
  assert.throws(() => parseSnapshot({ format: 'yurai.snapshot', version: 1,
    entries: [local_tombstoned_evidence], receipts: [] }), code('VALIDATION'));
  parseSnapshot({ format: 'yurai.snapshot', version: 1,
    entries: [local_source, foreign_live_verification], receipts: [] });
  assert.equal(local_tombstoned_evidence.data.redacted, true);
  assert.equal(foreign_live_verification.data.target_evidence_id, local_tombstoned_evidence.id);
  assert.notEqual(foreign_live_verification.id, local_tombstoned_evidence.id);
  assert.equal(expected.same_id_pair, false);
  // The backstop fires on the combination, not on ID equality.
  const hit = tombstoneBackstopHit([local_source, local_tombstoned_evidence, foreign_live_verification]);
  assert.deepEqual(hit, [expected.verification]);
  assert.equal(expected.kind, 'merge.tombstone-conflict');
  assert.ok(MERGE_KINDS.has(expected.kind));
  assert.equal(expected.written, 0);

  // §3.1.7c: tombstoned events contribute no effective state, either side, any ID.
  const isTomb = candidate => candidate.data?.redacted === true;
  const liveReview = { id: 'rev_mrg_tomb_live', type: 'review',
    data: { target_id: 'clm_mrg_tomb_e', state: 'accepted' } };
  const tombstonedForeignReview = { id: 'rev_mrg_tomb_foreign', type: 'review',
    data: { target_id: 'clm_mrg_tomb_e', state: 'rejected', redacted: true } };
  assert.equal(
    specEffectiveStateSkippingTombstones([liveReview, tombstonedForeignReview], new Set(), isTomb, 'clm_mrg_tomb_e'),
    'accepted');
  const liveVerification = { id: 'vrf_mrg_tomb_live', type: 'verification',
    data: { target_evidence_id: 'evd_mrg_tomb_e', outcome: 'match' } };
  const tombstonedForeignVerification = { id: 'vrf_mrg_tomb_foreign', type: 'verification',
    data: { target_evidence_id: 'evd_mrg_tomb_e', outcome: 'mismatch', redacted: true } };
  assert.equal(
    specAnchorWarningSkippingTombstones([tombstonedForeignVerification], isTomb, 'evd_mrg_tomb_e'),
    'anchor_not_verified');
  assert.equal(
    specAnchorWarningSkippingTombstones([liveVerification, tombstonedForeignVerification], isTomb, 'evd_mrg_tomb_e'),
    'anchor_match');
});

test('merge-semantics: duplicated events classify, never silently skip or overwrite (M11)', () => {
  const { local, foreign_snapshot, expected } = load('duplicate-events-positions.json');
  parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: local, receipts: [] });
  parseSnapshot(foreign_snapshot);
  const foreign = foreign_snapshot.entries;
  assert.equal(expected.pairs.length, 2);
  for (const pair of expected.pairs) {
    const a = local.find(e => e.id === pair.id);
    const b = foreign.find(e => e.id === pair.id);
    assert.ok(a && b, pair.id);
    assert.equal(a.type, 'review');
    assert.equal(b.type, 'review');
    assert.equal(classifySameId(a, b, noTombstones), pair.same_id_class, pair.id);
    assert.equal(pair.refusal, 'merge.collision');
    assert.ok(MERGE_KINDS.has(pair.refusal));
  }
  const classes = expected.pairs.map(p => p.same_id_class).sort();
  assert.deepEqual(classes, ['different-body', 'different-provenance']);
  assert.equal(outcomeFor('same-id-different-body').outcome, 'needs-decision');
  assert.equal(outcomeFor('same-id-different-provenance').outcome, 'needs-decision');
});

test('merge-semantics: exact retry replays, a different operation with the old plan refuses stale (M1/M16)', () => {
  const { artifact, expected, operation_identity } = load('repeated-merge.json');
  const snapshot = parseSnapshot(artifact);
  assert.equal(snapshot.entries.length, expected.first_apply.records_written);
  assert.deepEqual(expected.first_apply.skips, []);
  // The declared replay is self-consistent: every artifact entry skips, none
  // is written, and the skip set covers the artifact exactly.
  assert.equal(expected.second_apply.replayed, true);
  assert.equal(expected.second_apply.records_written, 0);
  assert.deepEqual([...expected.second_apply.skips].sort(), snapshot.entries.map(e => e.id).sort());
  assert.equal(expected.second_apply.no_duplicated_records, true);
  assert.equal(expected.second_apply.no_reinsertion_to_refresh_seq, true);
  // Exact retry: the second apply presents the first operation's identity,
  // so it is recognized before the stale check and replays instead of
  // refusing — the fingerprint advance is its own commit (§4.4).
  assert.equal(expected.second_apply.same_operation_identity, expected.first_apply.operation_identity);
  // A different operation reusing the old plan after the fingerprint moved
  // is not a retry: it refuses stale (M16), including the §5.3 loser.
  const other = expected.different_operation_with_old_plan;
  assert.notEqual(other.operation_identity, expected.first_apply.operation_identity);
  assert.equal(other.same_artifact_and_plan, true);
  assert.equal(other.fingerprint_moved_by_first_commit, true);
  assert.equal(other.refusal, 'merge.stale-plan');
  assert.ok(MERGE_KINDS.has(other.refusal));
  assert.equal(other.written, 0);
  // The identity fields and retry presentation stay provisional on #31 box 1.
  assert.match(operation_identity, /PROVISIONAL P2\/P5/);
  assert.match(operation_identity, /#31-final box 1/);
});

test('merge-semantics: plans bind source bytes and target fingerprint; stale and truncated plans refuse (M16/M17/M18)', () => {
  const { complete_plan, truncated_plan, stale_cases, limits, source_binding, expected, plan_identity } = load('merge-plan.json');
  assert.equal(complete_plan.complete, true);
  assert.equal(complete_plan.conflicts.truncated, false);
  assert.equal(complete_plan.conflicts.total, 0);
  assert.ok(complete_plan.admission.length > 0);
  assert.match(complete_plan.plan_digest, /^[a-f0-9]{64}$/);
  assert.match(complete_plan.source_digest, /^[a-f0-9]{64}$/);

  // The target binding is a fingerprint over every planning-relevant write,
  // not MAX(records.seq) alone.
  assert.equal(typeof complete_plan.target_fingerprint, 'string');
  assert.ok(!('target_revision' in complete_plan));
  assert.deepEqual(complete_plan.fingerprint_advances_on,
    ['record admission', 'receipt minting', 'replay-registry appends', 'merge-admission state']);
  assert.match(complete_plan.revision_insufficient, /must not be the sole binding/);

  // Stale-plan detection: either half of the binding moves → refuse.
  assert.equal(planStale(complete_plan, complete_plan.source_digest, complete_plan.target_fingerprint), false);
  const [contentWrite, artifactChanged, allEqualOp] = stale_cases;
  assert.equal(planStale(complete_plan, complete_plan.source_digest, contentWrite.current_fingerprint), true);
  assert.ok(contentWrite.current_fingerprint !== contentWrite.planned_fingerprint);
  assert.ok(contentWrite.records_max_seq_after !== contentWrite.records_max_seq_before);
  assert.equal(planStale(complete_plan, 'f'.repeat(64), complete_plan.target_fingerprint), true);
  assert.equal(artifactChanged.artifact_bytes_changed, true);
  // The all-equal merge operation between plan and apply: receipt-only, no
  // record seq moves, yet the plan is stale — MAX(seq) alone would miss it.
  assert.equal(planStale(complete_plan, complete_plan.source_digest, allEqualOp.current_fingerprint), true);
  assert.ok(allEqualOp.current_fingerprint !== allEqualOp.planned_fingerprint);
  assert.equal(allEqualOp.records_max_seq_unchanged, 7);
  assert.equal(expected.refusal_kind, 'merge.stale-plan');
  assert.ok(MERGE_KINDS.has(expected.refusal_kind));
  assert.equal(expected.apply_checks_binding_inside_transaction, true);
  // Plan identity stays provisional; the binding rule it constrains is the
  // source-digest + planning-fingerprint rule, not a revision binding.
  assert.match(plan_identity, /PROVISIONAL P5/);
  assert.match(plan_identity, /planning-fingerprint binding rule is FINAL/);
  assert.ok(!plan_identity.includes('revision'));

  // Source binding is a raw-byte hash: a reformatting that parses to
  // identical JSON still refuses.
  assert.equal(source_binding.algorithm, 'SHA-256 over raw artifact bytes');
  assert.equal(source_binding.canonical_json, false);
  assert.equal(source_binding.reformatting_refuses, true);
  const compact = '{"a":2,"b":1}';
  const spaced = '{ "b" : 1 , "a" : 2 }';
  assert.deepEqual(JSON.parse(compact), JSON.parse(spaced));
  assert.notEqual(sha256hex(compact), sha256hex(spaced));

  // Truncated plans carry explicit markers and must not approve-all.
  assert.equal(truncated_plan.complete, false);
  assert.equal(truncated_plan.truncated, true);
  assert.equal(truncated_plan.conflicts.truncated, true);
  assert.ok(truncated_plan.conflicts.total > truncated_plan.conflicts.categories[0].shown);
  assert.ok(truncated_plan.admission_total > truncated_plan.admission_shown);
  assert.equal(truncated_plan.target_fingerprint, complete_plan.target_fingerprint);
  assert.equal(expected.truncated_plan_must_not_approve_all.refusal_kind, 'merge.truncated-plan');
  assert.ok(MERGE_KINDS.has('merge.truncated-plan'));

  // Limits: one contract for the oversized case, events inside the item cap,
  // reports byte- and path-bounded (§5).
  assert.equal(limits.artifact_raw_bytes_max, 16 * 1024 * 1024);
  assert.equal(limits.admitted_entries_per_application_max, 200);
  assert.equal(limits.admitted_entries_include_events, true);
  assert.ok(!('admitted_content_records_per_application_max' in limits));
  assert.equal(limits.report_per_category_max, 100);
  assert.equal(limits.report_default_shown, 20);
  assert.equal(limits.report_output_bytes_max, 16 * 1024 * 1024);
  assert.equal(limits.cycle_members_named_max, 100);
  assert.equal(limits.path_page_max, 100);
  assert.equal(limits.kind, 'merge.limit-exceeded');
  assert.equal(limits.top_level, 'VALIDATION');
  assert.equal(limits.exit_code, 2);
  assert.ok(MERGE_KINDS.has('merge.limit-exceeded'));
  assert.ok(MERGE_KINDS.has('merge.empty-selection'));
});

test('merge-semantics: merge artifacts stay within the input byte bound (M18)', () => {
  for (const name of ['old-remote-review.json', 'preserved-testimony.json',
    'overlapping-corrections.json', 'missing-dependency.json', 'remap-conflict.json',
    'inactive-target.json', 'duplicate-request-ids.json', 'duplicate-events-positions.json',
    'imported-event-no-local.json', 'repeated-merge.json']) {
    const bytes = readFileSync(new URL(name, dir)).length;
    assert.ok(bytes < 16 * 1024 * 1024, `${name}: ${bytes} bytes`);
    const fixture = load(name);
    const artifact = fixture.foreign_snapshot ?? fixture.artifact;
    assert.ok(artifact, `${name} carries a merge artifact`);
    parseSnapshot(artifact);
  }
});

test('merge-semantics: refusals are decided pre-write and leave the ledger unchanged (M12)', t => {
  for (const [name, kind] of [['overlapping-corrections.json', 'merge.supersedes-cycle'],
    ['missing-dependency.json', 'merge.missing-dependency']]) {
    const { local, foreign_snapshot, expected } = load(name);
    assert.equal(planRefusalKind(local, foreign_snapshot.entries), kind);
    assert.equal(expected.kind, kind);
    assert.equal(expected.written, 0);
  }
  // Refusal-path atomicity pinned on existing machinery: a refused restore
  // leaves records, receipts, index, and revision identical.
  const { store, ledger } = setup(t);
  const { local } = load('overlapping-corrections.json');
  const { foreign_snapshot } = load('missing-dependency.json');
  ledger.capture({ version: 1, request_id: 'req_mrg_m12', actor: bundleActor, entries: toInputs(local) });
  const before = ledger.exportSnapshot();
  const revision = store.revision();
  assert.throws(() => ledger.importSnapshot(foreign_snapshot), code('CONFLICT'));
  assert.deepEqual(ledger.exportSnapshot(), before);
  assert.equal(store.revision(), revision);
});

test('merge-semantics: export/restore round-trips entries, receipts, and event order (M13)', t => {
  const { foreign_snapshot, expected } = load('preserved-testimony.json');
  const { ledger } = setup(t);
  ledger.capture({ version: 1, request_id: 'req_mrg_m13', actor: bundleActor,
    entries: toInputs(foreign_snapshot.entries) });
  const exported = ledger.exportSnapshot();
  const other = setup(t);
  other.ledger.importSnapshot(exported);
  const restored = other.ledger.exportSnapshot();
  // Entries, receipts, and per-target event order survive (ADR 0008 §13 style).
  assert.deepEqual(restored.entries, exported.entries);
  assert.deepEqual(restored.receipts, exported.receipts);
  assert.deepEqual(reviewOrder(restored.entries), reviewOrder(exported.entries));
  // The imported event's effective-state content survives the round-trip.
  const stateOf = entries => entries
    .filter(e => e.type === 'review' && e.data.target_id === 'clm_mrg_txt').at(-1).data.state;
  assert.equal(stateOf(restored.entries), stateOf(exported.entries));
  assert.equal(stateOf(restored.entries), 'accepted');
  // The distinction representation is provisional; legacy snapshots keep the
  // legacy shape and restore exactly as today.
  assert.match(expected.round_trip.representation, /PROVISIONAL P1/);
  assert.equal(expected.round_trip.legacy_snapshots_restore_exactly_as_today, true);
  assert.deepEqual(Object.keys(exported).sort(), ['entries', 'format', 'receipts', 'version']);
});

test('merge-semantics: direct search keeps literal AND, Japanese terms, paging, warnings, actor (M14)', t => {
  const { ledger } = setup(t);
  const { foreign_snapshot } = load('preserved-testimony.json');
  ledger.capture({ version: 1, request_id: 'req_mrg_m14', actor: bundleActor,
    entries: toInputs(foreign_snapshot.entries) });
  // Japanese literal term matches; literal AND narrows; unknown terms miss.
  const jp = ledger.search('合成データ');
  assert.equal(jp.match, 'literal_terms_and');
  assert.equal(jp.truth_evaluated, false);
  assert.deepEqual(jp.items.map(v => v.entry.id), ['clm_mrg_txt']);
  assert.equal(ledger.search('合成データ 仮説').items.length, 1);
  assert.equal(ledger.search('合成データ 架空の値').items.length, 0);
  // Newest-first, pagination, warnings, actor, revision.
  ledger.capture({ version: 1, request_id: 'req_mrg_m14b', actor: bundleActor, entries: [{ id: 'clm_mrg_newer',
    type: 'claim', data: { text: '合成データの新しい主張。', kind: 'assertion', attributed_to: 'synthetic-author' } }] });
  assert.deepEqual(ledger.search('合成データ').items.map(v => v.entry.id), ['clm_mrg_newer', 'clm_mrg_txt']);
  const page = ledger.search('合成データ', { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.next_offset, 1);
  assert.deepEqual(ledger.search('合成データ', { limit: 1, offset: 1 }).items.map(v => v.entry.id), ['clm_mrg_txt']);
  assert.deepEqual(page.items[0].entry.actor, bundleActor);
  assert.ok(Array.isArray(page.items[0].warnings));
  assert.ok(Number.isInteger(page.revision));
  assert.ok(ledger.show('evd_mrg_txt').warnings.includes('anchor_not_verified'));
  // Inactive records stay excluded by default and auditable on request.
  const { local } = load('inactive-target.json');
  ledger.capture({ version: 1, request_id: 'req_mrg_m14c', actor: bundleActor, entries: toInputs(local) });
  assert.equal(ledger.search('withdrawn').items.length, 0);
  assert.deepEqual(ledger.search('withdrawn', { includeInactive: true }).items.map(v => v.entry.id),
    ['clm_mrg_retired']);
});

test('merge-semantics: expanded discovery keeps routing, via, totals, and truncation markers (M15)', t => {
  const { ledger } = setup(t);
  const { foreign_snapshot } = load('preserved-testimony.json');
  ledger.capture({ version: 1, request_id: 'req_mrg_m15', actor: bundleActor,
    entries: toInputs(foreign_snapshot.entries) });
  // 'AI' lives only in the evidence quote: direct search misses, expanded routes.
  assert.equal(ledger.search('AI').items.length, 0);
  const found = ledger.search('AI', { expand: 'evidence' });
  assert.equal(found.match, 'expanded_evidence_routed');
  assert.equal(found.truth_evaluated, false);
  assert.deepEqual(found.items.map(v => v.entry.id), ['clm_mrg_txt']);
  const [item] = found.items;
  assert.equal(item.direct_match, false);
  assert.equal(item.total_paths, 1);
  assert.equal(item.paths_truncated, false);
  assert.deepEqual(item.via[0].match_fields, ['quote']);
  assert.equal(item.via[0].evidence.entry.id, 'evd_mrg_txt');
  assert.equal(item.via[0].assessment.entry.data.stance, 'reports');
  assert.equal(item.via[0].source.entry.id, 'src_mrg_txt');
  assert.ok(item.via[0].evidence.warnings.includes('anchor_not_verified'));
  // Inactive audit path: withdrawn claims route only when asked.
  const { local } = load('inactive-target.json');
  ledger.capture({ version: 1, request_id: 'req_mrg_m15b', actor: bundleActor, entries: toInputs(local) });
  assert.equal(ledger.search('withdrawn', { expand: 'evidence' }).items.length, 0);
  const audit = ledger.search('withdrawn', { expand: 'evidence', includeInactive: true });
  assert.deepEqual(audit.items.map(v => v.entry.id), ['clm_mrg_retired']);
  assert.equal(audit.items[0].direct_match, true);
});

test('merge-semantics: acceptance matrix covers every box with usable examples (box 6)', () => {
  const { rows } = load('acceptance-matrix.json');
  assert.equal(rows.length, 18);
  assert.deepEqual(rows.map(r => r.id),
    rows.map((_, i) => `M${i + 1}`));
  assert.deepEqual([...new Set(rows.map(r => r.box))].sort(), [1, 2, 3, 4, 5, 6]);
  for (const row of rows) {
    assert.ok(row.case.length > 0, row.id);
    assert.ok(row.expected.length > 0, row.id);
    assert.ok(row.fixtures.length > 0, row.id);
    for (const name of row.fixtures) load(name); // every referenced example exists and parses
    assert.ok(['final', 'rule-final'].includes(row.status), `${row.id}: ${row.status}`);
    if (row.status === 'final') {
      assert.equal(row.pending, null, row.id);
    } else {
      // Provisional remainder names its exact pending dependency: a #31-final
      // box or the #30-follow-up winner — never a silent default.
      assert.match(row.pending, /#31-final box [123]|#30-follow-up winner/, row.id);
    }
  }
  const final = rows.filter(r => r.status === 'final').map(r => r.id);
  assert.deepEqual(final, ['M2', 'M5', 'M6', 'M8', 'M12', 'M14', 'M15', 'M18']);
});

test('merge-semantics: no merge machinery is activated; import stays restore-only', () => {
  for (const method of ['merge', 'mergeSnapshot', 'mergePlan', 'mergeApply',
    'importForeign', 'remap', 'applyMerge', 'resolveConflict', 'planMerge']) {
    assert.equal(method in Ledger.prototype, false, method);
  }
  // The restore surface this ADR constrains still exists unchanged; refusal
  // into a non-empty ledger is covered by ledger.test.mjs.
  assert.equal(typeof Ledger.prototype.exportSnapshot, 'function');
  assert.equal(typeof Ledger.prototype.importSnapshot, 'function');
});
