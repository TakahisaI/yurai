import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { toExpandedRefsV1 } from '../dist/index.js';
import { code } from './helpers/assert.mjs';
import { memorySetup } from './helpers/memory.mjs';
import { cliSetup } from './helpers/cli.mjs';

const evalLedger = JSON.parse(readFileSync(new URL('../examples/eval/ledger.json', import.meta.url), 'utf8'));
const evalWdDeps = JSON.parse(readFileSync(new URL('../examples/eval/ledger-wd-deps.json', import.meta.url), 'utf8'));
const evalVerify = JSON.parse(readFileSync(new URL('../examples/eval/ledger-verify.json', import.meta.url), 'utf8'));
const actor = { kind: 'agent', id: 'test-agent', model: 'synthetic' };
const bundle = (entries, request_id) => ({ version: 1, request_id, actor, entries });

function evalSetup(t) {
  const { store, ledger } = memorySetup(t, { now: null });
  ledger.capture(evalLedger);
  ledger.capture(evalWdDeps);
  ledger.capture(evalVerify);
  return { store, ledger };
}

/** Test-only inverse: re-expand a refs response into the inline shape. */
function expandRefs(refs) {
  const { format, version, window, included, included_complete, ...rest } = refs;
  assert.equal(format, 'yurai.expanded.refs');
  assert.equal(version, 1);
  assert.equal(included_complete, true);
  assert.ok(window && typeof window === 'object');
  return {
    ...rest,
    items: refs.items.map(item => {
      const { via, ...claim } = item;
      return {
        ...claim,
        via: via.map(p => ({
          evidence: included[p.evidence_ref],
          assessment: included[p.assessment_ref],
          source: included[p.source_ref],
          match_fields: p.match_fields,
        })),
      };
    }),
  };
}

function refSet(refs) {
  const out = new Set();
  for (const item of refs.items) for (const p of item.via) {
    out.add(p.evidence_ref);
    out.add(p.assessment_ref);
    out.add(p.source_ref);
  }
  return out;
}

/** Run one query both ways: lossless round-trip plus completeness. */
function roundTrip(ledger, query, options) {
  const inline = ledger.search(query, options);
  const refs = ledger.search(query, { ...options, projection: 'refs-v1' });
  assert.equal(refs.format, 'yurai.expanded.refs');
  assert.equal(refs.version, 1);
  assert.equal(refs.included_complete, true);
  // A JSON round-trip proves the refs form carries the views by value:
  // null-vs-absent, order, and text must survive serialization.
  assert.deepEqual(expandRefs(JSON.parse(JSON.stringify(refs))), inline);
  assert.deepEqual(new Set(Object.keys(refs.included)), refSet(refs));
  for (const item of refs.items) for (const p of item.via) {
    assert.equal(refs.included[p.evidence_ref].entry.type, 'evidence');
    assert.equal(refs.included[p.assessment_ref].entry.type, 'assessment');
    assert.equal(refs.included[p.source_ref].entry.type, 'source');
  }
  return { inline, refs };
}

