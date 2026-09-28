import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ledger, SqliteStore } from '../dist/index.js';

const ledger = JSON.parse(readFileSync(new URL('../examples/eval/ledger.json', import.meta.url), 'utf8'));
const ledgerWdDeps = JSON.parse(readFileSync(new URL('../examples/eval/ledger-wd-deps.json', import.meta.url), 'utf8'));
const ledgerVerify = JSON.parse(readFileSync(new URL('../examples/eval/ledger-verify.json', import.meta.url), 'utf8'));
const queries = JSON.parse(readFileSync(new URL('../examples/eval/queries.json', import.meta.url), 'utf8'));

function setup() {
  const store = new SqliteStore(':memory:', true);
  const ledgerApi = new Ledger(store);
  ledgerApi.capture(ledger);
  ledgerApi.capture(ledgerWdDeps);
  ledgerApi.capture(ledgerVerify);
  return { store, ledgerApi };
}

const tuple = (claim, evidence, assessment, stance, fields) =>
  [claim, evidence, assessment, stance, [...fields].sort().join('+')].join('|');

function actualPaths(items) {
  const out = [];
  for (const item of items) {
    for (const v of item.via ?? []) {
      out.push(tuple(item.entry.id, v.evidence.entry.id, v.assessment.entry.id,
        v.assessment.entry.data.stance, v.match_fields));
    }
  }
  return out.sort();
}

test('retrieval eval: exact claim sets and exact routed-path sets', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const failures = [];
  const detail = [];
  let elapsedMs = 0;
  let expansionPaths = 0;
  for (const q of queries) {
    const started = Date.now();
    const result = ledgerApi.search(q.query, {
      limit: q.limit ?? 50,
      includeInactive: q.includeInactive ?? false,
      ...(q.mode === 'expanded' ? { expand: 'evidence' } : {}),
    });
    const caseMs = Date.now() - started;
    elapsedMs += caseMs;
    const retrieved = result.items.map(i => i.entry.id);
    const byId = new Map(result.items.map(i => [i.entry.id, i]));
    const missed = [];
    const unexpected = [];
    if (q.mode === 'expanded') expansionPaths += result.items.reduce((n, i) => n + (i.total_paths ?? 0), 0);
    if (q.partial) {
      const allowed = new Set(q.expect_subset_of ?? []);
      for (const id of retrieved) {
        if (!allowed.has(id)) unexpected.push(id);
      }
      if (result.items.length !== (q.limit ?? 50)) missed.push(`page size ${result.items.length}`);
    } else {
      const expected = new Set(q.expect_ids ?? []);
      for (const id of expected) {
        if (!retrieved.includes(id)) missed.push(id);
      }
      for (const id of retrieved) {
        if (!expected.has(id)) unexpected.push(id);
      }
    }
    for (const id of q.expect_direct ?? []) {
      if (!byId.get(id)?.direct_match) missed.push(`direct:${id}`);
    }
    for (const id of q.expect_routed_only ?? []) {
      const item = byId.get(id);
      if (!item || item.direct_match) missed.push(`routed-only:${id}`);
    }
    if (q.mode === 'expanded' && !q.partial) {
      for (const item of result.items) {
        for (const v of item.via ?? []) {
          if (v.source.entry.id !== v.evidence.entry.data.source_id) {
            missed.push(`source-mismatch:${v.evidence.entry.id}->${v.source.entry.id}`);
          }
        }
      }
      const actual = actualPaths(result.items);
      const expected = (q.expect_paths ?? []).map(p =>
        tuple(p.claim, p.evidence, p.assessment, p.stance, p.fields ?? [])).sort();
      for (const p of expected) {
        if (!actual.includes(p)) missed.push(`path:${p}`);
      }
      for (const p of actual) {
        if (!expected.includes(p)) unexpected.push(`path:${p}`);
      }
      detail.push({ id: q.id, query: q.query, retrieved, paths: actual, missed, unexpected, elapsed_ms: caseMs });
    } else {
      detail.push({ id: q.id, query: q.query, retrieved, missed, unexpected, elapsed_ms: caseMs });
    }
    if (q.expect_next_offset !== undefined) {
      const hasMore = result.next_offset !== null && result.next_offset !== undefined;
      if (hasMore !== q.expect_next_offset) missed.push(`next_offset:${result.next_offset}`);
    }
    for (const m of [...missed, ...unexpected.map(u => `unexpected:${u}`)]) failures.push(`${q.id}: ${m}`);
  }
  const snapshotBytes = Buffer.byteLength(JSON.stringify(ledgerApi.exportSnapshot()), 'utf8');
  console.log(JSON.stringify({
    eval: 'retrieval', cases: queries.length, failures: failures.length,
    elapsed_ms: elapsedMs, expansion_paths: expansionPaths, snapshot_bytes: snapshotBytes,
    detail,
  }));
  assert.deepEqual(failures, []);
});

