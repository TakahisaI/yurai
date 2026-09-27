import type { Entry, Receipt } from './model.js';
/** A synchronous local transaction boundary, not a general-purpose ORM. */
export interface Store {
  transaction<T>(fn: () => T): T;
  get(id: string): Entry | undefined;
  insert(entry: Entry): void;
  latestReview(id: string): Entry | undefined;
  latestVerification(evidenceId: string): Entry | undefined;
  schemaVersion(): number;
  incoming(id: string, limit: number, offset: number): Entry[];
  search(kind: 'claim' | 'source', tokens: string[], includeInactive: boolean, limit: number, offset: number): Entry[];
  entries(): Entry[];
  receipt(requestId: string): Receipt | undefined;
  receipts(): Receipt[];
  insertReceipt(receipt: Receipt): void;
  count(): number;
}