test('refs-v1: the 38℃ eval case round-trips losslessly with shared views deduped', t => {
  const { ledger } = evalSetup(t);
  const { inline, refs } = roundTrip(ledger, '38℃', { expand: 'evidence' });
  assert.deepEqual(refs.window, { offset: 0, limit: 20, path_offset: 0, path_limit: 20 });
  assert.equal(refs.query, '38℃');
  assert.equal(refs.match, 'expanded_evidence_routed');
  assert.equal(refs.revision, inline.revision);
  assert.equal(refs.truth_evaluated, false);
  assert.equal(refs.next_offset, inline.next_offset);
  // 5 paths x 3 views inline, 9 unique views under included.
  const occurrences = refs.items.reduce((n, i) => n + i.via.length * 3, 0);
  assert.equal(occurrences, 15);
  const keys = Object.keys(refs.included);
  assert.equal(keys.length, 9);
  const byType = {};
  for (const id of keys) {
    const type = refs.included[id].entry.type;
    byType[type] = (byType[type] ?? 0) + 1;
  }
  assert.deepEqual(byType, { evidence: 2, assessment: 5, source: 2 });
  // The shared drop evidence is referenced three times but stored once.
  const dropRefs = refs.items.flatMap(i => i.via).filter(p => p.evidence_ref === 'evd_eval_drop');
  assert.equal(dropRefs.length, 3);
  assert.equal(keys.filter(id => id === 'evd_eval_drop').length, 1);
  // Opposing stances stay separate paths with distinct assessments.
  const all = refs.items.find(i => i.entry.id === 'clm_eval_all');
  assert.equal(all.via.length, 2);
  const stances = all.via.map(p => refs.included[p.assessment_ref].entry.data.stance).sort();
  assert.deepEqual(stances, ['challenges', 'supports']);
  assert.notEqual(all.via[0].assessment_ref, all.via[1].assessment_ref);
  // Counts, order, and paging mean exactly what inline says.
  assert.deepEqual(refs.items.map(i => i.entry.id), inline.items.map(i => i.entry.id));
  for (const [r, o] of refs.items.map((r, n) => [r, inline.items[n]])) {
    assert.equal(r.direct_match, o.direct_match);
    assert.equal(r.total_paths, o.total_paths);
    assert.equal(r.paths_truncated, o.paths_truncated);
    assert.equal(r.via_next_offset, o.via_next_offset);
    assert.deepEqual(Object.keys(r).sort(),
      ['direct_match', 'entry', 'paths_truncated', 'review', 'state', 'total_paths', 'via', 'via_next_offset', 'warnings']);
    for (const p of r.via) assert.deepEqual(Object.keys(p).sort(),
      ['assessment_ref', 'evidence_ref', 'match_fields', 'source_ref']);
  }
  // Provenance values ride the round-trip above: the deepEqual entails every
  // included view equals its inline twin, and retrieval-eval pins the same
  // XZ-7 chain on the inline form.
});

test('refs-v1: the audit path round-trips with full withdrawn states', t => {
  const { ledger } = evalSetup(t);
  const { refs } = roundTrip(ledger, 'OLDTERM', { expand: 'evidence', includeInactive: true });
  const item = refs.items.find(i => i.entry.id === 'clm_eval_drop');
  assert.ok(item);
  assert.equal(item.state, 'proposed');
  assert.equal(refs.included[item.via[0].evidence_ref].state, 'withdrawn');
  assert.equal(refs.included[item.via[0].assessment_ref].state, 'proposed');
  assert.equal(refs.included[item.via[0].source_ref].state, 'proposed');
  roundTrip(ledger, '38℃', { expand: 'evidence', includeInactive: true });
});

test('refs-v1: empty results carry an empty complete included map', t => {
  const { ledger } = evalSetup(t);
  const { inline, refs } = roundTrip(ledger, 'qqqzzz-no-such-term', { expand: 'evidence' });
  assert.deepEqual(inline.items, []);
  assert.deepEqual(refs.items, []);
  assert.deepEqual(refs.included, {});
  assert.equal(refs.next_offset, null);
  // Flagless responses keep the legacy shape with no refs keys.
  for (const key of ['format', 'version', 'window', 'included', 'included_complete']) {
    assert.equal(key in inline, false, key);
  }
});

