import { LedgerError } from '../../dist/core/model.js';

/** Matches a LedgerError carrying the expected code, for assert.throws. */
export const code = expected => e => e instanceof LedgerError && e.code === expected;
