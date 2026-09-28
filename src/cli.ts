#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Ledger, SqliteStore, LedgerError, bundleSchema, inputSchema, snapshotSchema } from './index.js';
import { MAX_VERIFY_BYTES } from './core/verify.js';

const help = `yurai — a local ledger of claims and their grounds

  yurai init [--db PATH]
  yurai capture --file bundle.json [--dry-run]
  yurai add --file record.json [--actor ID] [--actor-kind human|agent|import]
  yurai review ID --state accepted|rejected|withdrawn|proposed --reason TEXT
  yurai search QUERY [--kind claim|source] [--include-inactive] [--expand evidence]
                 [--path-limit L] [--path-offset O] [--as-of REV]
  yurai show ID [--limit 20] [--offset 0] [--as-of REV]
  yurai show --request-id ID [--limit 20] [--offset 0]
  yurai verify EVIDENCE_ID --file PATH [--edition LABEL] [--method verbatim|normalized]
  yurai export                         # snapshot JSON to stdout
  yurai import --file snapshot.json    # empty initialized ledger only
  yurai doctor
  yurai schema [bundle|record|snapshot]

Global: --db PATH, --actor ID, --actor-kind KIND, --request-id ID,
        --limit 1..100, --offset N, --readonly, --help
Expanded search pages match paths per claim with --path-limit (default: --limit)
and --path-offset; via_next_offset continues truncated paths.
File '-' reads stdin. Output is JSON; errors go to stderr.
Accepted means retained after review, NOT established as true.
Source URIs are stored only: no network access or model calls.
`;
function usage(message: string): never { throw new LedgerError('USAGE', message); }
function readRaw(file: string | undefined, maxBytes: number): Buffer {
  if (!file) usage('--file is required');
  if (file !== '-' && statSync(file).size > maxBytes) usage(`input exceeds ${maxBytes} bytes`);
  // Read stdin incrementally to enforce the cap before allocating unbounded memory.
  const chunks: Buffer[] = [];
  if (file === '-') {
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
      const n = readSync(0, chunk, 0, chunk.length, null);
      if (!n) break;
      total += n;
      if (total > maxBytes) usage(`input exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, n));
    }
  } else chunks.push(readFileSync(file));
  const bytes = Buffer.concat(chunks);
  if (bytes.length > maxBytes) usage(`input exceeds ${maxBytes} bytes`);
  return bytes;
}
function readJson(file: string | undefined, maxBytes: number): unknown {
  const bytes = readRaw(file, maxBytes);
  try { return JSON.parse(bytes.toString('utf8')); } catch { return usage('input is not valid JSON'); }
}

let store: SqliteStore | undefined;
try {
  const { values: v, positionals: args } = parseArgs({ allowPositionals: true, strict: true,
    options: { db: { type: 'string' }, file: { type: 'string' }, actor: { type: 'string' },
      'actor-kind': { type: 'string' }, 'request-id': { type: 'string' }, kind: { type: 'string' },
      state: { type: 'string' }, reason: { type: 'string' }, edition: { type: 'string' }, method: { type: 'string' },
      limit: { type: 'string' }, offset: { type: 'string' },
      'path-limit': { type: 'string' }, 'path-offset': { type: 'string' }, 'as-of': { type: 'string' },
      'dry-run': { type: 'boolean' }, 'include-inactive': { type: 'boolean' }, expand: { type: 'string' }, readonly: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  const [command, arg] = args;
  if (v.help || !command) { process.stdout.write(help); }
  else {
    const positionalCounts: Record<string, number> = { init: 1, capture: 1, add: 1, review: 2, search: 2, show: v['request-id'] !== undefined ? 1 : 2, verify: 2, export: 1, import: 1, doctor: 1, schema: arg ? 2 : 1 };
    if (!Object.hasOwn(positionalCounts, command) || args.length !== positionalCounts[command]) usage('unknown command or wrong arguments; use --help');
    // Reject misplaced flags instead of accepting options which have no effect.
    const allowed: Record<string, string[]> = {
      init: [], capture: ['file','dry-run'], add: ['file','actor','actor-kind','request-id','dry-run'],
      review: ['state','reason','actor','actor-kind','request-id','dry-run'],
      search: ['kind','limit','offset','include-inactive','expand','path-limit','path-offset','as-of'], show: ['limit','offset','request-id','as-of'],
      verify: ['file','edition','method','actor','actor-kind','request-id','dry-run'],
      export: [], import: ['file'], doctor: [], schema: [] };
    for (const key of Object.keys(v)) if (!['db','help','readonly'].includes(key) && !allowed[command]!.includes(key)) usage(`--${key} is not valid for ${command}`);
    if (command === 'init' && v.readonly) usage('--readonly cannot create or initialize a ledger');
    let result: unknown;
    if (command === 'schema') {
      const schemas: Record<string, unknown> = { bundle: bundleSchema, record: inputSchema, snapshot: snapshotSchema };
      const name = arg ?? 'bundle';
      if (!Object.hasOwn(schemas, name)) usage('schema must be bundle, record, or snapshot');
      result = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schemas[name] as object };
    } else {
      const db = resolve(v.db ?? process.env.YURAI_DB ?? join(homedir(), '.yurai', 'ledger.sqlite'));
      // Import reads (and size-checks) its input before opening the target, so a
      // refusal leaves the database file untouched: never migrated, never created.
      const importInput = command === 'import' ? readJson(v.file, 16 * 1024 * 1024) : undefined;
      store = new SqliteStore(db, command === 'init', { readonly: v.readonly ?? false });
      const ledger = new Ledger(store);
      const actor = { kind: v['actor-kind'] ?? 'human', id: v.actor ?? 'local' };
      const request_id = v['request-id'] ?? `req_${randomUUID()}`;
      switch (command) {
        case 'init': result = { database: db, schema_version: store.schemaVersion() }; break;
        case 'capture': result = ledger.capture(readJson(v.file, 1024 * 1024), v['dry-run']); break;
        case 'add': result = ledger.capture({ version: 1, request_id, actor, entries: [readJson(v.file, 1024 * 1024)] }, v['dry-run']); break;
        case 'review':
          if (!v.state || !v.reason) usage('review requires --state and --reason');
          result = ledger.capture({ version: 1, request_id, actor, entries: [{ id: `rev_${createHash('sha256').update(request_id).digest('hex')}`, type: 'review',
            data: { target_id: arg, state: v.state, rationale: v.reason } }] }, v['dry-run']); break;
        case 'search':
          if (v.kind && v.kind !== 'claim' && v.kind !== 'source') usage('--kind must be claim or source');
          if (v.expand !== undefined && v.expand !== 'evidence') usage('--expand must be evidence');
          if (v.kind === 'source' && v.expand !== undefined) usage('--expand routes to claims only');
          result = ledger.search(arg!, { kind: v.kind === 'source' ? 'source' : 'claim', limit: Number(v.limit ?? 20), offset: Number(v.offset ?? 0),
            includeInactive: v['include-inactive'] ?? false, ...(v.expand === undefined ? {} : { expand: 'evidence' as const }),
            ...(v['path-limit'] === undefined ? {} : { pathLimit: Number(v['path-limit']) }),
            ...(v['path-offset'] === undefined ? {} : { pathOffset: Number(v['path-offset']) }),
            ...(v['as-of'] === undefined ? {} : { asOf: Number(v['as-of']) }) }); break;
        case 'show':
          result = v['request-id'] !== undefined
            ? ledger.inspectCapture(v['request-id'], Number(v.limit ?? 20), Number(v.offset ?? 0), v['as-of'] === undefined ? undefined : Number(v['as-of']))
            : ledger.show(arg!, Number(v.limit ?? 20), Number(v.offset ?? 0), v['as-of'] === undefined ? undefined : Number(v['as-of'])); break;
        case 'verify': {
          if (!v.file) usage('verify requires --file');
          if (v.method !== undefined && v.method !== 'verbatim' && v.method !== 'normalized') usage('--method must be verbatim or normalized');
          let content: Buffer | null, detail: string | undefined;
          try { content = readRaw(v.file, MAX_VERIFY_BYTES); }
          catch (error) {
            if (error instanceof LedgerError) throw error;
            content = null;
            // detail must fit text(2000) with no NUL; paths and OS errors are unbounded.
            detail = `unreadable ${v.file}: ${error instanceof Error ? error.message : String(error)}`
              .replace(/\u0000/gu, '').slice(0, 2000).replace(/[\uD800-\uDBFF]$/u, '');
          }
          result = ledger.verifyEvidence({ evidence_id: arg!, content,
            ...(v.edition === undefined ? {} : { edition: v.edition }),
            ...(v.method === undefined ? {} : { method: v.method as 'verbatim' | 'normalized' }),
            ...(detail === undefined ? {} : { detail }),
            actor, request_id, dryRun: v['dry-run'] ?? false }); break;
        }
        case 'export': result = ledger.exportSnapshot(); break;
        case 'import': result = ledger.importSnapshot(importInput); break;
        case 'doctor': result = store.doctor(); if (!(result as { ok: boolean }).ok) process.exitCode = 1; break;
      }
    }
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (command === 'export' && Buffer.byteLength(output) > 16 * 1024 * 1024)
      usage('snapshot exceeds the current 16 MiB restore limit; no partial export was written');
    process.stdout.write(output);
  }
} catch (error) {
  const e = error instanceof LedgerError ? error : new LedgerError('IO_OR_RUNTIME', error instanceof Error ? error.message : String(error));
  process.stderr.write(`${JSON.stringify({ error: { code: e.code, message: e.message } })}\n`);
  process.exitCode = e.code === 'VALIDATION' || e.code === 'USAGE' ? 2 : e.code === 'NOT_FOUND' ? 3 : e.code === 'CONFLICT' ? 4 : 1;
} finally { store?.close(); }
