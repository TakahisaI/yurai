// Deterministic scale/cost measurement for #44. Builds synthetic ledgers at
// explicit sizes, times representative operations, and prints one JSON report.
// Not part of `npm test`: timings are environment-dependent. All content is
// synthetic; no private data is read. Run with `node --expose-gc`: each heap
// boundary runs five full collections first, and the report carries
// per-phase heap deltas plus the post-cleanup residual per scale point.
// Warm latency repeats a query on one open store; cold opens a fresh store on
// the same db file per repetition (open + query + close per sample; process
// cold only — the OS page cache is not dropped). Capture timings are
// capture() wall time (parseBundle+digest validation runs pre-txn, ~0.05ms
// single / ~1.1ms batch-20 — an upper bound on the IMMEDIATE hold).
// Slice 5 adds OS-level lock-duration proxies plus operation coverage:
//  - locks.txn_ms: single-sample hold per operation (callback entry after
//    BEGIN succeeds, to COMMIT/ROLLBACK) as a RESERVED-hold proxy on a
//    pristine-shape DB. Honest limits: hold time inside the txn boundary,
//    including SQLite CPU and commit fsync — not kernel lock tracing or
//    WAL-lock introspection; BEGIN-acquisition waits are excluded by
//    construction (a failed BEGIN records 0); single-process, no
//    contention; wall-clock and environment-dependent. Timed medians stay
//    the robust latency readings; each txn_ms is one sample from a separate
//    pass on a separate same-shape DB — not paired with the timed medians,
//    so it illustrates hold magnitude and pins the one-txn-per-op structure
//    but never decomposes a median (no subtracting to infer pre/post-txn
//    shares). Cold holds are UNMEASURED: never sampled, with no claim that
//    they equal warm holds.
//  - locks.blocking: functional two-connection WAL characterization (no
//    timing): a held BEGIN IMMEDIATE (same RESERVED any writable-mode Ledger
//    txn takes, reads included) still lets readonly (deferred/SHARED) reads
//    proceed, while a second BEGIN IMMEDIATE with busy_timeout=0 fails fast
//    with SQLITE_BUSY. Production uses busy_timeout=5000, so real writers
//    wait; the probe observes the serialization signal without the wait.
//  - Operation coverage, current vs added (timed medians unless noted):
//    current: direct_common/rare/2char (warm+cold), expanded (warm+cold),
//    show (warm+cold), export, import (empty restore), capture_single,
//    capture_batch_20; cost (single-sample counts): the reads plus show,
//    export, capture_single.
//    added timed: expanded_refs_v1 (warm+cold), inspect_capture (warm+cold),
//    doctor (warm+cold), capture_dry_run, capture_replay, capture_supersedes,
//    import_nonempty_refusal (expected CONFLICT).
//    added cost+locks: the new timed ops except doctor (doctor bypasses the
//    Store port with internal SQL, so no Store-method counts; its txn hold is
//    still recorded via a one-call transaction proxy), plus capture_batch_20
//    counts and import_empty counts (fresh-DB restore of the pristine base).
//    Bytes stay UTF-8 bytes; no token estimates.
// Env records node, platform, GC control, git revision identity (HEAD commit
// resolved from the harness checkout plus a dirty flag and a diff sha256, or
// unknown-with-reason outside git), and SQLite version per #44 (environment
// + exact revision). The diff sha256 covers the tracked `git diff HEAD`
// excluding docs/validation.md (the file recording the hash — excluded so
// the record cannot move the value), plus the worktree status names and the
// sorted bytes of untracked files. `--print-identity` prints just the env
// identity for instant reviewer reproduction.
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, SqliteStore } from '../dist/index.js';
import { CountingStore, ScanCollector } from '../dist/core/observe.js';

