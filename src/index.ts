export { Ledger } from './core/ledger.js';
export { canonicalReferences, isPlanStale, planPurge, planRedact, REDACT_SCOPE_NOTE,
  sourceFingerprint, verifyPlanApproval, verifyPlanDigest } from './core/planPurge.js';
export type { AffectedReceipt, DegradedDependent, DependentReason, PlanLimits, PlanSource, PlanStatus,
  PurgeExpected, PurgeOptions, PurgePlan, RedactAffectedReceipt, RedactExpected, RedactOptions,
  RedactPlan, RedactReason, RedactStateImpact, RefEdge, ReferenceResolver, ResolvedLimits,
  StateTransition, TombstonePreview, ViaEdge } from './core/planPurge.js';
export { toExpandedRefsV1 } from './core/refs.js';
export type { ExpandedRefsResponse, RefsInlineResponse, RefsView, RefsWindow } from './core/refs.js';
export { LedgerError, bundleSchema, inputSchema, snapshotSchema } from './core/model.js';
export type { Actor, Bodies, Bundle, Entry, Input, Kind, Receipt, Snapshot, State } from './core/model.js';
export type { Store } from './core/ports.js';
export { SqliteStore } from './storage/sqlite.js';

// Narrow on purpose (ADR 0015): the package root ships the Ledger, the
// model, the Store port, the SQLite adapter, and the landed planner and
// refs APIs. Spec-only merge-identity classification
// (./core/mergeIdentity.js) and the measurement harness
// (./core/observe.js) stay importable by path but are not re-exported here.
