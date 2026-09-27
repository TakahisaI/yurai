// Deterministic scale/cost measurement for #44. Builds synthetic ledgers at
// explicit sizes, times representative operations, and prints one JSON report.
// Not part of `npm test`: timings are environment-dependent. All content is
// synthetic; no private data is read. Memory is intentionally unmeasured:
// honest heap deltas need GC control at both boundaries (a later pass).
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, SqliteStore } from '../dist/index.js';

const actor = { kind: 'agent', id: 'scale-gen' };
const AT = '2026-09-27T00:00:00.000Z';

// mulberry32: deterministic vocabulary and fan-out.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['光合成', '気孔', '蒸散', '葉緑素', '根圏', '開花', '受粉', '発芽', '光周性', '耐乾性',
  'photosynthesis', 'stomata', 'xylem', 'cultivar', 'phenotype', 'nitrogen', 'canopy', 'biomass'];

function buildLedger({ claims, evdPerClaim, asmPerEvd, reviewsPerClaim, verificationsFraction, quoteWords }) {
  const rand = rng(20260927);
  const dir = mkdtempSync(join(tmpdir(), 'yurai-scale-'));
  const store = new SqliteStore(join(dir, 'ledger.sqlite'), true);
  const ledger = new Ledger(store, () => AT);
  const pick = () => WORDS[Math.floor(rand() * WORDS.length)];
  const counts = { source: 0, claim: 0, evidence: 0, assessment: 0, review: 0, verification: 0, relation: 0 };
  const started = performance.now();
  // One shared source per 10 claims models repeated-source overlap.
  for (let c = 0; c < claims; c++) {
    const entries = [];
    if (c % 10 === 0) {
      entries.push({ id: `src_m${String(c).padStart(4, '0')}`, type: 'source', data: {
        title: `Synthetic heat study ${(c / 10) | 0}`, medium: 'experiment',
        uri: `urn:yurai:synthetic:scale:${(c / 10) | 0}` } });
      counts.source++;
    }
    const src = `src_m${String(c - (c % 10)).padStart(4, '0')}`;
    const clm = `clm_m${String(c).padStart(4, '0')}`;
    // 気孔 in every claim holds the 2-char probe at the 50-result cap on all shapes.
    entries.push({ id: clm, type: 'claim', data: { text: `架空所見${c}：気孔と${pick()}の関係 COMMONTERM CLAIMRARE${c}`, kind: 'assertion', attributed_to: 'synthetic' } });
    counts.claim++;
    for (let e = 0; e < evdPerClaim; e++) {
      const evd = `${clm}_e${e}`;
      const quote = Array.from({ length: quoteWords }, pick).join('') + ` RARE${c}_${e} 架空値`;
      entries.push({ id: evd, type: 'evidence', data: { source_id: src, quote, locator: `tab${e}` } });
      counts.evidence++;
      for (let a = 0; a < asmPerEvd; a++) {
        entries.push({ id: `${evd}_a${a}`, type: 'assessment', data: { claim_id: clm, evidence_id: evd,
          stance: a % 3 === 2 ? 'challenges' : 'supports', rationale: `synthetic ${a}` } });
        counts.assessment++;
      }
      if (rand() < verificationsFraction) {
        const searched = Buffer.from('synthetic bytes without the passage', 'utf8');
        entries.push({ id: `${evd}_v`, type: 'verification', data: { target_evidence_id: evd, target_source_id: src,
          outcome: 'mismatch', method: 'verbatim', verified_at: AT,
          searched_sha256: createHash('sha256').update(searched).digest('hex'), searched_bytes: searched.length } });
        counts.verification++;
      }
    }
    for (let r = 0; r < reviewsPerClaim; r++) {
      entries.push({ id: `${clm}_r${r}`, type: 'review', data: { target_id: clm, state: r === 0 ? 'accepted' : 'proposed', rationale: 'syn' } });
      counts.review++;
    }
    if (c > 0 && c % 25 === 0) {
      entries.push({ id: `${clm}_rel`, type: 'relation', data: { from_claim_id: clm,
        to_claim_id: `clm_m${String(c - 1).padStart(4, '0')}`, relation: 'extends', rationale: 'syn' } });
      counts.relation++;
    }
    ledger.capture({ version: 1, request_id: `req_scale_${c}`, actor, entries });
  }
  const buildMs = performance.now() - started;
  return { dir, store, ledger, counts, buildMs };
}

