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
export { canonicalJson, classifySameId, exactContentEquals, exactEntryEquals, isLedgerId, outcomeFor,
  sameForkMappingKey, sameOriginIdentity, FORK_REWRITTEN_REFERENCE_FIELDS, MERGE_IDENTITY_OUTCOMES } from './core/mergeIdentity.js';
export type { MergeOutcome, OriginIdentity, OriginLabel, OutcomeCaseId, OutcomeRow, SameIdClass } from './core/mergeIdentity.js';
export type { Actor, Bodies, Bundle, Entry, Input, Kind, Receipt, Snapshot, State } from './core/model.js';
export type { Store } from './core/ports.js';
export { CountingStore, ScanCollector } from './core/observe.js';
export type { LedgerObserver, MethodStats, ScanKind, StoreCallStats, StoreMethod } from './core/observe.js';
export { SqliteStore } from './storage/sqlite.js';
