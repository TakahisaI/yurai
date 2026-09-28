// Issue #31 / ADR 0011: pure contract/fixture assertions for merge retries vs
// origin receipts and deletion barriers on merge admission.
// No DB, no merge command, no migration: fixtures plus JSON rules only.
// Every fixture below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSnapshot } from '../dist/core/model.js';
import { code } from './helpers/assert.mjs';
import { classifySameId, exactContentEquals, isLedgerId, sameForkMappingKey, sameOriginIdentity } from '../dist/core/mergeIdentity.js';

const dir = new URL('./fixtures/merge-retries/', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const sha256hex = s => createHash('sha256').update(s, 'utf8').digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;
const noTombstones = () => false;
const isTombstone = entry => entry?.data?.redacted === true;

// ADR 0011 §1.1: retry compares the ledger-scoped request_id plus the
// artifact/selection/policy/namespace/pairing quintuple. Transport fields
// (JSON-RPC IDs, PIDs, artifact paths) are never part of retry identity.
// Selection order is insignificant (a sorted ID list); everything else
// is exact — including the import namespace, which requests different
// local IDs for the same incoming IDs, and the shared-history pairing
// declaration (C9 evaluates paired and unpaired imports differently, so
// a changed pairing is safety-relevant input, never a silent replay).
function mergeFingerprint(request) {
  return JSON.stringify({
    artifact_digest: request.artifact_digest,
    selection: [...request.selection].sort(),
    policy: request.policy,
    namespace: request.namespace,
    pairing: request.pairing ?? null,
  });
}
function mergeRetryOutcome(stored, retry) {
  if (stored.request_id !== retry.request_id) return 'distinct';
  return mergeFingerprint(stored) === mergeFingerprint(retry) ? 'replay' : 'CONFLICT';
}
// ADR 0008 §6 detector, reused for the §4.3 combination table: a receipt
// whose request_id digest sits in the registry is a CONFLICT, never
// auto-resolved.
function receiptRegistryConflicts(receipts, digests) {
  const blocked = new Set(digests);
  return receipts.map(r => r.request_id).filter(id => blocked.has(sha256hex(id)));
}
// ADR 0011 §2.2 installation condition: a receipt may stand as a local
// capture receipt only when membership AND digest both still describe local
// creation byte-exactly. `localCreation` is null when this ledger never
// created under that request_id.
function installableAsLocalReceipt(foreignReceipt, localCreation) {
  if (!localCreation) return false;
  return foreignReceipt.request_id === localCreation.request_id
    && foreignReceipt.digest === localCreation.digest
    && JSON.stringify(foreignReceipt.ids) === JSON.stringify(localCreation.ids);
}
// ADR 0011 §2.4 repeat rule over ADR 0009 mapping keys: unknown labels
// refuse, an occupied key under the same namespace refuses the whole
// operation as a zero-create (§1.5 FINAL interim until P9: no
// duplicates are minted, but no receipt row is writable either), and a
// different namespace is a distinct import.
function repeatOutcome(existing, attempt) {
  if (typeof attempt.namespace !== 'string' || attempt.namespace.length === 0)
    return 'refuse-needs-namespace';
  const attemptKey = { origin: attempt.namespace, id: attempt.incoming_id };
  const hit = existing.some(m =>
    sameForkMappingKey({ origin: m.namespace, id: m.incoming_id }, attemptKey));
  return hit ? 'refuse-zero-create' : 'distinct-import';
}
// ADR 0008 §12 detector, reused for C5: live Verifications targeting
// tombstoned Evidence.
function liveVerificationsOnTombstonedEvidence(entries) {
  const tombstoned = new Set(entries
    .filter(e => e.type === 'evidence' && e.data.redacted === true)
    .map(e => e.id));
  return entries
    .filter(e => e.type === 'verification' && e.data.redacted !== true
      && tombstoned.has(e.data.target_evidence_id))
    .map(e => e.id);
}
// ADR 0011 §4.2 cross-record detector for C6: incoming live
// Verifications in the selection whose target resolves to locally
// tombstoned Evidence. The Verification carries its own ID; this is
// not a same-ID pair.
function incomingLiveVerificationsOnLocalTombstones(localEntries, incomingEntries, selection) {
  const tombstoned = new Set(localEntries
    .filter(e => e.type === 'evidence' && e.data.redacted === true)
    .map(e => e.id));
  const selected = new Set(selection);
  return incomingEntries
    .filter(e => e.type === 'verification' && e.data.redacted !== true
      && selected.has(e.id) && tombstoned.has(e.data.target_evidence_id))
    .map(e => e.id);
}
function parseOne(entry) {
  return parseSnapshot({ format: 'yurai.snapshot', version: 1, entries: [entry], receipts: [] });
}

test('box 1: same local request plus same artifact/selection/policy/namespace/pairing replays; any change conflicts', () => {
  const fixture = load('merge-requests.json');
  assert.match(fixture.artifact_a, HEX64);
  assert.match(fixture.artifact_b, HEX64);
  assert.notEqual(fixture.artifact_a, fixture.artifact_b);
  for (const pair of fixture.pairs) {
    assert.equal(mergeRetryOutcome(pair.stored, pair.retry), pair.expected, pair.name);
  }
  // Selection order never matters (first pair is deliberately reordered);
  // transport fields never participate.
  for (const c of fixture.transport_cases) {
    assert.equal(mergeRetryOutcome(c.stored, c.retry), c.expected, c.name);
    // The fingerprint provably ignores transport fields: swapping them
    // never changes the outcome.
    assert.equal(mergeFingerprint(c.stored), mergeFingerprint({ ...c.stored, transport: { jsonrpc_id: 999 } }), c.name);
  }
  assert.equal(mergeFingerprint({ artifact_digest: 'd', selection: ['b', 'a'], policy: 'p', namespace: 'n' }),
    mergeFingerprint({ artifact_digest: 'd', selection: ['a', 'b'], policy: 'p', namespace: 'n' }));
  // The namespace participates: same request with another namespace
  // is a conflict, never a replay.
  assert.equal(mergeFingerprint({ artifact_digest: 'd', selection: ['a'], policy: 'p', namespace: 'n1' }) ===
    mergeFingerprint({ artifact_digest: 'd', selection: ['a'], policy: 'p', namespace: 'n2' }), false);
  // The pairing declaration participates too: same request with a
  // changed pairing is a conflict, never a replay (§1.1, C9).
  assert.equal(mergeFingerprint({ artifact_digest: 'd', selection: ['a'], policy: 'p', namespace: 'n', pairing: null }) ===
    mergeFingerprint({ artifact_digest: 'd', selection: ['a'], policy: 'p', namespace: 'n', pairing: 'synthetic-pair-1' }), false);
  assert.equal(mergeFingerprint({ artifact_digest: 'd', selection: ['a'], policy: 'p', namespace: 'n', pairing: 'synthetic-pair-1' }),
    mergeFingerprint({ artifact_digest: 'd', selection: ['a'], policy: 'p', namespace: 'n', pairing: 'synthetic-pair-1' }));

  // ADR 0011 §1.5 receipt-shape limits. A zero-create merge has no
  // created IDs, but the receipts row requires 1-200 IDs — so the row
  // is unwritable today (P9) and no receipt may be synthesized from
  // foreign receipts. Receipt rows also carry no actor field (P10).
  const limits = fixture.receipt_limits;
  assert.deepEqual(limits.zero_create.created_ids, []);
  assert.equal(limits.zero_create.current_receipt_row_writable, false);
  assert.equal(limits.zero_create.retry_replays_from_stored_receipt, false);
  assert.equal(limits.zero_create.synthesize_from_foreign, false);
  assert.deepEqual(limits.zero_create.candidate_shapes,
    ['relaxed-ids', 'merge-operation-record', 'no-persisted-receipt']);
  // FINAL interim until P9 settles: a merge that would create no local
  // IDs refuses as uncertain admission — success without a stored
  // receipt could neither replay nor conflict a changed-input retry.
  assert.equal(limits.zero_create.interim_until_P9, 'refuse-as-uncertain');
  assert.equal(limits.zero_create.provisional, 'P9');
  assert.throws(() => parseSnapshot({
    format: 'yurai.snapshot', version: 1, entries: [],
    receipts: [{ request_id: 'req_merge_1', digest: 'a'.repeat(64), ids: [] }],
  }), code('VALIDATION'));
  // The contrasting writable row parses, pinning that only the empty
  // membership is unrepresentable.
  parseSnapshot({
    format: 'yurai.snapshot', version: 1, entries: [],
    receipts: [{ request_id: 'req_merge_1', digest: 'a'.repeat(64), ids: ['clm_m31_a'] }],
  });
  assert.deepEqual(limits.importer_actor.receipt_row_fields, ['request_id', 'digest', 'ids']);
  assert.equal(limits.importer_actor.actor_field_present, false);
  assert.equal(limits.importer_actor.provisional, 'P10');
});

test('box 2: equal request strings are unrelated; foreign receipts never install', () => {
  const fixture = load('receipt-namespaces.json');
  const { ledger_a_receipt, ledger_b_receipt, expected } = fixture.equal_strings;
  assert.equal(ledger_a_receipt.request_id, ledger_b_receipt.request_id);
  assert.notEqual(ledger_a_receipt.digest, ledger_b_receipt.digest);
  assert.equal(expected, 'unrelated');
  // Same string, same ledger would replay-or-conflict; across ledgers it
  // means nothing, so installation is impossible in both directions.
  assert.equal(installableAsLocalReceipt(ledger_a_receipt, null), false);
  assert.equal(installableAsLocalReceipt(ledger_b_receipt, null), false);

  const reuse = fixture.string_reuse;
  assert.equal(reuse.local_fresh_use_of_same_string.allowed, true);
  assert.equal(reuse.local_fresh_use_of_same_string.local_digest_differs_from_foreign, true);
  assert.equal(reuse.foreign_receipt_installed_locally, false);
  assert.equal(installableAsLocalReceipt(reuse.foreign_receipt, null), false);
  // Even when the local ledger later mints the same string, the foreign
  // digest describes the foreign bundle, never the local creation.
  assert.equal(installableAsLocalReceipt(reuse.foreign_receipt,
    { request_id: reuse.foreign_receipt.request_id, digest: sha256hex('synthetic-local-bundle'), ids: ['clm_m31_local'] }), false);
});

test('box 2: copied ledgers skip exact pairs and conflict on divergence', () => {
  const copied = load('receipt-namespaces.json').copied_ledger;
  parseOne(copied.exact_local);
  parseOne(copied.exact_incoming);
  parseOne(copied.diverged_incoming);
  assert.equal(classifySameId(copied.exact_local, copied.exact_incoming, noTombstones), 'same-entry');
  assert.equal(copied.exact_expected, 'skip');
  assert.equal(classifySameId(copied.exact_local, copied.diverged_incoming, noTombstones), 'different-body');
  assert.equal(copied.diverged_expected, 'needs-decision');
});

test('box 2: repeats refuse as zero-create under one namespace, split under two, refuse when origin-less', () => {
  const { existing_mapping, attempts } = load('receipt-namespaces.json').repeat_import;
  assert.equal(existing_mapping.length, 1);
  for (const attempt of attempts) {
    assert.equal(repeatOutcome(existing_mapping, attempt), attempt.expected, attempt.name);
  }
  // The same-namespace refusal is the §1.5 zero-create interim (P9),
  // not a success-with-skip: the occupied mapping key is what makes
  // the repeat create zero local IDs.
  const sameNs = attempts.find(a => a.namespace === 'synthetic-ns-a');
  assert.equal(sameNs.expected, 'refuse-zero-create');
  assert.equal(sameNs.provisional, 'P9');
  assert.equal(sameNs.interim, 'refuse-as-uncertain-until-P9');
  // The distinct-namespace import really is a new slot, not a collision.
  assert.equal(sameForkMappingKey(
    { origin: 'synthetic-ns-a', id: 'clm_m31_x' },
    { origin: 'synthetic-ns-b', id: 'clm_m31_x' }), false);
});

test('box 2: overlaps skip the intersection only on exact equality and fail whole on a conflicting remainder', () => {
  const overlap = load('receipt-namespaces.json').overlap;
  const mapped = new Set(overlap.existing_mapping.map(m => m.incoming_id));
  const split = selection => ({
    skipped: selection.filter(id => mapped.has(id)),
    evaluated: selection.filter(id => !mapped.has(id)),
  });
  assert.deepEqual(split(overlap.clean_selection), overlap.clean_expected);
  // Membership routes the key, but the skip itself requires the
  // incoming entry to still exactly equal the previously imported
  // bytes (ADR 0011 §2.5): key order is forgiven, nothing else.
  const gate = overlap.equality_gate;
  parseOne(gate.previous_bytes);
  parseOne(gate.incoming_unchanged);
  parseOne(gate.incoming_changed_body);
  parseOne(gate.incoming_changed_actor);
  assert.equal(exactContentEquals(gate.previous_bytes, gate.incoming_unchanged), true);
  assert.equal(gate.unchanged_expected, 'skip');
  // A changed re-supply of the SAME intersected key conflicts instead
  // of skipping: membership alone would silently keep stale bytes.
  assert.equal(exactContentEquals(gate.previous_bytes, gate.incoming_changed_body), false);
  assert.equal(exactContentEquals(gate.previous_bytes, gate.incoming_changed_actor), false);
  assert.equal(classifySameId(gate.previous_bytes, gate.incoming_changed_body, noTombstones),
    'different-body');
  assert.equal(classifySameId(gate.previous_bytes, gate.incoming_changed_actor, noTombstones),
    'different-provenance');
  assert.equal(gate.changed_expected, 'conflict-names-key-refuse-whole');
  assert.equal(overlap.conflicting_remainder_expected, 'refuse-whole');
  assert.equal(overlap.selective_continuation.provisional, 'P4');

  const outside = load('receipt-namespaces.json').out_of_selection;
  assert.ok(outside.foreign_receipt.ids.some(id => !outside.selection.includes(id)));
  assert.equal(outside.installed, false);
  assert.equal(outside.unselected_pulled_in, false);
  // The local operation receipt lists only actually-created local IDs.
  assert.deepEqual(outside.local_operation_receipt_ids, ['clm_m31_x_m1']);
  assert.ok(!outside.local_operation_receipt_ids.includes('clm_m31_unselected'));
  assert.deepEqual(outside.provisional_extra, ['P2']);
});

test('box 3: importer identity stays on the operation; origin strings prove nothing', () => {
  const fixture = load('origin-preservation.json');
  const { merge_operation_actor, imported_entry, mapping_key } = fixture.importer_vs_origin;
  parseOne(imported_entry);
  assert.deepEqual(imported_entry.actor, { kind: 'human', id: 'synthetic-foreign-recorder' });
  assert.notDeepEqual(imported_entry.actor, merge_operation_actor);
  assert.equal(fixture.importer_vs_origin.importer_stamped_on_entry, false);
  assert.equal(fixture.importer_vs_origin.foreign_actor_preserved_byte_identical, true);
  assert.equal(fixture.importer_vs_origin.foreign_created_at_preserved, true);
  assert.equal(mapping_key.origin, 'synthetic-op-pair-1');
  assert.equal(fixture.importer_vs_origin.provisional, 'P3');

  // Content claims — path, self-declared name, DOI, URI — never populate
  // the comparison-time origin label: it stays unknown and matches nothing.
  const spoof = fixture.origin_spoof;
  assert.equal(spoof.operator_pairing_label, null);
  assert.equal(spoof.comparison_label_derived, null);
  assert.ok(Object.values(spoof.content_claims).every(s => typeof s === 'string' && s.length > 0));
  assert.equal(sameOriginIdentity(
    { origin: spoof.comparison_label_derived, id: 'clm_m31_o' },
    { origin: 'synthetic-ledger-a', id: 'clm_m31_o' }), false);
  assert.equal(spoof.matches_known_origin_synthetic_ledger_a, false);

  const pairing = fixture.operator_pairing;
  assert.equal(sameOriginIdentity(
    { origin: pairing.label_a, id: pairing.id },
    { origin: pairing.label_b, id: pairing.id }), pairing.same_origin_identity);

  const reported = fixture.self_reported;
  assert.equal(reported.foreign_actor_authenticated, false);
  assert.equal(reported.foreign_created_at_authenticated, false);
  assert.equal(reported.origin_label_authenticated, false);
});

test('box 4: barriers run before remap; the combination table fails closed', () => {
  const fixture = load('barrier-order.json');
  assert.deepEqual(fixture.ordered_checks, ['local-registry', 'classification', 'remap']);
  assert.equal(fixture.ordered_checks.at(-1), 'remap');
  assert.equal(fixture.remap_last, true);
  // The local registry fixture is honest: the digest really is the
  // SHA-256 of the named blocked request_id.
  assert.deepEqual(fixture.local_registry.digests, [sha256hex(fixture.local_registry.blocked_request_id)]);

  const byId = Object.fromEntries(fixture.combinations.map(c => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']);

  assert.deepEqual(receiptRegistryConflicts(byId.C1.receipts, byId.C1.registry_digests), ['req_m31_live']);
  assert.equal(byId.C1.expected, 'CONFLICT');
  assert.equal(byId.C1.writes, 'nothing');

  assert.ok(fixture.local_registry.digests.includes(sha256hex(byId.C2.merge_request_id)));
  assert.equal(byId.C2.expected, 'refuse-whole');

  assert.equal(byId.C3.admission_consults_foreign, false);
  assert.equal(byId.C3.unioned_into_local, false);
  assert.equal(byId.C3.local_registry_unchanged, true);

  assert.deepEqual(receiptRegistryConflicts(
    byId.C4.incoming_receipts, byId.C4.incoming_registry.digests), ['req_foreign_blocked']);
  assert.equal(byId.C4.expected, 'refuse-artifact-whole');

  assert.deepEqual(liveVerificationsOnTombstonedEvidence(byId.C5.incoming_entries), ['ver_m31_f']);
  assert.equal(byId.C5.expected, 'refuse-artifact-whole');
  // The survivor pins quote-derived bytes: the leak a partial admission
  // would keep. The tombstoned half is invalid under today's live-only
  // schema, the live half parses.
  assert.throws(() => parseOne(byId.C5.incoming_entries[0]), code('VALIDATION'));
  parseOne(byId.C5.incoming_entries[1]);

  // C6 is a cross-record reference refusal, NOT a same-ID pair: the
  // incoming live Verification carries its own ID and targets the
  // locally-tombstoned Evidence. Both selection shapes refuse, and each
  // shape supplies every entry its selection names.
  const c6 = byId.C6;
  assert.notEqual(c6.incoming_live_verification.id, c6.local_tombstoned_evidence.id);
  assert.equal(c6.incoming_live_verification.data.target_evidence_id,
    c6.local_tombstoned_evidence.id);
  parseOne(c6.incoming_live_verification); // live shape, yet unadmittable here
  assert.throws(() => parseOne(c6.local_tombstoned_evidence), code('VALIDATION'));
  // The Evidence+Verification shape names the Evidence, so the fixture
  // supplies it: a foreign tombstoned copy of the same ID. (That same-ID
  // pair would independently collide per §4.2; the cross-record refusal
  // below holds regardless.)
  assert.throws(() => parseOne(c6.incoming_evidence), code('VALIDATION'));
  assert.equal(c6.incoming_evidence.id, c6.local_tombstoned_evidence.id);
  assert.deepEqual(Object.keys(c6.selections).sort(),
    ['evidence_plus_verification', 'verification_only']);
  assert.deepEqual(c6.selections.evidence_plus_verification, ['evd_m31_t', 'ver_m31_v']);
  assert.deepEqual(c6.selections.verification_only, ['ver_m31_v']);
  const c6Incoming = {
    evidence_plus_verification: [c6.incoming_evidence, c6.incoming_live_verification],
    verification_only: [c6.incoming_live_verification],
  };
  for (const [shape, selection] of Object.entries(c6.selections)) {
    const incoming = c6Incoming[shape];
    assert.deepEqual(incoming.map(e => e.id).sort(), [...selection].sort(), shape);
    assert.deepEqual(incomingLiveVerificationsOnLocalTombstones(
      [c6.local_tombstoned_evidence], incoming, selection),
      ['ver_m31_v'], shape);
  }
  assert.equal(c6.expected, 'refuse-whole');
  assert.equal(c6.refusal, 'cross-record-reference');
  assert.deepEqual(c6.reported_ids, ['ver_m31_v', 'evd_m31_t']);

  // C7 is the symmetric same-ID Evidence pair with a local live
  // Verification on the local side: the pair collides, the merge
  // refuses whole, and the local Verification stays intact.
  const c7 = byId.C7;
  parseOne(c7.local_live_evidence);
  parseOne(c7.local_live_verification);
  assert.throws(() => parseOne(c7.incoming_tombstoned), code('VALIDATION'));
  assert.equal(c7.local_live_verification.data.target_evidence_id,
    c7.local_live_evidence.id);
  assert.equal(classifySameId(c7.local_live_evidence, c7.incoming_tombstoned, isTombstone),
    'tombstone-collision');
  assert.equal(c7.expected, 'refuse-whole');
  assert.equal(c7.refusal, 'tombstone-collision-same-id-pair');
  assert.equal(c7.local_verification_intact, true);

  assert.equal(byId.C8.fail_closed, true);
  assert.equal(byId.C8.writes, 'nothing');
  assert.equal(byId.C8.provisional, 'P5');

  // C9: the shared-history barrier. The incoming foreign receipt
  // re-supplies the locally-blocked request string; the pairing gate
  // decides whether the comparison runs at all. The digest is genuine.
  const c9 = byId.C9;
  assert.equal(c9.local_registry_digest, sha256hex(c9.incoming_foreign_receipt.request_id));
  assert.ok(fixture.local_registry.digests.includes(c9.local_registry_digest));
  assert.equal(c9.paired.shared_history_declared, true);
  assert.equal(c9.paired.expected, 'refuse-whole');
  assert.equal(c9.paired.before, 'remap');
  assert.equal(c9.paired.lookup_mechanics, 'provisional');
  assert.equal(c9.paired.provisional, 'P8');
  assert.equal(c9.unpaired.shared_history_declared, false);
  assert.equal(c9.unpaired.strings_compared, false);
  assert.equal(c9.unpaired.expected, 'evaluated-without-barrier');

  const nop = fixture.no_permission;
  assert.equal(nop.classification, 'tombstone-collision');
  assert.equal(nop.local_redacted, false);
  assert.deepEqual(nop.local_receipts_dropped, []);
  assert.deepEqual(nop.local_records_deleted, []);
  assert.equal(fixture.purge_scope_overlap.provisional, 'P6');
});

test('box 5: detection limits refuse the universal-prevention claim', () => {
  const fixture = load('detection-limits.json');
  assert.equal(fixture.universal_resurrection_prevention_claimed, false);
  assert.deepEqual(fixture.cases, [
    { signal: 'locally-blocked-request-id-reused', detectable: true, outcome: 'refused' },
    { signal: 'partial-purge-survivor-same-id-live', detectable: true, outcome: 'immutable-ID-CONFLICT' },
    { signal: 'same-id-tombstone-either-side', detectable: true, outcome: 'tombstone-collision' },
    { signal: 'origin-less-artifact-claiming-sameness', detectable: false, outcome: 'unknown-origin-never-matches' },
    { signal: 'rewritten-request-ids', detectable: false, outcome: 'new-recording-act-not-stopped' },
    { signal: 'fully-purged-record-ids-reimported', detectable: false, outcome: 'no-record-id-trace', paired_exception: 'C9-refuses-paired-receipt-resupply-P8' },
    { signal: 'newly-keyed-content', detectable: false, outcome: 'distinct-records' },
    { signal: 'foreign-registry-digest-matching-local-string', detectable: false, outcome: 'not-consulted-namespaces-differ', paired_exception: 'C9-checks-receipt-strings-not-foreign-registry-P8' },
  ]);
  // The undetectable rows are the point: most resurrection shapes are NOT
  // stopped by a request-ID-only registry.
  assert.ok(fixture.cases.filter(c => !c.detectable).length >= 5);
  // The two rows a paired shared-history import could touch carry the
  // C9 exception explicitly: pairing refuses the receipt re-supply, but
  // never consults the foreign registry itself (§5.1, C9).
  const bySignal = Object.fromEntries(fixture.cases.map(c => [c.signal, c]));
  assert.equal(bySignal['fully-purged-record-ids-reimported'].paired_exception,
    'C9-refuses-paired-receipt-resupply-P8');
  assert.equal(bySignal['foreign-registry-digest-matching-local-string'].paired_exception,
    'C9-checks-receipt-strings-not-foreign-registry-P8');
});

test('box 6: privacy metadata survives export/restore; unknown versions and malformed input refuse', () => {
  const fixture = load('privacy-survival.json');
  assert.equal(fixture.registry_export.nonempty_registry_must_ride_export, true);
  assert.equal(fixture.registry_export.registry_dropping_export, 'refused-never-silent');
  assert.equal(fixture.registry_export.empty_registry_omitted, true);

  assert.equal(fixture.future_version.expected, 'refuse-whole');
  assert.equal(fixture.future_version.restore_anything, false);
  assert.notEqual(fixture.future_version.registry_version, 1);
  assert.throws(() => parseSnapshot(fixture.future_version.current_reader_snapshot), code('VALIDATION'));
  assert.equal(fixture.future_version.current_reader_rejects, true);

  assert.equal(fixture.total_export.tombstone_present_exports_as_tombstone, true);
  assert.equal(fixture.total_export.carving_tombstones, 'refused');
  assert.equal(fixture.total_export.carving_registry, 'refused');

  assert.deepEqual(fixture.leakage.registry_leaks, ['purge-count', 'guessable-request-id-membership']);
  assert.equal(fixture.leakage.registry_leaks_content, false);
  assert.equal(fixture.leakage.registry_leaks_raw_ids, false);
  assert.equal(fixture.leakage.origin_mapping_withheld_from_export, true);
  assert.equal(fixture.leakage.sensitive_merges_use_unguessable_request_ids, true);

  for (const id of fixture.malformed.invalid_merge_request_ids) {
    assert.equal(isLedgerId(id), false, JSON.stringify(id));
  }
  assert.equal(isLedgerId('req_merge_1'), true);
  assert.equal(fixture.malformed.expected, 'VALIDATION-refuse-whole');

  // The refusal rests on this ADR's own uncertain-admission rule, not
  // on ADR 0008 rule 7, which decides direct capture only (§6.2).
  assert.equal(fixture.distinct_id_foreign_tombstone.import_default, 'refuse');
  assert.equal(fixture.distinct_id_foreign_tombstone.reason,
    'no-settled-transfer-rule-uncertain-admission-refuses');
  assert.equal(fixture.distinct_id_foreign_tombstone.rule7_cited_for, 'direct-capture-only');
  assert.equal(fixture.distinct_id_foreign_tombstone.provisional, 'P7');

  // ADR 0011 §6.2 survival ledger: per-class retained/excluded for
  // imported privacy metadata. Foreign digests and distinct-ID foreign
  // tombstones are excluded; per-record origin annotation survives in
  // the entry envelope; the mapping survives only via P3+P11 pairing.
  const survival = fixture.imported_privacy_metadata_survival;
  assert.equal(survival.foreign_registry_digests, 'excluded-never-retained');
  assert.equal(survival.distinct_id_foreign_tombstones, 'excluded-until-P7');
  assert.equal(survival.per_record_origin_annotation, 'retained-in-entry-envelope');
  assert.equal(survival.origin_mapping, 'P3-storage-plus-P11-backup-pairing-only');
  assert.equal(survival.restore_without_mapping, 'refuse-uncertain');

  // ADR 0011 §6.2 preservation-or-refusal. Foreign digests have an
  // explicit non-survival path: nothing remembers them, so no decision
  // may depend on recalling them across attempts.
  const noSurvival = fixture.foreign_registry_no_survival;
  assert.equal(noSurvival.in_ledger_copy, false);
  assert.equal(noSurvival.export_row, false);
  assert.equal(noSurvival.cross_attempt_memory, false);
  assert.equal(noSurvival.consistency_check_scope, 'present-bytes-only-per-attempt');
  assert.equal(noSurvival.cross_attempt_dependence_allowed, false);

  // The operator-held mapping must be paired with the ledger backup;
  // a restore that loses it refuses repeats as uncertain (P11).
  const preservation = fixture.mapping_preservation;
  assert.equal(preservation.operator_held_backup_paired_with_ledger, true);
  assert.equal(preservation.restore_without_mapping.repeat_skip_allowed, false);
  assert.equal(preservation.restore_without_mapping.blind_remint_allowed, false);
  assert.equal(preservation.restore_without_mapping.expected, 'refuse-uncertain');
  assert.deepEqual(preservation.privacy_constraints, [
    'never-ordinary-in-ledger-content',
    'never-raw-removed-ids-in-live-audit',
    'cut-or-withheld-from-uncontrolled-exports',
  ]);
  assert.equal(preservation.pairing_mechanics, 'provisional');
  assert.equal(preservation.provisional, 'P11');
});

test('box 6: adversarial cases pin the required expected results', () => {
  const { cases } = load('adversarial-cases.json');
  const byName = Object.fromEntries(cases.map(c => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'body-restoration-via-foreign-full-copy',
    'foreign-registry-smuggling',
    'laundered-replay-under-new-request-id',
    'namespace-spoof-via-content',
    'receipt-smuggling',
    'request-string-reuse',
    'verification-straggler-import',
  ]);

  const reuse = byName['request-string-reuse'];
  assert.equal(reuse.local_receipt_already_exists, false);
  assert.equal(reuse.expected.allowed_as_fresh, true);
  assert.equal(reuse.expected.foreign_receipt_installed, false);
  assert.equal(reuse.expected.local_digest_equals_foreign, false);
  assert.equal(installableAsLocalReceipt(reuse.foreign_receipt, null), false);

  const smuggle = byName['receipt-smuggling'];
  assert.equal(smuggle.foreign_receipt.request_id, smuggle.local_live_receipt.request_id);
  assert.notEqual(smuggle.foreign_receipt.digest, smuggle.local_live_receipt.digest);
  assert.equal(installableAsLocalReceipt(smuggle.foreign_receipt, smuggle.local_live_receipt), false);
  assert.equal(smuggle.expected.installed, false);
  assert.equal(smuggle.expected.installation_attempt, 'CONFLICT');
  assert.equal(smuggle.expected.local_receipt_unchanged, true);

  const spoof = byName['namespace-spoof-via-content'];
  assert.equal(spoof.expected.comparison_label, null);
  assert.equal(sameOriginIdentity(
    { origin: spoof.expected.comparison_label, id: 'clm_adv_spoof' },
    { origin: 'synthetic-ledger-a', id: 'clm_adv_spoof' }), spoof.expected.matches_known_origin);

  const restore = byName['body-restoration-via-foreign-full-copy'];
  assert.throws(() => parseOne(restore.local_tombstoned), code('VALIDATION'));
  parseOne(restore.incoming_full);
  assert.equal(classifySameId(restore.local_tombstoned, restore.incoming_full, isTombstone),
    restore.expected.classification);
  assert.equal(restore.expected.admitted_body, null);
  assert.equal(restore.expected.local_tombstone_intact, true);

  const straggler = byName['verification-straggler-import'];
  parseOne(straggler.incoming_live_verification); // live shape, yet unadmittable here
  assert.equal(straggler.incoming_live_verification.data.target_evidence_id,
    straggler.local_tombstoned_evidence);
  assert.equal(straggler.expected.admitted, false);
  // The Verification-only selection refuses too: the target always
  // resolves against local state (§4.2 cross-record refusal).
  assert.deepEqual(Object.keys(straggler.selections).sort(),
    ['evidence_plus_verification', 'verification_only']);
  assert.deepEqual(straggler.selections.verification_only, ['ver_adv_straggler']);
  assert.equal(straggler.expected.admitted_verification_only, false);

  const registry = byName['foreign-registry-smuggling'];
  assert.ok(registry.incoming_registry.digests.every(d => HEX64.test(d)));
  assert.equal(registry.expected.consulted_for_admission, false);
  assert.equal(registry.expected.unioned_into_local, false);
  assert.equal(registry.expected.local_registry_unchanged, true);

  // The honest limit: a laundered replay under a NEW request_id is a new
  // recording act and is NOT refused. The fixture digests are genuine.
  const laundered = byName['laundered-replay-under-new-request-id'];
  assert.equal(laundered.purged_digest, sha256hex(laundered.purged_local_request_id));
  assert.equal(laundered.reimport_digest, sha256hex(laundered.reimport_request_id));
  assert.notEqual(laundered.purged_digest, laundered.reimport_digest);
  assert.equal(laundered.expected.refused, false);
  assert.equal(laundered.expected.reason, 'new-recording-act-undetectable');
  assert.equal(laundered.expected.documents_limit, true);
});

test('provisional register: every marker names a known dependency and all eleven resolve', () => {
  const KNOWN = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'];
  const names = ['merge-requests.json', 'receipt-namespaces.json', 'origin-preservation.json',
    'barrier-order.json', 'detection-limits.json', 'privacy-survival.json', 'adversarial-cases.json'];
  const found = new Set();
  const collect = value => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if ((key === 'provisional' || key === 'provisional_touched' || key === 'provisional_extra')) {
          for (const marker of Array.isArray(entry) ? entry : [entry]) {
            assert.ok(KNOWN.includes(marker), `unknown provisional marker: ${marker}`);
            found.add(marker);
          }
        } else collect(entry);
      }
    }
  };
  for (const name of names) collect(load(name));
  assert.deepEqual([...found].sort(), [...KNOWN].sort());
  // The ADR register is the normative list: every P-number resolves there.
  const adr = readFileSync(new URL('../docs/adr/0011-merge-retries-origin-receipts.md', import.meta.url), 'utf8');
  for (const marker of KNOWN) assert.ok(adr.includes(`| ${marker} |`), marker);
});
