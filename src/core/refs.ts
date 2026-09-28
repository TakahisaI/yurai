import { canonicalJson, fail } from './model.js';
import type { EvidenceField } from './model.js';

/** Resolved paging window the refs response was built from. */
export interface RefsWindow { offset: number; limit: number; path_offset: number; path_limit: number; }

/** One lexical match path as ID references into `included`. */
export interface RefsViaPath {
  evidence_ref: string;
  assessment_ref: string;
  source_ref: string;
  match_fields: EvidenceField[];
}

/**
 * A RecordView as built by Ledger: the immutable entry plus current
 * state/review/warnings (and the verification summary on Evidence views).
 * Fields pass through untouched; refs-v1 never reduces them.
 */
export interface RefsView {
  entry: { id: string; type: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface RefsInlinePath {
  evidence: RefsView;
  assessment: RefsView;
  source: RefsView;
  match_fields: EvidenceField[];
}

/** Inline expanded item: the Claim view stays inline, only `via` is referenced. */
export interface RefsInlineItem {
  via: RefsInlinePath[];
  [key: string]: unknown;
}

export interface RefsInlineResponse {
  items: RefsInlineItem[];
  next_offset: number | null;
  query: string;
  match: string;
  revision: number;
  truth_evaluated: boolean;
}

export interface RefsResponseItem {
  [key: string]: unknown;
  via: RefsViaPath[];
}

export interface ExpandedRefsResponse {
  format: 'yurai.expanded.refs';
  version: 1;
  query: string;
  match: 'expanded_evidence_routed';
  revision: number;
  truth_evaluated: false;
  window: RefsWindow;
  items: RefsResponseItem[];
  next_offset: number | null;
  included: Record<string, RefsView>;
  included_complete: true;
}

/**
 * Pure projection from an already-built inline expanded response to refs-v1.
 * No store access: the caller passes the response and its resolved window,
 * and every referenced view comes from that response alone.
 *
 * Invariant: included keys == the union of all *_ref in the returned via.
 * A missing view, a wrong record type, or two different views under one ID
 * is an integrity error, never a silent overwrite or drop.
 */
export function toExpandedRefsV1(inline: RefsInlineResponse, window: RefsWindow): ExpandedRefsResponse {
  if (inline.match !== 'expanded_evidence_routed') fail('IO_OR_RUNTIME', 'refs-v1 projection needs an expanded search response');
  if (inline.truth_evaluated !== false) fail('IO_OR_RUNTIME', 'refs-v1 projection needs an unevaluated expanded response');
  if (!Array.isArray(inline.items)) fail('IO_OR_RUNTIME', 'refs-v1 projection needs response items');
  const included = new Map<string, RefsView>();
  const intern = (view: unknown, expectedType: string): string => {
    const entry = (view as { entry?: unknown } | null)?.entry as { id?: unknown; type?: unknown } | undefined;
    if (typeof entry?.id !== 'string' || typeof entry?.type !== 'string')
      fail('IO_OR_RUNTIME', 'refs-v1 projection: path view lacks an entry id/type');
    if (entry.type !== expectedType)
      fail('IO_OR_RUNTIME', `refs-v1 projection: expected ${expectedType} view, found ${entry.type} (${entry.id})`);
    const prior = included.get(entry.id);
    if (prior === undefined) included.set(entry.id, view as RefsView);
    // Order-insensitive comparison: JSON shape keeps the null-vs-absent
    // distinction; sorting only neutralizes key order.
    else if (canonicalJson(prior) !== canonicalJson(view))
      fail('IO_OR_RUNTIME', `refs-v1 projection: conflicting views for ${entry.id}`);
    return entry.id;
  };
  const items: RefsResponseItem[] = inline.items.map(item => {
    if (!Array.isArray(item?.via)) fail('IO_OR_RUNTIME', 'refs-v1 projection: expanded item lacks via paths');
    const { via, ...claim } = item;
    return {
      ...claim,
      via: via.map(path => {
        if (!Array.isArray(path?.match_fields)) fail('IO_OR_RUNTIME', 'refs-v1 projection: path lacks match_fields');
        return {
          evidence_ref: intern(path.evidence, 'evidence'),
          assessment_ref: intern(path.assessment, 'assessment'),
          source_ref: intern(path.source, 'source'),
          match_fields: path.match_fields,
        };
      }),
    };
  });
  // fromEntries defines own properties even for __proto__-like IDs, unlike assignment.
  return {
    format: 'yurai.expanded.refs',
    version: 1,
    query: inline.query,
    match: 'expanded_evidence_routed',
    revision: inline.revision,
    truth_evaluated: false,
    window: { ...window },
    items,
    next_offset: inline.next_offset,
    included: Object.fromEntries(included),
    included_complete: true,
  };
}
