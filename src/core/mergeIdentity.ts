import { canonicalJson, ID_MAX_LENGTH, ID_PATTERN } from './model.js';
import type { Entry, Kind } from './model.js';

/**
 * Foreign identity, exact equality, and collision classification for a future
 * cross-ledger merge (issue #30, ADR 0009). Spec-only and pure: no Store, no
 * Ledger, no mutation, no conflict resolution. Every function here classifies
 * or compares; nothing here writes, rewrites, remaps, or picks a winner.
 *
 * Vocabulary shared with the deletion track (ADR 0005, issue #23) is reused,
 * not redefined: purge, redact, tombstone, and the replay-prevention registry
 * keep the meaning ADR 0005 gives them. #23 owns the tombstoned-body
 * representation and the registry; this module only names the collision cases
 * where those artifacts meet a merge.
 */

/** Comparison-time origin label. `null` means legacy or unknown origin:
 *  snapshots carry no origin field, so any snapshot without out-of-band
 *  provenance compares as origin-unknown. A ledger path, self-declared name,
 *  DOI, URI, or similar text is NOT proof of origin and must never populate
 *  this label. */
export type OriginLabel = string | null;

/** Origin identity is the pair `(origin, id)`. Local identity is the bare
 *  record ID, meaningful only inside its own ledger. Two records from
 *  different ledgers share an origin identity only when both halves match;
 *  an unknown origin never matches anything, including another unknown. */
export interface OriginIdentity { origin: OriginLabel; id: string; }

/** True only when both halves match and the origin is known AND nonempty.
 *  Unknown origins never match: two origin-less snapshots cannot prove
 *  they are the same ledger, even when their IDs coincide (see the
 *  copied-ledger case). A missing (`null`/`undefined`/omitted) or empty
 *  label is unknown at runtime, so two such labels never compare as the
 *  same origin even with coincident IDs. */
export function sameOriginIdentity(a: OriginIdentity, b: OriginIdentity): boolean {
  if (typeof a.origin !== 'string' || typeof b.origin !== 'string') return false;
  if (a.origin.length === 0 || b.origin.length === 0) return false;
  return a.origin === b.origin && a.id === b.id;
}

/**
 * Fork-mapping key equality: do `a` and `b` occupy the same
 * `(incoming origin, incoming id)` slot? Unlike `sameOriginIdentity`,
 * unknown origins (`null`/`undefined`/omitted/empty) all normalize to one
 * key, so two unrelated origin-less snapshots containing `clm_k` both
 * produce `(null, clm_k)` and collide: one slot cannot preserve both
 * mappings. Such a fork refuses until the operator supplies a distinct
 * import namespace per import (a known, nonempty label each); the
 * namespace mechanics belong to #31. Same key under one known label is
 * the idempotent replay key, not a cross-import collision. Pure
 * comparison only: nothing here remaps, writes, or picks a winner.
 */
export function sameForkMappingKey(a: OriginIdentity, b: OriginIdentity): boolean {
  const key = (identity: OriginIdentity): OriginLabel =>
    typeof identity.origin === 'string' && identity.origin.length > 0 ? identity.origin : null;
  return key(a) === key(b) && a.id === b.id;
}

/** Canonical JSON, defined once in model.ts and re-exported here so this
 *  module's pinned export surface does not churn. */
export { canonicalJson };

/**
 * Exact-entry equality: same ID, same type, same body (including
 * `attributed_to`, `scope`, quotes, and every other content field), same
 * actor, same `created_at`. Bodies compare under `canonicalJson`, so only
 * key order is forgiven. A body match with a different recorder or time is
 * NOT exactly equal (see `classifySameId` → `different-provenance`).
 */
export function exactEntryEquals(a: Entry, b: Entry): boolean {
  return a.id === b.id
    && a.type === b.type
    && canonicalJson(a.data) === canonicalJson(b.data)
    && canonicalJson(a.actor) === canonicalJson(b.actor)
    && a.created_at === b.created_at;
}

