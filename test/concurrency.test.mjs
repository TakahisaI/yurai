import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yurai-cc-'));
  const db = join(dir, 'ledger.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runAsync = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--db', db, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  return { dir, db, runAsync };
}
const claim = (id, text) => ({ id, type: 'claim',
  data: { text, kind: 'assertion', attributed_to: 'concurrency-probe', scope: 'synthetic race test' } });
const bundleFile = (dir, name, request_id, entries) => {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ version: 1, request_id,
    actor: { kind: 'agent', id: 'concurrency-probe' }, entries }));
  return file;
};
test('concurrent captures from multiple processes all persist', async t => {
  const { dir, runAsync } = setup(t);
  assert.equal((await runAsync(['init'])).status, 0);
  const n = 6;
  const files = Array.from({ length: n }, (_, i) =>
    bundleFile(dir, `race-${i}.json`, `req_cc_${i}`, [claim(`clm_cc_${i}`, `concurrent finding ${i}`)]));
  const results = await Promise.all(files.map(f => runAsync(['capture', '--file', f])));
  for (const [i, r] of results.entries()) assert.equal(r.status, 0, `racer ${i}: ${r.stderr}`);
  for (let i = 0; i < n; i++) {
    const shown = await runAsync(['show', `clm_cc_${i}`]);
    assert.equal(shown.status, 0);
    assert.equal(JSON.parse(shown.stdout).entry.data.text, `concurrent finding ${i}`);
  }
  assert.equal(JSON.parse((await runAsync(['doctor'])).stdout).ok, true);
});
test('same request_id and bundle from multiple processes replays without duplication', async t => {
  const { dir, runAsync } = setup(t);
  assert.equal((await runAsync(['init'])).status, 0);
  const file = bundleFile(dir, 'same.json', 'req_cc_same', [claim('clm_cc_same', 'single shared finding')]);
  const results = await Promise.all([0, 1, 2, 3].map(() => runAsync(['capture', '--file', file])));
  for (const [i, r] of results.entries()) assert.equal(r.status, 0, `racer ${i}: ${r.stderr}`);
  const replayed = results.map(r => JSON.parse(r.stdout).replayed);
  assert.equal(replayed.filter(Boolean).length, 3);
  assert.equal(replayed.filter(r => !r).length, 1);
  const snapshot = JSON.parse((await runAsync(['export'])).stdout);
  assert.equal(snapshot.receipts.filter(r => r.request_id === 'req_cc_same').length, 1);
  assert.equal(snapshot.entries.filter(e => e.id === 'clm_cc_same').length, 1);
});
test('same request_id with different content concurrently conflicts exactly once per loser', async t => {
  const { dir, runAsync } = setup(t);
  assert.equal((await runAsync(['init'])).status, 0);
  const a = bundleFile(dir, 'a.json', 'req_cc_duel', [claim('clm_cc_duel_a', 'duel version A')]);
  const b = bundleFile(dir, 'b.json', 'req_cc_duel', [claim('clm_cc_duel_b', 'duel version B')]);
  const results = await Promise.all([runAsync(['capture', '--file', a]), runAsync(['capture', '--file', b])]);
  assert.deepStrictEqual(results.map(r => r.status).sort(), [0, 4]);
  const loserError = JSON.parse(results.find(r => r.status === 4).stderr).error;
  assert.equal(loserError.code, 'CONFLICT');
  assert.match(loserError.message, /request_id was already used with different content/);
  const snapshot = JSON.parse((await runAsync(['export'])).stdout);
  assert.equal(snapshot.receipts.filter(r => r.request_id === 'req_cc_duel').length, 1);
  const duelIds = snapshot.entries.map(e => e.id).filter(id => id.startsWith('clm_cc_duel_'));
  assert.deepStrictEqual(duelIds.length, 1);
  const shown = JSON.parse((await runAsync(['show', duelIds[0]])).stdout);
  assert.equal(shown.entry.data.text, `duel version ${duelIds[0].endsWith('_a') ? 'A' : 'B'}`);
});
test('writer exceeding busy timeout fails without partial writes', async t => {
  const { dir, db, runAsync } = setup(t);
  assert.equal((await runAsync(['init'])).status, 0);
  const holder = new DatabaseSync(db);
  let writer;
  const started = Date.now();
  try {
    holder.exec('BEGIN IMMEDIATE');
    const file = bundleFile(dir, 'blocked.json', 'req_cc_blocked', [claim('clm_cc_blocked', 'never lands')]);
    writer = await runAsync(['capture', '--file', file]);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  const elapsed = Date.now() - started;
  assert.equal(writer.status, 1, writer.stderr);
  const busyError = JSON.parse(writer.stderr).error;
  assert.equal(busyError.code, 'IO_OR_RUNTIME');
  assert.match(busyError.message, /locked|busy/i);
  assert.ok(elapsed >= 4000, 'writer must retry through the busy timeout, not fail instantly');
  assert.ok(elapsed < 30000, 'writer must fail near the 5s busy timeout, not hang');
  assert.equal(JSON.parse((await runAsync(['doctor'])).stdout).ok, true);
  const snapshot = JSON.parse((await runAsync(['export'])).stdout);
  assert.equal(snapshot.entries.filter(e => e.id === 'clm_cc_blocked').length, 0);
  assert.equal(snapshot.receipts.filter(r => r.request_id === 'req_cc_blocked').length, 0);
});