function time(fn, runs = 4) {
  fn();
  const samples = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); samples.push(performance.now() - t); }
  samples.sort((a, b) => a - b);
  const mid = runs / 2;
  const median = runs % 2 ? samples[mid | 0] : (samples[mid - 1] + samples[mid]) / 2;
  return { median_ms: median, max_ms: samples[runs - 1] };
}

const SCALES = [
  { name: 'flat-100', claims: 100, evdPerClaim: 1, asmPerEvd: 1, reviewsPerClaim: 1, verificationsFraction: 0.1, quoteWords: 6 },
  { name: 'flat-500', claims: 500, evdPerClaim: 1, asmPerEvd: 1, reviewsPerClaim: 1, verificationsFraction: 0.1, quoteWords: 6 },
  { name: 'flat-2000', claims: 2000, evdPerClaim: 1, asmPerEvd: 1, reviewsPerClaim: 1, verificationsFraction: 0.1, quoteWords: 6 },
  { name: 'dense-100x8', claims: 100, evdPerClaim: 8, asmPerEvd: 3, reviewsPerClaim: 4, verificationsFraction: 0.2, quoteWords: 40 },
];

const report = { env: { node: process.version, platform: process.platform }, scales: [] };
for (const shape of SCALES) {
  const { dir, store, ledger, counts, buildMs } = buildLedger(shape);
  const directCommon = time(() => ledger.search('COMMONTERM', { limit: 50 }));
  const directRare = time(() => ledger.search(`CLAIMRARE${shape.claims - 1}`, { limit: 50 }));
  const directShort = time(() => ledger.search('気孔', { limit: 50 }));
  const expanded = time(() => ledger.search('RARE7_0', { limit: 50, expand: 'evidence' }));
  const show = time(() => ledger.show('clm_m0007'));
  const exportTimed = time(() => ledger.exportSnapshot());
  // Byte size uses the exact CLI export serialization the 16 MiB gate measures.
  const snapshotJson = `${JSON.stringify(ledger.exportSnapshot(), null, 2)}\n`;
  const parsed = JSON.parse(snapshotJson);
  const importSamples = [];
  for (let i = 0; i < 5; i++) {
    const target = mkdtempSync(join(tmpdir(), 'yurai-scale-'));
    const store2 = new SqliteStore(join(target, 'ledger.sqlite'), true);
    const ledger2 = new Ledger(store2);
    const t1 = performance.now();
    ledger2.importSnapshot(parsed);
    importSamples.push(performance.now() - t1);
    store2.close();
    rmSync(target, { recursive: true, force: true });
  }
  importSamples.sort((a, b) => a - b);
  const importTimed = { median_ms: importSamples[2], max_ms: importSamples[4] };
  // Capture probes run last so export/import match the advertised counts.
  let probe = 0;
  const capture = time(() => ledger.capture({ version: 1, request_id: `req_probe_${shape.name}_${probe}`, actor,
    entries: [{ id: `clm_probe_${shape.name}_${probe++}`, type: 'claim', data: { text: 'probe', kind: 'assertion', attributed_to: 'syn' } }] }));
  report.scales.push({ shape: shape.name, counts, build_ms: Math.round(buildMs),
    direct_common: directCommon, direct_rare: directRare, direct_short_2char: directShort, expanded, show, capture_single: capture,
    export: exportTimed, export_bytes: Buffer.byteLength(snapshotJson, 'utf8'),
    import: importTimed });
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 1));
