import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, LedgerError, SqliteStore } from '../dist/index.js';

const example = JSON.parse(readFileSync(new URL('../examples/capture.json', import.meta.url), 'utf8'));
const actor = { kind: 'agent', id: 'test-agent', model: 'synthetic' };
const claim = (id, text = '出生率 AI evidence 100% a_b "quote" ＡＢＣ') => ({ id, type: 'claim',
  data: { text, kind: 'hypothesis', attributed_to: 'test', scope: 'not a real research finding' } });
const bundle = (entries, request_id = 'req_test') => ({ version: 1, request_id, actor, entries });
function setup(t) {
  const store = new SqliteStore(':memory:', true);
  t.after(() => store.close());
  return { store, ledger: new Ledger(store, () => '2026-09-27T00:00:00.000Z') };
}
function code(expected) { return e => e instanceof LedgerError && e.code === expected; }

test('complete capture retrieves claim, attribution, evidence, source and qualification', t => {
  const { store, ledger } = setup(t);
  ledger.capture(example);
  const view = ledger.show('clm_demo');
  assert.equal(view.entry.data.attributed_to, '架空の実験者');
  const connection = view.connections.find(c => c.entry.type === 'assessment');
  assert.equal(connection.entry.data.stance, 'reports');
  assert.equal(connection.references.find(r => r.entry.type === 'evidence').entry.data.quote, '条件X: A=80, B=70（架空の値）');
  assert.equal(connection.sources[0].entry.id, 'src_demo');
  assert.equal(view.truth_evaluated, false);
  assert.equal(store.doctor().ok, true);
});
test('supports, challenges and source reports are preserved separately for one span', t => {
  const { ledger } = setup(t); ledger.capture(example);
  ledger.capture(bundle(['supports', 'challenges'].map(stance => ({ id: `asm_${stance}`, type: 'assessment',
    data: { claim_id: 'clm_demo', evidence_id: 'evd_demo', stance, rationale: `test ${stance}` } }))));
  assert.deepEqual(new Set(ledger.show('clm_demo').connections.filter(c => c.entry.type === 'assessment').map(c => c.entry.data.stance)),
    new Set(['reports','supports','challenges']));
});
test('idempotent retry is canonical for object key order, not altered payloads', t => {
  const { store, ledger } = setup(t); const original = bundle([claim('clm_one')]);
  const saved = ledger.capture(original);
  assert.equal(ledger.capture({ entries: original.entries, actor, request_id: 'req_test', version: 1 }).replayed, true);
  assert.equal(store.count(), 1);
  assert.throws(() => ledger.capture(bundle([claim('clm_one', 'changed')])), code('CONFLICT'));
  assert.equal(saved.ids[0], 'clm_one');
});
test('dry run writes neither records nor receipts', t => {
  const { store, ledger } = setup(t); ledger.capture(example, true);
  assert.equal(store.count(), 0); assert.equal(store.receipts().length, 0);
  assert.equal(ledger.capture(example).replayed, false);
});
test('dangling and wrong-typed references reject the whole bundle', t => {
  const { store, ledger } = setup(t);
  assert.throws(() => ledger.capture(bundle([claim('clm_one'), { id: 'evd_bad', type: 'evidence', data: { source_id: 'src_missing', quote: 'x' } }])), code('NOT_FOUND'));
  assert.equal(store.count(), 0);
  assert.throws(() => ledger.capture(bundle([claim('clm_one'), { id: 'evd_bad', type: 'evidence', data: { source_id: 'clm_one', quote: 'x' } }])), code('VALIDATION'));
  assert.equal(store.count(), 0); assert.equal(store.receipts().length, 0);
});
test('forward references are allowed within an atomic capture', t => {
  const { store, ledger } = setup(t);
  ledger.capture({ ...example, entries: [...example.entries].reverse() });
  assert.equal(store.count(), 6); assert.equal(store.doctor().ok, true);
});
test('an injected storage failure rolls back content, index and receipt', t => {
  const { store, ledger } = setup(t);
  const insert = store.insert.bind(store); let n = 0;
  store.insert = e => { insert(e); if (++n === 2) throw new Error('injected failure'); };
  assert.throws(() => ledger.capture(bundle([claim('clm_one'), claim('clm_two')])));
  assert.equal(store.count(), 0); assert.equal(store.receipts().length, 0);
  assert.equal(ledger.search('AI').items.length, 0); assert.equal(store.doctor().ok, true);
});
test('blank, unknown, malformed, and oversized data are rejected', t => {
  const { ledger } = setup(t);
  for (const input of [claim('clm_one', ''), claim('clm_one', ' '.repeat(10)), claim('clm_one', 'x'.repeat(8001)),
    { ...claim('clm_one'), invented: true }, { ...claim('clm_one'), data: { ...claim('x').data, confidence: 0.9 } },
    { id: 'evd_one', type: 'evidence', data: { source_id: 'src_one', paraphrase: 'unanchored summary' } },
    { id: 'src_one', type: 'source', data: { title: 'unknown origin', medium: 'paper' } },
    { id: 'src_one', type: 'source', data: { title: 'a', medium: 'paper', uri: 'not-a-uri' } },
    { id: 'src_one', type: 'source', data: { title: 'a', medium: 'paper', uri: 'urn:test:a', accessed_at: '2026-02-31T00:00:00Z' } }])
    assert.throws(() => ledger.capture(bundle([input])), code('VALIDATION'));
  assert.throws(() => ledger.capture(bundle(Array.from({ length: 201 }, (_, i) => claim(`clm_${i}`)))), code('VALIDATION'));
});
test('duplicate immutable IDs are never silently overwritten or merged', t => {
  const { ledger } = setup(t);
  assert.throws(() => ledger.capture(bundle([claim('clm_one'), claim('clm_one')])), code('CONFLICT'));
  ledger.capture(bundle([claim('clm_one')]));
  assert.throws(() => ledger.capture(bundle([claim('clm_one')], 'req_other')), code('CONFLICT'));
});
test('Japanese, short terms, mixed tokens, punctuation and NFKC are literal', t => {
  const { ledger } = setup(t); ledger.capture(bundle([claim('clm_one')]));
  for (const q of ['出生率', '出生', '率', 'AI', '出生 AI', '100%', 'a_b', '"quote"', 'ABC'])
    assert.equal(ledger.search(q).items.length, 1, q);
  for (const q of ['100_', 'a%b', 'unknown', 'AI OR missing']) assert.equal(ledger.search(q).items.length, 0, q);
  assert.throws(() => ledger.search(''), code('VALIDATION'));
  assert.throws(() => ledger.search('AI', { limit: 0 }), code('VALIDATION'));
  assert.throws(() => ledger.search('AI', { offset: -1 }), code('VALIDATION'));
});
test('search is paginated, source search is explicit', t => {
  const { ledger } = setup(t); ledger.capture(bundle([claim('clm_one'), claim('clm_two'), claim('clm_three')]));
  const first = ledger.search('AI', { limit: 2 });
  assert.equal(first.next_offset, 2);
  assert.equal(ledger.search('AI', { limit: 2, offset: 2 }).next_offset, null);
  ledger.capture(example);
  assert.equal(ledger.search('架空', { kind: 'source' }).items[0].entry.id, 'src_demo');
});
test('review changes workflow status, not truth or quote verification', t => {
  const { ledger } = setup(t); ledger.capture(example);
  ledger.capture(bundle([{ id: 'rev_one', type: 'review', data: { target_id: 'evd_demo', state: 'accepted', rationale: 'retained, not checked' } }]));
  const evidence = ledger.show('evd_demo');
  assert.equal(evidence.state, 'accepted');
  assert.ok(evidence.warnings.includes('anchor_not_verified'));
  assert.equal(evidence.truth_evaluated, false);
});
test('review ordering uses insertion sequence and withdrawn records remain auditable', t => {
  const { ledger } = setup(t); ledger.capture(bundle([claim('clm_one')]));
  ledger.capture(bundle([{ id: 'rev_one', type: 'review', data: { target_id: 'clm_one', state: 'accepted', rationale: 'retain' } }], 'req_review1'));
  ledger.capture(bundle([{ id: 'rev_two', type: 'review', data: { target_id: 'clm_one', state: 'withdrawn', rationale: 'mistake' } }], 'req_review2'));
  assert.equal(ledger.search('AI').items.length, 0);
  assert.equal(ledger.search('AI', { includeInactive: true }).items.length, 1);
  assert.equal(ledger.show('clm_one').state, 'withdrawn');
  assert.equal(ledger.show('clm_one', 1).next_offset, 1);
});
test('inactive evidence is visible as inactive when inspecting a supported claim', t => {
  const { ledger } = setup(t); ledger.capture(example);
  ledger.capture(bundle([{ id: 'rev_one', type: 'review', data: { target_id: 'evd_demo', state: 'withdrawn', rationale: 'bad quote' } }]));
  const evidence = ledger.show('clm_demo').connections.find(c => c.entry.type === 'assessment').references.find(r => r.entry.type === 'evidence');
  assert.equal(evidence.state, 'withdrawn'); assert.ok(evidence.warnings.includes('inactive_record'));
});
test('supersedes direction is new to old and cycles are forbidden', t => {
  const { ledger } = setup(t);
  const relation = (id, from, to) => ({ id, type: 'relation', data: { from_claim_id: from, to_claim_id: to, relation: 'supersedes', rationale: 'correction' } });
  ledger.capture(bundle([claim('clm_old'), claim('clm_new'), relation('rel_new', 'clm_new', 'clm_old')]));
  assert.throws(() => ledger.capture(bundle([relation('rel_loop', 'clm_old', 'clm_new')], 'req_loop')), code('VALIDATION'));
  assert.throws(() => ledger.capture(bundle([relation('rel_self', 'clm_old', 'clm_old')], 'req_self')), code('VALIDATION'));
});
test('snapshot round trip preserves IDs, actors, receipts, order and retrieval', t => {
  const { ledger } = setup(t); const second = setup(t);
  ledger.capture(example);
  ledger.capture(bundle([{ id: 'rev_one', type: 'review', data: { target_id: 'clm_demo', state: 'accepted', rationale: 'retain' } }]));
  const snapshot = ledger.exportSnapshot();
  assert.equal(second.ledger.importSnapshot(snapshot).restored, 7);
  assert.deepEqual(second.ledger.exportSnapshot(), snapshot);
  assert.equal(second.ledger.capture(example).replayed, true);
  assert.deepEqual(second.ledger.show('clm_demo'), ledger.show('clm_demo'));
  assert.throws(() => second.ledger.importSnapshot(snapshot), code('CONFLICT'));
});
test('invalid snapshots roll back and cannot install dangling receipts', t => {
  const { store, ledger } = setup(t);
  const snapshot = { format: 'yurai.snapshot', version: 1, entries: [], receipts: [{ request_id: 'req_bad', digest: 'a'.repeat(64), ids: ['clm_missing'] }] };
  assert.throws(() => ledger.importSnapshot(snapshot), code('VALIDATION'));
  assert.equal(store.count(), 0); assert.equal(store.receipts().length, 0);
});
test('reopen, application identity, future schema refusal and immutable storage', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.sqlite');
  assert.throws(() => new SqliteStore(path), code('NOT_FOUND'));
  const first = new SqliteStore(path, true); new Ledger(first).capture(example); first.close();
  const reopened = new SqliteStore(path); assert.equal(reopened.count(), 6); reopened.close();
  const raw = new DatabaseSync(path);
  assert.throws(() => raw.exec("UPDATE records SET body='{}'"), /immutable/);
  assert.throws(() => raw.exec('DELETE FROM records'), /immutable/);
  raw.exec('PRAGMA user_version=999'); raw.close();
  assert.throws(() => new SqliteStore(path), code('SCHEMA'));
  const other = join(dir, 'other.sqlite'); const unknown = new DatabaseSync(other); unknown.exec('CREATE TABLE app (id INTEGER)'); unknown.close();
  assert.throws(() => new SqliteStore(other, true), code('SCHEMA'));
});

