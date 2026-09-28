// Deterministic authoring-friction measurement for #40 box 1 (measure-first).
//
// Replays authoring of the EXISTING synthetic capture/correction fixtures and
// reports mechanical steps (IDs minted, references wired, fields filled) plus
// validation retries to green under the CURRENT diagnostics. No helper, no
// schema change, no production change: strict rejection behavior is observed,
// never altered. All fixtures are synthetic; no private data is read.
//
// Run: `node scripts/measure-authoring.mjs` (from the repo root, after build).
// Exit code is nonzero when a baseline fixture no longer captures green.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, SqliteStore } from '../dist/index.js';
import { references } from '../dist/core/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_FILES = ['examples/capture.json', 'examples/dogfood/01-capture.json', 'examples/dogfood/02-correct.json'];

export function loadFixture(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}
const clone = value => JSON.parse(JSON.stringify(value));

// Reference-valued data fields per record type (mirrors references() in
// src/core/model.ts). Field counts citing "required" mirror the required lists
// in the same file's bodySchemas.
const REF_FIELDS = new Set(['source_id', 'claim_id', 'evidence_id',
  'from_claim_id', 'to_claim_id', 'target_id', 'target_evidence_id', 'target_source_id']);
const REQUIRED = {
  source: ['title', 'medium'],
  claim: ['text', 'kind', 'attributed_to'],
  evidence: ['source_id'],
  assessment: ['claim_id', 'evidence_id', 'stance', 'rationale'],
  relation: ['from_claim_id', 'to_claim_id', 'relation', 'rationale'],
  review: ['target_id', 'state', 'rationale'],
  verification: ['target_evidence_id', 'target_source_id', 'outcome', 'method', 'verified_at'],
};