if (typeof globalThis.gc !== 'function' && !process.argv.includes('--print-identity')) {
  console.error('measure-scale: rerun as `node --expose-gc scripts/measure-scale.mjs`; heap deltas need GC control.');
  process.exit(1);
}
const gc = globalThis.gc;
// Five full collections before each reading: fewer passes leave survivors
// that pollute the next boundary (observed as negative import deltas), and
// stopping at the first stable reading quits while incremental work is still
// in flight. Heap values are single post-GC samples, not medians: the
// collection itself is the stabilizer.
function heapBytes() {
  for (let i = 0; i < 5; i++) gc();
  return process.memoryUsage().heapUsed;
}

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
  const dbPath = join(dir, 'ledger.sqlite');
  const raw = new SqliteStore(dbPath, true);
  // Assess-only hooks (#44): timed paths run on the same unwrapped store as
  // pre-instrumentation baselines (no decorator, no observer), so warm/cold
  // comparisons and baseline continuity hold. Counting runs in a separate
  // deterministic pass per operation on a wrapped view of a separately
  // built same-shape store (parity is pinned by
  // test/instrumentation.test.mjs).
  const ledger = new Ledger(raw, () => AT);
  const counting = new CountingStore(raw);
  const scans = new ScanCollector();
  const countingLedger = new Ledger(counting, () => AT, scans);
  const store = raw;
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
  return { dir, dbPath, store, ledger, countingLedger, counting, scans, counts, buildMs };
}

function summarize(samples) {
  samples.sort((a, b) => a - b);
  const runs = samples.length, mid = runs / 2;
  const median = runs % 2 ? samples[mid | 0] : (samples[mid - 1] + samples[mid]) / 2;
  return { median_ms: median, max_ms: samples[runs - 1] };
}

function time(fn, runs = 4) {
  fn();
  const samples = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); samples.push(performance.now() - t); }
  return summarize(samples);
}

// One deterministic cost+lock sample per operation: per-method Store-method
// calls with rows returned and rows written [calls, rows returned, rows
// written], total Store-method calls, total rows returned, total rows
// written, Ledger-level full-scan reports (records examined at the Ledger
// level — never SQL statements issued or rows examined inside SQLite, which
// stay an explicit follow-up under #44), and the single-sample hold as a
// RESERVED-hold proxy (one txn per Ledger op, clocked post-BEGIN; rolled-back
// txns record hold-to-rollback, failed acquisitions record 0). Only nonzero
// count entries are kept. Cold paths are not re-counted: they run the same
// Ledger code over the same rows, so warm counts apply (the parity test
// proves hooks change nothing); cold holds are UNMEASURED (never sampled;
// no claim they equal warm holds).
// expectThrow runs the failure path (e.g. restore into a non-empty ledger),
// requires the expected refusal (success throws), and still captures its
// counts plus hold-to-rollback.
function costLockOf(counting, scans, fn, expectThrow = null) {
  counting.reset(); scans.reset();
  let errorCode = null;
  try { fn(); }
  catch (error) {
    errorCode = error?.code ?? 'UNKNOWN';
    if (expectThrow === null || errorCode !== expectThrow) throw error;
  }
  if (expectThrow !== null && errorCode === null)
    throw new Error(`expected ${expectThrow}, saw success`);
  const calls = {};
  let storeMethodCalls = 0, rowsReturned = 0, rowsWritten = 0;
  for (const [method, s] of Object.entries(counting.snapshot()))
    if (s.calls) { calls[method] = [s.calls, s.rowsReturned, s.rowsWritten]; storeMethodCalls += s.calls; rowsReturned += s.rowsReturned; rowsWritten += s.rowsWritten; }
  const scanOut = {};
  for (const [kind, n] of Object.entries(scans.snapshot())) if (n) scanOut[kind] = n;
  const txn = counting.txnTimings();
  if (txn.length !== 1) throw new Error(`expected one transaction per op, saw ${txn.length}`);
  const cost = { store_method_calls: storeMethodCalls, rows_returned: rowsReturned, rows_written: rowsWritten, calls, scans: scanOut };
  if (errorCode !== null) cost.error_code = errorCode;
  return { cost, txn_ms: txn[0] };
}

// Cold: one fresh store open per repetition (open + query + close per sample,
// including the untimed warmup). Same median/max methodology as warm.
function timeCold(dbPath, query, runs = 4) {
  const once = () => {
    const coldStore = new SqliteStore(dbPath);
    try { query(new Ledger(coldStore, () => AT)); }
    finally { coldStore.close(); }
  };
  once();
  const samples = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); once(); samples.push(performance.now() - t); }
  return summarize(samples);
}

