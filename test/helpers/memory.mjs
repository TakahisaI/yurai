import { Ledger, SqliteStore } from '../../dist/index.js';
import { CountingStore, ScanCollector } from '../../dist/core/observe.js';

/** Fixed clock pinning created_at across the in-memory setups. */
const FIXED_AT = '2026-09-27T00:00:00.000Z';
const fixedNow = () => FIXED_AT;

/**
 * Fresh in-memory ledger for one test.
 *
 * `t` registers teardown closing the store; pass null when the caller owns
 * the store lifetime and closes it. `now` is the fixed test clock by
 * default; pass null for the live clock. `hooked` wraps the store in a
 * CountingStore plus ScanCollector. `raw` aliases `store` for the
 * measurement files that named it so.
 */
export function memorySetup(t, { now = fixedNow, hooked = false } = {}) {
  const store = new SqliteStore(':memory:', true);
  if (t) t.after(() => store.close());
  if (!hooked) return { store, raw: store, ledger: new Ledger(store, now ?? undefined) };
  const counting = new CountingStore(store);
  const scans = new ScanCollector();
  return { store, raw: store, counting, scans, ledger: new Ledger(counting, now ?? undefined, scans) };
}
