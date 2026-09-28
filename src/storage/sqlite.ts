import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, normalize, references } from '../core/model.js';
import type { Entry, Receipt } from '../core/model.js';
import type { Store } from '../core/ports.js';

const APPLICATION_ID = 0x59555249; // YURI; prevents opening unrelated SQLite files.
const RECORDS_DDL = (name: string, types: string) => `CREATE TABLE ${name} (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN (${types})),
  body TEXT NOT NULL CHECK(json_valid(body)), actor TEXT NOT NULL CHECK(json_valid(actor)), created_at TEXT NOT NULL
) STRICT;`;
const V2_TYPES = `'source','claim','evidence','assessment','relation','review','verification'`;
const RECORDS_TRIGGERS = ['UPDATE', 'DELETE'].map(op =>
  `CREATE TRIGGER records_${op.toLowerCase()} BEFORE ${op} ON records BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;`).join('\n');
/** v1 -> v2: admit the verification record type. Rebuilds records (SQLite cannot
 *  drop a CHECK), preserving seq so insertion order survives. Runs inside the
 *  registry's transaction with foreign keys off (DROP TABLE under enforced
 *  deferred FKs fails at commit, and the pragma cannot flip inside a
 *  transaction), so integrity is checked explicitly before and after the
 *  rebuild; a failure rolls everything back. Steps never touch transactions
 *  or user_version: the registry commits each step's DDL, checks, and version
 *  update as one atomic unit. */
function migrateV1toV2(db: DatabaseSync): void {
  if (foreignKeyCheck(db).length) fail('SCHEMA', 'v1 ledger failed integrity; refusing migration');
  db.exec(`${RECORDS_DDL('records_new', V2_TYPES)}
INSERT INTO records_new(seq,id,type,body,actor,created_at) SELECT seq,id,type,body,actor,created_at FROM records;
DROP TABLE records;
ALTER TABLE records_new RENAME TO records;
CREATE INDEX review_target ON records(json_extract(body, '$.target_id'), seq) WHERE type='review';
${RECORDS_TRIGGERS}`);
  if (foreignKeyCheck(db).length) fail('SCHEMA', 'migration broke references');
}
/** Numbered forward migrations. Each step runs once, in order, from the stored
 *  user_version to CURRENT_SCHEMA; unknown versions are refused, never skipped. */
