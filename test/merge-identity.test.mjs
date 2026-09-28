import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../dist/index.js';
import { canonicalJson, classifySameId, exactContentEquals,
  exactEntryEquals, isLedgerId, outcomeFor, sameForkMappingKey, sameOriginIdentity,
  FORK_REWRITTEN_REFERENCE_FIELDS, MERGE_IDENTITY_OUTCOMES } from '../dist/core/mergeIdentity.js';
import { parseSnapshot, references } from '../dist/core/model.js';
import * as mergeIdentity from '../dist/core/mergeIdentity.js';

// Synthetic conformance cases for issue #30 / ADR 0009. Pure fixture
// assertions only: nothing here merges, rewrites, migrates, or activates a
// conflict policy. Every fixture below is synthetic.

const T = '2026-09-27T00:00:00.000Z';
const U = '2026-09-28T00:00:00.000Z';
const recorderA = { kind: 'human', id: 'synthetic-recorder-a' };
const recorderB = { kind: 'human', id: 'synthetic-recorder-b' };

const entry = (id, type, data, actor = recorderA, created_at = T) =>
  ({ id, type, data, actor, created_at });

const claimData = (overrides = {}) => ({
  text: 'Synthetic claim about dosage X.',
  kind: 'assertion',
  attributed_to: 'synthetic-author',
  scope: 'synthetic adults cohort',
  why: 'synthetic fixture',
  ...overrides,
});

/** Explicit "these fixtures hold no tombstones" claim, required by classifySameId. */
const noTombstones = () => false;

/** Every fixture entry used for classification must itself be schema-valid. */
function assertSchemaValid(entries) {
  const snapshot = parseSnapshot({ format: 'yurai.snapshot', version: 1, entries, receipts: [] });
  assert.equal(snapshot.entries.length, entries.length);
}

test('identity: exact-entry equality forgives key order and nothing else', () => {
  const base = entry('clm_k', 'claim', claimData());
  const reordered = {
    actor: { id: 'synthetic-recorder-a', kind: 'human' },
    created_at: T,
    data: { why: 'synthetic fixture', scope: 'synthetic adults cohort',
      attributed_to: 'synthetic-author', kind: 'assertion', text: 'Synthetic claim about dosage X.' },
    id: 'clm_k',
    type: 'claim',
  };
  assert.equal(exactEntryEquals(base, reordered), true);
  assertSchemaValid([base, { ...reordered, id: 'clm_reordered_ok' }]);

  const variants = [
    ['text edit', entry('clm_k', 'claim', claimData({ text: 'Synthetic claim about dosage X!' }))],
    ['attribution', entry('clm_k', 'claim', claimData({ attributed_to: 'someone-else' }))],
    ['scope dropped', entry('clm_k', 'claim', (() => { const { scope, ...rest } = claimData(); return rest; })())],
    ['kind', entry('clm_k', 'claim', claimData({ kind: 'hypothesis' }))],
    ['actor', entry('clm_k', 'claim', claimData(), recorderB)],
    ['created_at', entry('clm_k', 'claim', claimData(), recorderA, U)],
    ['id', entry('clm_other', 'claim', claimData())],
  ];
  for (const [label, variant] of variants) {
    assert.equal(exactEntryEquals(base, variant), false, label);
  }
  // A type mismatch is a different body even when the payload shape overlaps.
  const reviewShaped = entry('clm_k', 'review',
    { target_id: 'clm_target', state: 'accepted', rationale: 'synthetic rationale' });
  assert.equal(exactEntryEquals(base, reviewShaped), false, 'type');
  // The ID-blind comparison exists only for analysis, never for unification.
  assert.equal(exactContentEquals(base, variants[6][1]), true);
  assert.equal(exactContentEquals(base, variants[0][1]), false);
  assert.equal(exactContentEquals(base, reviewShaped), false);
});

test('identity: strings compare byte-identically, never normalized', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }),
    canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  const nfc = 'caf\u00e9 dosage';
  const nfd = 'cafe\u0301 dosage';
  assert.notEqual(canonicalJson(nfc), canonicalJson(nfd));
  assert.notEqual(canonicalJson('CO2'), canonicalJson('ＣＯ２'));
  assert.notEqual(canonicalJson('dose'), canonicalJson('dose '));
  assert.notEqual(canonicalJson('Dose'), canonicalJson('dose'));

  const base = entry('clm_u', 'claim', claimData({ text: 'caf\u00e9 dosage ＣＯ２' }));
  for (const [label, text] of [
    ['nfd twin', 'cafe\u0301 dosage ＣＯ２'],
    ['halfwidth twin', 'caf\u00e9 dosage CO2'],
    ['trailing space', 'caf\u00e9 dosage ＣＯ２ '],
  ]) {
    assert.equal(exactEntryEquals(base, entry('clm_u', 'claim', claimData({ text }))), false, label);
  }
  // Multibyte Japanese fixtures get the same byte treatment: one char differs.
  const jp = entry('clm_jp', 'claim', claimData({ text: '合成投与量は有効だった。' }));
  const jpTwin = entry('clm_jp', 'claim', claimData({ text: '合成投与量は有効である。' }));
  assert.equal(exactEntryEquals(jp, jpTwin), false);
  assertSchemaValid([base, jp]);
});