// Cold doctor: fresh store open + doctor + close per sample (same methodology
// as timeCold, but doctor is Store-level, not Ledger-level).
function timeColdDoctor(dbPath, runs = 4) {
  const once = () => {
    const coldStore = new SqliteStore(dbPath);
    try { coldStore.doctor(); }
    finally { coldStore.close(); }
  };
  once();
  const samples = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); once(); samples.push(performance.now() - t); }
  return summarize(samples);
}

// Timed failure path (e.g. restore into a non-empty ledger): each sample must
// throw the expected code; the timing covers the attempt including the
// rolled-back txn hold. Same warmup + median/max methodology as time().
function timeThrowing(fn, expectCode, runs = 4) {
  const once = () => {
    try { fn(); }
    catch (error) {
      if (error?.code !== expectCode) throw error;
      return;
    }
    throw new Error(`expected ${expectCode}, saw success`);
  };
  once();
  const samples = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); once(); samples.push(performance.now() - t); }
  return summarize(samples);
}

// Doctor bypasses the Store port (internal SQL, not Store-method calls), so
// CountingStore cannot observe it. This one-call transaction proxy records
// the same hold for doctor on any store — clocked from callback entry (after
// BEGIN succeeds) like CountingStore, so a failed BEGIN records 0 — and
// restores the method in a finally; the wrapped call is exactly one
// doctor() in one txn.
function doctorTxnMs(store) {
  const orig = store.transaction.bind(store);
  let ms = null;
  store.transaction = (fn) => {
    let holdStart = null;
    const wrapped = () => { holdStart ??= performance.now(); return fn(); };
    try {
      const result = orig(wrapped);
      ms = holdStart === null ? 0 : performance.now() - holdStart;
      return result;
    } catch (error) {
      ms = holdStart === null ? 0 : performance.now() - holdStart;
      throw error;
    }
  };
  try { store.doctor(); }
  finally { store.transaction = orig; }
  if (ms === null) throw new Error('doctor recorded no transaction');
  return ms;
}

// Functional WAL blocking characterization (no timing). Holds BEGIN
// IMMEDIATE on one raw connection — the same RESERVED lock any writable-mode
// Ledger txn takes, reads included — then probes from other connections: a
// readonly (deferred/SHARED) Ledger search must still succeed, while a second
// BEGIN IMMEDIATE with busy_timeout=0 must fail fast with SQLITE_BUSY.
// Returns deterministic booleans plus any unexpected error text.
function blockingProbe(dbPath) {
  const holder = new DatabaseSync(dbPath);
  holder.exec('BEGIN IMMEDIATE');
  let readonlyProceeds = false, writableSerializes = false;
  let readError = null, writeError = null;
  try {
    const reader = new SqliteStore(dbPath, false, { readonly: true });
    try {
      new Ledger(reader, () => AT).search('COMMONTERM', { limit: 1 });
      readonlyProceeds = true;
    } catch (error) { readError = String(error?.message ?? error); }
    finally { reader.close(); }
    const contended = new DatabaseSync(dbPath);
    try {
      contended.exec('PRAGMA busy_timeout=0;');
      try { contended.exec('BEGIN IMMEDIATE'); contended.exec('ROLLBACK'); }
      catch (error) {
        if (/busy|locked/i.test(String(error?.message ?? error))) writableSerializes = true;
        else writeError = String(error?.message ?? error);
      }
    } finally { contended.close(); }
  } finally {
    try { holder.exec('ROLLBACK'); } catch { /* held txn always rolls back */ }
    holder.close();
  }
  const out = { readonly_reads_proceed_under_held_immediate: readonlyProceeds,
    writable_txns_serialize_busy_observed: writableSerializes };
  if (readError !== null) out.read_error = readError;
  if (writeError !== null) out.write_error = writeError;
  return out;
}

