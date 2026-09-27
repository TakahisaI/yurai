import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const writer = fileURLToPath(new URL('./helpers/crash-writer.mjs', import.meta.url));
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-crash-'));
  const db = join(dir, 'ledger.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = args => spawnSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', cli, '--db', db, ...args], { encoding: 'utf8' });
  return { dir, db, run };
}
function runCrashWriter(db, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writer, db, mode]);
    let out = '', done = false;
    const fail = e => { if (done) return; done = true; clearTimeout(timer); reject(e instanceof Error ? e : new Error(e)); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail('crash writer timed out'); }, 15000);
    child.stdout.on('data', c => { out += c; });
    child.on('error', fail);
    child.on('close', status => {
      if (done) return; done = true; clearTimeout(timer);
      if (!out.includes('ready')) fail(new Error(`crash writer exited before deciding (status ${status})`));
      else resolve(status);
    });
  });
}
function seed(t) {
  const { dir, db, run } = setup(t);
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
  await runCrashWriter(db, 'partial');
  // links has no CLI command of its own; doctor's foreign_key_check covers it.
  assert.equal(JSON.parse(run(['doctor']).stdout).ok, true);
  const snapshot = JSON.parse(run(['export']).stdout);
  assert.deepEqual(snapshot.entries.map(e => e.id), ['clm_seed']);
  assert.equal(snapshot.receipts.filter(r => r.request_id === 'req_crash').length, 0);
  assert.equal(run(['show', 'evd_crash']).status, 3);
  assert.equal(JSON.parse(run(['search', 'crashtoken', '--kind', 'source']).stdout).items.length, 0);
});
test('committed rows survive the same crash harness', async t => {
  const { db, run } = seed(t);
  await runCrashWriter(db, 'committed');
  assert.equal(JSON.parse(run(['doctor']).stdout).ok, true);
  const snapshot = JSON.parse(run(['export']).stdout);
  assert.deepEqual(snapshot.entries.map(e => e.id).sort(), ['clm_seed', 'evd_crash', 'src_crash']);
  assert.equal(snapshot.receipts.filter(r => r.request_id === 'req_crash').length, 1);
  assert.equal(JSON.parse(run(['search', 'crashtoken', '--kind', 'source']).stdout).items.length, 1);
});