test('identity: a body match with a different recorder or time is a provenance conflict', () => {
  const local = entry('clm_p', 'claim', claimData());
  const otherRecorder = entry('clm_p', 'claim', claimData(), recorderB);
  const otherTime = entry('clm_p', 'claim', claimData(), recorderA, U);
  assert.equal(classifySameId(local, local, noTombstones), 'same-entry');
  assert.equal(classifySameId(local, otherRecorder, noTombstones), 'different-provenance');
  assert.equal(classifySameId(local, otherTime, noTombstones), 'different-provenance');
  assert.equal(outcomeFor('same-id-different-provenance').outcome, 'needs-decision');
  assertSchemaValid([local]);
});

test('identity: ledger path, name, DOI, and URI text never prove origin', () => {
  assert.equal(sameOriginIdentity({ origin: 'ledger-a', id: 'clm_k' }, { origin: 'ledger-a', id: 'clm_k' }), true);
  assert.equal(sameOriginIdentity({ origin: null, id: 'clm_k' }, { origin: null, id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ origin: null, id: 'clm_k' }, { origin: 'ledger-a', id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ origin: 'ledger-a', id: 'clm_k' }, { origin: 'ledger-b', id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ origin: 'ledger-a', id: 'clm_k' }, { origin: 'ledger-a', id: 'clm_j' }), false);
  // Unknown never matches, even against itself: omitted, undefined, and
  // empty labels are all unknown at runtime, never the same origin.
  assert.equal(sameOriginIdentity({ id: 'clm_k' }, { id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ origin: undefined, id: 'clm_k' }, { origin: undefined, id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ origin: undefined, id: 'clm_k' }, { origin: null, id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ origin: '', id: 'clm_k' }, { origin: '', id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ origin: '', id: 'clm_k' }, { origin: 'ledger-a', id: 'clm_k' }), false);
  assert.equal(sameOriginIdentity({ id: 'clm_k' }, { origin: 'ledger-a', id: 'clm_k' }), false);

  // Same DOI/URI text under different IDs: distinct records, never unified.
  const doiA = entry('src_a', 'source', { title: 'Synthetic paper', medium: 'paper',
    uri: 'https://example.test/synthetic', identifiers: { doi: '10.0000/synthetic' } });
  const doiB = entry('src_b', 'source', { title: 'Synthetic paper', medium: 'paper',
    uri: 'https://example.test/synthetic', identifiers: { doi: '10.0000/synthetic' } });
  assert.equal(exactEntryEquals(doiA, doiB), false);
  assert.equal(outcomeFor('different-ids-similar-text').outcome, 'allowed');
  assert.equal(outcomeFor('auto-unify-similar').outcome, 'refused');
  // Same URI, new edition, same ID: a different body, not the same record.
  const v1 = entry('src_v', 'source', { title: 'Synthetic paper', medium: 'paper',
    uri: 'https://example.test/synthetic', version: 'v1' });
  const v2 = entry('src_v', 'source', { title: 'Synthetic paper', medium: 'paper',
    uri: 'https://example.test/synthetic', version: 'v2' });
  assert.equal(classifySameId(v1, v2, noTombstones), 'different-body');
  assertSchemaValid([doiA, doiB, v1]);
});

