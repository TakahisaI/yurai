import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memorySetup } from './helpers/memory.mjs';

// Issue #39 judgment-trail trial: all fixtures are synthetic. Each test builds a
// fresh disposable in-memory ledger, so the "fresh context" reuse pass (box 5) is
// a genuinely separate ledger rather than a re-read of shared state.
const files = ['01-conditional.json', '02-competing.json', '03-joint.json', '04-revisit.json', '05-states.json'];
const bundles = files.map(f => JSON.parse(readFileSync(new URL(`../examples/judgment-trail/${f}`, import.meta.url), 'utf8')));
const TOTAL_RECORDS = bundles.reduce((n, b) => n + b.entries.length, 0);

function setup(t, count = bundles.length) {
  const { store, ledger } = memorySetup(t, { now: null });
  for (const bundle of bundles.slice(0, count)) {
    const result = ledger.capture(bundle);
    assert.equal(result.replayed, false);
  }
  return { store, ledger };
}

const connectionsOf = (view, type) => view.connections.filter(c => c.entry.type === type);

test('box 1: conditional conclusion carries question, purpose and sufficiency as attributed judgments', t => {
  const { ledger } = setup(t, 1);
  for (const [id, attributed_to] of [['clm_jt_question', 'trial-user'], ['clm_jt_purpose', 'trial-user'],
    ['clm_jt_sufficient', 'trial-user'], ['clm_jt_conditional', 'trial-agent']]) {
    assert.equal(ledger.show(id).entry.data.attributed_to, attributed_to, id);
  }
  assert.match(ledger.show('clm_jt_sufficient').entry.data.scope, /not a universal proof threshold/);
  const conditional = ledger.show('clm_jt_conditional');
  assert.equal(conditional.entry.data.kind, 'inference');
  assert.match(conditional.entry.data.scope, /above 12 riders per run/);
  assert.match(conditional.entry.data.scope, /evd_jt_riders_jan, evd_jt_cost_jan/);
  assert.match(conditional.entry.data.why, /clm_jt_sufficient/);
  const stances = new Map(connectionsOf(conditional, 'assessment').map(c => [c.entry.id, c.entry.data.stance]));
  assert.equal(stances.get('asm_jt_cond_riders'), 'supports');
  assert.equal(stances.get('asm_jt_cond_cost'), 'qualifies');
  // The January figure supports baseline demand only; it must never read as
  // clearing the February-ridership condition, which remains unchecked.
  const ridersRationale = connectionsOf(conditional, 'assessment')
    .find(c => c.entry.id === 'asm_jt_cond_riders').entry.data.rationale;
  assert.match(ridersRationale, /does not satisfy the February condition/);
  assert.doesNotMatch(ridersRationale, /clears the/);
});

test('box 1: competing interpretations share one passage with distinct stances and an unresolved objection', t => {
  const { ledger } = setup(t, 2);
  const onShared = [ledger.show('clm_jt_stable'), ledger.show('clm_jt_declining')]
    .flatMap(view => connectionsOf(view, 'assessment'))
    .filter(c => c.references.some(r => r.entry.id === 'evd_jt_riders_jan'));
  assert.deepEqual(new Set(onShared.map(c => c.entry.data.stance)), new Set(['supports', 'qualifies']));
  const declining = ledger.show('clm_jt_declining');
  const compete = connectionsOf(declining, 'relation').find(c => c.entry.id === 'rel_jt_compete');
  assert.equal(compete.entry.data.relation, 'contradicts');
  for (const id of ['clm_jt_stable', 'clm_jt_declining']) {
    const qualifiers = connectionsOf(ledger.show(id), 'relation')
      .filter(c => c.entry.data.relation === 'qualifies').map(c => c.entry.id);
    assert.ok(qualifiers.some(q => q.startsWith('rel_jt_unresolved_')), `${id} keeps the unresolved objection`);
  }
  assert.match(ledger.show('clm_jt_unresolved_shape').entry.data.text, /unresolved/);
  // Both readings of the SHARED passage are defensible: it carries
  // multi-month steadiness (the supports-stable ground) while reporting only
  // monthly averages (the qualifies ground, hiding within-month shape).
  assert.match(ledger.show('evd_jt_riders_jan').entry.data.quote, /steady against the prior three months/);
  const stableRationale = onShared.find(c => c.entry.data.stance === 'supports').entry.data.rationale;
  assert.match(stableRationale, /settled demand level/);
  assert.doesNotMatch(stableRationale, /adequate demand/);
});