/**
 * Same comparison ignoring the record ID, for analyzing cross-ledger pairs
 * that key the "same" content under different IDs. An equal result NEVER
 * authorizes unification: different IDs stay different records (see the
 * `different-ids-similar-text` outcome). Type still participates: a claim
 * and a review with coincidentally similar shapes are not content-equal.
 */
export function exactContentEquals(a: Entry, b: Entry): boolean {
  return a.type === b.type
    && canonicalJson(a.data) === canonicalJson(b.data)
    && canonicalJson(a.actor) === canonicalJson(b.actor)
    && a.created_at === b.created_at;
}

/** Same-ID collision classes. Anything other than `same-entry` is a
 *  conflict: it needs an explicit decision and refuses silently succeeding. */
export type SameIdClass =
  | 'same-entry'
  | 'different-body'
  | 'different-provenance'
  | 'tombstone-collision';

/**
 * Classify a same-ID pair. `isTombstone` marks entries whose body is a
 * redaction tombstone; the tombstoned-body representation is owned by #23,
 * so callers supply the predicate and this module never guesses from shape.
 * The detector is REQUIRED with no silent default: defaulting to "not a
 * tombstone" would let an equal tombstone pair slip through as `same-entry`
 * and bypass the privacy-sensitive conflict rule. Callers whose inputs are
 * known to contain no tombstones pass that claim explicitly as
 * `() => false`. A tombstone on EITHER side is a privacy-sensitive
 * `tombstone-collision`, never an invitation to restore the removed body
 * from the other side.
 */
export function classifySameId(
  local: Entry,
  incoming: Entry,
  isTombstone: (entry: Entry) => boolean,
): SameIdClass {
  if (typeof isTombstone !== 'function')
    throw new Error('classifySameId needs an explicit tombstone detector');
  if (local.id !== incoming.id) throw new Error('classifySameId needs a same-ID pair');
  if (isTombstone(local) || isTombstone(incoming)) return 'tombstone-collision';
  if (exactEntryEquals(local, incoming)) return 'same-entry';
  if (local.type !== incoming.type || canonicalJson(local.data) !== canonicalJson(incoming.data))
    return 'different-body';
  return 'different-provenance';
}

export type MergeOutcome = 'allowed' | 'refused' | 'needs-decision';

/** One row of the allowed/refused/needs-decision table (ADR 0009 § Outcomes).
 *  `privacySensitive` marks rows where the conflict touches redacted or
 *  removed content: resolution must never restore the body or reintroduce
 *  raw removed IDs into live audit. */
export interface OutcomeRow {
  caseId: string;
  outcome: MergeOutcome;
  privacySensitive: boolean;
  rule: string;
}

/**
 * The full outcome table. `allowed` rows still forbid rewriting: an allowed
 * same-entry pair is skipped byte-identically, and allowed distinct-ID rows
 * import side by side without unification. `refused` rows must fail the
 * merge even when a policy is later selected; `needs-decision` rows refuse
 * by default until the owner selects a winner (NOT done by #30).
 */