function multiPageSetup(t) {
  const { store, ledger } = memorySetup(t);
  const entries = [
    { id: 'src_mp', type: 'source', data: { title: 'synthetic paging', medium: 'note', uri: 'urn:yurai:synthetic:mp' } },
    { id: 'clm_mp_a', type: 'claim', data: { text: 'first paged host', kind: 'assertion', attributed_to: 'test' } },
    { id: 'clm_mp_b', type: 'claim', data: { text: 'second paged host', kind: 'assertion', attributed_to: 'test' } },
  ];
  const stances = ['supports', 'challenges', 'context', 'reports', 'qualifies', 'supports'];
  for (let n = 1; n <= 6; n++) {
    entries.push({ id: `evd_mp_${n}`, type: 'evidence', data: { source_id: 'src_mp', quote: `MPGTERM span ${n}` } });
    entries.push({ id: `asm_mp_${n}`, type: 'assessment',
      data: { claim_id: 'clm_mp_a', evidence_id: `evd_mp_${n}`, stance: stances[n - 1], rationale: `reading ${n}` } });
  }
  entries.push({ id: 'evd_mp_b', type: 'evidence', data: { source_id: 'src_mp', quote: 'MPGTERM lone span' } });
  entries.push({ id: 'asm_mp_b', type: 'assessment',
    data: { claim_id: 'clm_mp_b', evidence_id: 'evd_mp_b', stance: 'supports', rationale: 'lone reading' } });
  ledger.capture(bundle(entries, 'req_mp'));
  return { store, ledger };
}

test('refs-v1: claim and path pages round-trip through mid, end, and out-of-range', t => {
  const { ledger } = multiPageSetup(t);
  const first = roundTrip(ledger, 'MPGTERM', { expand: 'evidence', pathLimit: 2 });
  assert.deepEqual(first.refs.items.map(i => i.entry.id), ['clm_mp_a', 'clm_mp_b']);
  assert.deepEqual(first.refs.window, { offset: 0, limit: 20, path_offset: 0, path_limit: 2 });
  const head = first.refs.items[0];
  assert.equal(head.total_paths, 6);
  assert.equal(head.via.length, 2);
  assert.equal(head.via_next_offset, 2);
  assert.equal(head.paths_truncated, true);
  const mid = roundTrip(ledger, 'MPGTERM', { expand: 'evidence', pathLimit: 2, pathOffset: 2 });
  assert.equal(mid.refs.items[0].via.length, 2);
  assert.equal(mid.refs.items[0].via_next_offset, 4);
  assert.equal(mid.refs.items[0].paths_truncated, true);
  const end = roundTrip(ledger, 'MPGTERM', { expand: 'evidence', pathLimit: 2, pathOffset: 4 });
  assert.equal(end.refs.items[0].via.length, 2);
  assert.equal(end.refs.items[0].via_next_offset, null);
  assert.equal(end.refs.items[0].paths_truncated, true);
  // Pages together cover every path exactly once, in inline order.
  const paged = [...first.refs.items[0].via, ...mid.refs.items[0].via, ...end.refs.items[0].via];
  const whole = ledger.search('MPGTERM', { expand: 'evidence' }).items[0].via;
  assert.deepEqual(paged.map(p => p.assessment_ref), whole.map(p => p.assessment.entry.id));
  // Past the end, via is empty and nothing is included for any claim.
  const past = roundTrip(ledger, 'MPGTERM', { expand: 'evidence', pathLimit: 2, pathOffset: 6 });
  assert.equal(past.refs.items.length, 2);
  assert.ok(past.refs.items.every(i => i.via.length === 0));
  assert.ok(past.refs.items.every(i => i.paths_truncated));
  assert.deepEqual(past.refs.included, {});
  assert.deepEqual(past.refs.window, { offset: 0, limit: 20, path_offset: 6, path_limit: 2 });
  // Claim pages carry their own window and included set.
  const claims = roundTrip(ledger, 'MPGTERM', { expand: 'evidence', limit: 1, offset: 1, pathLimit: 1 });
  assert.deepEqual(claims.refs.items.map(i => i.entry.id), ['clm_mp_b']);
  assert.deepEqual(claims.refs.window, { offset: 1, limit: 1, path_offset: 0, path_limit: 1 });
  assert.deepEqual(new Set(Object.keys(claims.refs.included)), refSet(claims.refs));
});

