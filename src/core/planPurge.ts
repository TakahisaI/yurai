/** Pure purge/redact impact planner (issue #24, slice 1, boxes 1-6).
 *
 * Computes what maintenance would remove or change before any live ledger is
 * touched. Core-only: no Store, no SQLite, no clock, no writes of any kind.
 * The planner consumes a read-only {@link PlanSource} snapshot plus source
 * identity, schema, registry, and logical revision, and returns
 * machine-readable plans only.
 *
 * Every plan carries a `source_fingerprint` (hash over source identity,
 * schema, revision, registry version, registry, entries, and receipts) and
 * a self-sealing `digest` over the plan itself. The executor flow is: reject
 * when {@link verifyPlanApproval} fails against the digest retained from the
 * actual approval (substituted or altered artifact), when {@link isPlanStale}
 * reports the source moved (stale source), or when a fresh plan over the
 * live source — recomputed with the retained selection, limits, resolver,
 * and confirmation parameters — yields a digest different from the retained
 * approval digest (altered scope or effects) — never silently recompute an
 * approved plan.
 *
 * Planner diagnostics never carry record IDs: thrown validation errors
 * describe the defect class without naming the record (sensitivity doc).
 */
import { createHash } from 'node:crypto';
import { canonicalJson, fail, isKnownKind, isValidTimestamp, LedgerError, references } from './model.js';
import type { Entry, Kind, Receipt } from './model.js';

/** Read-only planning input. Never a writable Store handle: callers pass a
 *  detached entry/receipt snapshot (e.g. from exportSnapshot) plus the
 *  logical revision it was taken at. The planner never mutates it.
 *
 *  Entries stay in source array order, which mirrors restore `seq` semantics:
 *  the last event in array order is the latest review/verification. The
 *  {@link sourceFingerprint} is therefore order-sensitive on purpose — a
 *  reordered event pair changes effective state, so it must read as stale.
 *  Receipt `ids` likewise stay in stored membership order: capture preserves
 *  bundle order and `inspectCapture` pages in it, so a reordered membership
 *  list is a source change and must read as stale. Receipts themselves are
 *  an order-insensitive set keyed by `request_id`. */
export interface PlanSource {
  readonly revision: number;
  readonly entries: readonly Entry[];
  readonly receipts: readonly Receipt[];
  /** Opaque caller-supplied source identity (ledger path or label).
   *  Absent means unidentified, never "same as any other source". A plan
   *  over an unidentified source can never be `ready`. */
  readonly source_id?: string;
  /** Ledger schema version (`user_version`) the snapshot was taken at.
   *  Absent means unknown. A plan over an unknown schema can never be
   *  `ready`. */
  readonly schema_version?: number;
  /** Blocked request digests (ADR 0008 registry extension): sorted unique
   *  lowercase hex SHA-256. Absent means an empty registry. */
  readonly registry?: readonly string[];
  /** Registry extension version (`registry_version`, ADR 0008 box 1).
   *  Absent means unknown. Supplied alongside `registry` so the
   *  fingerprint binds the digest encoding, not just the digest set. Any
   *  supplied version the planner does not support fails closed — even
   *  with an empty registry, an explicit version is distinct from the
   *  absent legacy extension — as does a nonempty registry under a
   *  missing version: no `ready` plan leaves. */
  readonly registry_version?: number;
}

/** One outgoing reference edge, mirroring canonical `references()`. */
export interface RefEdge {
  readonly id: string;
  readonly role: string;
  readonly kind: string;
}

/** Resolves outgoing reference edges for one entry. Defaults to the
 *  canonical `references()`; future registered record variants plug in here
 *  without changing the closure mechanics.
 *
 *  A resolver MUST throw `LedgerError` with code `'UNKNOWN_KIND'` for any
 *  entry kind it cannot resolve. The planner then halts the plan as
 *  `incomplete`, naming the unresolvable IDs: returning no edges for an
 *  unknown kind would silently shrink the closure and is fail-open. */
export type ReferenceResolver = (entry: Entry) => readonly RefEdge[];

export function canonicalReferences(entry: Entry): readonly RefEdge[] {
  if (!entry || typeof entry !== 'object' || entry.data === null || typeof entry.data !== 'object') {
    fail('VALIDATION', 'plan source holds a malformed entry');
  }
  if (!isKnownKind(entry.type)) {
    fail('UNKNOWN_KIND', `no reference table for record kind '${entry.type as string}'`);
  }
  return references(entry);
}

export interface PlanLimits {
  /** Hard stop on transitive-closure growth, and the bound on the echoed
   *  `selection` (the closure seed). Default 10000. */
  readonly maxClosure?: number;
  /** Cap on survivors/degraded/detail lists: unknown and unresolvable IDs,
   *  cascade, state impact, already-tombstoned, unsupported kinds. Default 500. */
  readonly maxReasons?: number;
  /** Cap on affected-receipt detail arrays. Default 500. */
  readonly maxReceipts?: number;
  /** Cap on per-dependent `via` edges. Default 8. */
  readonly maxVia?: number;
}

/** Effective (default-filled) limits a plan was computed under. Echoed so an
 *  executor re-planning for comparison uses identical bounds. */
export interface ResolvedLimits {
  readonly maxClosure: number;
  readonly maxReasons: number;
  readonly maxReceipts: number;
  readonly maxVia: number;
}

export interface ViaEdge {
  readonly target: string;
  readonly role: string;
  readonly kind: string;
}

export interface DependentReason {
  readonly id: string;
  readonly type: string;
  readonly depth: number;
  readonly via: readonly ViaEdge[];
  readonly viaTruncated: boolean;
}

/** A receipt intersecting the purge removal scope. The receipt is removed;
 *  records listed under `surviving_ids` stay live. */
export interface AffectedReceipt {
  readonly request_id: string;
  /** Opaque replay-prevention digest: lowercase hex SHA-256 over the UTF-8
   *  bytes of `request_id` (#23 box 1). No raw IDs or content. */
  readonly blocked_digest: string;
  /** Always true in this contract: #23 box 4 (registry membership and
   *  admission) is pending, so the blocked prediction is provisional — a
   *  planner forecast, never registry state. Partial purges fail closed on
   *  immutable-ID conflict regardless of the registry. */
  readonly blocked_digest_provisional: true;
  readonly removed_ids: readonly string[];
  readonly surviving_ids: readonly string[];
  readonly disposition: 'remove-receipt';
}

/** A receipt intersecting the redact scope. The receipt is dropped while its
 *  surviving records stay live with their IDs intact (ADR 0005 rule 5).
 *  Carries no blocked digest: only purged `request_id` values enter the
 *  replay registry, and a redact re-submission fails closed on
 *  immutable-ID conflict, so no block is predicted or required. */