// Mechanical replay: IDs minted (one per entry plus the bundle request_id),
// references wired (reference edges between records), fields filled (data
// keys). Data fields split into judgment-bearing (semantic content a helper
// must never invent: text, quote, stance, rationale, ...) and mechanical
// (reference IDs copied from minted IDs).
export function mechanicalSteps(bundle) {
  const perType = {};
  let refEdges = 0, fieldsFilled = 0, requiredFilled = 0, refFields = 0;
  for (const entry of bundle.entries) {
    const keys = Object.keys(entry.data);
    const edges = references(entry).length;
    refEdges += edges;
    fieldsFilled += keys.length;
    requiredFilled += keys.filter(k => REQUIRED[entry.type].includes(k)).length;
    refFields += keys.filter(k => REF_FIELDS.has(k)).length;
    perType[entry.type] = (perType[entry.type] ?? 0) + 1;
  }
  const idsMinted = bundle.entries.length + 1; // entries + request_id
  return { entries: bundle.entries.length, idsMinted, refEdges, fieldsFilled,
    requiredFilled, optionalFilled: fieldsFilled - requiredFilled,
    judgmentFields: fieldsFilled - refFields, mechanicalRefFields: refFields,
    bytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'), perType };
}

function attempt(bundle, preload = []) {
  const store = new SqliteStore(':memory:', true);
  try {
    const ledger = new Ledger(store, () => '2026-09-27T00:00:00.000Z');
    for (const prior of preload) ledger.capture(prior);
    return { ok: true, result: ledger.capture(bundle, true) };
  } catch (error) {
    return { ok: false, code: error.code ?? 'THROWN', message: error.message ?? String(error) };
  } finally {
    store.close();
  }
}

// Single-fault injections modeling realistic authoring mistakes. Each fault
// carries its fix so the multi-fault simulation can resolve failures in the
// order the validator reports them (fail-fast: one fault per round).
const byId = (bundle, id) => bundle.entries.find(e => e.id === id);
// Original-value lookup: fixes must restore the fixture's own content, never
// substitute replacement prose that merely validates. Values are read from the
// on-disk fixture so they stay in sync with examples/.
const originalDatum = (base, id, key) =>
  loadFixture(FIXTURE_FILES[base]).entries.find(e => e.id === id).data[key];
// Key-order-insensitive comparison: delete + restore cycles can reorder keys,
// so replay fidelity is judged on sorted-key serialization, not raw JSON text.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const FAULTS = [
  { name: 'unknown-field/entry-key', category: 'unknown field', base: 0,
    apply: b => { byId(b, 'clm_demo').label = 'synthetic label'; },
    fix: b => { delete byId(b, 'clm_demo').label; } },
  { name: 'unknown-field/data-synonym', category: 'unknown field', base: 0,
    apply: b => { byId(b, 'clm_demo').data.author = 'synthetic author'; },
    fix: b => { delete byId(b, 'clm_demo').data.author; } },
  { name: 'bad-ref/dangling', category: 'bad reference', base: 0,
    apply: b => { byId(b, 'asm_demo').data.claim_id = 'clm_no_such'; },
    fix: b => { byId(b, 'asm_demo').data.claim_id = 'clm_demo'; } },
  { name: 'bad-ref/wrong-type', category: 'bad reference', base: 0,
    apply: b => { byId(b, 'evd_demo').data.source_id = 'clm_demo'; },
    fix: b => { byId(b, 'evd_demo').data.source_id = 'src_demo'; } },
  { name: 'bad-ref/duplicate-id', category: 'bad reference', base: 0,
    apply: b => { byId(b, 'clm_demo').id = 'src_demo'; },
    fix: b => { b.entries[1].id = 'clm_demo'; } },
  { name: 'bad-ref/existing-id', category: 'bad reference', base: 0, preload: [0],
    apply: b => { b.request_id = 'req_synthetic_retry_new_id'; },
    fix: b => { b.request_id = 'req_synthetic_demo_v1'; } },
  { name: 'malformed/blank-text', category: 'malformed data', base: 0,
    apply: b => { byId(b, 'clm_demo').data.text = '   '; },
    fix: b => { byId(b, 'clm_demo').data.text = loadFixture(FIXTURE_FILES[0]).entries[1].data.text; } },
  { name: 'malformed/bad-enum', category: 'malformed data', base: 0,
    apply: b => { byId(b, 'asm_demo').data.stance = 'agree'; },
    fix: b => { byId(b, 'asm_demo').data.stance = 'reports'; } },
  { name: 'malformed/bad-id', category: 'malformed data', base: 0,
    apply: b => { byId(b, 'clm_demo').id = '9bad'; },
    fix: b => { b.entries[1].id = 'clm_demo'; } },
  { name: 'malformed/missing-required', category: 'malformed data', base: 0,
    apply: b => { delete byId(b, 'clm_demo').data.attributed_to; },
    fix: b => { byId(b, 'clm_demo').data.attributed_to = originalDatum(0, 'clm_demo', 'attributed_to'); } },
  { name: 'malformed/bad-uri', category: 'malformed data', base: 0,
    apply: b => { byId(b, 'src_demo').data.uri = 'not a uri'; },
    fix: b => { byId(b, 'src_demo').data.uri = 'urn:yurai:example:comparison:v1'; } },
  { name: 'malformed/evidence-bare', category: 'malformed data', base: 0,
    apply: b => { delete byId(b, 'evd_demo').data.quote; delete byId(b, 'evd_demo').data.locator; },
    fix: b => { byId(b, 'evd_demo').data.quote = originalDatum(0, 'evd_demo', 'quote');
      byId(b, 'evd_demo').data.locator = originalDatum(0, 'evd_demo', 'locator'); } },
  { name: 'malformed/self-relation', category: 'malformed data', base: 0,
    apply: b => { byId(b, 'rel_limit').data.to_claim_id = 'clm_limit'; },
    fix: b => { byId(b, 'rel_limit').data.to_claim_id = 'clm_demo'; } },
  { name: 'malformed/source-no-anchor', category: 'malformed data', base: 0,
    apply: b => { delete byId(b, 'src_demo').data.uri; },
    fix: b => { byId(b, 'src_demo').data.uri = 'urn:yurai:example:comparison:v1'; } },
  { name: 'malformed/review-bad-state', category: 'malformed data', base: 2, preload: [1],
    apply: b => { byId(b, 'rev_fixture_old').data.state = 'approved'; },
    fix: b => { byId(b, 'rev_fixture_old').data.state = 'withdrawn'; } },
  { name: 'oversize/text', category: 'oversize', base: 0,
    apply: b => { byId(b, 'clm_demo').data.text = 'x'.repeat(8001); },
    fix: b => { byId(b, 'clm_demo').data.text = originalDatum(0, 'clm_demo', 'text'); } },
  { name: 'oversize/quote', category: 'oversize', base: 0,
    apply: b => { byId(b, 'evd_demo').data.quote = 'x'.repeat(16001); },
    fix: b => { byId(b, 'evd_demo').data.quote = originalDatum(0, 'evd_demo', 'quote'); } },
  { name: 'oversize/entries', category: 'oversize', base: 0,
    apply: b => { while (b.entries.length < 201) {
      const n = b.entries.length;
      b.entries.push({ id: `clm_pad_${n}`, type: 'claim',
        data: { text: `synthetic pad ${n}`, kind: 'assertion', attributed_to: 'syn' } }); } },
    fix: b => { b.entries.length = 6; } },
];