test('refs-v1: same-text records under different IDs are never merged', t => {
  const { ledger } = memorySetup(t);
  ledger.capture(bundle([
    { id: 'src_dup', type: 'source', data: { title: 'synthetic dup', medium: 'note', uri: 'urn:yurai:synthetic:dup' } },
    { id: 'clm_dup', type: 'claim', data: { text: 'dup host', kind: 'assertion', attributed_to: 'test' } },
    { id: 'evd_dup_a', type: 'evidence', data: { source_id: 'src_dup', quote: 'DUPTERM identical span' } },
    { id: 'evd_dup_b', type: 'evidence', data: { source_id: 'src_dup', quote: 'DUPTERM identical span' } },
    { id: 'asm_dup_a', type: 'assessment', data: { claim_id: 'clm_dup', evidence_id: 'evd_dup_a', stance: 'supports', rationale: 'first' } },
    { id: 'asm_dup_b', type: 'assessment', data: { claim_id: 'clm_dup', evidence_id: 'evd_dup_b', stance: 'supports', rationale: 'second' } },
  ], 'req_dup'));
  const { refs } = roundTrip(ledger, 'DUPTERM', { expand: 'evidence' });
  assert.equal(refs.items.length, 1);
  assert.equal(refs.items[0].via.length, 2);
  const ids = refs.items[0].via.map(p => p.evidence_ref).sort();
  assert.deepEqual(ids, ['evd_dup_a', 'evd_dup_b']);
  assert.ok(Object.hasOwn(refs.included, 'evd_dup_a'));
  assert.ok(Object.hasOwn(refs.included, 'evd_dup_b'));
  assert.equal(refs.included.evd_dup_a.entry.data.quote, refs.included.evd_dup_b.entry.data.quote);
  assert.deepEqual(new Set(Object.keys(refs.included)),
    new Set(['evd_dup_a', 'evd_dup_b', 'asm_dup_a', 'asm_dup_b', 'src_dup']));
});

test('refs-v1: review text and verification summaries ride the included views', t => {
  const { ledger } = memorySetup(t);
  const content = Buffer.from('before RVTERM checkable span here after', 'utf8');
  const sha = createHash('sha256').update(content).digest('hex');
  ledger.capture(bundle([
    { id: 'src_rv', type: 'source', data: { title: 'synthetic check', medium: 'note',
      uri: 'urn:yurai:synthetic:rv', version: 'v3', content_sha256: sha } },
    { id: 'clm_rv', type: 'claim', data: { text: 'checked host', kind: 'assertion', attributed_to: 'test' } },
    { id: 'evd_rv', type: 'evidence', data: { source_id: 'src_rv', quote: 'RVTERM checkable span here' } },
    { id: 'asm_rv', type: 'assessment', data: { claim_id: 'clm_rv', evidence_id: 'evd_rv', stance: 'supports', rationale: 'checked reading' } },
  ], 'req_rv'));
  ledger.capture(bundle([{ id: 'rev_rv', type: 'review',
    data: { target_id: 'asm_rv', state: 'accepted', rationale: 'retained after reading the span' } }], 'req_rv_review'));
  const checked = ledger.verifyEvidence({ evidence_id: 'evd_rv', content, edition: 'v3', actor, request_id: 'req_rv_verify' });
  assert.equal(checked.outcome, 'match');
  const { refs } = roundTrip(ledger, 'RVTERM', { expand: 'evidence' });
  assert.equal(refs.items.length, 1);
  const path = refs.items[0].via[0];
  const assessment = refs.included[path.assessment_ref];
  assert.equal(assessment.state, 'accepted');
  assert.equal(assessment.review.data.rationale, 'retained after reading the span');
  const evidence = refs.included[path.evidence_ref];
  assert.equal(evidence.verification.outcome, 'match');
  assert.equal(evidence.verification.edition.agreement, 'match');
  assert.equal(evidence.verification.bytes.agreement, 'match');
  assert.deepEqual(evidence.verification, ledger.show('evd_rv').verification);
  assert.ok(evidence.warnings.includes('anchor_match'));
});