export interface RedactAffectedReceipt {
  readonly request_id: string;
  readonly removed_ids: readonly string[];
  readonly surviving_ids: readonly string[];
  readonly disposition: 'drop-receipt';
}

export type PlanStatus = 'ready' | 'refused' | 'incomplete';

interface ClosureMember {
  depth: number;
  via: ViaEdge[];
  viaTruncated: boolean;
}

function resolveLimits(limits?: PlanLimits): ResolvedLimits {
  const positive = (v: number | undefined, fallback: number, name: string): number => {
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || v < 1) fail('VALIDATION', `plan limit ${name} must be a positive integer`);
    return v;
  };
  return {
    maxClosure: positive(limits?.maxClosure, 10000, 'maxClosure'),
    maxReasons: positive(limits?.maxReasons, 500, 'maxReasons'),
    maxReceipts: positive(limits?.maxReceipts, 500, 'maxReceipts'),
    maxVia: positive(limits?.maxVia, 8, 'maxVia'),
  };
}

/** Registry extension versions the planner can interpret (ADR 0008 box 1:
 *  `registry_version: 1`). Any supplied version outside this set carries a
 *  digest encoding the planner cannot know — even with an empty digest
 *  list, an explicit extension version is distinct from the absent legacy
 *  extension — so the source is unreadable for planning and fails closed.
 *  A nonempty registry under a missing version fails closed the same way. */
const SUPPORTED_REGISTRY_VERSIONS: ReadonlySet<number> = new Set([1]);

/** True when the source registry needs no interpretation the planner lacks:
 *  absent or empty with no unsupported version supplied (legacy ledgers
 *  carry no version), or nonempty under a supported version. An explicit
 *  unsupported `registry_version` refuses even when `registry` is empty.
 *  Never throws: malformed registries fail in `checkSource`; this decides
 *  `ready` versus fail-closed halt. */
function registryReadable(source: PlanSource): boolean {
  if (source.registry_version !== undefined && !SUPPORTED_REGISTRY_VERSIONS.has(source.registry_version)) return false;
  if ((source.registry ?? []).length === 0) return true;
  return source.registry_version !== undefined && SUPPORTED_REGISTRY_VERSIONS.has(source.registry_version);
}

function checkSource(source: PlanSource): void {
  if (!source || typeof source !== 'object') fail('VALIDATION', 'plan source must be an object');
  if (!Number.isInteger(source.revision) || source.revision < 0) {
    fail('VALIDATION', 'plan source revision must be a non-negative integer');
  }
  if (!Array.isArray(source.entries) || !Array.isArray(source.receipts)) {
    fail('VALIDATION', 'plan source entries and receipts must be arrays');
  }
  if (source.source_id !== undefined && (typeof source.source_id !== 'string' || !source.source_id)) {
    fail('VALIDATION', 'plan source_id must be a non-empty string');
  }
  if (source.schema_version !== undefined
    && (!Number.isInteger(source.schema_version) || source.schema_version < 0)) {
    fail('VALIDATION', 'plan source schema_version must be a non-negative integer');
  }
  if (source.registry !== undefined
    && (!Array.isArray(source.registry)
      || source.registry.some(d => typeof d !== 'string' || !/^[a-f0-9]{64}$/.test(d)))) {
    fail('VALIDATION', 'plan source registry must hold lowercase hex SHA-256 digests');
  }
  if (source.registry_version !== undefined
    && (!Number.isInteger(source.registry_version) || source.registry_version < 0)) {
    fail('VALIDATION', 'plan source registry_version must be a non-negative integer');
  }
}

function normalizeSelection(select: readonly string[]): string[] {
  if (!Array.isArray(select)) fail('VALIDATION', 'plan selection must be an array of record IDs');
  const seen = new Set<string>(), out: string[] = [];
  for (const id of select) {
    if (typeof id !== 'string' || !id) fail('VALIDATION', 'plan selection must hold non-empty string IDs');
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

function checkEdge(edge: RefEdge): void {
  if (!edge || typeof edge !== 'object'
    || typeof edge.id !== 'string' || !edge.id
    || typeof edge.role !== 'string' || !edge.role
    || typeof edge.kind !== 'string' || !edge.kind) {
    // No entry ID: planner diagnostics never carry record IDs.
    fail('VALIDATION', 'reference resolver returned a malformed edge (id, role, and kind must be non-empty strings)');
  }
}

/** Transitive incoming-reference closure over `selected`: every entry that
 *  directly or transitively references a selected record. Cycles terminate
 *  via the visited set; duplicate paths merge into one member with combined
 *  `via` edges (bounded). Returns members in BFS discovery order.
 *
 *  Entries the resolver cannot handle (`UNKNOWN_KIND`) are collected as
 *  `unresolved` instead of contributing edges; callers must treat a
 *  non-empty set as an incomplete closure, never as "no dependents". */
function computeClosure(
  byId: ReadonlyMap<string, Entry>,
  selected: readonly string[],
  resolve: ReferenceResolver,
  maxClosure: number,
): { members: Map<string, ClosureMember>; complete: boolean; unresolved: string[] } {
  const dependents = new Map<string, { from: Entry; role: string; kind: string }[]>();
  const unresolved = new Set<string>();
  for (const entry of byId.values()) {
    let edges: readonly RefEdge[];
    try {
      edges = resolve(entry);
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'UNKNOWN_KIND') {
        unresolved.add(entry.id);
        continue;
      }
      throw error;
    }
    for (const edge of edges) {
      checkEdge(edge);
      const slot = dependents.get(edge.id);
      const link = { from: entry, role: edge.role, kind: edge.kind };
      if (slot) slot.push(link);
      else dependents.set(edge.id, [link]);
    }
  }
  const members = new Map<string, ClosureMember>();
  if (selected.length > maxClosure) return { members, complete: false, unresolved: [...unresolved].sort() };
  const queue: string[] = [];
  for (const id of selected) {
    members.set(id, { depth: 0, via: [], viaTruncated: false });
    queue.push(id);
  }
  let complete = true;
  // BFS over dependents; `head` avoids O(n) shift on wide closures.
  for (let head = 0; head < queue.length && complete; head++) {
    const current = queue[head] as string;
    const depth = (members.get(current) as ClosureMember).depth;
    for (const link of dependents.get(current) ?? []) {
      const edge: ViaEdge = { target: current, role: link.role, kind: link.kind };
      const known = members.get(link.from.id);
      if (known) {
        if (!known.via.some(v => v.target === edge.target && v.role === edge.role)) known.via.push(edge);
        continue;
      }
      if (members.size >= maxClosure) { complete = false; break; }
      members.set(link.from.id, { depth: depth + 1, via: [edge], viaTruncated: false });
      queue.push(link.from.id);
    }
  }
  return { members, complete, unresolved: [...unresolved].sort() };
}

function sortedVia(member: ClosureMember): ViaEdge[] {
  return [...member.via].sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0);
}

