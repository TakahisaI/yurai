import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliSetup } from './helpers/cli.mjs';
const writer = fileURLToPath(new URL('./helpers/crash-writer.mjs', import.meta.url));
function runCrashWriter(db, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', writer, db, mode]);
    let out = '', err = '', done = false;
    const fail = e => { if (done) return; done = true; clearTimeout(timer); reject(e instanceof Error ? e : new Error(e)); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail('crash writer timed out'); }, 15000);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', fail);
    child.on('close', (status, signal) => {
      if (done) return; done = true; clearTimeout(timer); resolve({ status, signal, out, err });
    });
  });
}
function seed(t) {
  const { dir, db, run } = cliSetup(t, 'yurai-crash-');
  assert.equal(run(['init']).status, 0);
  const file = join(dir, 'seed.json');
  writeFileSync(file, JSON.stringify({ version: 1, request_id: 'req_crash_seed',
    actor: { kind: 'agent', id: 'crash-probe' },
    entries: [{ id: 'clm_seed', type: 'claim',
      data: { text: 'seed finding', kind: 'assertion', attributed_to: 'crash-probe' } }] }));
  assert.equal(run(['capture', '--file', file]).status, 0);
  return { db, run };
}
test('records, links, index, and receipts never partially persist after a mid-write crash', async t => {
  const { db, run } = seed(t);
  const crashed = await runCrashWriter(db, 'partial');
  // links has no CLI command of its own; doctor's foreign_key_check covers it.
  assert.ok(crashed.out.includes('staged'), 'capture must reach its final staged write');
  assert.ok(!crashed.out.includes('unexpected-commit'), 'capture must not commit');
  assert.equal(crashed.err, '');
  assert.equal(JSON.parse(run(['doctor']).stdout).ok, true);
  const snapshot = JSON.parse(run(['export']).stdout);
  assert.deepEqual(snapshot.entries.map(e => e.id), ['clm_seed']);
  assert.equal(snapshot.receipts.filter(r => r.request_id === 'req_crash_cap').length, 0);
  assert.equal(run(['show', 'evd_cap']).status, 3);
  assert.equal(JSON.parse(run(['search', 'crashcap', '--kind', 'source']).stdout).items.length, 0);
});
test('committed rows survive the same crash harness', async t => {
  const { db, run } = seed(t);
  const crashed = await runCrashWriter(db, 'committed');
  assert.ok(crashed.out.includes('staged'));
  assert.ok(crashed.out.includes('committed'));
  assert.equal(crashed.err, '');
  assert.equal(JSON.parse(run(['doctor']).stdout).ok, true);
  const snapshot = JSON.parse(run(['export']).stdout);
  assert.deepEqual(snapshot.entries.map(e => e.id).sort(),
    ['asm_cap', 'clm_cap', 'clm_seed', 'evd_cap', 'src_cap']);
  assert.equal(snapshot.receipts.filter(r => r.request_id === 'req_crash_cap').length, 1);
  assert.equal(JSON.parse(run(['search', 'crashcap', '--kind', 'source']).stdout).items.length, 1);
});