test('refs-v1: Japanese and one/two-character terms keep working under projection', t => {
  const { ledger } = evalSetup(t);
  for (const query of ['気孔', '孔', 'CO2', 'ＣＯ２', '光合成速度']) {
    const { refs } = roundTrip(ledger, query, { expand: 'evidence' });
    assert.ok(refs.items.length > 0, query);
  }
});

test('refs-v1: a write between pages conflicts exactly like inline', t => {
  const { ledger } = evalSetup(t);
  const first = ledger.search('38℃', { expand: 'evidence', projection: 'refs-v1', limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.next_offset, 2);
  ledger.capture(bundle([
    { id: 'src_late', type: 'source', data: { title: 'late', medium: 'note', uri: 'urn:yurai:synthetic:late' } },
  ], 'req_late'));
  assert.throws(() => ledger.search('38℃', { expand: 'evidence', projection: 'refs-v1', limit: 2, offset: 2, asOf: first.revision }),
    code('CONFLICT'));
  const inlineFirst = ledger.search('38℃', { expand: 'evidence', limit: 2 });
  ledger.capture(bundle([
    { id: 'src_later', type: 'source', data: { title: 'later', medium: 'note', uri: 'urn:yurai:synthetic:later' } },
  ], 'req_later'));
  assert.throws(() => ledger.search('38℃', { expand: 'evidence', limit: 2, offset: 2, asOf: inlineFirst.revision }),
    code('CONFLICT'));
});

test('refs-v1: unknown projections and non-expanded use fail explicitly', t => {
  const { ledger } = evalSetup(t);
  assert.throws(() => ledger.search('38℃', { expand: 'evidence', projection: 'bogus' }), code('VALIDATION'));
  assert.throws(() => ledger.search('38℃', { projection: 'bogus' }), code('VALIDATION'));
  assert.throws(() => ledger.search('38℃', { projection: 'refs-v1' }), code('VALIDATION'));
  assert.throws(() => ledger.search('38℃', { kind: 'source', projection: 'refs-v1' }), code('VALIDATION'));
  assert.throws(() => ledger.search('38℃', { projection: '' }), code('VALIDATION'));
});

test('refs-v1: conflicting or mistyped views fail instead of merging', t => {
  const { ledger } = evalSetup(t);
  const inline = ledger.search('38℃', { expand: 'evidence' });
  const window = { offset: 0, limit: 20, path_offset: 0, path_limit: 20 };
  // Same ID with a different view is an integrity error, never last-write-wins.
  const tampered = JSON.parse(JSON.stringify(inline));
  tampered.items[1].via[0].evidence.warnings.push('injected');
  assert.throws(() => toExpandedRefsV1(tampered, window), code('IO_OR_RUNTIME'));
  // A source view where evidence belongs is rejected by record type.
  const swapped = JSON.parse(JSON.stringify(inline));
  const victim = swapped.items[0].via[0];
  [victim.evidence, victim.source] = [victim.source, victim.evidence];
  assert.throws(() => toExpandedRefsV1(swapped, window), code('IO_OR_RUNTIME'));
  // Views without an entry id cannot become references.
  const missing = JSON.parse(JSON.stringify(inline));
  delete missing.items[0].via[0].assessment.entry.id;
  assert.throws(() => toExpandedRefsV1(missing, window), code('IO_OR_RUNTIME'));
  // Direct-search responses and shapeless input are rejected, not coerced.
  assert.throws(() => toExpandedRefsV1(ledger.search('光合成速度'), window), code('IO_OR_RUNTIME'));
  assert.throws(() => toExpandedRefsV1({ ...inline, match: 'literal_terms_and' }, window), code('IO_OR_RUNTIME'));
  const novia = JSON.parse(JSON.stringify(inline));
  delete novia.items[0].via;
  assert.throws(() => toExpandedRefsV1(novia, window), code('IO_OR_RUNTIME'));
  const nofields = JSON.parse(JSON.stringify(inline));
  delete nofields.items[0].via[0].match_fields;
  assert.throws(() => toExpandedRefsV1(nofields, window), code('IO_OR_RUNTIME'));
});

test('refs-v1: hostile IDs stay own properties without polluting prototypes', t => {
  const view = (id, type) => ({ entry: { id, type, data: {}, created_at: '2026-09-27T00:00:00.000Z', actor },
    state: 'proposed', review: null, warnings: [] });
  const inline = {
    items: [{ ...view('clm_hostile', 'claim'), direct_match: false,
      via: [{ evidence: view('__proto__', 'evidence'), assessment: view('constructor', 'assessment'),
        source: view('hasOwnProperty', 'source'), match_fields: ['quote'] }],
      total_paths: 1, paths_truncated: false, via_next_offset: null }],
    next_offset: null, query: 'hostile', match: 'expanded_evidence_routed', revision: 7, truth_evaluated: false,
  };
  const refs = toExpandedRefsV1(inline, { offset: 0, limit: 20, path_offset: 0, path_limit: 20 });
  for (const id of ['__proto__', 'constructor', 'hasOwnProperty']) {
    assert.ok(Object.hasOwn(refs.included, id), id);
  }
  assert.deepEqual(expandRefs(JSON.parse(JSON.stringify(refs))), inline);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual({}.__proto__, Object.prototype);
});

test('refs-v1: projection adds no store reads or writes', t => {
  const { store, ledger } = evalSetup(t);
  const names = ['transaction', 'revision', 'search', 'entries', 'incoming', 'get',
    'latestReview', 'latestVerification', 'receipt', 'insert', 'insertReceipt'];
  const counts = Object.fromEntries(names.map(n => [n, 0]));
  for (const name of names) {
    const original = store[name].bind(store);
    store[name] = (...args) => { counts[name] += 1; return original(...args); };
  }
  const run = options => {
    for (const name of names) counts[name] = 0;
    ledger.search('38℃', options);
    return { ...counts };
  };
  const inline = run({ expand: 'evidence' });
  const refs = run({ expand: 'evidence', projection: 'refs-v1' });
  assert.deepEqual(refs, inline);
  assert.equal(inline.insert, 0);
  assert.equal(inline.insertReceipt, 0);
});

test('refs-v1: CLI output parses as the Core representation', t => {
  const { run } = cliSetup(t, 'yurai-refs-');
  assert.equal(run(['init']).status, 0);
  for (const file of ['examples/eval/ledger.json', 'examples/eval/ledger-wd-deps.json', 'examples/eval/ledger-verify.json']) {
    assert.equal(run(['capture', '--file', file]).status, 0);
  }
  const inline = run(['search', '38℃', '--expand', 'evidence']);
  assert.equal(inline.status, 0, inline.stderr);
  const projected = run(['search', '38℃', '--expand', 'evidence', '--projection', 'refs-v1']);
  assert.equal(projected.status, 0, projected.stderr);
  const refs = JSON.parse(projected.stdout);
  assert.equal(refs.format, 'yurai.expanded.refs');
  assert.equal(refs.version, 1);
  assert.equal(refs.included_complete, true);
  assert.deepEqual(refs.window, { offset: 0, limit: 20, path_offset: 0, path_limit: 20 });
  assert.deepEqual(expandRefs(refs), JSON.parse(inline.stdout));
  assert.deepEqual(new Set(Object.keys(refs.included)), refSet(refs));
});

test('refs-v1: CLI rejects bad projection use with usage errors', t => {
  const { run } = cliSetup(t, 'yurai-refs-');
  assert.equal(run(['show', 'clm_demo', '--projection', 'refs-v1']).status, 2);
  assert.equal(run(['init']).status, 0);
  assert.equal(run(['search', 'x', '--expand', 'evidence', '--projection', 'bogus']).status, 2);
  assert.equal(run(['search', 'x', '--projection', 'refs-v1']).status, 2);
  assert.equal(run(['search', 'x', '--kind', 'source', '--expand', 'evidence', '--projection', 'refs-v1']).status, 2);
  assert.equal(run(['show', '--request-id', 'req_x', '--projection', 'refs-v1']).status, 2);
});