const dogfood = name => JSON.parse(readFileSync(new URL(`../examples/dogfood/${name}`, import.meta.url), 'utf8'));
test('inspectCapture pages original membership, expands grounds, and never mutates records', t => {
  const { ledger, store } = setup(t);
  ledger.capture(example);
  const before = ledger.exportSnapshot();
  // Inspect a known receipt without scanning/exporting the whole ledger.
  const entries = store.entries.bind(store);
  store.entries = () => { throw new Error('unexpected full-ledger scan'); };
  const first = ledger.inspectCapture(example.request_id, 2);
  assert.equal(first.total, 6); assert.equal(first.next_offset, 2);
  assert.equal(first.states_as_of, 'inspection'); assert.equal(first.truth_evaluated, false);
  const collected = [...first.items];
  for (let offset = first.next_offset; offset !== null;) {
    const page = ledger.inspectCapture(example.request_id, 2, offset);
    collected.push(...page.items); offset = page.next_offset;
  }
  assert.deepEqual(collected.map(v => v.entry.id), example.entries.map(e => e.id));
  const assessment = collected.find(v => v.entry.type === 'assessment');
  assert.equal(assessment.sources[0].entry.id, 'src_demo');
  assert.ok(assessment.references.find(v => v.entry.type === 'evidence').warnings.includes('anchor_not_verified'));
  assert.deepEqual(ledger.inspectCapture(example.request_id, 2, 100).items, []);
  store.entries = entries;
  assert.deepEqual(ledger.exportSnapshot(), before);
});
test('capture inspection survives restore and presents current reviews without rewriting events', t => {
  const { ledger } = setup(t), other = setup(t);
  const first = dogfood('01-capture.json'), correction = dogfood('02-correct.json');
  ledger.capture(first); ledger.capture(correction);
  const old = ledger.inspectCapture(first.request_id).items.find(v => v.entry.id === 'clm_fixture_old');
  assert.equal(old.state, 'withdrawn');
  assert.equal(old.entry.data.text, first.entries.find(e => e.id === old.entry.id).data.text);
  assert.equal(old.review.data.rationale, 'The universal wording exceeded the attached evidence.');
  const corrected = ledger.inspectCapture(correction.request_id);
  const edge = corrected.items.find(v => v.entry.id === 'rel_fixture_supersedes');
  assert.equal(edge.references.find(v => v.entry.id === 'clm_fixture_old').state, 'withdrawn');
  // A review event remains the original event even after its target is reviewed again.
  ledger.capture(bundle([{ id: 'rev_fixture_later', type: 'review', data: {
    target_id: 'clm_fixture_old', state: 'rejected', rationale: 'later decision' } }], 'req_fixture_later'));
  const event = ledger.inspectCapture(correction.request_id).items.find(v => v.entry.type === 'review');
  assert.equal(event.entry.data.state, 'withdrawn'); assert.equal(event.references[0].state, 'rejected');
  other.ledger.importSnapshot(ledger.exportSnapshot());
  assert.deepEqual(other.ledger.inspectCapture(correction.request_id), ledger.inspectCapture(correction.request_id));
  assert.equal(other.ledger.capture(correction).replayed, true);
});
test('capture inspection validates selection and never exposes a dry-run as saved', t => {
  const { ledger } = setup(t); ledger.capture(example, true);
  assert.throws(() => ledger.inspectCapture(example.request_id), code('NOT_FOUND'));
  for (const id of ['', 'x', 'bad id', 'a'.repeat(129), 42])
    assert.throws(() => ledger.inspectCapture(id), code('VALIDATION'));
  assert.throws(() => ledger.inspectCapture('req_missing', 0), code('VALIDATION'));
  assert.throws(() => ledger.inspectCapture('req_missing', 101), code('VALIDATION'));
  assert.throws(() => ledger.inspectCapture('req_missing', 20, -1), code('VALIDATION'));
});
test('synthetic dogfood preserves attribution, disagreement, correction and current literal-search limit', t => {
  const { ledger } = setup(t);
  ledger.capture(dogfood('01-capture.json')); ledger.capture(dogfood('02-correct.json'));
  const user = ledger.show('clm_fixture_user');
  assert.equal(user.entry.actor.id, 'fixture-agent');
  assert.equal(user.entry.data.attributed_to, 'fixture-user');
  assert.equal(user.entry.data.kind, 'hypothesis');
  assert.match(user.entry.data.text, /かもしれない/);
  assert.match(user.entry.data.scope, /Tentative/); assert.ok(user.entry.data.why);
  const old = ledger.show('clm_fixture_old');
  assert.deepEqual(new Set(old.connections.filter(v => v.entry.type === 'assessment').map(v => v.entry.data.stance)), new Set(['supports', 'challenges']));
  assert.equal(ledger.search('架空').items.some(v => v.entry.id === old.entry.id), false);
  assert.equal(ledger.search('架空', { includeInactive: true }).items.some(v => v.entry.id === old.entry.id), true);
  assert.ok(old.connections.some(v => v.entry.type === 'relation' && v.entry.data.relation === 'supersedes'));
  // Characterizes the current gap, not the desired behavior. Replace this assertion in Issue #4.
  assert.equal(ledger.search('ZKQ').items.length, 0);
  assert.match(ledger.show('evd_fixture_x').entry.data.quote, /ZKQ/);
  ledger.capture(bundle([{ id: 'rev_fixture_keep', type: 'review', data: {
    target_id: 'clm_fixture_corrected', state: 'accepted', rationale: 'retain this representation only' } }], 'req_fixture_keep'));
  const inspected = ledger.inspectCapture('req_fixture_correction');
  assert.equal(inspected.items.find(v => v.entry.id === 'clm_fixture_corrected').state, 'accepted');
  const anchor = inspected.items.find(v => v.entry.id === 'asm_fixture_corrected_x').references.find(v => v.entry.type === 'evidence');
  assert.equal(anchor.state, 'proposed'); assert.ok(anchor.warnings.includes('anchor_not_verified'));
});