const MIGRATIONS: { from: number; to: number; name: string; run: (db: DatabaseSync) => void }[] = [
  { from: 1, to: 2, name: 'admit verification records', run: migrateV1toV2 },
];
// Static guard for the next migration author: strictly forward, contiguous, from version 1.
{
  let expectFrom = 1;
  for (const m of MIGRATIONS) {
    if (m.to <= m.from || m.from !== expectFrom) throw new Error('migrations must form a forward chain from version 1');
    expectFrom = m.to;
  }
}
const CURRENT_SCHEMA = MIGRATIONS[MIGRATIONS.length - 1]?.to ?? 1;
const migration = `
${RECORDS_DDL('records', V2_TYPES)}
CREATE TABLE links (
  from_id TEXT NOT NULL REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED,
  to_id TEXT NOT NULL REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL, PRIMARY KEY(from_id, role)
) STRICT;
CREATE INDEX links_target ON links(to_id);
CREATE INDEX review_target ON records(json_extract(body, '$.target_id'), seq) WHERE type='review';
CREATE TABLE receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, ids TEXT NOT NULL CHECK(json_valid(ids))) STRICT;
CREATE VIRTUAL TABLE lookup USING fts5(id UNINDEXED, kind UNINDEXED, text, tokenize='trigram');
${['records', 'links', 'receipts'].map(t => ['UPDATE', 'DELETE'].map(op =>
  `CREATE TRIGGER ${t}_${op.toLowerCase()} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT, 'immutable ledger'); END;`).join('\n')).join('\n')}
PRAGMA application_id = ${APPLICATION_ID};
PRAGMA user_version = ${CURRENT_SCHEMA};
`;
function foreignKeyCheck(db: DatabaseSync): unknown[] {
  return db.prepare('PRAGMA foreign_key_check').all();
}
type Row = Record<string, unknown>;
function decode(row: Row): Entry {
  return { id: row.id, type: row.type, data: JSON.parse(row.body as string),
    actor: JSON.parse(row.actor as string), created_at: row.created_at } as Entry;
}
function receipt(row: Row): Receipt {
  return { request_id: row.request_id as string, digest: row.digest as string, ids: JSON.parse(row.ids as string) };
}
function searchText(e: Entry): string | undefined {
  if (e.type === 'claim') return normalize([e.data.text, e.data.scope, e.data.why].filter(Boolean).join('\n'));
  if (e.type === 'source') return normalize([e.data.title, e.data.uri, ...Object.values(e.data.identifiers ?? {})].filter(Boolean).join('\n'));
  return undefined;
}
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly readOnly: boolean;
  constructor(path: string, create = false, options: { readonly?: boolean } = {}) {
    this.readOnly = options.readonly ?? false;
    if (this.readOnly && create) fail('USAGE', 'readonly mode cannot create or initialize a ledger');
    if (this.readOnly && path === ':memory:') fail('USAGE', 'readonly mode needs an existing file ledger');
    if (path !== ':memory:' && !existsSync(path)) {
      if (!create) fail('NOT_FOUND', 'Ledger does not exist. Run yurai init with the same --db path.');
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = this.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      const app = Number(this.db.prepare('PRAGMA application_id').get()?.application_id);
      if (version === 0 && app === 0) {
        const tables = Number(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.n);
        if (!create || tables) fail('SCHEMA', 'Refusing to initialize an unrecognized database');
        this.transaction(() => { this.db.exec(migration); });
      } else if (app !== APPLICATION_ID) fail('SCHEMA', 'Unsupported ledger identity or schema version');
      else if (version !== CURRENT_SCHEMA) {
        if (version < 1 || version > CURRENT_SCHEMA) fail('SCHEMA', 'Unsupported ledger identity or schema version');
        if (this.readOnly) fail('SCHEMA', `schema v${version} needs migration; reopen without --readonly to migrate`);
        this.applyMigrations(version);
      }
      if (!this.readOnly) this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    } catch (error) { this.db.close(); throw error; }
  }
  private applyMigrations(version: number): void {
    // Foreign keys stay off around the chain: the pragma cannot flip inside a
    // transaction, and at least one rebuild needs it off. Steps verify
    // integrity explicitly with foreign_key_check instead of relying on commit.
    this.db.exec('PRAGMA foreign_keys=OFF;');
    try {
      for (;;) {
        if (version === CURRENT_SCHEMA) return;
        const next = MIGRATIONS.find(m => m.from === version);
        if (!next) fail('SCHEMA', 'Unsupported ledger identity or schema version');
        this.transaction(() => {
          next.run(this.db);
          this.db.exec(`PRAGMA user_version = ${next.to};`);
          version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
          if (version !== next.to) fail('SCHEMA', `migration ${next.from}->${next.to} did not advance the schema version`);
        });
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON;');
    }
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    // Readonly keeps a deferred read snapshot so multi-query reads (export,
    // expanded search) stay consistent; mutators refuse first, and SQLite
    // readOnly is the backstop against any write slipping through.
    this.db.exec(this.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): Entry | undefined {
    const row = this.db.prepare('SELECT * FROM records WHERE id=?').get(id);
    return row ? decode(row) : undefined;
  }
  insert(e: Entry): void {
    if (this.readOnly) fail('READONLY', 'ledger is open read-only; reopen without --readonly to write');
    this.db.prepare('INSERT INTO records(id,type,body,actor,created_at) VALUES(?,?,?,?,?)')
      .run(e.id, e.type, JSON.stringify(e.data), JSON.stringify(e.actor), e.created_at);
    for (const ref of references(e)) this.db.prepare('INSERT INTO links(from_id,to_id,role) VALUES(?,?,?)').run(e.id, ref.id, ref.role);
    const text = searchText(e);
    if (text !== undefined) this.db.prepare('INSERT INTO lookup(id,kind,text) VALUES(?,?,?)').run(e.id, e.type, text);
  }
  latestReview(id: string): Entry | undefined {
    const row = this.db.prepare("SELECT * FROM records WHERE type='review' AND json_extract(body,'$.target_id')=? ORDER BY seq DESC LIMIT 1").get(id);
    return row ? decode(row) : undefined;
  }
  latestVerification(evidenceId: string): Entry | undefined {
    const row = this.db.prepare(`SELECT r.* FROM records r JOIN links l ON r.id=l.from_id
      WHERE l.to_id=? AND r.type='verification' ORDER BY r.seq DESC LIMIT 1`).get(evidenceId);
    return row ? decode(row) : undefined;
  }
  schemaVersion(): number {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
  }
  incoming(id: string, limit: number, offset: number): Entry[] {
    return this.db.prepare('SELECT DISTINCT r.* FROM records r JOIN links l ON r.id=l.from_id WHERE l.to_id=? ORDER BY r.seq DESC LIMIT ? OFFSET ?')
      .all(id, limit, offset).map(decode);
  }
  search(kind: 'claim' | 'source', tokens: string[], includeInactive: boolean, limit: number, offset: number): Entry[] {
    const long = tokens.filter(t => [...t].length >= 3), short = tokens.filter(t => [...t].length < 3);
    const conditions = ['r.type=?'], params: (string | number)[] = [kind];
    if (long.length) {
      conditions.push('lookup MATCH ?');
      params.push(long.map(t => `"${t.replaceAll('"', '""')}"`).join(' AND '));
    }
    for (const token of short) { conditions.push('instr(lookup.text,?) > 0'); params.push(token); }
    if (!includeInactive) conditions.push(`COALESCE((SELECT json_extract(v.body,'$.state') FROM records v
      WHERE v.type='review' AND json_extract(v.body,'$.target_id')=r.id ORDER BY v.seq DESC LIMIT 1),'proposed')
      NOT IN ('rejected','withdrawn')`);
    return this.db.prepare(`SELECT r.* FROM records r JOIN lookup ON lookup.id=r.id
      WHERE ${conditions.join(' AND ')} ORDER BY r.seq DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).map(decode);
  }
  entries(): Entry[] { return this.db.prepare('SELECT * FROM records ORDER BY seq').all().map(decode); }
  receipt(requestId: string): Receipt | undefined {
    const row = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(requestId);
    return row ? receipt(row) : undefined;
  }
  receipts(): Receipt[] { return this.db.prepare('SELECT * FROM receipts ORDER BY rowid').all().map(receipt); }
  insertReceipt(r: Receipt): void {
    if (this.readOnly) fail('READONLY', 'ledger is open read-only; reopen without --readonly to write');
    this.db.prepare('INSERT INTO receipts(request_id,digest,ids) VALUES(?,?,?)').run(r.request_id, r.digest, JSON.stringify(r.ids));
  }
  count(): number { return Number(this.db.prepare('SELECT count(*) AS n FROM records').get()?.n); }
  revision(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM records').get()?.n); }
  doctor() {
    return this.transaction(() => this.check());
  }
  private check() {
    const integrity = this.db.prepare('PRAGMA integrity_check').all();
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
    // The FTS self-check is a special write; readonly skips it and says so.
    const fts_integrity = this.readOnly ? 'skipped-readonly' as const : 'checked' as const;
    if (!this.readOnly) this.db.exec("INSERT INTO lookup(lookup) VALUES('integrity-check')");
    const expected = this.db.prepare("SELECT * FROM records WHERE type IN ('claim','source') ORDER BY seq").all().map(decode);
    const actual = this.db.prepare('SELECT id,kind,text FROM lookup').all();
    const index = new Map(actual.map(r => [r.id, r]));
    const consistent = actual.length === expected.length && expected.every(e => index.get(e.id)?.text === searchText(e) && index.get(e.id)?.kind === e.type);
    return { ok: integrity.every(r => r.integrity_check === 'ok') && !foreignKeys.length && consistent,
      schema_version: this.schemaVersion(), sqlite_version: this.db.prepare('SELECT sqlite_version() AS v').get()?.v,
      records: this.count(), foreign_key_errors: foreignKeys, search_index_consistent: consistent,
      fts_integrity, integrity, truth_evaluated: false };
  }
}