// Minimal valid snapshot for the non-empty-restore refusal path: one claim
// exported from a throwaway ledger, so parseSnapshot always succeeds and the
// timed/counted work is the early non-empty CONFLICT (count+receipts check
// inside one rolled-back txn), not snapshot validation.
function tinySnapshot() {
  const target = mkdtempSync(join(tmpdir(), 'yurai-scale-'));
  const raw = new SqliteStore(join(target, 'ledger.sqlite'), true);
  try {
    new Ledger(raw, () => AT).capture({ version: 1, request_id: 'req_tiny', actor,
      entries: [{ id: 'clm_tiny', type: 'claim',
        data: { text: 'tiny probe', kind: 'assertion', attributed_to: 'syn' } }] });
    return new Ledger(raw, () => AT).exportSnapshot();
  } finally {
    raw.close();
    rmSync(target, { recursive: true, force: true });
  }
}

const SCALES = [
  { name: 'flat-100', claims: 100, evdPerClaim: 1, asmPerEvd: 1, reviewsPerClaim: 1, verificationsFraction: 0.1, quoteWords: 6 },
  { name: 'flat-500', claims: 500, evdPerClaim: 1, asmPerEvd: 1, reviewsPerClaim: 1, verificationsFraction: 0.1, quoteWords: 6 },
  { name: 'flat-2000', claims: 2000, evdPerClaim: 1, asmPerEvd: 1, reviewsPerClaim: 1, verificationsFraction: 0.1, quoteWords: 6 },
  { name: 'dense-100x8', claims: 100, evdPerClaim: 8, asmPerEvd: 3, reviewsPerClaim: 4, verificationsFraction: 0.2, quoteWords: 40 },
];

