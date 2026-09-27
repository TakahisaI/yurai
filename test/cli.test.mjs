import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const cli = new URL('../dist/cli.js', import.meta.url);
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'ledger.sqlite');
  const run = (args, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(cli), '--db', db, ...args], { encoding: 'utf8', input });
  return { dir, db, run };
}
test('CLI init -> capture -> search -> show -> review -> export -> restore -> doctor', t => {
  const { dir, run } = setup(t);
  assert.equal(run(['init']).status, 0);
  const captured = run(['capture','--file','examples/capture.json']); assert.equal(captured.status, 0, captured.stderr);
  assert.equal(JSON.parse(run(['search','架空']).stdout).items.length, 2);
  assert.equal(JSON.parse(run(['show','clm_demo']).stdout).truth_evaluated, false);
  const review = ['review','clm_demo','--state','accepted','--reason','retained','--request-id','req_cli_review'];
  assert.equal(run(review).status, 0);
  assert.equal(JSON.parse(run(review).stdout).replayed, true);
  const snapshot = run(['export']).stdout; writeFileSync(join(dir, 'snapshot.json'), snapshot);
  const dest = join(dir, 'restored.sqlite');
  assert.equal(run(['init','--db',dest]).status, 0);
  const imported = run(['import','--file',join(dir,'snapshot.json'),'--db',dest]); assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(run(['doctor','--db',dest]).stdout).ok, true);
  assert.deepEqual(JSON.parse(run(['export','--db',dest]).stdout), JSON.parse(snapshot));
});
test('missing DB, malformed input, misuse and unknown fields are explicit failures', t => {
  const { db, run } = setup(t);
  assert.equal(run(['search','AI']).status, 3); assert.equal(existsSync(db), false);
  assert.equal(run(['schema']).status, 0); assert.equal(existsSync(db), false);
  assert.equal(run(['init']).status, 0);
  assert.equal(run(['capture','--file','-'], '{bad').status, 2);
  assert.equal(run(['show','missing']).status, 3);
  assert.equal(run(['capture','--file','examples/capture.json','--actor','ignored']).status, 2);
  assert.equal(run(['search','x','--kind','evidence']).status, 2);
  assert.equal(run(['init','extra']).status, 2);
  assert.equal(run(['capture','--file','-'], 'x'.repeat(1024*1024+1)).status, 2);
});
test('CLI consumes stdin and schema is machine readable without a DB', t => {
  const { db, run } = setup(t);
  const shapes = JSON.parse(run(['schema','record']).stdout).oneOf;
  assert.equal(shapes.length, 7);
  assert.equal(shapes.find(s => s.properties.type.const === 'verification').properties.data.properties.outcome.enum.length, 4);
  assert.equal(existsSync(db), false);
  run(['init']);
  const record = { id: 'clm_stdin', type: 'claim', data: { text: '日本語テスト', kind: 'hypothesis', attributed_to: 'test' } };
  const result = run(['add','--file','-','--actor-kind','agent','--actor','test-agent'], JSON.stringify(record));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(run(['search','日本語']).stdout).items[0].entry.actor.kind, 'agent');
});