test('box 1: revisit after correction preserves history and grounds the new conclusion on the fix', t => {
  const { ledger } = setup(t, 4);
  const old = ledger.show('clm_jt_conditional');
  assert.match(old.entry.data.text, /provided February ridership stays above 12/);
  const supersedes = connectionsOf(old, 'relation').find(c => c.entry.id === 'rel_jt_v2_supersedes');
  assert.equal(supersedes.entry.data.relation, 'supersedes');
  assert.equal(supersedes.entry.data.from_claim_id, 'clm_jt_conditional_v2');
  assert.equal(ledger.show('evd_jt_cost_jan').state, 'withdrawn');
  assert.match(ledger.show('evd_jt_cost_jan').review.data.rationale, /mistranscribed/);
  const revised = ledger.show('clm_jt_conditional_v2');
  const grounds = connectionsOf(revised, 'assessment').map(c => c.references.find(r => r.entry.type === 'evidence').entry.id);
  assert.ok(grounds.includes('evd_jt_cost_jan_fixed'));
  assert.ok(!grounds.includes('evd_jt_cost_jan'));
  // The revisited conclusion enumerates its full source-record set, including
  // the carried-over ridership ground, and distinguishes it from withdrawn
  // records that are no longer grounds.
  assert.match(revised.entry.data.scope, /evd_jt_riders_jan, evd_jt_cost_jan_fixed/);
  assert.match(revised.entry.data.scope, /no longer a ground/);
  const v2RidersRationale = connectionsOf(revised, 'assessment')
    .find(c => c.entry.id === 'asm_jt_v2_riders').entry.data.rationale;
  assert.match(v2RidersRationale, /does not satisfy the February condition/);
  assert.doesNotMatch(v2RidersRationale, /clears the/);
});

test('box 2: source claims, user hypotheses and agent deductions stay distinct; reservations stay visible', t => {
  const { ledger } = setup(t);
  const kindOf = id => [ledger.show(id).entry.data.kind, ledger.show(id).entry.data.attributed_to];
  assert.deepEqual(kindOf('clm_jt_pump_ok'), ['assertion', 'fictional-bench-operator']);
  assert.deepEqual(kindOf('clm_jt_stable'), ['hypothesis', 'trial-user']);
  assert.deepEqual(kindOf('clm_jt_declining'), ['inference', 'trial-agent']);
  assert.deepEqual(kindOf('clm_jt_flow_ok'), ['inference', 'trial-agent']);
  // reports (the notes state it) is not supports (it proves readiness).
  assert.equal(ledger.show('clm_jt_flow_ok').connections.filter(c => c.entry.type === 'assessment').length, 0);
  const conditional = ledger.show('clm_jt_conditional');
  const reservations = connectionsOf(conditional, 'relation').filter(c => c.entry.data.relation === 'qualifies');
  const fromIds = reservations.map(c => c.entry.data.from_claim_id);
  assert.ok(fromIds.includes('clm_jt_reservation_feb'));
  assert.ok(fromIds.includes('clm_jt_nohit_note'));
  assert.match(ledger.show('clm_jt_nohit_note').entry.data.text, /not proof that no counterevidence exists/);
});

test('box 3: joint premises recall as a conjunction, never as independent supports', t => {
  const { ledger } = setup(t, 3);
  const conclusion = ledger.show('clm_jt_flow_ok');
  assert.match(conclusion.entry.data.scope, /clm_jt_pump_ok AND clm_jt_loop_ok jointly/);
  assert.match(conclusion.entry.data.scope, /Neither premise alone warrants/);
  // The joint conclusion enumerates Evidence IDs (not only premise Claims),
  // states that the grounds are not the capture membership, and is scoped to
  // the ten-minute run the pump passage warrants.
  assert.match(conclusion.entry.data.scope, /evd_jt_pump, evd_jt_loop/);
  assert.match(conclusion.entry.data.scope, /not the capture membership/);
  assert.match(conclusion.entry.data.text, /for ten minutes/);
  assert.match(conclusion.entry.data.scope, /ten-minute run at 40 L\/min only/);
  const relations = connectionsOf(conclusion, 'relation');
  assert.equal(relations.length, 2);
  for (const rel of relations) {
    assert.equal(rel.entry.data.relation, 'related');
    assert.match(rel.entry.data.rationale, /Deliberately not supports/);
  }
  assert.deepEqual(new Set(relations.map(r => r.entry.data.from_claim_id)),
    new Set(['clm_jt_pump_ok', 'clm_jt_loop_ok']));
  // No supports edge from either premise to the conclusion exists anywhere.
  for (const premise of ['clm_jt_pump_ok', 'clm_jt_loop_ok']) {
    const outgoing = connectionsOf(ledger.show(premise), 'relation')
      .filter(c => c.entry.data.from_claim_id === premise && c.entry.data.to_claim_id === 'clm_jt_flow_ok');
    assert.ok(outgoing.every(c => c.entry.data.relation !== 'supports'));
  }
});

