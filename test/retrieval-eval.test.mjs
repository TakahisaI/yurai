import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ledger, SqliteStore } from '../dist/index.js';

const ledger = JSON.parse(readFileSync(new URL('../examples/eval/ledger.json', import.meta.url), 'utf8'));
const queries = JSON.parse(readFileSync(new URL('../examples/eval/queries.json', import.meta.url), 'utf8'));

function setup() {
  const store = new SqliteStore(':memory:', true);
  const ledgerApi = new Ledger(store);
  ledgerApi.capture(ledger);
  return { store, ledgerApi };
}

function checkPaths(item, expected, missed) {
  for (const p of expected) {
    const via = (item?.via ?? []).find(v =>
      v.evidence.entry.id === p.evidence && v.assessment.entry.id === p.assessment);
    if (!via) { missed.push(`path ${p.claim}/${p.evidence}/${p.assessment}: absent`); continue; }
    if (via.assessment.entry.data.stance !== p.stance) {
      missed.push(`path ${p.claim}/${p.evidence}/${p.assessment}: stance is ${via.assessment.entry.data.stance}`);
    }
    for (const field of p.fields ?? []) {
      if (!via.match_fields.includes(field)) {
        missed.push(`path ${p.claim}/${p.evidence}/${p.assessment}: missing field ${field}`);
      }
    }
  }
}

test('retrieval eval: expected claims, paths, stances, and fields', t => {
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
    for (const id of q.expect_any ?? []) {
      if (!retrieved.includes(id)) missed.push(id);
    }
    for (const id of q.expect_none ?? []) {
      if (retrieved.includes(id)) unexpected.push(id);
    }
    for (const id of q.expect_direct ?? []) {
      if (!byId.get(id)?.direct_match) missed.push(`direct:${id}`);
    }
    for (const id of q.expect_routed_only ?? []) {
      const item = byId.get(id);
      if (!item || item.direct_match) missed.push(`routed-only:${id}`);
    }
    for (const p of q.expect_paths ?? []) {
      checkPaths(byId.get(p.claim), [p], missed);
    }
    if (q.expect_next_offset !== undefined) {
      const hasMore = result.next_offset !== null && result.next_offset !== undefined;
      if (hasMore !== q.expect_next_offset) missed.push(`next_offset:${result.next_offset}`);
    }
    for (const m of [...missed, ...unexpected.map(u => `unexpected:${u}`)]) failures.push(`${q.id}: ${m}`);
    detail.push({ id: q.id, query: q.query, retrieved, missed, unexpected, elapsed_ms: caseMs });
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
  assert.equal(item.via[0].evidence.state, 'withdrawn');
});
