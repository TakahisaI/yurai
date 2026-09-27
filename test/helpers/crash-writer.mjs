// Crash mid-write, then let the parent verify. Usage: node crash-writer.mjs DB MODE
// partial: stage record, link, lookup, and receipt rows and die before COMMIT.
// committed: COMMIT the same rows, then die. Prints 'ready' once the outcome
// is decided; the parent awaits process exit before asserting.
import { DatabaseSync } from 'node:sqlite';
const [, , dbPath, mode] = process.argv;
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON;');
db.exec('BEGIN IMMEDIATE');
db.exec(`INSERT INTO records(id,type,body,actor,created_at) VALUES
  ('src_crash','source','{"title":"crash token source crashtoken","medium":"note","uri":"urn:yurai:synthetic:crash"}',
   '{"kind":"agent","id":"crash"}','2026-09-27T00:00:00.000Z'),
  ('evd_crash','evidence','{"source_id":"src_crash","quote":"qf"}',
   '{"kind":"agent","id":"crash"}','2026-09-27T00:00:00.000Z');
  INSERT INTO links(from_id,to_id,role) VALUES ('evd_crash','src_crash','source');
  INSERT INTO lookup(id,kind,text) VALUES ('src_crash','source',
   'crash token source crashtoken' || char(10) || 'urn:yurai:synthetic:crash');
  INSERT INTO receipts(request_id,digest,ids) VALUES
  ('req_crash','${'f'.repeat(64)}','["src_crash","evd_crash"]');`);
if (mode === 'committed') db.exec('COMMIT');
process.stdout.write('ready\n', () => process.kill(process.pid, 'SIGKILL'));
