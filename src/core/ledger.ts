import { createHash } from 'node:crypto';
import { fail, matchedEvidenceFields, normalize, pageBounds, parseBundle, parseSnapshot, references } from './model.js';
import type { Entry, EvidenceField, Input, Snapshot, State } from './model.js';
import type { Store } from './ports.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export class Ledger {
  constructor(private readonly store: Store, private readonly now = () => new Date().toISOString()) {}
  private required(id: string): Entry { return this.store.get(id) ?? fail('NOT_FOUND', `No record: ${id}`); }
  private checkReferences(inputs: Input[]): void {
    const byId = new Map<string, Input>();
    for (const input of inputs) {
      if (byId.has(input.id)) fail('CONFLICT', `Duplicate ID in input: ${input.id}`);
      if (this.store.get(input.id)) fail('CONFLICT', `Immutable ID already exists: ${input.id}`);
      byId.set(input.id, input);
    }
    for (const input of inputs) for (const ref of references(input)) {
      const target = byId.get(ref.id) ?? this.store.get(ref.id);
      if (!target) fail('NOT_FOUND', `${input.id}: missing ${ref.role} ${ref.id}`);
      if (ref.kind === 'reviewable' ? target.type === 'review' : target.type !== ref.kind)
        fail('VALIDATION', `${input.id}: ${ref.role} has wrong record type`);
    }
    // Supersession is historical replacement, not a general reasoning edge.
    const replacements = [...this.store.entries(), ...inputs].filter(e => e.type === 'relation' && e.data.relation === 'supersedes');
    const next = new Map<string, string[]>();
    for (const e of replacements) if (e.type === 'relation')
      next.set(e.data.from_claim_id, [...(next.get(e.data.from_claim_id) ?? []), e.data.to_claim_id]);
    for (const start of next.keys()) {
      const stack = [...(next.get(start) ?? [])], visited = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (id === start) fail('VALIDATION', 'supersedes must not form a cycle');
        if (visited.has(id)) continue;
        visited.add(id); stack.push(...(next.get(id) ?? []));
      }
    }
  }
  capture(value: unknown, dryRun = false) {
    const bundle = parseBundle(value), fingerprint = digest(bundle);
    return this.store.transaction(() => {
      const receipt = this.store.receipt(bundle.request_id);
      if (receipt) {
        if (receipt.digest !== fingerprint) fail('CONFLICT', 'request_id was already used with different content');
        return { ...receipt, replayed: true, dry_run: dryRun };
      }
      this.checkReferences(bundle.entries);
      const result = { request_id: bundle.request_id, digest: fingerprint, ids: bundle.entries.map(e => e.id) };
      if (!dryRun) {
        const created_at = this.now();
        for (const input of bundle.entries) this.store.insert({ ...input, created_at, actor: bundle.actor });
        this.store.insertReceipt(result);
      }
      return { ...result, replayed: false, dry_run: dryRun };
    });
  }
  private view(entry: Entry) {
    const review = this.store.latestReview(entry.id);
    const state: State = review?.type === 'review' ? review.data.state : 'proposed';
    const warnings: string[] = [];
    if (entry.type !== 'review' && state === 'proposed') warnings.push('not_reviewed');
    if (state === 'rejected' || state === 'withdrawn') warnings.push('inactive_record');
    if (entry.type === 'evidence') warnings.push('anchor_not_verified');
    if (entry.type === 'source') {
      if (!entry.data.version && !entry.data.content_sha256) warnings.push('source_version_not_pinned');
      if (!entry.data.snapshot_uri) warnings.push('no_snapshot_reference');
      if (entry.data.medium === 'conversation') warnings.push('conversation_is_not_independent_corroboration');
    }
    if (entry.type === 'claim' && entry.data.attributed_to === 'unknown') warnings.push('unknown_attribution');
    return { entry, state, review: review ?? null, warnings };
  }
  search(query: string, options: { kind?: 'claim' | 'source'; limit?: number; offset?: number; includeInactive?: boolean; expand?: 'evidence' } = {}) {
    const { kind = 'claim', limit = 20, offset = 0, includeInactive = false, expand } = options;
    pageBounds(limit, offset);
    if (kind !== 'claim' && kind !== 'source') fail('VALIDATION', 'search kind must be claim or source');
    if (expand !== undefined && expand !== 'evidence') fail('VALIDATION', 'expand must be evidence');
    if (expand && kind !== 'claim') fail('VALIDATION', 'expanded discovery routes to claims only');
    if (typeof query !== 'string' || query.length > 500 || query.includes('\u0000')) fail('VALIDATION', 'invalid query');
    const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length || tokens.length > 16) fail('VALIDATION', 'query needs 1..16 literal terms');
    return this.store.transaction(() => {
      if (expand) return this.expanded(tokens, includeInactive, limit, offset, query);
      const rows = this.store.search(kind, tokens, includeInactive, limit + 1, offset);
      return { items: rows.slice(0, limit).map(e => this.view(e)), next_offset: rows.length > limit ? offset + limit : null,
        query, match: 'literal_terms_and', truth_evaluated: false };
    });
  }
  private expanded(tokens: string[], includeInactive: boolean, limit: number, offset: number, query: string) {
    // Exhaust small result sets, then page the union once: paging the evidence
    // scan or the direct matches first would silently drop routed claims.
    const direct: Entry[] = [];
    for (let off = 0; ; off += 100) {
      const page = this.store.search('claim', tokens, includeInactive, 101, off);
      direct.push(...page.slice(0, 100));
      if (page.length <= 100) break;
    }
    type Path = { evidence: Entry; assessment: Entry; source: Entry; match_fields: EvidenceField[] };
    const routed = new Map<string, { claim: Entry; paths: Path[] }>();
    for (const evidence of this.store.entries()) {
      if (evidence.type !== 'evidence') continue;
      const match_fields = matchedEvidenceFields(evidence.data, tokens);
      if (!match_fields.length) continue;
      for (let off = 0; ; off += 100) {
        const page = this.store.incoming(evidence.id, 101, off);
        for (const assessment of page.slice(0, 100)) {
          if (assessment.type !== 'assessment') continue;
          const claim = this.required(assessment.data.claim_id);
          const slot = routed.get(claim.id) ?? { claim, paths: [] as Path[] };
          slot.paths.push({ evidence, assessment, source: this.required(evidence.data.source_id), match_fields });
          routed.set(claim.id, slot);
        }
        if (page.length <= 100) break;
      }
    }
    const live = (entry: Entry) => { const s = this.view(entry).state; return s !== 'rejected' && s !== 'withdrawn'; };
    const merged = new Map<string, { claim: Entry; direct: boolean; paths: Path[] }>();
    for (const claim of direct) merged.set(claim.id, { claim, direct: true, paths: [] });
    for (const { claim, paths } of routed.values()) {
      const slot = merged.get(claim.id) ?? { claim, direct: false, paths: [] as Path[] };
      slot.paths.push(...paths);
      merged.set(claim.id, slot);
    }
    const byRecency = (a: Entry, b: Entry) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
    const items = [...merged.values()]
      .filter(({ claim }) => includeInactive || live(claim))
      .map(({ claim, direct, paths }) => {
        const kept = (includeInactive ? paths : paths.filter(p => live(p.evidence) && live(p.assessment) && live(p.source)))
          .sort((a, b) => byRecency(a.assessment, b.assessment) || a.evidence.id.localeCompare(b.evidence.id));
        return { ...this.view(claim), direct_match: direct,
          via: kept.slice(0, limit).map(p => ({ evidence: this.view(p.evidence), assessment: this.view(p.assessment),
            source: this.view(p.source), match_fields: p.match_fields })),
          total_paths: kept.length, paths_truncated: kept.length > limit };
      })
      .filter(item => includeInactive || item.direct_match || item.total_paths > 0)
      .sort((a, b) => byRecency(a.entry, b.entry));
    const page = items.slice(offset, offset + limit + 1);
    return { items: page.slice(0, limit), next_offset: page.length > limit ? offset + limit : null,
      query, match: 'expanded_evidence_routed', truth_evaluated: false };
  }
  private resolve(entry: Entry) {
    const refs = references(entry).map(r => this.required(r.id));
    const sourceIds = new Set(refs.filter(r => r.type === 'evidence').map(r => r.data.source_id));
    return { ...this.view(entry), references: refs.map(r => this.view(r)),
      sources: [...sourceIds].map(s => this.view(this.required(s))) };
  }
  inspectCapture(requestId: string, limit = 20, offset = 0) {
    pageBounds(limit, offset);
    if (typeof requestId !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{1,127}$/.test(requestId))
      fail('VALIDATION', 'invalid request_id');
    return this.store.transaction(() => {
      const receipt = this.store.receipt(requestId) ?? fail('NOT_FOUND', `No capture: ${requestId}`);
      const ids = receipt.ids.slice(offset, offset + limit);
      return { request_id: receipt.request_id, digest: receipt.digest, total: receipt.ids.length,
        items: ids.map(id => this.resolve(this.required(id))),
        next_offset: offset + limit < receipt.ids.length ? offset + limit : null,
        states_as_of: 'inspection', truth_evaluated: false };
    });
  }
  show(id: string, limit = 20, offset = 0) {
    pageBounds(limit, offset);
    return this.store.transaction(() => {
      const entry = this.required(id);
      const rows = this.store.incoming(id, limit + 1, offset);
      return { ...this.resolve(entry), connections: rows.slice(0, limit).map(e => this.resolve(e)),
        next_offset: rows.length > limit ? offset + limit : null, truth_evaluated: false };
    });
  }
  exportSnapshot(): Snapshot {
    return this.store.transaction(() => ({ format: 'yurai.snapshot', version: 1,
      entries: this.store.entries(), receipts: this.store.receipts() }));
  }
  importSnapshot(value: unknown) {
    const snapshot = parseSnapshot(value);
    return this.store.transaction(() => {
      if (this.store.count() || this.store.receipts().length) fail('CONFLICT', 'restore requires an empty initialized ledger');
      this.checkReferences(snapshot.entries);
      const ids = new Set(snapshot.entries.map(e => e.id)), requests = new Set<string>();
      for (const receipt of snapshot.receipts) {
        if (requests.has(receipt.request_id)) fail('CONFLICT', 'duplicate receipt request_id');
        requests.add(receipt.request_id);
        if (new Set(receipt.ids).size !== receipt.ids.length || receipt.ids.some(id => !ids.has(id)))
          fail('VALIDATION', 'receipt refers to missing or duplicate records');
      }
      // Array order is the review-event order, not wall-clock timestamps.
      for (const entry of snapshot.entries) this.store.insert(entry);
      for (const receipt of snapshot.receipts) this.store.insertReceipt(receipt);
      return { restored: snapshot.entries.length, receipts: snapshot.receipts.length };
    });
  }
}