test('identity: same-ID classification covers body, provenance, and tombstones', () => {
  const local = entry('clm_c', 'claim', claimData());
  assert.equal(classifySameId(local, entry('clm_c', 'claim', claimData()), noTombstones), 'same-entry');
  assert.equal(classifySameId(local,
    entry('clm_c', 'claim', claimData({ text: 'Synthetic claim about dosage Y.' })), noTombstones), 'different-body');
  assert.equal(classifySameId(local,
    entry('clm_c', 'claim', claimData({ scope: 'synthetic children cohort' })), noTombstones), 'different-body');
  assert.equal(classifySameId(local,
    entry('clm_c', 'review', { target_id: 'clm_c', state: 'accepted', rationale: 'synthetic' }), noTombstones),
    'different-body');

  // Tombstone detection is caller-supplied (#23 owns the representation);
  // a tombstone on EITHER side — or both — is a privacy-sensitive collision.
  // The stand-in detector keys on content, not object identity, and the two
  // tombstones below are distinct but byte-equal objects: without the
  // short-circuit they would read as same-entry.
  const TOMB_TEXT = 'Redacted placeholder, not the original.';
  const full = entry('clm_t', 'claim', claimData());
  const tombA = entry('clm_t', 'claim', claimData({ text: TOMB_TEXT }));
  const tombB = entry('clm_t', 'claim', claimData({ text: TOMB_TEXT }));
  const isTomb = candidate => candidate.data.text === TOMB_TEXT;
  assert.equal(exactEntryEquals(tombA, tombB), true);
  assert.equal(classifySameId(full, tombA, isTomb), 'tombstone-collision');
  assert.equal(classifySameId(tombA, full, isTomb), 'tombstone-collision');
  assert.equal(classifySameId(tombA, tombB, isTomb), 'tombstone-collision');
  assert.equal(classifySameId(full, full, isTomb), 'same-entry');
  const row = outcomeFor('tombstone-collision');
  assert.equal(row.outcome, 'needs-decision');
  assert.equal(row.privacySensitive, true);
  assert.equal(outcomeFor('redacted-vs-full').privacySensitive, true);
  assert.throws(() => classifySameId(local,
    entry('clm_else', 'claim', claimData()), noTombstones), /same-ID pair/);
});

test('identity: classification fails closed without an explicit tombstone detector', () => {
  const a = entry('clm_d', 'claim', claimData());
  const b = entry('clm_d', 'claim', claimData());
  // No silent "not a tombstone" default: an omitted detector throws rather
  // than letting an equal pair through as same-entry.
  assert.throws(() => classifySameId(a, b), /explicit tombstone detector/);
  assert.throws(() => classifySameId(a, b, null), /explicit tombstone detector/);
  assert.equal(classifySameId(a, b, noTombstones), 'same-entry');
});

test('identity: outcome table covers every issue-30 case with no silent success', () => {
  const expected = {
    'same-id-same-entry': ['allowed', false],
    'same-id-different-body': ['needs-decision', false],
    'same-id-different-provenance': ['needs-decision', false],
    'same-text-different-scope': ['allowed', false],
    'different-ids-similar-text': ['allowed', false],
    'legacy-origin-less-exact': ['allowed', false],
    'legacy-origin-less-diverged': ['needs-decision', false],
    'copied-ledger-exact': ['allowed', false],
    'copied-ledger-diverged': ['needs-decision', false],
    'redacted-vs-full': ['needs-decision', true],
    'tombstone-collision': ['needs-decision', true],
    'auto-unify-similar': ['refused', false],
    'overwrite-immutable-id': ['refused', false],
    'silent-prefer-local': ['refused', false],
  };
  assert.deepEqual(MERGE_IDENTITY_OUTCOMES.map(r => r.caseId).sort(), Object.keys(expected).sort());
  for (const row of MERGE_IDENTITY_OUTCOMES) {
    assert.deepEqual([row.outcome, row.privacySensitive], expected[row.caseId], row.caseId);
    assert.ok(row.rule.length > 0, row.caseId);
    assert.equal(outcomeFor(row.caseId), row);
  }
  // Privacy-sensitive rows never resolve by restoring a body.
  for (const caseId of ['redacted-vs-full', 'tombstone-collision']) {
    assert.match(outcomeFor(caseId).rule, /[Nn]ever restore/);
  }
  assert.throws(() => outcomeFor('no-such-case'), /unknown merge-identity case/);
});

test('identity: fork inventory matches references() for every record type', () => {
  assert.deepEqual(Object.keys(FORK_REWRITTEN_REFERENCE_FIELDS).sort(),
    ['assessment', 'claim', 'evidence', 'relation', 'review', 'source', 'verification']);
  const fixtures = {
    source: { id: 'src_f', type: 'source', data: { title: 'Synthetic', medium: 'note', uri: 'urn:yurai:synthetic:f' } },
    claim: { id: 'clm_f', type: 'claim', data: claimData() },
    evidence: { id: 'evd_f', type: 'evidence', data: { source_id: 'src_f', quote: 'synthetic span' } },
    assessment: { id: 'asm_f', type: 'assessment',
      data: { claim_id: 'clm_f', evidence_id: 'evd_f', stance: 'supports', rationale: 'synthetic' } },
    relation: { id: 'rel_f', type: 'relation',
      data: { from_claim_id: 'clm_f', to_claim_id: 'clm_g', relation: 'supports', rationale: 'synthetic' } },
    review: { id: 'rev_f', type: 'review',
      data: { target_id: 'clm_f', state: 'accepted', rationale: 'synthetic' } },
    verification: { id: 'vrf_f', type: 'verification',
      data: { target_evidence_id: 'evd_f', target_source_id: 'src_f', outcome: 'mismatch',
        method: 'verbatim', verified_at: T, searched_sha256: '0'.repeat(64), searched_bytes: 3 } },
  };
  for (const [type, input] of Object.entries(fixtures)) {
    const refs = references(input);
    const fields = FORK_REWRITTEN_REFERENCE_FIELDS[type];
    assert.equal(fields.length, refs.length, `${type}: every reference rewrites, nothing else`);
    for (const ref of refs) {
      assert.ok(fields.some(field => input.data[field] === ref.id), `${type}: ${ref.role} ${ref.id}`);
    }
  }
  assert.deepEqual(FORK_REWRITTEN_REFERENCE_FIELDS.claim, []);
  assert.deepEqual(FORK_REWRITTEN_REFERENCE_FIELDS.source, []);
  assertSchemaValid(Object.values(fixtures).map(input => ({ ...input, actor: recorderA, created_at: T }))
    .concat([entry('clm_g', 'claim', claimData({ text: 'Synthetic second claim.' }))]));
});