// Diagnostic quality rubric. namesEntry: the message carries a concrete entry
// id or its entries[i] position (bundle-level paths such as bundle.entries
// name no entry). namesField: it carries the offending field, key, role, or
// field family — disclosed approximations: dangling/wrong-type name the role
// plus the bad id rather than the exact key, bad-uri narrows to the
// uri-family (uri, snapshot_uri), and the entries-count diagnostic names the
// collection rather than one field. namesRule: it states the violated rule
// beyond "check the shape". A pinpoint diagnostic (all three) needs no schema
// consultation (0 diagnosis steps); an index-only diagnostic forces the
// author to diff the entry against the schema/examples (1 step).
// diagnosisSteps is a rating, not a timing; retriesToGreen is measured by the
// caller via real fix + recapture and is not set here.
function rateDiagnostic(fault, bundle, outcome) {
  const generic = /must match exactly one documented record shape/.test(outcome.message);
  // The oneOf fallback names only entries[i]: the author must diff the whole
  // entry against the schema/examples to localize the fault (1 step). Every
  // other diagnostic in the matrix states the violated rule, so the fix is
  // obvious from the message (0 steps).
  if (generic) return { namesEntry: true, namesField: false, namesRule: false,
    generic, diagnosisSteps: 1 };
  const entryIds = bundle.entries.map(e => e.id);
  const namesEntry = entryIds.some(id => outcome.message.includes(id))
    || /entries\[\d+\]/.test(outcome.message);
  const fieldKeys = new Set(bundle.entries.flatMap(e => [...Object.keys(e), ...Object.keys(e.data)]));
  const namesField = [...fieldKeys].some(k => k.length >= 3 && outcome.message.includes(k))
    || /missing \S+|unknown field \S+|wrong record type|quote or locator|self-relations|absolute URI|uri or|Duplicate ID|already exists|invalid item count/.test(outcome.message);
  return { namesEntry, namesField, namesRule: true, generic, diagnosisSteps: 0 };
}

export function measureSingleFaults(fixtures) {
  return FAULTS.map(fault => {
    const bundle = clone(fixtures[fault.base]);
    fault.apply(bundle);
    const preload = (fault.preload ?? []).map(i => fixtures[i]);
    const outcome = attempt(bundle, preload);
    if (outcome.ok) throw new Error(`fault accepted, strictness regressed: ${fault.name}`);
    const quality = rateDiagnostic(fault, bundle, outcome);
    // Measured rerun: apply the recorded fix and recapture. retriesToGreen
    // counts real recapture calls to green; a fix that does not reach green
    // fails the harness instead of pinning an assumed 1.
    const fixed = clone(bundle);
    fault.fix(fixed);
    // Replay fidelity: the fix must restore the original fixture content, not
    // substitute replacement prose that merely validates. A fixed bundle that
    // differs from its clean base fails the harness before recapture.
    if (stable(fixed) !== stable(fixtures[fault.base])) {
      throw new Error(`fix altered fixture content instead of restoring it: ${fault.name}`);
    }
    let retriesToGreen = 0;
    retriesToGreen += 1;
    const rerun = attempt(fixed, preload);
    if (!rerun.ok) throw new Error(`fix did not reach green: ${fault.name} -> ${rerun.code}: ${rerun.message}`);
    return { name: fault.name, category: fault.category, code: outcome.code,
      message: outcome.message, ...quality, retriesToGreen };
  });
}

// Which entry a fault touches, found by diffing the faulty bundle against its
// clean base. Compared by index against the clean entry ids; request-level
// faults (request_id only) report index -1.
export function faultEntry(fault, fixtures) {
  const clean = clone(fixtures[fault.base]);
  const dirty = clone(fixtures[fault.base]);
  fault.apply(dirty);
  if (JSON.stringify(dirty.entries) === JSON.stringify(clean.entries)) return { index: -1, id: null };
  const n = Math.max(dirty.entries.length, clean.entries.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(dirty.entries[i]) !== JSON.stringify(clean.entries[i])) {
      return { index: i, id: clean.entries[i]?.id ?? dirty.entries[i]?.id ?? null };
    }
  }
  return { index: -1, id: null };
}