test('retrieval eval: the universal claim keeps supporting and challenging assessments apart', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const view = ledgerApi.show('clm_eval_all');
  const stances = new Set(view.connections
    .filter(c => c.entry.type === 'assessment')
    .map(c => c.entry.data.stance));
  assert.deepEqual(stances, new Set(['supports', 'challenges']));
});

test('retrieval eval: the scoped drop claim takes no challenges, only qualification', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const view = ledgerApi.show('clm_eval_drop');
  const stances = view.connections
    .filter(c => c.entry.type === 'assessment')
    .map(c => c.entry.data.stance);
  assert.ok(!stances.includes('challenges'));
  const relations = view.connections.filter(c => c.entry.type === 'relation');
  assert.ok(relations.some(c => c.entry.data.relation === 'qualifies'));
});

test('retrieval eval: withdrawn evidence path keeps full states on the audit path', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const result = ledgerApi.search('OLDTERM', { expand: 'evidence', includeInactive: true });
  const item = result.items.find(i => i.entry.id === 'clm_eval_drop');
  assert.ok(item);
  assert.ok(item.via.length > 0);
  assert.equal(item.state, 'proposed');
  assert.equal(item.via[0].evidence.state, 'withdrawn');
  assert.equal(item.via[0].assessment.state, 'proposed');
  assert.equal(item.via[0].source.state, 'proposed');
});

test('retrieval eval: withdrawn assessment path keeps full states on the audit path', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const result = ledgerApi.search('WDASMTERM', { expand: 'evidence', includeInactive: true });
  const item = result.items.find(i => i.entry.id === 'clm_eval_drop');
  assert.ok(item);
  assert.ok(item.via.length > 0);
  assert.equal(item.state, 'proposed');
  assert.equal(item.via[0].evidence.state, 'proposed');
  assert.equal(item.via[0].assessment.state, 'withdrawn');
  assert.equal(item.via[0].source.state, 'proposed');
});

test('retrieval eval: routed results carry paths, never corroboration counts', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const result = ledgerApi.search('38℃', { expand: 'evidence' });
  assert.ok(result.items.length > 1);
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item).sort(),
      ['direct_match', 'entry', 'paths_truncated', 'review', 'state', 'total_paths', 'via', 'via_next_offset', 'warnings']);
    assert.ok(item.via.length > 0);
    for (const v of item.via) {
      assert.deepEqual(Object.keys(v).sort(), ['assessment', 'evidence', 'match_fields', 'source']);
      for (const side of ['evidence', 'assessment', 'source']) {
        assert.ok(v[side].entry.id);
        assert.ok(['proposed', 'accepted', 'rejected', 'withdrawn'].includes(v[side].state));
      }
      assert.ok(v.match_fields.length > 0);
    }
    if (!item.paths_truncated) assert.equal(item.total_paths, item.via.length);
  }
});

test('retrieval eval: withdrawn source path keeps full states on the audit path', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const result = ledgerApi.search('WDSRCTERM', { expand: 'evidence', includeInactive: true });
  const item = result.items.find(i => i.entry.id === 'clm_eval_drop');
  assert.ok(item);
  assert.ok(item.via.length > 0);
  assert.equal(item.state, 'proposed');
  assert.equal(item.via[0].evidence.state, 'proposed');
  assert.equal(item.via[0].assessment.state, 'proposed');
  assert.equal(item.via[0].source.state, 'withdrawn');
});

