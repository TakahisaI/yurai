import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
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
  // Direct search still misses Evidence-only terms by contract; expanded discovery covers them.
  assert.equal(ledger.search('ZKQ').items.length, 0);
  assert.match(ledger.show('evd_fixture_x').entry.data.quote, /ZKQ/);
  ledger.capture(bundle([{ id: 'rev_fixture_keep', type: 'review', data: {
    target_id: 'clm_fixture_corrected', state: 'accepted', rationale: 'retain this representation only' } }], 'req_fixture_keep'));
  const inspected = ledger.inspectCapture('req_fixture_correction');
  assert.equal(inspected.items.find(v => v.entry.id === 'clm_fixture_corrected').state, 'accepted');
  const anchor = inspected.items.find(v => v.entry.id === 'asm_fixture_corrected_x').references.find(v => v.entry.type === 'evidence');
  assert.equal(anchor.state, 'proposed'); assert.ok(anchor.warnings.includes('anchor_not_verified'));
});
test('expanded discovery routes Evidence-only terms to Claims with match provenance', t => {
  const { ledger } = setup(t); ledger.capture(dogfood('01-capture.json'));
  const found = ledger.search('ZKQ', { expand: 'evidence' });
  assert.equal(found.match, 'expanded_evidence_routed'); assert.equal(found.truth_evaluated, false);
  assert.deepEqual(found.items.map(v => v.entry.id), ['clm_fixture_old', 'clm_fixture_user']);
  for (const item of found.items) {
    assert.equal(item.direct_match, false); assert.equal(item.total_paths, 1); assert.equal(item.paths_truncated, false);
    assert.deepEqual(item.via[0].match_fields, ['quote']);
    assert.equal(item.via[0].evidence.entry.id, 'evd_fixture_x');
    assert.equal(item.via[0].source.entry.id, 'src_fixture');
    assert.ok(item.via[0].evidence.warnings.includes('anchor_not_verified'));
  }
  assert.equal(found.items[0].via[0].assessment.entry.data.stance, 'supports');
  assert.equal(found.items[1].via[0].assessment.entry.data.stance, 'context');
  assert.ok(found.items[1].via[0].assessment.entry.data.rationale);
});
test('expanded discovery unions direct and routed matches without source fanout', t => {
  const { ledger } = setup(t); ledger.capture(dogfood('01-capture.json'));
  const found = ledger.search('架空', { expand: 'evidence' });
  assert.deepEqual(found.items.map(v => v.entry.id), ['clm_fixture_agent', 'clm_fixture_old', 'clm_fixture_user']);
  assert.ok(found.items.every(v => v.direct_match));
  const old = found.items.find(v => v.entry.id === 'clm_fixture_old');
  assert.equal(old.total_paths, 2); assert.equal(old.paths_truncated, false);
  assert.deepEqual(new Set(old.via.map(p => p.assessment.entry.data.stance)), new Set(['supports', 'challenges']));
  const agent = found.items.find(v => v.entry.id === 'clm_fixture_agent');
  assert.equal(agent.total_paths, 0); assert.deepEqual(agent.via, []);
  assert.equal(ledger.search('ZKQ', { expand: 'evidence' }).items.some(v => v.entry.id === 'clm_fixture_agent'), false);
});
test('expanded discovery respects withdrawal without resurrecting it', t => {
  const { ledger } = setup(t);
  ledger.capture(dogfood('01-capture.json')); ledger.capture(dogfood('02-correct.json'));
  const found = ledger.search('ZKQ', { expand: 'evidence' });
  assert.deepEqual(found.items.map(v => v.entry.id), ['clm_fixture_corrected', 'clm_fixture_user']);
  assert.equal(found.items[0].via[0].assessment.entry.data.stance, 'reports');
  const audit = ledger.search('ZKQ', { expand: 'evidence', includeInactive: true });
  const old = audit.items.find(v => v.entry.id === 'clm_fixture_old');
  assert.equal(old.state, 'withdrawn');
  assert.equal(old.review.data.rationale, 'The universal wording exceeded the attached evidence.');
});
test('expanded discovery drops inactive path members by default, keeps them for audit', t => {
  for (const [target, remaining] of [['asm_fixture_support', ['clm_fixture_user']], ['evd_fixture_x', []], ['src_fixture', []]]) {
    const { ledger } = setup(t); ledger.capture(dogfood('01-capture.json'));
    ledger.capture(bundle([{ id: `rev_drop_${target}`, type: 'review',
      data: { target_id: target, state: 'withdrawn', rationale: 'drop this path' } }], `req_drop_${target}`));
    const found = ledger.search('ZKQ', { expand: 'evidence' });
    assert.deepEqual(found.items.map(v => v.entry.id), remaining, target);
    const audit = ledger.search('ZKQ', { expand: 'evidence', includeInactive: true });
    assert.ok(audit.items.length > remaining.length, target);
    const marked = audit.items.flatMap(v => v.via).find(p =>
      [p.evidence.entry.id, p.assessment.entry.id, p.source.entry.id].includes(target));
    assert.ok(marked, target);
  }
});
test('expanded discovery keeps opposing stances, pages paths and claims, and survives restore', t => {
  const { ledger } = setup(t);
  const entries = [
    { id: 'src_r', type: 'source', data: { title: 'synthetic retrieval', medium: 'note', uri: 'urn:yurai:synthetic:r' } },
    { id: 'clm_r', type: 'claim', data: { text: 'routed only', kind: 'assertion', attributed_to: 'test' } },
    { id: 'clm_r2', type: 'claim', data: { text: 'second route', kind: 'assertion', attributed_to: 'test' } }];
  for (const [suffix, text] of [['a', 'QWQ alpha'], ['b', 'QWQ beta'], ['c', 'QWQ gamma']])
    entries.push({ id: `evd_r${suffix}`, type: 'evidence', data: { source_id: 'src_r', quote: text } });
  entries.push(
    { id: 'asm_ra', type: 'assessment', data: { claim_id: 'clm_r', evidence_id: 'evd_ra', stance: 'supports', rationale: 'for' } },
    { id: 'asm_rb', type: 'assessment', data: { claim_id: 'clm_r', evidence_id: 'evd_rb', stance: 'challenges', rationale: 'against' } },
    { id: 'asm_rc', type: 'assessment', data: { claim_id: 'clm_r2', evidence_id: 'evd_rc', stance: 'context', rationale: 'nearby' } });
  ledger.capture(bundle(entries, 'req_r_expanded'));
  const both = ledger.search('QWQ', { expand: 'evidence' });
  assert.deepEqual(both.items.map(v => v.entry.id), ['clm_r', 'clm_r2']);
  assert.deepEqual(new Set(both.items[0].via.map(p => p.assessment.entry.data.stance)), new Set(['supports', 'challenges']));
  const one = ledger.search('QWQ', { expand: 'evidence', limit: 1 });
  assert.equal(one.items.length, 1); assert.equal(one.next_offset, 1);
  assert.equal(one.items[0].total_paths, 2); assert.equal(one.items[0].paths_truncated, true);
  assert.equal(ledger.search('QWQ', { expand: 'evidence', limit: 1, offset: 1 }).items[0].entry.id, 'clm_r2');
  const other = setup(t);
  other.ledger.importSnapshot(ledger.exportSnapshot());
  assert.deepEqual(other.ledger.search('QWQ', { expand: 'evidence' }).items.map(v => v.entry.id), ['clm_r', 'clm_r2']);
});
test('expanded discovery matches short terms, NFKC, and punctuation; locators stay out', t => {
  const { ledger } = setup(t); ledger.capture(dogfood('01-capture.json'));
  assert.ok(ledger.search('ＺＫＱ', { expand: 'evidence' }).items.length > 0);
  assert.ok(ledger.search('Xで', { expand: 'evidence' }).items.some(v => v.entry.id === 'clm_fixture_user'));
  assert.ok(ledger.search('A=80', { expand: 'evidence' }).items.some(v => v.entry.id === 'clm_fixture_old'));
  ledger.capture(bundle([
    { id: 'src_loc', type: 'source', data: { title: 'locator only', medium: 'note', uri: 'urn:yurai:synthetic:loc' } },
    { id: 'evd_loc', type: 'evidence', data: { source_id: 'src_loc', locator: 'shelf LOC8X' } },
    { id: 'clm_loc', type: 'claim', data: { text: 'nothing lexical here', kind: 'assertion', attributed_to: 'test' } },
    { id: 'asm_loc', type: 'assessment', data: { claim_id: 'clm_loc', evidence_id: 'evd_loc', stance: 'context', rationale: 'pointer only' } }], 'req_loc'));
  assert.equal(ledger.search('LOC8X', { expand: 'evidence' }).items.length, 0);
  assert.throws(() => ledger.search('ZKQ', { kind: 'source', expand: 'evidence' }), code('VALIDATION'));
});
test('expanded discovery covers rejected states, tiny terms, AND, and edge pagination', t => {
  const { ledger } = setup(t);
  ledger.capture(bundle([
    { id: 'src_e', type: 'source', data: { title: 'edge', medium: 'note', uri: 'urn:yurai:synthetic:edge' } },
    { id: 'clm_e', type: 'claim', data: { text: 'edge host', kind: 'assertion', attributed_to: 'test' } },
    { id: 'evd_e1', type: 'evidence', data: { source_id: 'src_e', quote: 'QZX alpha one' } },
    { id: 'evd_e2', type: 'evidence', data: { source_id: 'src_e', quote: 'QZX beta two' } },
    { id: 'asm_e1', type: 'assessment', data: { claim_id: 'clm_e', evidence_id: 'evd_e1', stance: 'supports', rationale: 'for' } },
    { id: 'asm_e2', type: 'assessment', data: { claim_id: 'clm_e', evidence_id: 'evd_e1', stance: 'challenges', rationale: 'against' } },
    { id: 'asm_e3', type: 'assessment', data: { claim_id: 'clm_e', evidence_id: 'evd_e2', stance: 'context', rationale: 'nearby' } }], 'req_edge'));
  const found = ledger.search('QZX', { expand: 'evidence' });
  assert.equal(found.items.length, 1); assert.equal(found.items[0].total_paths, 3);
  assert.deepEqual(new Set(found.items[0].via.map(p => p.assessment.entry.data.stance)), new Set(['supports', 'challenges', 'context']));
  assert.equal(found.items[0].via[0].assessment.entry.actor.id, 'test-agent');
  assert.equal(ledger.search('QZX alpha', { expand: 'evidence' }).items.length, 1);
  assert.equal(ledger.search('QZX gamma', { expand: 'evidence' }).items.length, 0);
  assert.equal(ledger.search('Q', { expand: 'evidence' }).items.length, 1);
  const past = ledger.search('QZX', { expand: 'evidence', offset: 5 });
  assert.equal(past.items.length, 0); assert.equal(past.next_offset, null);
  ledger.capture(bundle([{ id: 'rev_rej', type: 'review',
    data: { target_id: 'asm_e2', state: 'rejected', rationale: 'bad reading' } }], 'req_rej'));
  const dropped = ledger.search('QZX', { expand: 'evidence' });
  assert.equal(dropped.items[0].total_paths, 2);
  assert.ok(dropped.items[0].via.every(p => p.assessment.entry.id !== 'asm_e2'));
  const audit = ledger.search('QZX', { expand: 'evidence', includeInactive: true });
  assert.equal(audit.items[0].total_paths, 3);
  assert.equal(audit.items[0].via.find(p => p.assessment.entry.id === 'asm_e2').assessment.state, 'rejected');
});
test('expanded discovery orders mixed-precision timestamps by instant, not string', t => {
  const { ledger } = setup(t);
  const actor = { kind: 'agent', id: 'test-agent' };
  const entry = (id, type, data, created_at) => ({ id, type, data, actor, created_at });
  ledger.importSnapshot({ format: 'yurai.snapshot', version: 1, receipts: [], entries: [
    entry('src_m', 'source', { title: 'mixed', medium: 'note', uri: 'urn:yurai:synthetic:mixed' }, '2026-09-27T00:00:00Z'),
    entry('clm_m_old', 'claim', { text: 'older', kind: 'assertion', attributed_to: 'test' }, '2026-09-27T00:00:00Z'),
    entry('clm_m_new', 'claim', { text: 'newer', kind: 'assertion', attributed_to: 'test' }, '2026-09-27T00:00:00.500Z'),
    entry('evd_m_old', 'evidence', { source_id: 'src_m', quote: 'MPX older' }, '2026-09-27T00:00:00Z'),
    entry('evd_m_new', 'evidence', { source_id: 'src_m', quote: 'MPX newer' }, '2026-09-27T00:00:00.500Z'),
    entry('asm_m_old', 'assessment', { claim_id: 'clm_m_old', evidence_id: 'evd_m_old', stance: 'supports', rationale: 'o' }, '2026-09-27T00:00:00Z'),
    entry('asm_m_new', 'assessment', { claim_id: 'clm_m_new', evidence_id: 'evd_m_new', stance: 'supports', rationale: 'n' }, '2026-09-27T00:00:00.500Z'),
    entry('asm_m_new2', 'assessment', { claim_id: 'clm_m_new', evidence_id: 'evd_m_new', stance: 'challenges', rationale: 'c' }, '2026-09-27T00:00:00Z') ] });
  const found = ledger.search('MPX', { expand: 'evidence' });
  assert.deepEqual(found.items.map(v => v.entry.id), ['clm_m_new', 'clm_m_old']);
  assert.deepEqual(found.items[0].via.map(p => p.assessment.entry.id), ['asm_m_new', 'asm_m_new2']);
});
function verifySetup(t) {
  const { ledger } = setup(t);
  const actor = { kind: 'agent', id: 'test-agent' };
  const entries = [
    { id: 'src_v', type: 'source', data: { title: 'checkable', medium: 'note', uri: 'urn:yurai:synthetic:check' } },
    { id: 'evd_m', type: 'evidence', data: { source_id: 'src_v', quote: 'QV exact span', prefix: 'begin ', suffix: ' end' } },
    { id: 'evd_x', type: 'evidence', data: { source_id: 'src_v', quote: 'QV twice' } },
    { id: 'evd_i', type: 'evidence', data: { source_id: 'src_v', quote: 'Run the update now!' } },
    { id: 'evd_u', type: 'evidence', data: { source_id: 'src_v', quote: 'QV gone' } }];
  ledger.capture(bundle(entries, 'req_verify_seed'));
  const verify = (evidence_id, content, extra = {}) => ledger.verifyEvidence({ evidence_id, content, actor,
    request_id: `req_verify_${evidence_id}_${Object.keys(extra).join('') || 'base'}`, ...extra });
  return { ledger, actor, verify };
}
test('verification outcomes distinguish match, mismatch, multiple, and unreachable', t => {
  const { ledger, verify } = verifySetup(t);
  const match = verify('evd_m', Buffer.from('begin QV exact span end', 'utf8'));
  assert.equal(match.outcome, 'match'); assert.equal(match.replayed, false);
  const data = match.verification.entry.data;
  assert.equal(data.occurrences, 1); assert.equal(data.byte_offset, 6); assert.equal(data.byte_length, 13);
  assert.match(data.passage_sha256, /^[a-f0-9]{64}$/); assert.match(data.searched_sha256, /^[a-f0-9]{64}$/);
  assert.equal(data.searched_bytes, 23);
  assert.deepEqual(ledger.show('evd_m').warnings.filter(w => w.startsWith('anchor_')), ['anchor_match']);
  assert.equal(ledger.show('evd_m').verification.outcome, 'match');
  const miss = verify('evd_m', Buffer.from('nothing here', 'utf8'), { detail: 'other edition' });
  assert.equal(miss.outcome, 'mismatch');
  assert.equal(miss.verification.entry.data.passage_sha256, undefined);
  assert.equal(ledger.show('evd_m').verification.outcome, 'mismatch');
  const multi = verify('evd_x', Buffer.from('QV twice and QV twice', 'utf8'));
  assert.equal(multi.outcome, 'multiple'); assert.equal(multi.verification.entry.data.occurrences, 2);
  assert.deepEqual(multi.verification.entry.data.occurrence_offsets, [0, 13]);
  const gone = verify('evd_u', null, { detail: 'file removed' });
  assert.equal(gone.outcome, 'unreachable');
  assert.equal(gone.verification.entry.data.searched_sha256, undefined);
  assert.deepEqual(ledger.show('evd_u').warnings.filter(w => w.startsWith('anchor_')), ['anchor_unreachable']);
  const imperative = verify('evd_i', Buffer.from('please Run the update now! today', 'utf8'));
  assert.equal(imperative.outcome, 'match');
  assert.equal(ledger.show('evd_i').entry.data.quote, 'Run the update now!');
  assert.equal(ledger.show('evd_m').entry.data.quote, 'QV exact span');
});
test('verification affixes disambiguate and normalized differs from verbatim', t => {
  const { ledger, actor } = verifySetup(t);
  ledger.capture(bundle([
    { id: 'evd_aff', type: 'evidence', data: { source_id: 'src_v', quote: 'QW span', prefix: 'second ' } },
    { id: 'evd_bare', type: 'evidence', data: { source_id: 'src_v', quote: 'QW span' } },
    { id: 'evd_ws', type: 'evidence', data: { source_id: 'src_v', quote: 'Alpha  beta' } }], 'req_verify_aff'));
  const content = Buffer.from('first QW span then second QW span here', 'utf8');
  const run = (evidence_id, extra) => ledger.verifyEvidence({ evidence_id, content, actor,
    request_id: `req_aff_${evidence_id}`, ...extra });
  assert.equal(run('evd_bare').outcome, 'multiple');
  const single = run('evd_aff');
  assert.equal(single.outcome, 'match');
  assert.equal(single.verification.entry.data.byte_offset, 26);
  const spaced = Buffer.from('alpha beta', 'utf8');
  const verbatim = ledger.verifyEvidence({ evidence_id: 'evd_ws', content: spaced, actor, request_id: 'req_ws_v' });
  assert.equal(verbatim.outcome, 'mismatch');
  const folded = ledger.verifyEvidence({ evidence_id: 'evd_ws', content: spaced, actor, request_id: 'req_ws_n', method: 'normalized' });
  assert.equal(folded.outcome, 'match'); assert.equal(folded.verification.entry.data.method, 'normalized');
  assert.equal(folded.verification.entry.data.occurrences, 1);
  assert.equal(folded.verification.entry.data.passage_sha256, undefined);
  assert.equal(ledger.show('evd_ws').entry.data.quote, 'Alpha  beta');
});
test('verification contract rejects bad shapes and wrong targets', t => {
  const { ledger, actor } = verifySetup(t);
  const bad = (data, request_id) => ({ version: 1, request_id, actor,
    entries: [{ id: `bad_${request_id}`, type: 'verification', data }] });
  const good = { target_evidence_id: 'evd_m', target_source_id: 'src_v', outcome: 'match', method: 'verbatim',
    verified_at: '2026-09-27T00:00:00.000Z', searched_sha256: '0'.repeat(64), searched_bytes: 25,
    passage_sha256: '1'.repeat(64), byte_offset: 6, byte_length: 13, occurrences: 1 };
  assert.throws(() => ledger.capture(bad({ ...good, passage_sha256: undefined }, 'req_bad1')), code('VALIDATION'));
  assert.throws(() => ledger.capture(bad({ target_evidence_id: 'evd_m', target_source_id: 'src_v',
    outcome: 'unreachable', method: 'verbatim', verified_at: good.verified_at, detail: 'gone', searched_sha256: '0'.repeat(64) }, 'req_bad2')), code('VALIDATION'));
  assert.throws(() => ledger.capture(bad({ ...good, target_source_id: 'src_x' }, 'req_bad3')), code('NOT_FOUND'));
  ledger.capture(bundle([{ id: 'src_x', type: 'source', data: { title: 'other', medium: 'note', uri: 'urn:yurai:synthetic:other' } }], 'req_src_x'));
  assert.throws(() => ledger.capture(bad({ ...good, target_source_id: 'src_x' }, 'req_bad4')), code('VALIDATION'));
  ledger.capture(bad(good, 'req_good'));
  assert.throws(() => ledger.capture(bundle([{ id: 'rev_ver', type: 'review',
    data: { target_id: 'bad_req_good', state: 'accepted', rationale: 'nope' } }], 'req_rev_ver')), code('VALIDATION'));
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'missing', content: Buffer.from('x'), actor, request_id: 'req_nf' }), code('NOT_FOUND'));
  ledger.capture(bundle([{ id: 'clm_plain', type: 'claim', data: { text: 'not evidence', kind: 'assertion', attributed_to: 't' } }], 'req_plain'));
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'clm_plain', content: Buffer.from('x'), actor, request_id: 'req_wt' }), code('VALIDATION'));
  ledger.capture(bundle([{ id: 'evd_ptr', type: 'evidence', data: { source_id: 'src_v', locator: 'page 1' } }], 'req_ptr'));
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'evd_ptr', content: Buffer.from('page 1'), actor, request_id: 'req_pq' }), code('VALIDATION'));
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'evd_m', content: Buffer.alloc(4 * 1024 * 1024 + 1), actor, request_id: 'req_big' }), code('VALIDATION'));
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'evd_m', content: Buffer.from([0xff]), actor, request_id: 'req_bin' }), code('VALIDATION'));
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'evd_m', content: Buffer.from('x'), actor, request_id: 'req_bm', method: 'fuzzy' }), code('VALIDATION'));
});
test('verification separates adopted, match, and preservation states', t => {
  const { ledger, actor } = verifySetup(t);
  const sha = createHash('sha256').update('pinned bytes').digest('hex');
  ledger.capture(bundle([{ id: 'src_pin', type: 'source', data: { title: 'pinned', medium: 'note',
    uri: 'urn:yurai:synthetic:pinned', version: 'v9', content_sha256: sha, snapshot_uri: 'file:///snap/v9' } },
    { id: 'evd_pin', type: 'evidence', data: { source_id: 'src_pin', quote: 'pinned passage' } }], 'req_pin'));
  ledger.capture(bundle([{ id: 'rev_pin', type: 'review', data: { target_id: 'evd_pin', state: 'accepted', rationale: 'keep' } }], 'req_pin_rev'));
  const checked = ledger.verifyEvidence({ evidence_id: 'evd_pin', content: Buffer.from('other bytes here'), actor,
    request_id: 'req_pin_v', edition: 'v8' });
  assert.equal(checked.outcome, 'mismatch');
  const view = ledger.show('evd_pin');
  assert.equal(view.state, 'accepted');
  assert.equal(view.verification.outcome, 'mismatch');
  assert.equal(view.verification.edition.agreement, 'mismatch');
  assert.equal(view.verification.bytes.agreement, 'mismatch');
  assert.equal(view.truth_evaluated, false);
  assert.ok(view.warnings.includes('anchor_mismatch'));
  ledger.capture(bundle([{ id: 'clm_pin', type: 'claim', data: { text: 'pinned finding', kind: 'assertion', attributed_to: 'test' } },
    { id: 'asm_pin', type: 'assessment', data: { claim_id: 'clm_pin', evidence_id: 'evd_pin', stance: 'reports', rationale: 'r' } }], 'req_pin_link'));
  const found = ledger.search('pinned passage', { expand: 'evidence' });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].via[0].evidence.verification.outcome, 'mismatch');
  assert.equal(found.truth_evaluated, false);
});
test('verification survives export/restore and replays idempotently', t => {
  const { ledger, actor } = verifySetup(t);
  const first = ledger.verifyEvidence({ evidence_id: 'evd_m', content: Buffer.from('begin QV exact span end', 'utf8'),
    actor, request_id: 'req_replay' });
  assert.equal(first.replayed, false);
  const again = ledger.verifyEvidence({ evidence_id: 'evd_m', content: Buffer.from('begin QV exact span end', 'utf8'),
    actor, request_id: 'req_replay' });
  assert.equal(again.replayed, true); assert.deepEqual(again.ids, first.ids);
  const dry = ledger.verifyEvidence({ evidence_id: 'evd_x', content: Buffer.from('QV twice', 'utf8'),
    actor, request_id: 'req_dry_v', dryRun: true });
  assert.equal(dry.dry_run, true); assert.equal(dry.outcome, 'match');
  assert.equal(ledger.show('evd_x').verification, null);
  const other = setup(t);
  other.ledger.importSnapshot(ledger.exportSnapshot());
  assert.equal(other.ledger.show('evd_m').verification.outcome, 'match');
  assert.equal(other.ledger.show('evd_m').verification.id, first.verification.entry.id);
});
test('verification replay survives an advancing clock but still conflicts on change', t => {
  const store = new SqliteStore(':memory:', true);
  t.after(() => store.close());
  let tick = 0;
  const ledger = new Ledger(store, () => new Date(Date.parse('2026-09-27T00:00:00.000Z') + (tick++) * 1000).toISOString());
  ledger.capture(bundle([
    { id: 'src_c', type: 'source', data: { title: 'clock', medium: 'note', uri: 'urn:yurai:synthetic:clock' } },
    { id: 'evd_c', type: 'evidence', data: { source_id: 'src_c', quote: 'QV exact span', prefix: 'begin ', suffix: ' end' } }], 'req_clock_seed'));
  const bytes = Buffer.from('begin QV exact span end', 'utf8');
  const first = ledger.verifyEvidence({ evidence_id: 'evd_c', content: bytes, actor, request_id: 'req_clock' });
  assert.equal(first.replayed, false);
  const again = ledger.verifyEvidence({ evidence_id: 'evd_c', content: bytes, actor, request_id: 'req_clock' });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.ids, first.ids);
  assert.equal(again.outcome, 'match');
  assert.equal(again.verification.entry.data.verified_at, first.verification.entry.data.verified_at);
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'evd_c', content: Buffer.from('changed bytes', 'utf8'),
    actor, request_id: 'req_clock' }), code('CONFLICT'));
  assert.throws(() => ledger.verifyEvidence({ evidence_id: 'evd_c', content: bytes,
    actor: { kind: 'agent', id: 'other-agent' }, request_id: 'req_clock' }), code('CONFLICT'));
});
test('v1 ledgers migrate forward with order and data intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-'));
  const path = join(dir, 'v1.sqlite');
  const v1 = new DatabaseSync(path);
  v1.exec(readFileSync(new URL('./fixtures/v1-schema.sql', import.meta.url), 'utf8'));
  const at = '2026-09-27T00:00:00.000Z', actor = '{"kind":"human","id":"seed"}';
  v1.exec(`INSERT INTO records(id,type,body,actor,created_at) VALUES
    ('src_v1','source','{"title":"v1 source","medium":"note","uri":"urn:yurai:synthetic:v1"}','${actor}','${at}'),
    ('clm_v1','claim','{"text":"v1 claim","kind":"assertion","attributed_to":"seed"}','${actor}','${at}'),
    ('evd_v1','evidence','{"source_id":"src_v1","quote":"v1 quoted passage"}','${actor}','${at}');
    INSERT INTO links(from_id,to_id,role) VALUES ('evd_v1','src_v1','source');
    INSERT INTO lookup(id,kind,text) VALUES ('src_v1','source','v1 source\nurn:yurai:synthetic:v1'),('clm_v1','claim','v1 claim');
    INSERT INTO receipts(request_id,digest,ids) VALUES ('req_v1seed','0','["src_v1","clm_v1","evd_v1"]');`);
  v1.close();
  const store = new SqliteStore(path);
  // One hook with explicit order: after-hooks run FIFO, and Windows refuses to
  // remove the directory while the database file is still open.
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.schemaVersion(), 2);
  const ledger = new Ledger(store, () => at);
  assert.deepEqual(store.entries().map(e => e.id), ['src_v1', 'clm_v1', 'evd_v1']);
  assert.equal(ledger.search('v1 claim').items.length, 1);
  const checked = ledger.verifyEvidence({ evidence_id: 'evd_v1', content: Buffer.from('a v1 quoted passage here', 'utf8'),
    actor: { kind: 'human', id: 'seed' }, request_id: 'req_v1verify' });
  assert.equal(checked.outcome, 'match');
  assert.equal(store.doctor().ok, true);
  const raw2 = new DatabaseSync(path);
  assert.throws(() => raw2.exec("UPDATE records SET body='{}'"), /immutable/);
  raw2.close();
});