// Which entry a diagnostic reports: an entries[i] position, a leading entry
// id ("asm_demo: ...", "Duplicate ID in input: ..."), or bundle-level.
function reportedEntry(message) {
  const positioned = message.match(/entries\[(\d+)\]/);
  if (positioned) return { kind: 'index', ref: `entries[${positioned[1]}]`, index: Number(positioned[1]) };
  if (/^bundle[.:]/.test(message)) return { kind: 'bundle', ref: 'bundle' };
  const named = message.match(/^(?:Duplicate ID in input|Immutable ID already exists): (\S+)/)
    ?? message.match(/^([A-Za-z][A-Za-z0-9_.:-]*):/);
  if (named) return { kind: 'id', ref: named[1], id: named[1] };
  return { kind: 'bundle', ref: 'bundle' };
}

// Fail-fast rounds to green: one fault from each category, fixed strictly in
// validator-reported order. Every round's fix touches the entry the
// diagnostic names; a diagnostic naming an entry no remaining fault touches
// fails the harness instead of misattributing the fix elsewhere.
export function measureMultiFault(fixtures) {
  const picked = ['unknown-field/data-synonym', 'bad-ref/dangling',
    'malformed/bad-enum', 'oversize/text'].map(name => FAULTS.find(f => f.name === name));
  const affected = new Map(picked.map(f => [f.name, faultEntry(f, fixtures)]));
  const bundle = clone(fixtures[0]);
  for (const fault of picked) fault.apply(bundle);
  const remaining = [...picked];
  const rounds = [];
  for (let attemptNo = 1; ; attemptNo++) {
    const outcome = attempt(bundle);
    if (outcome.ok) {
      if (stable(bundle) !== stable(fixtures[0])) {
        throw new Error('multi-fault replay diverged from the original fixture content');
      }
      return { faults: picked.length, attempts: attemptNo, retries: attemptNo - 1, rounds };
    }
    const reported = reportedEntry(outcome.message);
    const candidates = remaining.filter(f => {
      const a = affected.get(f.name);
      if (reported.kind === 'index') return a.index === reported.index;
      if (reported.kind === 'id') return a.id === reported.id;
      return a.index === -1;
    });
    if (!candidates.length) throw new Error(
      `multi-fault order broke: ${outcome.code}: ${outcome.message} names ${reported.ref}, ` +
      `untouched by remaining faults (${remaining.map(f => f.name).join(', ')})`);
    // Tie-break among same-entry faults: fix the one the diagnostic actually
    // describes — its lone fix must move the diagnostic or reach green.
    // Same-entry same-message faults are indistinguishable to the author too
    // (fixing either leaves the message unchanged); picked order decides, and
    // the fix still addresses the reported entry.
    let fixable = candidates[0];
    if (candidates.length > 1) {
      const movers = candidates.filter(f => {
        const scratch = clone(bundle);
        f.fix(scratch);
        const next = attempt(scratch);
        return next.ok || next.message !== outcome.message;
      });
      if (movers.length === 1) fixable = movers[0];
    }
    const a = affected.get(fixable.name);
    rounds.push({ attempt: attemptNo, code: outcome.code, message: outcome.message,
      fixed: fixable.name, reported: reported.ref,
      fixedEntry: a.index >= 0 ? `entries[${a.index}]` : 'bundle', fixedId: a.id });
    fixable.fix(bundle);
    remaining.splice(remaining.indexOf(fixable), 1);
    if (attemptNo > 10) throw new Error('multi-fault simulation did not converge');
  }
}

// Privacy: no judgment-bearing content value (text, quote, rationale, ...)
// may appear in any diagnostic. Structural IDs are allowed: naming the entry
// is the required behavior, and IDs are references by design, so entry ids
// and reference-ID values are out of the checked set. Short ASCII tokens
// match on word boundaries so common substrings cannot false-positive; every
// other value matches by substring.
export function echoes(message, value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (value.length >= 8 || !/^[\w-]+$/u.test(value)) return message.includes(value);
  return new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u').test(message);
}

// Every nonblank judgment-bearing string in the fixture entries, at any
// length, plus every fault- and fix-introduced value (diagnostics are
// produced from faulty and progressively fixed bundles). Entry-level keys
// other than id/type are in scope (e.g. an injected unknown field's value).
export function contentValues(fixtures) {
  const values = new Set();
  const add = v => { if (typeof v === 'string' && v.trim()) values.add(v); };
  const collectEntry = entry => {
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'id' || key === 'type') continue;
      if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [dk, dv] of Object.entries(value)) {
          if (REF_FIELDS.has(dk)) continue;
          if (typeof dv === 'string') add(dv);
          else if (dv && typeof dv === 'object') for (const v of Object.values(dv)) add(v);
        }
      } else if (typeof value === 'string') add(value);
      else if (value && typeof value === 'object') for (const v of Object.values(value)) add(v);
    }
  };
  for (const fixture of fixtures) for (const entry of fixture.entries) collectEntry(entry);
  for (const fault of FAULTS) {
    const dirty = clone(fixtures[fault.base]);
    fault.apply(dirty);
    for (const entry of dirty.entries) collectEntry(entry);
    fault.fix(dirty);
    for (const entry of dirty.entries) collectEntry(entry);
  }
  return [...values];
}