test('retrieval eval: routed paths preserve review, verification, and provenance', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const result = ledgerApi.search('38℃', { expand: 'evidence' });
  const item = result.items.find(i => i.entry.id === 'clm_eval_xz7');
  assert.ok(item);
  // Attribution, scope, and motive survive on the routed claim, as does the recorder.
  assert.equal(item.entry.data.attributed_to, 'fictional-experimenter');
  assert.deepEqual(item.entry.actor, { kind: 'agent', id: 'fixture-agent' });
  assert.ok(item.entry.data.scope.includes('XZ-7'));
  assert.ok(item.entry.data.why.length > 0);
  const path = item.via.find(v => v.evidence.entry.id === 'evd_eval_xz7');
  assert.ok(path);
  for (const side of [path.evidence, path.assessment, path.source]) {
    assert.deepEqual(side.entry.actor, { kind: 'agent', id: 'fixture-agent' });
  }
  // The review and verification came from a later capture by a distinct
  // recorder, so substitution with the claim actor cannot pass silently.
  assert.deepEqual(path.assessment.review.actor, { kind: 'agent', id: 'fixture-verifier' });
  assert.deepEqual(path.evidence.verification.actor, { kind: 'agent', id: 'fixture-verifier' });
  // The verified anchor carries its verification summary and edition agreement.
  assert.equal(path.evidence.verification.id, 'vrf_eval_xz7');
  assert.equal(path.evidence.verification.outcome, 'match');
  assert.equal(path.evidence.verification.edition.agreement, 'match');
  assert.deepEqual(path.evidence.verification, ledgerApi.show('evd_eval_xz7').verification);
  assert.ok(path.evidence.warnings.includes('anchor_match'));
  assert.ok(!path.evidence.warnings.includes('anchor_not_verified'));
  // The fixture verification is internally consistent: its pinned passage is
  // exactly the stored quote, so verifyEvidence() could have produced it.
  const pinned = ledgerApi.show('vrf_eval_xz7').entry.data;
  const quote = path.evidence.entry.data.quote;
  assert.equal(pinned.occurrences, 1);
  assert.equal(pinned.byte_length, Buffer.byteLength(quote, 'utf8'));
  assert.equal(pinned.passage_sha256, createHash('sha256').update(quote, 'utf8').digest('hex'));
  // The accepted assessment carries its review, stance, and rationale.
  assert.equal(path.assessment.state, 'accepted');
  assert.equal(path.assessment.review.data.state, 'accepted');
  assert.deepEqual(path.assessment.review, ledgerApi.show('asm_eval_xz7').review);
  assert.equal(path.assessment.entry.data.stance, 'supports');
  assert.ok(path.assessment.entry.data.rationale.includes('Table 2'));
  // Provenance: the attached source is the evidence's own declared source.
  assert.equal(path.source.entry.id, path.evidence.entry.data.source_id);
  assert.equal(path.source.entry.data.version, 'v1');
  // The same verified anchor on the opposing path keeps its summary while
  // the two paths stay separate assessments.
  const rival = result.items.find(i => i.entry.id === 'clm_eval_all');
  assert.ok(rival);
  const challenge = rival.via.find(v => v.evidence.entry.id === 'evd_eval_xz7');
  assert.ok(challenge);
  assert.equal(challenge.assessment.entry.id, 'asm_eval_all_challenge');
  assert.equal(challenge.assessment.entry.data.stance, 'challenges');
  assert.notEqual(challenge.assessment.entry.id, path.assessment.entry.id);
  assert.equal(challenge.evidence.verification.outcome, 'match');
  assert.deepEqual(challenge.evidence.verification, path.evidence.verification);
  // The unverified sibling anchor still says so instead of borrowing coverage.
  const drop = result.items.find(i => i.entry.id === 'clm_eval_drop');
  assert.ok(drop);
  const unverified = drop.via.find(v => v.evidence.entry.id === 'evd_eval_drop');
  assert.ok(unverified);
  assert.equal(unverified.evidence.verification, null);
  assert.ok(unverified.evidence.warnings.includes('anchor_not_verified'));
});
