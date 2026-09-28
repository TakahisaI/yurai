import type { Entry, Receipt } from './model.js';
import type { Store } from './ports.js';

/** Full-ledger read observation points in Core (#44). Each scan reports how
 * many stored records the operation examined at the Ledger level, not just
 * what it returned. These are Ledger-level records examined, not SQL
 * statements issued or rows examined inside SQLite — statement-level counting
 * is an explicit follow-up (see ADR 0010). */
export type ScanKind = 'supersedes-check' | 'expanded-evidence' | 'export';

/** Assess-only observer: Ledger reports scans to it but never branches on it,
 * and swallows any throw from it, so attaching an observer cannot change
 * results, ordering, errors, or transaction outcomes. The observer is
 * undefined by default and every report site is guarded, keeping the hot path
 * to one predictable branch per site when hooks are off. */
export interface LedgerObserver {
  scan(kind: ScanKind, recordsExamined: number): void;
}

/** Per-method Store-method call counts plus rows returned and rows
 * written. Rows returned are the records a Store method returned, not rows
 * examined in SQLite: array results contribute their length, single lookups
 * contribute 1 on hit / 0 on miss, scalar calls contribute 0. Writes are
 * counted separately: each void write contributes 1 row written and 0 rows
 * returned, so rowsReturned means what it says. */
export type StoreMethod =
  'transaction' | 'get' | 'insert' | 'latestReview' | 'latestVerification' |
  'schemaVersion' | 'incoming' | 'search' | 'entries' | 'receipt' |
  'receipts' | 'insertReceipt' | 'count' | 'revision';

export interface MethodStats { calls: number; rowsReturned: number; rowsWritten: number; }
export type StoreCallStats = Record<StoreMethod, MethodStats>;

function emptyStats(): StoreCallStats {
  const stats = {} as StoreCallStats;
  for (const m of ['transaction', 'get', 'insert', 'latestReview', 'latestVerification',
    'schemaVersion', 'incoming', 'search', 'entries', 'receipt',
    'receipts', 'insertReceipt', 'count', 'revision'] as const)
    stats[m] = { calls: 0, rowsReturned: 0, rowsWritten: 0 };
  return stats;
}

/** Assess-only Store decorator: delegates every call verbatim and counts
 * Store-method calls plus rows returned and rows written (never SQL
 * statements or SQLite rows examined). Production paths (CLI, MCP) never
 * wrap the store; only the measurement harness opts in, so normal operation
 * keeps one predictable branch per observer report site and no decorator
 * cost. */
export class CountingStore implements Store {
  private readonly stats = emptyStats();
  constructor(private readonly inner: Store) {}
  /** Snapshot the accumulated counts without resetting. */
  snapshot(): StoreCallStats {
    const out = emptyStats();
    for (const [k, v] of Object.entries(this.stats) as [StoreMethod, MethodStats][])
      out[k] = { ...v };
    return out;
  }
  reset(): void {
    for (const v of Object.values(this.stats)) { v.calls = 0; v.rowsReturned = 0; v.rowsWritten = 0; }
  }
  private hit(method: StoreMethod, rowsReturned: number, rowsWritten = 0): void {
    this.stats[method].calls++;
    this.stats[method].rowsReturned += rowsReturned;
    this.stats[method].rowsWritten += rowsWritten;
  }
  transaction<T>(fn: () => T): T { this.hit('transaction', 0); return this.inner.transaction(fn); }
  get(id: string): Entry | undefined { const r = this.inner.get(id); this.hit('get', r ? 1 : 0); return r; }
  insert(entry: Entry): void { this.inner.insert(entry); this.hit('insert', 0, 1); }
  latestReview(id: string): Entry | undefined {
    const r = this.inner.latestReview(id); this.hit('latestReview', r ? 1 : 0); return r;
  }
  latestVerification(evidenceId: string): Entry | undefined {
    const r = this.inner.latestVerification(evidenceId); this.hit('latestVerification', r ? 1 : 0); return r;
  }
  schemaVersion(): number { const r = this.inner.schemaVersion(); this.hit('schemaVersion', 0); return r; }
  incoming(id: string, limit: number, offset: number): Entry[] {
    const r = this.inner.incoming(id, limit, offset); this.hit('incoming', r.length); return r;
  }
  search(kind: 'claim' | 'source', tokens: string[], includeInactive: boolean, limit: number, offset: number): Entry[] {
    const r = this.inner.search(kind, tokens, includeInactive, limit, offset); this.hit('search', r.length); return r;
  }
  entries(): Entry[] { const r = this.inner.entries(); this.hit('entries', r.length); return r; }
  receipt(requestId: string): Receipt | undefined {
    const r = this.inner.receipt(requestId); this.hit('receipt', r ? 1 : 0); return r;
  }
  receipts(): Receipt[] { const r = this.inner.receipts(); this.hit('receipts', r.length); return r; }
  insertReceipt(receipt: Receipt): void { this.inner.insertReceipt(receipt); this.hit('insertReceipt', 0, 1); }
  count(): number { const r = this.inner.count(); this.hit('count', 0); return r; }
  revision(): number { const r = this.inner.revision(); this.hit('revision', 0); return r; }
}

/** Collects Ledger-level scan reports for one measurement window. */
export class ScanCollector implements LedgerObserver {
  private readonly scans: Record<ScanKind, number> = { 'supersedes-check': 0, 'expanded-evidence': 0, export: 0 };
  scan(kind: ScanKind, recordsExamined: number): void { this.scans[kind] += recordsExamined; }
  snapshot(): Record<ScanKind, number> { return { ...this.scans }; }
  reset(): void { this.scans['supersedes-check'] = 0; this.scans['expanded-evidence'] = 0; this.scans.export = 0; }
}