export function measureAll() {
  const fixtures = FIXTURE_FILES.map(loadFixture);
  const baselines = fixtures.map((fixture, i) => {
    const outcome = attempt(fixture, i === 2 ? [fixtures[1]] : []);
    return { file: FIXTURE_FILES[i], green: outcome.ok,
      error: outcome.ok ? null : `${outcome.code}: ${outcome.message}`, steps: mechanicalSteps(fixture) };
  });
  const single = measureSingleFaults(fixtures);
  const multi = measureMultiFault(fixtures);
  const contents = contentValues(fixtures);
  const echoed = [];
  for (const row of [...single, ...multi.rounds]) {
    for (const value of contents) {
      if (echoes(row.message, value)) echoed.push({ fault: row.name ?? `round-${row.attempt}`, value: `${value.slice(0, 48)}…` });
    }
  }
  return { baselines, single, multi, privacy: { contentValuesChecked: contents.length, echoed } };
}

function tick(v) { return v ? 'yes' : 'no'; }

function main() {
  const { baselines, single, multi, privacy } = measureAll();
  const lines = [];
  lines.push('# Authoring friction baseline (yurai #40 box 1)', '');
  lines.push('## Mechanical steps per fixture', '');
  lines.push('| Fixture | Entries | IDs minted | Refs wired | Fields filled (req/opt) | Judgment fields | Bytes |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const total = { entries: 0, idsMinted: 0, refEdges: 0, fieldsFilled: 0, requiredFilled: 0, judgmentFields: 0, bytes: 0 };
  for (const b of baselines) {
    const s = b.steps;
    lines.push(`| ${b.file} | ${s.entries} | ${s.idsMinted} | ${s.refEdges} | ${s.fieldsFilled} (${s.requiredFilled}/${s.optionalFilled}) | ${s.judgmentFields} | ${s.bytes} |`);
    for (const k of Object.keys(total)) total[k] += s[k];
  }
  lines.push(`| Total | ${total.entries} | ${total.idsMinted} | ${total.refEdges} | ${total.fieldsFilled} (${total.requiredFilled}/${total.fieldsFilled - total.requiredFilled}) | ${total.judgmentFields} | ${total.bytes} |`, '');
  lines.push('IDs minted = one per entry plus one request_id per bundle. Refs wired = reference edges ' +
    'a helper could derive from local aliases. Judgment fields = data fields carrying semantic content ' +
    '(text, quote, stance, rationale, attribution, scope, ...) that must stay human/agent-authored.', '');
  lines.push('## Single-fault retries under current diagnostics', '');
  lines.push('| Injected fault | Code | Diagnostic | Entry? | Field? | Rule? | Reruns to green | Diagnosis steps |');
  lines.push('| --- | --- | --- | --- | --- | --- | ---: | ---: |');
  for (const r of single) lines.push(`| ${r.name} | ${r.code} | \`${r.message}\` | ${tick(r.namesEntry)} | ${tick(r.namesField)} | ${tick(r.namesRule)} | ${r.retriesToGreen} | ${r.diagnosisSteps} |`);
  lines.push('', `Fail-fast multi-fault (${multi.faults} faults, one per category): ${multi.attempts} attempts, ${multi.retries} retries to green.`, '');
  lines.push('| Attempt | Code | Diagnostic | Fix applied | Reported entry | Fixed entry |');
  lines.push('| ---: | --- | --- | --- | --- | --- |');
  for (const r of multi.rounds) lines.push(`| ${r.attempt} | ${r.code} | \`${r.message}\` | ${r.fixed} | ${r.reported} | ${r.fixedEntry} |`);
  lines.push('');
  lines.push('## Privacy of diagnostics', '');
  lines.push(privacy.echoed.length
    ? `FAIL: ${privacy.echoed.length} diagnostics echo fixture content.`
    : `Checked ${privacy.contentValuesChecked} content values across all diagnostics: none echoed. Structural IDs are named (required), content is not.`, '');
  console.log(lines.join('\n'));
  const red = baselines.filter(b => !b.green);
  if (red.length) {
    console.error(`Baseline not green: ${red.map(b => `${b.file} -> ${b.error}`).join('; ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