test('identity: origin-less fork mappings collide until a distinct import namespace is supplied', () => {
  // Two unrelated origin-less snapshots containing clm_k both produce the
  // (null, clm_k) key: one slot cannot preserve both mappings, so the fork
  // refuses until the operator supplies a distinct import namespace per
  // import (namespace mechanics belong to #31).
  const snapA = { origin: null, id: 'clm_k' };
  const snapB = { origin: null, id: 'clm_k' };
  assert.equal(sameForkMappingKey(snapA, snapB), true);
  // ...yet unknown origins never prove the same ledger, so the merger
  // cannot tell an idempotent replay from an unrelated collision.
  assert.equal(sameOriginIdentity(snapA, snapB), false);
  // Every unknown spelling collides on the same key.
  assert.equal(sameForkMappingKey({ id: 'clm_k' }, snapA), true);
  assert.equal(sameForkMappingKey({ origin: '', id: 'clm_k' }, snapA), true);
  assert.equal(sameForkMappingKey({ origin: undefined, id: 'clm_k' }, snapB), true);
  // Distinct operator-supplied namespaces stop colliding.
  assert.equal(sameForkMappingKey(
    { origin: 'synthetic-import-a', id: 'clm_k' },
    { origin: 'synthetic-import-b', id: 'clm_k' }), false);
  // Same known label + same id is the idempotent replay key, not a
  // cross-import collision.
  assert.equal(sameForkMappingKey(
    { origin: 'synthetic-import-a', id: 'clm_k' },
    { origin: 'synthetic-import-a', id: 'clm_k' }), true);
  assert.equal(sameOriginIdentity(
    { origin: 'synthetic-import-a', id: 'clm_k' },
    { origin: 'synthetic-import-a', id: 'clm_k' }), true);
  // Different ids never share a slot even under one origin.
  assert.equal(sameForkMappingKey(
    { origin: 'synthetic-import-a', id: 'clm_k' },
    { origin: 'synthetic-import-a', id: 'clm_j' }), false);
});

test('identity: remapped IDs must stay inside the ledger ID grammar', () => {
  for (const id of ['clm_k_m1', 'a1', 'A._:-9', 'x'.repeat(128)]) {
    assert.equal(isLedgerId(id), true, id);
  }
  for (const id of ['', 'x', '1abc', 'has space', 'uni\u00e7ode', 'x'.repeat(129), '-lead']) {
    assert.equal(isLedgerId(id), false, JSON.stringify(id));
  }
});

test('identity: no merge machinery is activated', () => {
  for (const method of ['merge', 'mergeSnapshot', 'importForeign', 'remap', 'applyMerge', 'resolveConflict']) {
    assert.equal(method in Ledger.prototype, false, method);
  }
  // The spec module classifies only: fixed function and table surface.
  assert.deepEqual(Object.keys(mergeIdentity).sort(), [
    'FORK_REWRITTEN_REFERENCE_FIELDS', 'MERGE_IDENTITY_OUTCOMES', 'canonicalJson', 'classifySameId',
    'exactContentEquals', 'exactEntryEquals', 'isLedgerId', 'outcomeFor', 'sameForkMappingKey',
    'sameOriginIdentity',
  ]);
});

test('identity: restore exists but is not a merge', () => {
  // Pure surface assertion, no Store: the ledger exposes whole-snapshot
  // restore (refusal into a non-empty ledger is covered by ledger.test.mjs),
  // while no merge entry point exists for restore to silently become.
  assert.equal(typeof Ledger.prototype.exportSnapshot, 'function');
  assert.equal(typeof Ledger.prototype.importSnapshot, 'function');
  for (const method of ['merge', 'mergeSnapshot', 'importForeign', 'remap', 'applyMerge', 'resolveConflict']) {
    assert.equal(method in Ledger.prototype, false, method);
  }
});
