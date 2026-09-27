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

test('retrieval eval: expected claims are found and excluded ones stay out', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const failures = [];
  let elapsedMs = 0;
  let expansionPaths = 0;
  for (const q of queries) {
    const started = Date.now();
    const result = ledgerApi.search(q.query, {
      limit: q.limit ?? 50,
      includeInactive: q.includeInactive ?? false,
      ...(q.mode === 'expanded' ? { expand: 'evidence' } : {}),
    });
    elapsedMs += Date.now() - started;
    const retrieved = result.items.map(i => i.entry.id);
    if (q.mode === 'expanded') expansionPaths += result.items.reduce((n, i) => n + (i.total_paths ?? 0), 0);
    for (const id of q.expect_any) {
      if (!retrieved.includes(id)) failures.push(`${q.id}: missing ${id} for ${JSON.stringify(q.query)}`);
    }
    for (const id of q.expect_none) {
      if (retrieved.includes(id)) failures.push(`${q.id}: unexpected ${id} for ${JSON.stringify(q.query)}`);
    }
    if (q.expect_next_offset !== undefined) {
      const hasMore = result.next_offset !== null && result.next_offset !== undefined;
      if (hasMore !== q.expect_next_offset) failures.push(`${q.id}: next_offset is ${result.next_offset}`);
    }
  }
  const snapshotBytes = Buffer.byteLength(JSON.stringify(ledgerApi.exportSnapshot()), 'utf8');
  console.log(JSON.stringify({
    eval: 'retrieval', cases: queries.length, failures: failures.length,
    elapsed_ms: elapsedMs, expansion_paths: expansionPaths, snapshot_bytes: snapshotBytes,
  }));
  assert.deepEqual(failures, []);
});

test('retrieval eval: one claim keeps supporting and challenging assessments apart', t => {
  const { store, ledgerApi } = setup();
  t.after(() => store.close());
  const view = ledgerApi.show('clm_eval_drop');
  const stances = new Set(view.connections
    .filter(c => c.entry.type === 'assessment')
    .map(c => c.entry.data.stance));
  assert.ok(stances.has('supports'));
  assert.ok(stances.has('challenges'));
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
