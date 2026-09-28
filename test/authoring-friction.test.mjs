// Baseline pin for yurai #40 box 1: the authoring-friction numbers in
// docs/authoring-friction.md are produced by scripts/measure-authoring.mjs;
// this test pins the underlying contract (strict rejection per fault, current
// diagnostic quality, privacy of diagnostics) so box-2/box-3 diffs show up
// here before the report's "after" column is filled in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAULTS, contentValues, echoes, loadFixture, measureAll, mechanicalSteps } from '../scripts/measure-authoring.mjs';

const FILES = ['examples/capture.json', 'examples/dogfood/01-capture.json', 'examples/dogfood/02-correct.json'];

test('baseline fixtures stay green and mechanical counts match the report', () => {
  const { baselines } = measureAll();
  assert.equal(baselines.length, 3);
  for (const b of baselines) assert.equal(b.green, true, `${b.file}: ${b.error}`);
  const steps = baselines.map(b => b.steps);
  assert.deepEqual(steps.map(s => [s.entries, s.idsMinted, s.refEdges, s.fieldsFilled, s.judgmentFields]),
    [[6, 7, 5, 25, 20], [10, 11, 10, 42, 32], [5, 6, 7, 20, 13]]);
  assert.deepEqual(mechanicalSteps(loadFixture(FILES[0])).perType,
    { source: 1, claim: 2, evidence: 1, assessment: 1, relation: 1 });
});

test('every injected fault is strictly rejected with its baseline code', () => {
  const expected = {
    'unknown-field/entry-key': 'VALIDATION', 'unknown-field/data-synonym': 'VALIDATION',
    'bad-ref/dangling': 'NOT_FOUND', 'bad-ref/wrong-type': 'VALIDATION',
    'bad-ref/duplicate-id': 'CONFLICT', 'bad-ref/existing-id': 'CONFLICT',
    'malformed/blank-text': 'VALIDATION', 'malformed/bad-enum': 'VALIDATION',
    'malformed/bad-id': 'VALIDATION', 'malformed/missing-required': 'VALIDATION',
    'malformed/bad-uri': 'VALIDATION', 'malformed/evidence-bare': 'VALIDATION',
    'malformed/self-relation': 'VALIDATION', 'malformed/source-no-anchor': 'VALIDATION',
    'malformed/review-bad-state': 'VALIDATION',
    'oversize/text': 'VALIDATION', 'oversize/quote': 'VALIDATION', 'oversize/entries': 'VALIDATION',
  };
  assert.deepEqual(new Set(FAULTS.map(f => f.name)), new Set(Object.keys(expected)));
  const { single } = measureAll();
  for (const row of single) assert.equal(row.code, expected[row.name], row.name);
});

// Current diagnostic split: per-entry shape faults collapse into the generic
// oneOf message (entry index only); semantic and reference faults pinpoint
// entry, field/role, and rule; the entries-count fault names the collection
// and the rule but no single entry. Box 2 changes this split; update it there.
test('diagnostic quality split matches the baseline (9 generic, 8 pinpoint, 1 bundle-level)', () => {
  const { single } = measureAll();
  const generic = single.filter(r => r.generic).map(r => r.name).sort();
  assert.deepEqual(generic, ['malformed/bad-enum', 'malformed/bad-id', 'malformed/blank-text',
    'malformed/missing-required', 'malformed/review-bad-state', 'oversize/quote',
    'oversize/text', 'unknown-field/data-synonym', 'unknown-field/entry-key'].sort());
  const bundleLevel = single.filter(r => !r.generic && !r.namesEntry);
  assert.deepEqual(bundleLevel.map(r => r.name), ['oversize/entries']);
  assert.equal(bundleLevel[0].namesField, true);
  assert.equal(bundleLevel[0].namesRule, true);
  assert.equal(bundleLevel[0].diagnosisSteps, 0);
  for (const row of single) {
    // Measured, not assumed: the harness applies each fault's fix and
    // recaptures to green, failing loudly if one recapture is not enough.
    assert.equal(row.retriesToGreen, 1, row.name);
    assert.equal(row.diagnosisSteps, row.generic ? 1 : 0, row.name);
    if (!row.generic && row.namesEntry) assert.equal(row.namesField && row.namesRule, true, row.name);
  }
  const pinpoint = single.filter(r => !r.generic && r.namesEntry);
  assert.equal(pinpoint.length, 8);
});

test('fail-fast multi-fault follows validator-reported order to green', () => {
  const { multi } = measureAll();
  assert.equal(multi.faults, 4);
  assert.equal(multi.retries, 4);
  assert.equal(multi.attempts, 5);
  // Shape errors mask reference errors: both entries[1] faults clear first,
  // then the entries[3] shape fault, then the unmasked dangling reference.
  assert.deepEqual(multi.rounds.map(r => r.fixed),
    ['unknown-field/data-synonym', 'oversize/text', 'malformed/bad-enum', 'bad-ref/dangling']);
  // Every round's fix touches the entry the diagnostic reported.
  for (const r of multi.rounds) {
    if (r.reported.startsWith('entries[')) assert.equal(r.reported, r.fixedEntry, `round ${r.attempt}`);
    else assert.equal(r.reported, r.fixedId, `round ${r.attempt}`);
  }
});

test('no diagnostic echoes fixture or injected content', () => {
  const fixtures = FILES.map(loadFixture);
  const contents = contentValues(fixtures);
  assert.equal(contents.length, 259);
  // Short and injected values are in scope, not just long fixture strings.
  // Fixes restore original fixture content, so no fix-introduced value exists.
  for (const probe of ['reports', 'v1', 'synthetic author', 'synthetic label',
      'agree', 'not a uri', 'synthetic pad 6']) {
    assert.ok(contents.includes(probe), `expected in checked set: ${probe}`);
  }
  // Structural IDs stay out of scope by design: naming the entry is required.
  for (const id of ['src_demo', 'clm_demo', 'clm_no_such']) {
    assert.ok(!contents.includes(id), `structural ID must stay out of scope: ${id}`);
  }
  const { single, multi, privacy } = measureAll();
  assert.deepEqual(privacy.echoed, []);
  for (const row of [...single, ...multi.rounds]) {
    for (const value of contents) assert.ok(!echoes(row.message, value), `${row.name ?? 'round'} echoes content`);
  }
});