// `via` edges accumulate deduplicated during the BFS (bounded by in-degree);
// truncation to maxVia happens at report time over a sorted copy, so reports
// stay deterministic regardless of discovery order. Single truncation
// semantics shared by purge survivors and redact degraded dependents.
function truncateVia(member: ClosureMember, maxVia: number): { via: ViaEdge[]; truncated: boolean } {
  const via = sortedVia(member);
  return { via: via.slice(0, maxVia), truncated: via.length > maxVia };
}
function reasonsFor(
  members: ReadonlyMap<string, ClosureMember>,
  ids: readonly string[],
  byId: ReadonlyMap<string, Entry>,
  maxVia: number,
): DependentReason[] {
  return [...ids]
    .sort()
    .map(id => {
      const member = members.get(id) as ClosureMember;
      const entry = byId.get(id);
      const { via, truncated: viaTruncated } = truncateVia(member, maxVia);
      return {
        id,
        type: entry?.type ?? 'unknown',
        depth: member.depth,
        via,
        viaTruncated,
      };
    });
}

/** Cap a detail list honestly: the shown prefix plus the exact total. */
function boundList<T>(items: readonly T[], max: number): { shown: T[]; total: number; truncated: boolean } {
  return items.length > max
    ? { shown: items.slice(0, max), total: items.length, truncated: true }
    : { shown: [...items], total: items.length, truncated: false };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function blockedDigest(requestId: string): string {
  return sha256Hex(requestId);
}

/** Receipts are an order-insensitive set keyed by `request_id`: every sort
 *  shares this comparator so digests cannot drift between call sites. */
function byRequestId(a: { readonly request_id: string }, b: { readonly request_id: string }): number {
  return a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0;
}

/** Canonical live-receipt form for digests: sorted by `request_id`, each
 *  receipt's `ids` kept in stored membership order. Single mapping shared by
 *  the source fingerprint and both expected blocks. */
function canonicalReceipts(receipts: readonly Receipt[]): { digest: string; ids: string[]; request_id: string }[] {
  return [...receipts]
    .sort(byRequestId)
    .map(r => ({ digest: r.digest, ids: [...r.ids], request_id: r.request_id }));
}

function intersectingReceipts(
  receipts: readonly Receipt[],
  removal: ReadonlySet<string>,
): { request_id: string; removed: string[]; surviving: string[] }[] {
  const out: { request_id: string; removed: string[]; surviving: string[] }[] = [];
  for (const receipt of receipts) {
    const removed = receipt.ids.filter(id => removal.has(id));
    if (!removed.length) continue;
    out.push({
      request_id: receipt.request_id,
      removed: [...removed].sort(),
      surviving: receipt.ids.filter(id => !removal.has(id)).sort(),
    });
  }
  return out.sort(byRequestId);
}

function purgeAffectedReceipts(
  receipts: readonly Receipt[],
  removal: ReadonlySet<string>,
): AffectedReceipt[] {
  return intersectingReceipts(receipts, removal).map(r => ({
    request_id: r.request_id,
    blocked_digest: blockedDigest(r.request_id),
    blocked_digest_provisional: true as const,
    removed_ids: r.removed,
    surviving_ids: r.surviving,
    disposition: 'remove-receipt' as const,
  }));
}

function redactAffectedReceipts(
  receipts: readonly Receipt[],
  removal: ReadonlySet<string>,
): RedactAffectedReceipt[] {
  return intersectingReceipts(receipts, removal).map(r => ({
    request_id: r.request_id,
    removed_ids: r.removed,
    surviving_ids: r.surviving,
    disposition: 'drop-receipt' as const,
  }));
}

/** One exact effective-state transition: a review/verification event the plan
 *  removes or tombstones, and its surviving target's state before and after.
 *  Review transitions use effective Review state vocabulary
 *  (`proposed | accepted | rejected | withdrawn`, none-live means proposed);
 *  verification transitions use anchor-warning vocabulary
 *  (`anchor_match | anchor_mismatch | anchor_multiple | anchor_unreachable |
 *  anchor_not_verified`). Tombstoned events are skipped on both sides
 *  (ADR 0008 §11); equal before/after means the plan leaves that target's
 *  observable state unchanged. */
export interface StateTransition {
  readonly target: string;
  readonly event: string;
  readonly event_type: 'review' | 'verification';
  readonly before: string;
  readonly after: string;
}

/** Redact state impact: the same exact-transition shape, kept under its
 *  original name for the redact contract. */
export type RedactStateImpact = StateTransition;

function isTombstoned(entry: Entry): boolean {
  const data = entry.data as unknown as Record<string, unknown> | null;
  return !!data && typeof data === 'object' && data['redacted'] === true;
}

function eventTarget(entry: Entry): { target: string; event_type: 'review' | 'verification' } | null {
  if (entry.type !== 'review' && entry.type !== 'verification') return null;
  const data = entry.data as unknown as Record<string, unknown>;
  if (entry.type === 'review') {
    const target = data['target_id'];
    if (typeof target !== 'string' || !target) {
      fail('VALIDATION', 'plan source holds a review with a missing target');
    }
    return { target, event_type: 'review' };
  }
  const target = data['target_evidence_id'];
  if (typeof target !== 'string' || !target) {
    fail('VALIDATION', 'plan source holds a verification with a missing target');
  }
  return { target, event_type: 'verification' };
}

const REVIEW_STATES: ReadonlySet<string> = new Set(['proposed', 'accepted', 'rejected', 'withdrawn']);
const VERIFY_OUTCOMES: ReadonlySet<string> = new Set(['match', 'mismatch', 'multiple', 'unreachable']);

/** Effective Review state over entries in array order, mirroring the ledger
 *  view (latest live review decides, none-live means proposed) while
 *  skipping `skip` plus already-tombstoned events. */
function effectiveReviewState(
  entries: readonly Entry[],
  target: string,
  skip: ReadonlySet<string>,
): string {
  let state = 'proposed';
  for (const entry of entries) {
    if (entry.type !== 'review' || skip.has(entry.id) || isTombstoned(entry)) continue;
    const data = entry.data as unknown as Record<string, unknown>;
    const link = data['target_id'];
    if (typeof link !== 'string' || !link) {
      fail('VALIDATION', 'plan source holds a review with a missing target');
    }
    if (link !== target) continue;
    const candidate = data['state'];
    if (typeof candidate !== 'string' || !REVIEW_STATES.has(candidate)) {
      fail('VALIDATION', 'plan source holds a review with an invalid state');
    }
    state = candidate;
  }
  return state;
}

/** Anchor warning over entries in array order, mirroring the ledger view
 *  (`anchor_<latest outcome>`, none-live means `anchor_not_verified`). */
function effectiveAnchor(
  entries: readonly Entry[],
  evidenceId: string,
  skip: ReadonlySet<string>,
): string {
  let outcome: string | null = null;
  for (const entry of entries) {
    if (entry.type !== 'verification' || skip.has(entry.id) || isTombstoned(entry)) continue;
    const data = entry.data as unknown as Record<string, unknown>;
    const link = data['target_evidence_id'];
    if (typeof link !== 'string' || !link) {
      fail('VALIDATION', 'plan source holds a verification with a missing target');
    }
    if (link !== evidenceId) continue;
    const candidate = data['outcome'];
    if (typeof candidate !== 'string' || !VERIFY_OUTCOMES.has(candidate)) {
      fail('VALIDATION', 'plan source holds a verification with an invalid outcome');
    }
    outcome = candidate;
  }
  return outcome === null ? 'anchor_not_verified' : `anchor_${outcome}`;
}

function planTransitions(
  entries: readonly Entry[],
  events: readonly { id: string; target: string; event_type: 'review' | 'verification' }[],
  skipAfter: ReadonlySet<string>,
): StateTransition[] {
  const live = new Set<string>();
  return events
    .map(e => ({
      target: e.target,
      event: e.id,
      event_type: e.event_type,
      before: e.event_type === 'review'
        ? effectiveReviewState(entries, e.target, live)
        : effectiveAnchor(entries, e.target, live),
      after: e.event_type === 'review'
        ? effectiveReviewState(entries, e.target, skipAfter)
        : effectiveAnchor(entries, e.target, skipAfter),
    }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1
      : a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}

/** Removed review/verification events whose target survives the purge. Events
 *  whose target is removed alongside them leave no observable transition. */
function purgeTransitionEvents(
  entries: readonly Entry[],
  removal: ReadonlySet<string>,
): { id: string; target: string; event_type: 'review' | 'verification' }[] {
  const out: { id: string; target: string; event_type: 'review' | 'verification' }[] = [];
  for (const entry of entries) {
    if (!removal.has(entry.id)) continue;
    const t = eventTarget(entry);
    if (!t || removal.has(t.target)) continue;
    out.push({ id: entry.id, target: t.target, event_type: t.event_type });
  }
  return out;
}

/** Exact post-purge expectation (ADR 0005 rule 3 shape): the pre-delete
 *  export minus the doomed scope. `live_ids_digest` is lowercase hex
 *  SHA-256 over the canonical JSON of the sorted surviving live IDs, so an
 *  executor recomputes and compares instead of trusting the list.
 *  `live_entries_digest` pins the surviving entries as full entry objects in
 *  source array order, and `live_receipts_digest` pins the surviving
 *  receipts as full objects sorted by `request_id`: ADR 0005 rule 3 needs
 *  survivors byte-identical, so a changed survivor body or receipt moves
 *  these digests while the ID digest stands still. Null when the plan is
 *  `incomplete`, the closure did not complete, or receipt detail was
 *  truncated: an unexecutable plan carries no expectation. For a refused
 *  plan with a complete closure the expectation assumes the proposed scope
 *  is confirmed. */
export interface PurgeExpected {
  readonly scope_ids: readonly string[];
  readonly removed_receipts: readonly string[];
  readonly blocked_digests: readonly string[];
  /** Always true: the expected blocked digests are provisional planner
   *  predictions, like the per-receipt marker — #23 box 4 is pending, so
   *  they are never registry state. */
  readonly blocked_digests_provisional: true;
  readonly live_count: number;
  readonly live_ids_digest: string;
  readonly live_entries_digest: string;
  readonly live_receipts_digest: string;
}

/** Exact post-redact expectation: same entry IDs with tombstoned bodies,
 *  preserved links, and dropped affected receipts. `tombstones_digest` pins
 *  the sorted (id, tombstoned-body) pairs; `live_ids_digest` pins the full
 *  surviving ID set; `live_entries_digest` pins the full post-redact
 *  entries (scope entries tombstoned in place, untouched entries
 *  byte-identical) in source array order; `live_receipts_digest` pins the
 *  surviving receipts sorted by `request_id`. A changed untouched body or
 *  receipt moves the content digests while the ID digest stands still.
 *  Null when the plan is `incomplete`, the closure did not complete,
 *  receipt detail was truncated, or a scope body is unplannable. */
export interface RedactExpected {
  readonly scope_ids: readonly string[];
  readonly tombstones_digest: string;
  readonly dropped_receipts: readonly string[];
  readonly live_count: number;
  readonly live_ids_digest: string;
  readonly live_entries_digest: string;
  readonly live_receipts_digest: string;
}

/** Opaque source binding: lowercase hex SHA-256 over the canonical JSON of
 *  `{ v: 2, source_id, schema_version, revision, registry_version,
 *  registry, entries, receipts }`. Entries are hashed in source array order
 *  (event order is significant); receipts sorted by `request_id` with each
 *  receipt's `ids` in stored membership order (capture order is
 *  significant); registry canonically sorted. The fingerprint leaks nothing
 *  but equality: it names no content. */
export function sourceFingerprint(source: PlanSource): string {
  checkSource(source);
  const receipts = canonicalReceipts(source.receipts);
  return sha256Hex(canonicalJson({
    v: 2,
    source_id: source.source_id ?? '',
    schema_version: source.schema_version ?? null,
    revision: source.revision,
    registry_version: source.registry_version ?? null,
    registry: [...(source.registry ?? [])].sort(),
    entries: [...source.entries],
    receipts,
  }));
}

function planDigest(unsigned: unknown): string {
  return sha256Hex(canonicalJson(unsigned));
}

/** True when the artifact is untampered: its `digest` equals the SHA-256
 *  (hex) over the canonical JSON of the plan minus the digest field itself.
 *  The digest binds source fingerprint, mode, selection echo plus
 *  `selection_digest` over the full selection, scope, affected receipts,
 *  tombstones, expected results, transitions, limits, resolver, and
 *  confirmation parameters — every confirmation-relevant byte. */
export function verifyPlanDigest(plan: PurgePlan | RedactPlan): boolean {
  if (!plan || typeof plan !== 'object') return false;
  if (typeof plan.digest !== 'string' || !/^[a-f0-9]{64}$/.test(plan.digest)) return false;
  const rest = { ...(plan as unknown as Record<string, unknown>) };
  delete rest['digest'];
  return planDigest(rest) === plan.digest;
}

/** True when `plan` is the approved artifact, untampered, and approvable:
 *  its digest recomputes over its own bytes AND equals `approvedDigest`,
 *  the digest retained from the actual approval, AND it is a whole `ready`
 *  plan. `verifyPlanDigest` alone cannot see substitution — a fresh
 *  self-consistent plan for a different selection verifies, reads fresh,
 *  and re-plans to itself — so the executor retains the approval digest
 *  out-of-band and compares against it, never against the artifact's own
 *  digest field. Only `ready` plans are approvable: `refused` and
 *  `incomplete` (including any `truncated` or incomplete-closure plan)
 *  never pass, even when the digest matches, so a truncated plan can never
 *  be approved as if whole. A malformed retained digest never matches:
 *  fail closed. */
export function verifyPlanApproval(plan: PurgePlan | RedactPlan, approvedDigest: string): boolean {
  if (typeof approvedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(approvedDigest)) return false;
  if (!plan || typeof plan !== 'object') return false;
  if (plan.digest !== approvedDigest) return false;
  if (plan.status !== 'ready') return false;
  if (plan.truncated !== false) return false;
  if (plan.closure_complete !== true) return false;
  return verifyPlanDigest(plan);
}

export interface PurgeOptions {
  readonly references?: ReferenceResolver;
  readonly limits?: PlanLimits;
  /** Opaque resolver identity bound into the plan digest (default
   *  `'canonical'`). An executor re-planning for comparison must use the
   *  same resolver the plan was computed with. */
  readonly resolverId?: string;
}

export interface PurgePlan {
  readonly mode: 'purge';
  readonly status: PlanStatus;
  /** Present only when refused: dependents outside the selection survive,
   *  or the selection names unknown IDs. */
  readonly refusal?: 'dependents-survive' | 'unknown-ids';
  /** Bounded echo of the normalized selection (at most `maxClosure` IDs);
   *  the true total sits in `counts.selected`. Ready plans always echo the
   *  whole selection; a cut echo halts `incomplete`. */
  readonly selection: readonly string[];
  /** Opaque binding of the FULL normalized selection (deduped, input
   *  order): lowercase hex SHA-256 over the canonical JSON of the complete
   *  array, including the omitted tail when `selection` is cut. Two plans
   *  whose echoes coincide but whose full selections differ carry different
   *  digests, so a truncated plan cannot be substituted for another. */
  readonly selection_digest: string;
  readonly unknown_ids: readonly string[];
  readonly unknown_ids_total: number;
  /** Source entries the resolver could not handle: the closure may miss
   *  their dependents, so a non-empty set always halts as `incomplete`. */
  readonly unresolved_ids: readonly string[];
  readonly unresolved_ids_total: number;
  /** Effective removal set. Populated only when ready; never expanded
   *  silently — a refused plan proposes but does not adopt. */
  readonly scope: readonly string[];
  /** Full transitive closure the confirmed scope must cover. Empty when the
   *  closure did not complete. */
  readonly proposed_scope: readonly string[];
  readonly survivors: readonly DependentReason[];
  readonly survivors_total: number;
  readonly affected_receipts: readonly AffectedReceipt[];
  readonly affected_receipts_total: number;
  readonly state_transitions: readonly StateTransition[];
  readonly state_transitions_total: number;
  readonly expected: PurgeExpected | null;
  readonly counts: {
    readonly selected: number;
    readonly closure: number;
    readonly survivors: number;
    readonly removed_receipts: number;
    readonly surviving_records_in_removed_receipts: number;
    readonly state_transitions: number;
  };
  /** Source logical revision the plan was computed against. Revision alone
   *  never proves freshness — see `source_fingerprint` and
   *  {@link isPlanStale}. */
  readonly revision: number;
  readonly source_fingerprint: string;
  readonly digest: string;
  readonly resolver_id: string;
  readonly limits: ResolvedLimits;
  /** True when any detail array was cut to its bound, the source lacks
   *  the identity/schema binding a `ready` plan requires, or the registry
   *  carries an unsupported version (or a nonempty registry under a
   *  missing version). An incomplete plan must never be approved as if
   *  whole. */
  readonly truncated: boolean;
  readonly closure_complete: boolean;
}

/** Shared plan prologue: source validation, limits, resolver, selection
 *  normalization, and the selection echo/digest binding. Purge and redact
 *  run identical prologues — redact validates its `reason`/`redactedAt`
 *  first, before calling this — so validation-error order is identical in
 *  both modes. */
function planPrologue(
  source: PlanSource,
  select: readonly string[],
  options?: { readonly references?: ReferenceResolver; readonly limits?: PlanLimits; readonly resolverId?: string },
) {
  checkSource(source);
  const limits = resolveLimits(options?.limits);
  const resolve = options?.references ?? canonicalReferences;
  const resolverId = options?.resolverId ?? 'canonical';
  if (typeof resolverId !== 'string' || !resolverId) fail('VALIDATION', 'plan resolverId must be a non-empty string');
  const selection = normalizeSelection(select);
  const byId = new Map<string, Entry>();
  for (const entry of source.entries) byId.set(entry.id, entry);
  const unknownIds = boundList(selection.filter(id => !byId.has(id)).sort(), limits.maxReasons);
  const known = selection.filter(id => byId.has(id));
  // The full normalized selection drives the computation, but the plan
  // echoes at most maxClosure IDs (the closure seed it feeds) with the true
  // total in counts.selected and the full array bound opaquely in
  // selection_digest. Ready plans always echo the whole selection: a cut
  // echo halts incomplete, never approved as if whole.
  const selectionEcho = boundList(selection, limits.maxClosure);
  const selectionDigest = sha256Hex(canonicalJson(selection));
  return { limits, resolve, resolverId, selection, byId, unknownIds, known, selectionEcho, selectionDigest };
}

/** Ready requires a bound, readable source: without source identity and
 *  schema the plan cannot prove what it was computed against, and an
 *  unsupported registry version — or a nonempty registry under a missing
 *  version — carries a digest encoding the planner cannot know (ADR 0008)
 *  — so it halts incomplete with no expectation. An explicit unsupported
 *  version refuses even with an empty registry; only the absent legacy
 *  extension plans as today. Refusals keep their refusal: they are
 *  already unexecutable forecasts, not approvals. Shared so the fail-closed
 *  rule cannot drift between modes. */
function gateReady(
  status: PlanStatus,
  truncated: boolean,
  source: PlanSource,
): { status: PlanStatus; truncated: boolean } {
  const sourceBound = source.source_id !== undefined && source.schema_version !== undefined;
  if (status === 'ready' && (!sourceBound || !registryReadable(source))) {
    return { status: 'incomplete', truncated: true };
  }
  return { status, truncated };
}

/** Plan a purge: refuse when dependents survive, else name the exact removal
 *  set, affected receipts, and blocked digests. Never mutates the source. */
export function planPurge(source: PlanSource, select: readonly string[], options?: PurgeOptions): PurgePlan {
  const { limits, resolve, resolverId, byId, unknownIds, known, selectionEcho, selectionDigest } =
    planPrologue(source, select, options);

  const { members, complete, unresolved: unresolvedAll } = computeClosure(byId, known, resolve, limits.maxClosure);
  const unresolvedIds = boundList(unresolvedAll, limits.maxReasons);
  const closed = complete && unresolvedAll.length === 0;
  const closureIds = closed ? [...members.keys()].sort() : [];
  const knownSet = new Set(known);
  const survivorIds = closureIds.filter(id => !knownSet.has(id));
  const survivors = boundList(closed ? reasonsFor(members, survivorIds, byId, limits.maxVia) : [], limits.maxReasons);

  const removal = new Set(closureIds);
  const fullReceipts = closed ? purgeAffectedReceipts(source.receipts, removal) : [];
  const receipts = boundList(fullReceipts, limits.maxReceipts);
  // Totals stay exact under truncation: the count is computed over the full
  // list even when the shown detail is cut. Never report 0 for unshown rows.
  const survivingTotal = fullReceipts.reduce((n, r) => n + r.surviving_ids.length, 0);

  const transitions = boundList(
    closed ? planTransitions(source.entries, purgeTransitionEvents(source.entries, removal), removal) : [],
    limits.maxReasons);

  const viaTruncated = survivors.shown.some(s => s.viaTruncated);
  // Any cut detail — closure, reasons, receipts, transitions, ID lists, or
  // per-dependent paths — makes the plan incomplete: it must never be
  // approved as if whole.
  let truncated = !closed || survivors.truncated || receipts.truncated || transitions.truncated
    || unknownIds.truncated || unresolvedIds.truncated || viaTruncated || selectionEcho.truncated;
  let status: PlanStatus;
  let refusal: PurgePlan['refusal'];
  if (truncated) {
    status = 'incomplete';
  } else if (unknownIds.total) {
    status = 'refused';
    refusal = 'unknown-ids';
  } else if (survivorIds.length) {
    status = 'refused';
    refusal = 'dependents-survive';
  } else {
    status = 'ready';
  }
  ({ status, truncated } = gateReady(status, truncated, source));
  const liveIds = [...byId.keys()].filter(id => !removal.has(id)).sort();
  const liveEntries = source.entries.filter(e => !removal.has(e.id));
  const removedRequests = new Set(fullReceipts.map(r => r.request_id));
  const liveReceipts = canonicalReceipts(source.receipts.filter(r => !removedRequests.has(r.request_id)));
  const expected: PurgeExpected | null = closed && !receipts.truncated && status !== 'incomplete'
    ? {
      scope_ids: closureIds,
      removed_receipts: fullReceipts.map(r => r.request_id),
      blocked_digests: fullReceipts.map(r => r.blocked_digest).sort(),
      blocked_digests_provisional: true as const,
      live_count: liveIds.length,
      live_ids_digest: sha256Hex(canonicalJson(liveIds)),
      live_entries_digest: sha256Hex(canonicalJson(liveEntries)),
      live_receipts_digest: sha256Hex(canonicalJson(liveReceipts)),
    }
    : null;
  const unsigned: Omit<PurgePlan, 'digest'> = {
    mode: 'purge',
    status,
    ...(refusal === undefined ? {} : { refusal }),
    selection: selectionEcho.shown,
    selection_digest: selectionDigest,
    unknown_ids: unknownIds.shown,
    unknown_ids_total: unknownIds.total,
    unresolved_ids: unresolvedIds.shown,
    unresolved_ids_total: unresolvedIds.total,
    scope: status === 'ready' ? closureIds : [],
    proposed_scope: closed ? closureIds : [],
    survivors: survivors.shown,
    survivors_total: survivors.total,
    affected_receipts: receipts.shown,
    affected_receipts_total: receipts.total,
    state_transitions: transitions.shown,
    state_transitions_total: transitions.total,
    expected,
    counts: {
      selected: selectionEcho.total,
      closure: closed ? closureIds.length : members.size,
      survivors: survivorIds.length,
      removed_receipts: fullReceipts.length,
      surviving_records_in_removed_receipts: survivingTotal,
      state_transitions: transitions.total,
    },
    revision: source.revision,
    source_fingerprint: sourceFingerprint(source),
    resolver_id: resolverId,
    limits,
    truncated,
    closure_complete: closed,
  };
  return { ...unsigned, digest: planDigest(unsigned) };
}

export type RedactReason = 'sensitive' | 'wrong-scope';

/** Reference closure is not content discovery: a redact plan removes the
 *  bodies in scope only. It never claims deletion of duplicated secret text
 *  that may survive in other bodies. */
export const REDACT_SCOPE_NOTE =
  'Reference closure is not content discovery: only the bodies in scope are redacted; ' +
  'duplicated text elsewhere is not found or removed by this plan.';

/** Every reference field a tombstone MUST retain, by record type. Keys
 *  mirror `references()` in model.ts; the conformance test cross-checks this
 *  list against that function so the two can never drift. Content matches
 *  the fork inventory today but the owners differ (tombstone retention vs
 *  fork rewrite), so both tables stay. */
export const TOMBSTONE_REF_KEYS: Readonly<Record<Kind, readonly string[]>> = {
  source: [],
  claim: [],
  evidence: ['source_id'],
  assessment: ['claim_id', 'evidence_id'],
  relation: ['from_claim_id', 'to_claim_id'],
  review: ['target_id'],
  verification: ['target_evidence_id', 'target_source_id'],
};

export interface TombstonePreview {
  readonly id: string;
  readonly type: string;
  /** Tombstoned body per ADR 0008 box 2: `redacted`, retained reference
   *  targets, `reason`, `redacted_at`. Carries no removed content. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Reference edges of the live body, preserved exactly by the tombstone. */
  readonly references: readonly RefEdge[];
}

export interface DegradedDependent {
  readonly id: string;
  readonly type: string;
  readonly via: readonly ViaEdge[];
  readonly via_truncated: boolean;
  /** Fixed vocabulary: grounds lose their usable basis, targets lose
   *  readable content, anchors lose verifiable bytes. */
  readonly impact: 'grounds-degraded' | 'endpoint-degraded' | 'target-degraded' | 'source-content-removed';
}

export interface RedactOptions {
  readonly references?: ReferenceResolver;
  readonly limits?: PlanLimits;
  readonly resolverId?: string;
  /** Required: the `redacted_at` stamp for computed tombstones. The planner
   *  has no clock; the caller supplies the act time explicitly. */
  readonly redactedAt: string;
  readonly reason: RedactReason;
}

export interface RedactPlan {
  readonly mode: 'redact';
  readonly status: PlanStatus;
  readonly refusal?: 'unknown-ids' | 'verification-cascade' | 'already-tombstoned' | 'unsupported-kind';
  /** Bounded echo of the normalized selection (at most `maxClosure` IDs);
   *  the true total sits in `counts.selected`. Ready plans always echo the
   *  whole selection; a cut echo halts `incomplete`. */
  readonly selection: readonly string[];
  /** Opaque binding of the FULL normalized selection (deduped, input
   *  order): lowercase hex SHA-256 over the canonical JSON of the complete
   *  array, including the omitted tail when `selection` is cut. Two plans
   *  whose echoes coincide but whose full selections differ carry different
   *  digests, so a truncated plan cannot be substituted for another. */
  readonly selection_digest: string;
  readonly unknown_ids: readonly string[];
  readonly unknown_ids_total: number;
  readonly unresolved_ids: readonly string[];
  readonly unresolved_ids_total: number;
  /** Effective redaction set. Populated only when ready. */
  readonly scope: readonly string[];
  readonly tombstones: readonly TombstonePreview[];
  readonly tombstones_total: number;
  /** Live verifications targeting a selected evidence that the selection
   *  omits (ADR 0008 cascade). Empty unless refused for the cascade. */
  readonly cascade_required: readonly string[];
  readonly cascade_required_total: number;
  readonly already_tombstoned: readonly string[];
  readonly already_tombstoned_total: number;
  readonly unsupported_kinds: readonly string[];
  readonly unsupported_kinds_total: number;
  readonly degraded: readonly DegradedDependent[];
  readonly degraded_total: number;
  readonly state_impact: readonly RedactStateImpact[];
  readonly state_impact_total: number;
  /** Receipts referencing redacted records, dropped with survivors live.
   *  Computed over the confirmable scope (selection plus required cascade). */
  readonly affected_receipts: readonly RedactAffectedReceipt[];
  readonly affected_receipts_total: number;
  readonly expected: RedactExpected | null;
  readonly scope_note: string;
  readonly reason: RedactReason;
  readonly redacted_at: string;
  readonly counts: {
    readonly selected: number;
    readonly tombstones: number;
    readonly degraded: number;
    readonly state_impacts: number;
    readonly removed_receipts: number;
    readonly surviving_records_in_removed_receipts: number;
  };
  readonly revision: number;
  readonly source_fingerprint: string;
  readonly digest: string;
  readonly resolver_id: string;
  readonly limits: ResolvedLimits;
  /** True when any detail array was cut to its bound, the source lacks
   *  the identity/schema binding a `ready` plan requires, or the registry
   *  carries an unsupported version (or a nonempty registry under a
   *  missing version). An incomplete plan must never be approved as if
   *  whole. */
  readonly truncated: boolean;
  readonly closure_complete: boolean;
}

function checkRedactedAt(value: string): void {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    fail('VALIDATION', 'redactedAt must be a UTC timestamp like created_at');
  }
  if (!isValidTimestamp(value)) fail('VALIDATION', 'redactedAt must be a valid UTC timestamp');
}

function tombstoneBody(entry: Entry, reason: RedactReason, redactedAt: string): Record<string, unknown> | null {
  const keys = TOMBSTONE_REF_KEYS[entry.type];
  if (!keys) return null;
  const data = entry.data as unknown as Record<string, unknown>;
  const body: Record<string, unknown> = { redacted: true, reason, redacted_at: redactedAt };
  for (const key of keys) {
    const value = data[key];
    if (typeof value !== 'string' || !value) return null;
    body[key] = value;
  }
  return body;
}

function degradeImpact(dependentType: string, role: string): DegradedDependent['impact'] {
  if (dependentType === 'assessment') return 'grounds-degraded';
  if (dependentType === 'relation') return 'endpoint-degraded';
  if (dependentType === 'review') return 'target-degraded';
  if (role === 'source') return 'source-content-removed';
  return 'grounds-degraded';
}

/** Plan a redact: compute tombstoned bodies preserving IDs and the exact
 *  reference set, enforce the verification cascade (ADR 0008), drop receipts
 *  referencing redacted records, and report unaffected dependents whose
 *  usable grounds degrade. Never mutates. */
export function planRedact(source: PlanSource, select: readonly string[], options: RedactOptions): RedactPlan {
  if (options.reason !== 'sensitive' && options.reason !== 'wrong-scope') {
    fail('VALIDATION', 'redact reason must be sensitive or wrong-scope (never free text)');
  }
  checkRedactedAt(options.redactedAt);
  const { limits, resolve, resolverId, byId, unknownIds, known, selectionEcho, selectionDigest } =
    planPrologue(source, select, options);

  const alreadyAll = known.filter(id => isTombstoned(byId.get(id) as Entry)).sort();
  const already = boundList(alreadyAll, limits.maxReasons);
  const alreadySet = new Set(alreadyAll);
  const liveSelected = known.filter(id => !alreadySet.has(id));

  // ADR 0008 cascade: every live verification targeting a selected evidence
  // joins the scope, or the scope is refused.
  const selectedSet = new Set(known);
  const cascadeAll: string[] = [];
  for (const entry of byId.values()) {
    if (entry.type !== 'verification') continue;
    if (isTombstoned(entry)) continue;
    const target = entry.data.target_evidence_id as unknown;
    if (typeof target === 'string' && selectedSet.has(target) && !selectedSet.has(entry.id)) {
      cascadeAll.push(entry.id);
    }
  }
  cascadeAll.sort();
  const cascade = boundList(cascadeAll, limits.maxReasons);

  const { members, complete, unresolved: unresolvedAll } = computeClosure(byId, known, resolve, limits.maxClosure);

  const unsupportedAll: string[] = [];
  const tombstones: TombstonePreview[] = [];
  const unresolvedExtra = new Set<string>();
  for (const id of [...liveSelected].sort()) {
    const entry = byId.get(id) as Entry;
    const body = tombstoneBody(entry, options.reason, options.redactedAt);
    if (!body) { unsupportedAll.push(id); continue; }
    let refs: readonly RefEdge[];
    try {
      refs = resolve(entry);
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'UNKNOWN_KIND') {
        unresolvedExtra.add(id);
        continue;
      }
      throw error;
    }
    for (const edge of refs) checkEdge(edge);
    tombstones.push({ id, type: entry.type, body, references: [...refs] });
  }
  const unsupported = boundList(unsupportedAll, limits.maxReasons);
  const unresolvedIds = boundList([...new Set([...unresolvedAll, ...unresolvedExtra])].sort(), limits.maxReasons);
  const closed = complete && unresolvedIds.total === 0;

  // Degradation: transitive dependents outside the confirmable scope keep
  // resolving but lose usable grounds; redacted events stop counting toward
  // their targets. Cascade verifications join the scope, so they degrade
  // nothing — they are redacted instead.
  const confirmable = new Set([...known, ...cascadeAll]);
  const degradedIds = closed ? [...members.keys()].filter(id => !confirmable.has(id)) : [];
  const degradedFull: DegradedDependent[] = closed
    ? degradedIds
      .sort()
      .map(id => {
        const entry = byId.get(id) as Entry;
        const member = members.get(id) as ClosureMember;
        const { via, truncated: viaTruncated } = truncateVia(member, limits.maxVia);
        const first = via[0] as ViaEdge | undefined;
        return {
          id,
          type: entry.type,
          via,
          via_truncated: viaTruncated,
          impact: degradeImpact(entry.type, first?.role ?? ''),
        };
      })
    : [];
  const degraded = boundList(degradedFull, limits.maxReasons);

  const scopeToBe = [...new Set([...liveSelected, ...cascadeAll])].sort();
  const scopeToBeSet = new Set(scopeToBe);
  const transitionEvents: { id: string; target: string; event_type: 'review' | 'verification' }[] = [];
  for (const id of scopeToBe) {
    const t = eventTarget(byId.get(id) as Entry);
    if (t) transitionEvents.push({ id, target: t.target, event_type: t.event_type });
  }
  const stateImpact = boundList(planTransitions(source.entries, transitionEvents, scopeToBeSet), limits.maxReasons);

  const fullReceipts = redactAffectedReceipts(source.receipts, scopeToBeSet);
  const receipts = boundList(fullReceipts, limits.maxReceipts);
  const survivingTotal = fullReceipts.reduce((n, r) => n + r.surviving_ids.length, 0);

  const viaTruncated = degraded.shown.some(d => d.via_truncated);
  let truncated = !closed || degraded.truncated || viaTruncated || receipts.truncated
    || unknownIds.truncated || unresolvedIds.truncated || cascade.truncated
    || already.truncated || unsupported.truncated || stateImpact.truncated || selectionEcho.truncated;
  let status: PlanStatus;
  let refusal: RedactPlan['refusal'];
  if (truncated) {
    status = 'incomplete';
  } else if (unknownIds.total) {
    status = 'refused';
    refusal = 'unknown-ids';
  } else if (already.total) {
    status = 'refused';
    refusal = 'already-tombstoned';
  } else if (cascade.total) {
    status = 'refused';
    refusal = 'verification-cascade';
  } else if (unsupported.total) {
    status = 'refused';
    refusal = 'unsupported-kind';
  } else {
    status = 'ready';
  }
  ({ status, truncated } = gateReady(status, truncated, source));

  // An incomplete plan carries no expectation: no usable forecast leaves a
  // plan that must never be approved as if whole.
  let expected: RedactExpected | null = null;
  if (closed && !receipts.truncated && status !== 'incomplete') {
    const bodies: [string, Record<string, unknown>][] = [];
    const bodyById = new Map<string, Record<string, unknown>>();
    let plannable = true;
    for (const id of scopeToBe) {
      const body = tombstoneBody(byId.get(id) as Entry, options.reason, options.redactedAt);
      if (!body) { plannable = false; break; }
      bodies.push([id, body]);
      bodyById.set(id, body);
    }
    if (plannable) {
      const liveIds = [...byId.keys()].sort();
      const postEntries = source.entries.map(e => {
        const tomb = bodyById.get(e.id);
        return tomb ? { ...e, data: tomb } : e;
      });
      const dropped = new Set(fullReceipts.map(r => r.request_id));
      const liveReceipts = canonicalReceipts(source.receipts.filter(r => !dropped.has(r.request_id)));
      expected = {
        scope_ids: scopeToBe,
        tombstones_digest: sha256Hex(canonicalJson(bodies)),
        dropped_receipts: fullReceipts.map(r => r.request_id),
        live_count: liveIds.length,
        live_ids_digest: sha256Hex(canonicalJson(liveIds)),
        live_entries_digest: sha256Hex(canonicalJson(postEntries)),
        live_receipts_digest: sha256Hex(canonicalJson(liveReceipts)),
      };
    }
  }
  const unsigned: Omit<RedactPlan, 'digest'> = {
    mode: 'redact',
    status,
    ...(refusal === undefined ? {} : { refusal }),
    selection: selectionEcho.shown,
    selection_digest: selectionDigest,
    unknown_ids: unknownIds.shown,
    unknown_ids_total: unknownIds.total,
    unresolved_ids: unresolvedIds.shown,
    unresolved_ids_total: unresolvedIds.total,
    scope: status === 'ready' ? [...liveSelected].sort() : [],
    tombstones: status === 'ready' ? tombstones : [],
    tombstones_total: tombstones.length,
    cascade_required: cascade.shown,
    cascade_required_total: cascade.total,
    already_tombstoned: already.shown,
    already_tombstoned_total: already.total,
    unsupported_kinds: unsupported.shown,
    unsupported_kinds_total: unsupported.total,
    degraded: degraded.shown,
    degraded_total: degraded.total,
    state_impact: stateImpact.shown,
    state_impact_total: stateImpact.total,
    affected_receipts: receipts.shown,
    affected_receipts_total: receipts.total,
    expected,
    scope_note: REDACT_SCOPE_NOTE,
    reason: options.reason,
    redacted_at: options.redactedAt,
    counts: {
      selected: selectionEcho.total,
      tombstones: tombstones.length,
      degraded: degraded.total,
      state_impacts: stateImpact.total,
      removed_receipts: fullReceipts.length,
      surviving_records_in_removed_receipts: survivingTotal,
    },
    revision: source.revision,
    source_fingerprint: sourceFingerprint(source),
    resolver_id: resolverId,
    limits,
    truncated,
    closure_complete: closed,
  };
  return { ...unsigned, digest: planDigest(unsigned) };
}

/** True when the source moved past the plan: a different revision, or — for
 *  plans carrying a `source_fingerprint` — any change in source identity,
 *  schema, registry version, registry, entries, or receipts, even at the
 *  same revision. A bare revision number compares revisions only, for
 *  callers without the source at hand. */
export function isPlanStale(
  plan: { readonly revision: number; readonly source_fingerprint?: string },
  current: PlanSource | number,
): boolean {
  const revision = typeof current === 'number' ? current : current.revision;
  if (revision !== plan.revision) return true;
  if (typeof current === 'number' || plan.source_fingerprint === undefined) return false;
  return sourceFingerprint(current) !== plan.source_fingerprint;
}
