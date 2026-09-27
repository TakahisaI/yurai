import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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
  assert.equal(JSON.parse(run(['schema','record']).stdout).oneOf.length, 6);
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