test('box 4: later withdrawals flag reconsideration but never auto-reverse the recorded judgment', t => {
  const { ledger } = setup(t);
  assert.equal(ledger.show('clm_jt_conditional').state, 'accepted');
  assert.equal(ledger.show('clm_jt_conditional_v2').state, 'accepted');
  // Withdrawing a grounding passage marks the dependency, not the conclusion.
  ledger.capture({ version: 1, request_id: 'req_jt_trial_withdraw_riders', actor: { kind: 'agent', id: 'trial-agent' },
    entries: [{ id: 'rev_jt_trial_riders', type: 'review',
      data: { target_id: 'evd_jt_riders_jan', state: 'withdrawn', rationale: 'Trial probe: January sheet superseded mid-trial.' } }] });
  assert.equal(ledger.show('evd_jt_riders_jan').state, 'withdrawn');
  assert.equal(ledger.show('clm_jt_conditional').state, 'accepted');
  assert.equal(ledger.show('clm_jt_conditional_v2').state, 'accepted');
  // As-recorded content is unchanged while current dependency status shows the gap.
  const recalled = ledger.show('clm_jt_conditional');
  assert.match(recalled.entry.data.text, /provided February ridership stays above 12/);
  const riderGround = connectionsOf(recalled, 'assessment').find(c => c.entry.id === 'asm_jt_cond_riders');
  const ground = riderGround.references.find(r => r.entry.id === 'evd_jt_riders_jan');
  assert.equal(ground.state, 'withdrawn');
  assert.ok(ground.warnings.includes('inactive_record'));
});

test('box 4: capture inspection separates original membership from current states', t => {
  const { ledger } = setup(t);
  const inspected = ledger.inspectCapture('req_jt_conditional_v1', 50);
  assert.equal(inspected.states_as_of, 'inspection');
  assert.equal(inspected.truth_evaluated, false);
  assert.equal(inspected.total, bundles[0].entries.length);
  assert.deepEqual(inspected.items.map(i => i.entry.id), bundles[0].entries.map(e => e.id));
  const byId = new Map(inspected.items.map(i => [i.entry.id, i]));
  assert.equal(byId.get('clm_jt_conditional').state, 'accepted');
  assert.equal(byId.get('evd_jt_cost_jan').state, 'withdrawn');
  assert.match(byId.get('clm_jt_conditional').entry.data.scope, /req_jt_conditional_v1/);
});

test('box 5: a fresh disposable context reuses the trail with warrant, reservations and statuses intact', t => {
  const { store, ledger } = setup(t);
  assert.equal(store.count(), TOTAL_RECORDS);
  assert.equal(ledger.search('WQZ7').items.length, 0);
  const routed = ledger.search('WQZ7', { expand: 'evidence' });
  assert.deepEqual(routed.items.map(i => i.entry.id), ['clm_jt_declining']);
  assert.equal(routed.items[0].direct_match, false);
  assert.equal(routed.items[0].via[0].assessment.entry.data.stance, 'supports');
  const flow = ledger.show('clm_jt_flow_ok');
  assert.match(flow.entry.data.scope, /jointly/);
  assert.equal(flow.state, 'accepted');
  const conditional = ledger.show('clm_jt_conditional');
  assert.equal(conditional.state, 'accepted');
  assert.ok(connectionsOf(conditional, 'relation').some(c => c.entry.data.from_claim_id === 'clm_jt_reservation_feb'));
  // Corrected discoverability account: the withdrawn cost ground is visible
  // nested in this same show view (assessment connection reference), while
  // the top-level warnings stay empty.
  assert.deepEqual(conditional.warnings, []);
  const costGround = connectionsOf(conditional, 'assessment')
    .find(c => c.entry.id === 'asm_jt_cond_cost')
    .references.find(r => r.entry.id === 'evd_jt_cost_jan');
  assert.equal(costGround.state, 'withdrawn');
  assert.ok(costGround.warnings.includes('inactive_record'));
  assert.equal(ledger.show('clm_jt_stable').state, 'proposed');
  assert.equal(ledger.show('evd_jt_cost_jan').state, 'withdrawn');
  for (const view of [flow, conditional, routed]) assert.equal(view.truth_evaluated, false);
  assert.equal(store.doctor().ok, true);
});