export const MERGE_IDENTITY_OUTCOMES: readonly OutcomeRow[] = [
  { caseId: 'same-id-same-entry', outcome: 'allowed', privacySensitive: false,
    rule: 'Exact-entry equality: skip without rewriting. The incoming copy adds no content record, no review, and no foreign receipt; whether the merge run itself mints a local operation receipt for retry identity belongs to #31.' },
  { caseId: 'same-id-different-body', outcome: 'needs-decision', privacySensitive: false,
    rule: 'Same ID, different type or body: conflict. Default refuse; prefer/fork winners are unselected by #30.' },
  { caseId: 'same-id-different-provenance', outcome: 'needs-decision', privacySensitive: false,
    rule: 'Body match with a different recorder or time is NOT silently identical: conflict, same handling as different-body.' },
  { caseId: 'same-text-different-scope', outcome: 'allowed', privacySensitive: false,
    rule: 'Same claim text under different scope/conditions AND different IDs: distinct records. Import side by side; unification is refused. The same ID with a different scope is same-id-different-body, a conflict.' },
  { caseId: 'different-ids-similar-text', outcome: 'allowed', privacySensitive: false,
    rule: 'Similar text (or shared DOI/URI) under different IDs: distinct records. Automatic near-duplicate merging is refused.' },
  { caseId: 'legacy-origin-less-exact', outcome: 'allowed', privacySensitive: false,
    rule: 'Origin-less snapshots that are exactly entry-equal: skip like same-id-same-entry. Unknown origin proves nothing beyond the bytes.' },
  { caseId: 'legacy-origin-less-diverged', outcome: 'needs-decision', privacySensitive: false,
    rule: 'Origin-less snapshots with same-ID divergence: conflict. No origin label may be invented to break the tie.' },
  { caseId: 'copied-ledger-exact', outcome: 'allowed', privacySensitive: false,
    rule: 'Duplicate origins after a ledger copy with no divergence: exact-equal pairs skip; the copy shares history, not identity.' },
  { caseId: 'copied-ledger-diverged', outcome: 'needs-decision', privacySensitive: false,
    rule: 'Copied ledgers that diverged under one ID: conflict. Shared past does not pick the surviving account.' },
  { caseId: 'redacted-vs-full', outcome: 'needs-decision', privacySensitive: true,
    rule: 'Redacted and full versions of one ID: privacy-sensitive conflict. Never restore the removed body; never drop the tombstone silently.' },
  { caseId: 'tombstone-collision', outcome: 'needs-decision', privacySensitive: true,
    rule: 'A tombstone on either side of a same-ID pair: privacy-sensitive conflict, never restore-the-body. Coordinate with #23.' },
  { caseId: 'auto-unify-similar', outcome: 'refused', privacySensitive: false,
    rule: 'Automatic unification of similar texts, shared DOI/URI, or fuzzy matches: refused unconditionally. Similarity is not identity.' },
  { caseId: 'overwrite-immutable-id', outcome: 'refused', privacySensitive: false,
    rule: 'Resolving any conflict by UPDATE of an existing immutable ID: refused unconditionally. Incoming preference needs new records/history.' },
  { caseId: 'silent-prefer-local', outcome: 'refused', privacySensitive: false,
    rule: 'Reporting success while silently discarding conflicting incoming material or rebinding its dependents: refused unconditionally.' },
] as const;

export type OutcomeCaseId = typeof MERGE_IDENTITY_OUTCOMES[number]['caseId'];

/** Look up one outcome row; unknown case IDs throw rather than defaulting. */
export function outcomeFor(caseId: string): OutcomeRow {
  const row = MERGE_IDENTITY_OUTCOMES.find(r => r.caseId === caseId);
  if (!row) throw new Error(`unknown merge-identity case: ${caseId}`);
  return row;
}

/**
 * Every reference field a fork/remap option MUST rewrite, by record type
 * (ADR 0009 § Fork inventory). Keys mirror `references()` in model.ts; the
 * conformance test cross-checks this list against that function so the two
 * can never drift. Claim and source carry no outbound references.
 *
 * Rewriting means: each imported reference points at the remapped ID of its
 * target (or fails the merge when the target is out of scope), Review and
 * Verification event targets included. Bodies otherwise stay byte-identical.
 */
export const FORK_REWRITTEN_REFERENCE_FIELDS: Readonly<Record<Kind, readonly string[]>> = {
  source: [],
  claim: [],
  evidence: ['source_id'],
  assessment: ['claim_id', 'evidence_id'],
  relation: ['from_claim_id', 'to_claim_id'],
  review: ['target_id'],
  verification: ['target_evidence_id', 'target_source_id'],
} as const;

/** Ledger ID grammar from the data contract: 2–128 chars, leading letter.
 *  A fork/remap MUST mint IDs inside this grammar; anything outside it (or
 *  colliding with a live local ID) refuses the merge instead of truncating
 *  or coercing. The minting scheme itself is deferred to the merge planner
 *  (#34); this predicate only states the constraint every scheme must meet. */
export function isLedgerId(text: string): boolean {
  return ID_PATTERN.test(text) && String(text).length <= ID_MAX_LENGTH;
}