test('CLI inspects a capture by request ID, with bounded pages and no mutation', t => {
  const { run } = setup(t);
  run(['init']);
  run(['capture','--file','examples/dogfood/01-capture.json']);
  run(['capture','--file','examples/dogfood/02-correct.json']);
  const before = run(['export']).stdout;
  const result = run(['show','--request-id','req_fixture_initial','--limit','3']);
  assert.equal(result.status, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.total, 10); assert.equal(page.items.length, 3); assert.equal(page.next_offset, 3);
  const next = JSON.parse(run(['show','--request-id','req_fixture_initial','--limit','3','--offset','3']).stdout);
  assert.equal(next.items[0].entry.id, 'clm_fixture_old'); assert.equal(next.items[0].state, 'withdrawn');
  assert.equal(run(['export']).stdout, before);
  assert.equal(JSON.parse(run(['show','clm_fixture_user']).stdout).entry.data.attributed_to, 'fixture-user');
  assert.equal(JSON.parse(run(['doctor']).stdout).ok, true);
});
test('CLI rejects ambiguous capture selectors before opening a DB', t => {
  const { db, run } = setup(t);
  for (const args of [ ['show'], ['show','clm_demo','--request-id','req_x'],
    ['show','--request-id','req_x','--state','accepted'], ['show','--request-id','req_x','--dry-run'] ]) {
    assert.equal(run(args).status, 2);
    assert.equal(existsSync(db), false);
  }
  assert.equal(run(['show','--request-id','req_missing']).status, 3);
  assert.equal(existsSync(db), false);
  run(['init']);
  assert.equal(run(['show','--request-id','req_missing']).status, 3);
  assert.equal(run(['show','--request-id','']).status, 2);
  assert.equal(run(['show','--request-id','req_missing','--limit','101']).status, 2);
});
test('CLI expands Evidence-only terms to Claims end to end', t => {
  const { run } = setup(t);
  run(['init']);
  run(['capture','--file','examples/dogfood/01-capture.json']);
  run(['capture','--file','examples/dogfood/02-correct.json']);
  assert.equal(JSON.parse(run(['search','ZKQ']).stdout).items.length, 0);
  const found = JSON.parse(run(['search','ZKQ','--expand','evidence']).stdout);
  assert.equal(found.match, 'expanded_evidence_routed');
  assert.deepEqual(found.items.map(v => v.entry.id), ['clm_fixture_corrected', 'clm_fixture_user']);
  assert.equal(found.items[0].via[0].evidence.entry.id, 'evd_fixture_x');
  assert.equal(found.items[0].via[0].assessment.entry.data.stance, 'reports');
  assert.equal(JSON.parse(run(['doctor']).stdout).ok, true);
});
test('CLI rejects bad expanded-search usage', t => {
  const { run } = setup(t);
  assert.equal(run(['show','clm_demo','--expand','evidence']).status, 2);
  run(['init']);
  assert.equal(run(['search','ZKQ','--expand','bogus']).status, 2);
  assert.equal(run(['search','ZKQ','--kind','source','--expand','evidence']).status, 2);
});
function seedVerify(t) {
  const { dir, run } = setup(t);
  run(['init']);
  const bundle = { version: 1, request_id: 'req_cli_verify_seed', actor: { kind: 'human', id: 'cli' }, entries: [
    { id: 'src_cli', type: 'source', data: { title: 'local file', medium: 'note', uri: 'urn:yurai:synthetic:cli', version: 'v1' } },
    { id: 'evd_cli', type: 'evidence', data: { source_id: 'src_cli', quote: 'the checkable line' } },
    { id: 'evd_ptr', type: 'evidence', data: { source_id: 'src_cli', locator: 'page 9' } },
    { id: 'clm_cli', type: 'claim', data: { text: 'file finding', kind: 'assertion', attributed_to: 'cli' } }] };
  const file = join(dir, 'bundle.json'); writeFileSync(file, JSON.stringify(bundle));
  assert.equal(run(['capture','--file',file]).status, 0);
  return { dir, run };
}
test('CLI verifies a quote against a local file end to end', t => {
  const { dir, run } = seedVerify(t);
  const target = join(dir, 'source.txt'); writeFileSync(target, 'before\nthe checkable line\nafter\n');
  const match = run(['verify','evd_cli','--file',target,'--edition','v1','--request-id','req_cli_v1']);
  assert.equal(match.status, 0, match.stderr);
  assert.equal(JSON.parse(match.stdout).outcome, 'match');
  const shown = JSON.parse(run(['show','evd_cli']).stdout);
  assert.ok(shown.warnings.includes('anchor_match'));
  assert.equal(shown.verification.outcome, 'match');
  assert.equal(shown.verification.edition.agreement, 'match');
  writeFileSync(target, 'rewritten without the line\n');
  const miss = run(['verify','evd_cli','--file',target,'--request-id','req_cli_v2']);
  assert.equal(JSON.parse(miss.stdout).outcome, 'mismatch');
  assert.equal(JSON.parse(run(['show','evd_cli']).stdout).verification.outcome, 'mismatch');
  const gone = run(['verify','evd_cli','--file',join(dir,'missing.txt'),'--request-id','req_cli_v3']);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(JSON.parse(gone.stdout).outcome, 'unreachable');
  assert.ok(JSON.parse(run(['show','evd_cli']).stdout).warnings.includes('anchor_unreachable'));
  assert.equal(JSON.parse(run(['doctor']).stdout).ok, true);
});
test('CLI records unreachable for overlong paths without validation failure', t => {
  const { dir, run } = seedVerify(t);
  const long = join(dir, `${'p'.repeat(2100)}.txt`);
  const gone = run(['verify','evd_cli','--file',long,'--request-id','req_cli_long']);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(JSON.parse(gone.stdout).outcome, 'unreachable');
  assert.ok(JSON.parse(gone.stdout).verification.entry.data.detail.length <= 2000);
});
test('CLI rejects bad verify usage and undecodable input', t => {
  const { dir, run } = seedVerify(t);
  assert.equal(run(['verify','evd_cli']).status, 2);
  const target = join(dir, 'source.txt'); writeFileSync(target, 'the checkable line\n');
  assert.equal(run(['verify','evd_cli','--file',target,'--method','fuzzy']).status, 2);
  assert.equal(run(['verify','clm_cli','--file',target]).status, 2);
  assert.equal(run(['verify','evd_ptr','--file',target]).status, 2);
  assert.equal(run(['verify','evd_ptr','--file',join(dir,'missing.txt')]).status, 2);
  assert.equal(run(['search','x','--edition','v1']).status, 2);
  writeFileSync(join(dir, 'binary.dat'), Buffer.from([0xff, 0xfe]));
  assert.equal(run(['verify','evd_cli','--file',join(dir,'binary.dat')]).status, 2);
  const big = join(dir, 'big.txt'); writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
  assert.equal(run(['verify','evd_cli','--file',big]).status, 2);
});
test('CLI refuses to export snapshots over 16 MiB without partial output', t => {
  const { dir, run } = setup(t);
  run(['init']);
  const text = 'x'.repeat(8000);
  for (let b = 0; b < 23; b++) {
    const entries = [];
    for (let i = 0; i < 100; i++) entries.push({ id: `clm_big_${b}_${i}`, type: 'claim',
      data: { text, kind: 'assertion', attributed_to: 'bulk' } });
    const file = join(dir, `bulk-${b}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, request_id: `req_bulk_${b}`,
      actor: { kind: 'agent', id: 'bulk' }, entries }));
    assert.equal(run(['capture', '--file', file]).status, 0);
  }
  const out = run(['export']);
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /16 MiB/);
});
test('CLI refuses to import snapshots over 16 MiB and leaves the target empty', t => {
  const { dir, run } = setup(t);
  run(['init']);
  const huge = join(dir, 'huge.json');
  writeFileSync(huge, Buffer.alloc(16 * 1024 * 1024 + 1, 120));
  const out = run(['import', '--file', huge]);
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /exceeds/);
  const snapshot = JSON.parse(run(['export']).stdout);
  assert.deepEqual(snapshot.entries, []);
  assert.deepEqual(snapshot.receipts, []);
});
test('CLI refuses oversized import before migrating an old target', t => {
  const { dir, db, run } = setup(t);
  const seed = new DatabaseSync(db);
  seed.exec(readFileSync(new URL('./fixtures/v1-schema.sql', import.meta.url), 'utf8'));
  seed.close();
  const huge = join(dir, 'huge.json');
  writeFileSync(huge, Buffer.alloc(16 * 1024 * 1024 + 1, 120));
  const out = run(['import', '--file', huge]);
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '');
  const check = new DatabaseSync(db);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
  check.close();
});
