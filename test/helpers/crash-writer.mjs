// Crash a REAL Ledger.capture() after its final staged write but before COMMIT.
// Usage: node crash-writer.mjs DB MODE
// partial: SIGKILL inside the capture transaction; committed: SIGKILL after it.
// Prints 'staged' from the patched receipt write, then the outcome marker.
// Anything else (e.g. 'unexpected-commit') means the harness misfired.
import { writeSync } from 'node:fs';
import { Ledger, SqliteStore } from '../../dist/index.js';
const [, , dbPath, mode] = process.argv;
const store = new SqliteStore(dbPath);
const ledger = new Ledger(store, () => '2026-09-27T00:00:00.000Z');
const bundle = { version: 1, request_id: 'req_crash_cap', actor: { kind: 'agent', id: 'crash' }, entries: [
  { id: 'src_cap', type: 'source',
    data: { title: 'crashcap token source', medium: 'note', uri: 'urn:yurai:synthetic:crashcap' } },
  { id: 'clm_cap', type: 'claim',
    data: { text: 'crash capture finding', kind: 'assertion', attributed_to: 'crash' } },
  { id: 'evd_cap', type: 'evidence', data: { source_id: 'src_cap', quote: 'qf' } },
  { id: 'asm_cap', type: 'assessment',
    data: { claim_id: 'clm_cap', evidence_id: 'evd_cap', stance: 'reports', rationale: 'r' } }] };
const insertReceipt = store.insertReceipt.bind(store);
store.insertReceipt = r => {
  insertReceipt(r);
  writeSync(1, 'staged\n');
  if (mode === 'partial') process.kill(process.pid, 'SIGKILL');
};
ledger.capture(bundle);
if (mode === 'partial') { writeSync(1, 'unexpected-commit\n'); process.exit(1); }
writeSync(1, 'committed\n');
process.kill(process.pid, 'SIGKILL');