// Git identity resolves from the harness checkout (parent of scripts/),
// never the caller CWD — so the commit names the measured code. A dirty
// worktree keeps its HEAD commit but is flagged, with a sha256 over the
// tracked `git diff HEAD` EXCLUDING docs/validation.md (the file that
// records this hash — excluded so the record cannot move the value), plus
// the worktree status names and the sorted bytes of every untracked file
// (names alone would miss content changes in files like the untracked
// contention regression test the validation claim depends on); outside git
// the revision is unknown-with-reason instead of a misleading commit.
const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY_RECORD = 'docs/validation.md';
function gitIdentity() {
  try {
    const revision = execFileSync('git', ['-C', HARNESS_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', HARNESS_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
    const dirty = status.trim().length > 0;
    let diff = null;
    if (dirty) {
      const patch = execFileSync('git', ['-C', HARNESS_ROOT, 'diff', 'HEAD', '--', '.', `:!${IDENTITY_RECORD}`], { maxBuffer: 256 * 1024 * 1024 });
      const hash = createHash('sha256');
      hash.update(patch).update('\0').update(status, 'utf8');
      const others = execFileSync('git', ['-C', HARNESS_ROOT, 'ls-files', '--others', '--exclude-standard', '-z'], { maxBuffer: 256 * 1024 * 1024 });
      const rels = others.toString('utf8').split('\0').filter((p) => p.length > 0 && p !== IDENTITY_RECORD).sort();
      for (const rel of rels) {
        try {
          hash.update('\0').update(rel, 'utf8').update('\0').update(readFileSync(join(HARNESS_ROOT, rel)));
        } catch {
          hash.update('\0').update(`unreadable:${rel}`, 'utf8');
        }
      }
      diff = hash.digest('hex');
    }
    return { revision, revision_dirty: dirty, revision_diff_sha256: diff };
  } catch {
    return { revision: 'unknown', revision_dirty: null, revision_diff_sha256: null,
      revision_reason: 'no git metadata at the harness checkout (isolated copy?) or git unavailable' };
  }
}
const git = gitIdentity();
if (process.argv.includes('--print-identity')) {
  console.log(JSON.stringify({ node: process.version, platform: process.platform, ...git }));
  process.exit(0);
}
let sqlite = 'unknown';
try {
  const probe = new DatabaseSync(':memory:');
  try { sqlite = probe.prepare('SELECT sqlite_version() AS v').get()?.v ?? 'unknown'; }
  finally { probe.close(); }
} catch { /* sqlite probe failure still reports unknown, never throws */ }
const report = { env: { node: process.version, platform: process.platform, gc_control: true, ...git, sqlite }, scales: [] };
for (const shape of SCALES) {
  const heapBaseline = heapBytes();
  const { dir, dbPath, store, ledger, counts, buildMs } = buildLedger(shape);
  const heapAfterBuild = heapBytes();
  const directCommon = time(() => ledger.search('COMMONTERM', { limit: 50 }));
  const directRare = time(() => ledger.search(`CLAIMRARE${shape.claims - 1}`, { limit: 50 }));
  const directShort = time(() => ledger.search('気孔', { limit: 50 }));
  const expanded = time(() => ledger.search('RARE7_0', { limit: 50, expand: 'evidence' }));
  const show = time(() => ledger.show('clm_m0007'));
  // Added reads run at the same advertised base as the current reads (before
  // export/import/captures): refs-v1 projection over the same routed query,
  // capture-path inspection of one build bundle, and the Store-level doctor
  // (integrity + index consistency; its FTS integrity-check write touches no
  // user records).
  const expandedRefsV1 = time(() => ledger.search('RARE7_0', { limit: 50, expand: 'evidence', projection: 'refs-v1' }));
  const inspectCapture = time(() => ledger.inspectCapture('req_scale_7'));
  const doctor = time(() => store.doctor());
  // Cold runs the same queries with a fresh store open per repetition. The
  // warm store stays open but idle (no open txn), so samples never contend —
  // only the per-connection open/query/close cost differs from warm.
  const directCommonCold = timeCold(dbPath, (l) => l.search('COMMONTERM', { limit: 50 }));
  const directRareCold = timeCold(dbPath, (l) => l.search(`CLAIMRARE${shape.claims - 1}`, { limit: 50 }));
  const directShortCold = timeCold(dbPath, (l) => l.search('気孔', { limit: 50 }));
  const expandedCold = timeCold(dbPath, (l) => l.search('RARE7_0', { limit: 50, expand: 'evidence' }));
  const showCold = timeCold(dbPath, (l) => l.show('clm_m0007'));
  const expandedRefsV1Cold = timeCold(dbPath, (l) => l.search('RARE7_0', { limit: 50, expand: 'evidence', projection: 'refs-v1' }));
  const inspectCaptureCold = timeCold(dbPath, (l) => l.inspectCapture('req_scale_7'));
  const doctorCold = timeColdDoctor(dbPath);
  const heapAfterQueries = heapBytes();
  const exportTimed = time(() => ledger.exportSnapshot());
  // Byte size uses the exact CLI export serialization the 16 MiB gate measures.
  let snapshotJson = `${JSON.stringify(ledger.exportSnapshot(), null, 2)}\n`;
  let parsed = JSON.parse(snapshotJson);
  // snapshotJson and parsed stay alive through the import loop, so the export
  // delta includes both retained copies.
  const heapAfterExport = heapBytes();
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
  const heapAfterImport = heapBytes();
  const exportBytes = Buffer.byteLength(snapshotJson, 'utf8');
  // Release both export copies so later boundaries measure retained ledger
  // state, not the snapshot under test. The release gets its own boundary so
  // the capture delta stays interpretable.
  snapshotJson = null;
  parsed = null;
  const heapAfterRelease = heapBytes();
  // Cost+lock pass runs on a separately built pristine-shape DB (same seeded
  // shape, so identical counts), leaving the main DB untouched at the
  // advertised base for the capture timing probes below — prior-harness
  // parity: timed probes scan the same base they did before instrumentation.
  // Each cost entry is one deterministic sample; each locks.txn_ms entry is
  // the same run's single-sample transaction hold. Reads/export run first at
  // the pristine base; writes run sequentially after, so their supersedes
  // scans grow: capture_single sees base+1 input, dry_run sees base+1 stored
  // +1 input (no writes), replay setup adds 1 then the counted replay hits
  // the receipt (no scan), supersedes sees base+2 stored +2 inputs, batch_20
  // sees base+4 stored +20 inputs, and the refusal sees the grown base but
  // fails on the early non-empty check. Import_empty restores the pristine
  // base snapshot into a fresh DB (its supersedes scan is 0 stored + base
  // inputs). Doctor has no cost entry (internal SQL bypasses the Store port);
  // its hold is recorded via the one-call proxy at the pristine base. The
  // cost DB is closed and removed before the probes run, and the
  // capture-delta heap boundary below includes the cost pass plus the probes.
  const tiny = tinySnapshot();
  const costShape = buildLedger(shape);
  const pristineSnapshot = costShape.countingLedger.exportSnapshot();
  costShape.counting.reset(); costShape.scans.reset();
  const doctorHold = doctorTxnMs(costShape.store);
  const sampled = {};
  const take = (name, fn, expectThrow = null) => {
    const { cost: entry, txn_ms: hold } = costLockOf(costShape.counting, costShape.scans, fn, expectThrow);
    sampled[name] = { entry, hold };
  };
  take('direct_common', () => costShape.countingLedger.search('COMMONTERM', { limit: 50 }));
  take('direct_rare', () => costShape.countingLedger.search(`CLAIMRARE${shape.claims - 1}`, { limit: 50 }));
  take('direct_short_2char', () => costShape.countingLedger.search('気孔', { limit: 50 }));
  take('expanded', () => costShape.countingLedger.search('RARE7_0', { limit: 50, expand: 'evidence' }));
  take('expanded_refs_v1', () => costShape.countingLedger.search('RARE7_0', { limit: 50, expand: 'evidence', projection: 'refs-v1' }));
  take('show', () => costShape.countingLedger.show('clm_m0007'));
  take('inspect_capture', () => costShape.countingLedger.inspectCapture('req_scale_7'));
  take('export', () => costShape.countingLedger.exportSnapshot());
  take('capture_single', () => costShape.countingLedger.capture({ version: 1, request_id: `req_cost_${shape.name}`,
    actor, entries: [{ id: `clm_cost_${shape.name}`, type: 'claim',
      data: { text: 'cost probe', kind: 'assertion', attributed_to: 'syn' } }] }));
  take('capture_dry_run', () => costShape.countingLedger.capture({ version: 1, request_id: `req_cost_dry_${shape.name}`,
    actor, entries: [{ id: `clm_cost_dry_${shape.name}`, type: 'claim',
      data: { text: 'dry probe', kind: 'assertion', attributed_to: 'syn' } }] }, true));
  const replayBundle = { version: 1, request_id: `req_cost_replay_${shape.name}`,
    actor, entries: [{ id: `clm_cost_replay_${shape.name}`, type: 'claim',
      data: { text: 'replay probe', kind: 'assertion', attributed_to: 'syn' } }] };
  costShape.countingLedger.capture(replayBundle);
  take('capture_replay', () => costShape.countingLedger.capture(replayBundle));
  take('capture_supersedes', () => costShape.countingLedger.capture({ version: 1, request_id: `req_cost_sup_${shape.name}`,
    actor, entries: [{ id: `clm_cost_sup_${shape.name}`, type: 'claim',
        data: { text: 'superseder', kind: 'assertion', attributed_to: 'syn' } },
      { id: `rel_cost_sup_${shape.name}`, type: 'relation', data: { from_claim_id: `clm_cost_sup_${shape.name}`,
        to_claim_id: 'clm_m0000', relation: 'supersedes', rationale: 'syn' } }] }));
  take('capture_batch_20', () => costShape.countingLedger.capture({ version: 1, request_id: `req_cost_batch_${shape.name}`,
    actor, entries: Array.from({ length: 20 }, (_, i) => ({ id: `clm_cost_batch_${shape.name}_${i}`, type: 'claim',
      data: { text: `cost batch ${i}`, kind: 'assertion', attributed_to: 'syn' } })) }));
  take('import_nonempty_refusal', () => costShape.countingLedger.importSnapshot(tiny), 'CONFLICT');
  // Import_empty runs on its own fresh DB (pristine-base restore), not on the
  // grown cost DB: same single-sample cost+hold methodology, isolated target.
  const importTarget = mkdtempSync(join(tmpdir(), 'yurai-scale-'));
  const importRaw = new SqliteStore(join(importTarget, 'ledger.sqlite'), true);
  const importCounting = new CountingStore(importRaw);
  const importScans = new ScanCollector();
  const importLedger = new Ledger(importCounting, () => AT, importScans);
  const { cost: importEmptyCost, txn_ms: importEmptyHold } =
    costLockOf(importCounting, importScans, () => importLedger.importSnapshot(pristineSnapshot));
  importRaw.close();
  rmSync(importTarget, { recursive: true, force: true });
  const cost = Object.fromEntries(Object.entries(sampled).map(([k, v]) => [k, v.entry]));
  cost.import_empty = importEmptyCost;
  const txnMs = Object.fromEntries(Object.entries(sampled).map(([k, v]) => [k, v.hold]));
  txnMs.doctor = doctorHold;
  txnMs.import_empty = importEmptyHold;
  costShape.store.close();
  rmSync(costShape.dir, { recursive: true, force: true });
  // Capture probes run after export/import so those match the advertised
  // counts. Each timing is capture() wall time: it includes pre-txn bundle
  // validation (parseBundle+digest, ~0.05ms single / ~1.1ms batch-20), so it
  // is an upper bound on the IMMEDIATE hold; locks.txn_ms on the cost DB
  // illustrates hold magnitude for the same shapes but is a separate-pass
  // single sample, not a paired decomposition of these medians. Both probes
  // run the same
  // checkReferences path, so the batch amortizes the per-txn full-ledger
  // supersedes scan over 20 records — but the pre-txn validation share
  // (~1.1ms of the batch-20 total) is per-bundle work, not per-txn hold, so
  // "batch per record" divides a mixed cost. Timed batch samples run at
  // +25..+85 probe records over the shape base (the timing probes themselves:
  // 5 single-probe records plus up to 4x20 batch records ahead of each
  // sample; negligible at scale, up to ~+4-10% on flat-100 absolute). Added
  // capture probes run after the current ones (same wall-time methodology):
  // dry_run adds 0 records, replay setup adds 1 then 5 replays add 0, and
  // supersedes adds 5x2=10 records — +11 total, same negligible-at-scale
  // caveat. The refusal probe reuses the tiny snapshot and adds 0 records.
  let probe = 0;
  const capture = time(() => ledger.capture({ version: 1, request_id: `req_probe_${shape.name}_${probe}`, actor,
    entries: [{ id: `clm_probe_${shape.name}_${probe++}`, type: 'claim', data: { text: 'probe', kind: 'assertion', attributed_to: 'syn' } }] }));
  let batch = 0;
  const captureBatch = time(() => {
    const n = batch++;
    ledger.capture({ version: 1, request_id: `req_batch_${shape.name}_${n}`, actor,
      entries: Array.from({ length: 20 }, (_, i) => ({ id: `clm_batch_${shape.name}_${n}_${i}`, type: 'claim',
        data: { text: `batch probe ${n}/${i}`, kind: 'assertion', attributed_to: 'syn' } })) });
  });
  let dryProbe = 0;
  const captureDryRun = time(() => ledger.capture({ version: 1, request_id: `req_dry_${shape.name}_${dryProbe}`, actor,
    entries: [{ id: `clm_dry_${shape.name}_${dryProbe++}`, type: 'claim',
      data: { text: 'dry probe', kind: 'assertion', attributed_to: 'syn' } }] }, true));
  const timedReplayBundle = { version: 1, request_id: `req_replay_${shape.name}`, actor,
    entries: [{ id: `clm_replay_${shape.name}`, type: 'claim',
      data: { text: 'replay probe', kind: 'assertion', attributed_to: 'syn' } }] };
  ledger.capture(timedReplayBundle);
  const captureReplay = time(() => ledger.capture(timedReplayBundle));
  let supProbe = 0;
  const captureSupersedes = time(() => {
    const n = supProbe++;
    ledger.capture({ version: 1, request_id: `req_sup_${shape.name}_${n}`, actor,
      entries: [{ id: `clm_sup_${shape.name}_${n}`, type: 'claim',
          data: { text: `superseder ${n}`, kind: 'assertion', attributed_to: 'syn' } },
        { id: `rel_sup_${shape.name}_${n}`, type: 'relation', data: { from_claim_id: `clm_sup_${shape.name}_${n}`,
          to_claim_id: 'clm_m0000', relation: 'supersedes', rationale: 'syn' } }] });
  });
  const importRefusal = timeThrowing(() => ledger.importSnapshot(tiny), 'CONFLICT');
  const heapAfterCapture = heapBytes();
  store.close();
  // Blocking probe runs after the main store closes (file still on disk, no
  // idle holder): deterministic booleans, no timing, negligible heap (fully
  // collected before the cleanup boundary).
  const blocking = blockingProbe(dbPath);
  const locks = {
    method: 'single-sample hold per op (callback entry post-BEGIN to COMMIT/ROLLBACK) as RESERVED-hold proxy, writable mode, separate pristine-shape pass; cold holds UNMEASURED (never sampled; no equality claim)',
    limits: 'not OS-level tracing (no sqlite3_trace/VFS/busy-handler timing, no WAL-lock introspection); single-process, no contention; wall-clock, environment-dependent; includes SQLite CPU and commit fsync; single samples are not paired with the timed medians and do not decompose them; failed acquisitions record 0, rolled-back holds record hold-to-rollback',
    txn_ms: txnMs,
    blocking: { ...blocking,
      method: 'held BEGIN IMMEDIATE (same RESERVED any writable-mode Ledger txn takes, reads included); readonly search must proceed (WAL), second BEGIN IMMEDIATE with busy_timeout=0 must fail fast with SQLITE_BUSY',
      limits: 'functional signal only, no wait-duration claim; production retries 5s (busy_timeout=5000), the probe observes serialization without waiting' },
  };
  rmSync(dir, { recursive: true, force: true });
  const heapAfterCleanup = heapBytes();
  // Peak and residual are the robust readings: per-phase attribution carries
  // GC-timing noise (a boundary right after an allocation burst can read high
  // until later churn finishes sweeping, so a neighboring delta reads low),
  // but the peak always lands on the export boundary and cleanup returns to
  // the same floor on every shape.
  const heapPeak = Math.max(heapAfterBuild, heapAfterQueries, heapAfterExport,
    heapAfterImport, heapAfterRelease, heapAfterCapture);
  report.scales.push({ shape: shape.name, counts, build_ms: Math.round(buildMs),
    direct_common: directCommon, direct_rare: directRare, direct_short_2char: directShort, expanded, show, capture_single: capture,
    direct_common_cold: directCommonCold, direct_rare_cold: directRareCold, direct_short_2char_cold: directShortCold,
    expanded_cold: expandedCold, show_cold: showCold, capture_batch_20: captureBatch,
    expanded_refs_v1: expandedRefsV1, expanded_refs_v1_cold: expandedRefsV1Cold,
    inspect_capture: inspectCapture, inspect_capture_cold: inspectCaptureCold,
    doctor, doctor_cold: doctorCold,
    capture_dry_run: captureDryRun, capture_replay: captureReplay, capture_supersedes: captureSupersedes,
    import_nonempty_refusal: importRefusal,
    export: exportTimed, export_bytes: exportBytes,
    import: importTimed, cost, locks,
    heap: { baseline_bytes: heapBaseline,
      peak_delta_bytes: heapPeak - heapBaseline,
      residual_bytes: heapAfterCleanup - heapBaseline,
      phases: { build_delta_bytes: heapAfterBuild - heapBaseline,
        queries_delta_bytes: heapAfterQueries - heapAfterBuild,
        export_delta_bytes: heapAfterExport - heapAfterQueries,
        import_delta_bytes: heapAfterImport - heapAfterExport,
        release_delta_bytes: heapAfterRelease - heapAfterImport,
        capture_delta_bytes: heapAfterCapture - heapAfterRelease } } });
}
console.log(JSON.stringify(report, null, 1));
