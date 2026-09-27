import { createHash } from 'node:crypto';
import { fail, normalize, pageBounds, parseBundle, parseSnapshot, references } from './model.js';
import type { Entry, Input, Snapshot, State } from './model.js';
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
  search(query: string, options: { kind?: 'claim' | 'source'; limit?: number; offset?: number; includeInactive?: boolean } = {}) {
    const { kind = 'claim', limit = 20, offset = 0, includeInactive = false } = options;
    pageBounds(limit, offset);
    if (kind !== 'claim' && kind !== 'source') fail('VALIDATION', 'search kind must be claim or source');
    if (typeof query !== 'string' || query.length > 500 || query.includes('\u0000')) fail('VALIDATION', 'invalid query');
    const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length || tokens.length > 16) fail('VALIDATION', 'query needs 1..16 literal terms');
    return this.store.transaction(() => {
      const rows = this.store.search(kind, tokens, includeInactive, limit + 1, offset);
      return { items: rows.slice(0, limit).map(e => this.view(e)), next_offset: rows.length > limit ? offset + limit : null,
        query, match: 'literal_terms_and', truth_evaluated: false };
    });
  }
  show(id: string, limit = 20, offset = 0) {
    pageBounds(limit, offset);
    return this.store.transaction(() => {
      const entry = this.required(id);
      const resolve = (e: Entry) => {
        const refs = references(e).map(r => this.required(r.id));
        const sourceIds = new Set(refs.filter(r => r.type === 'evidence').map(r => r.data.source_id));
        return { ...this.view(e), references: refs.map(r => this.view(r)),
          sources: [...sourceIds].map(s => this.view(this.required(s))) };
      };
      const rows = this.store.incoming(id, limit + 1, offset);
      return { ...resolve(entry), connections: rows.slice(0, limit).map(resolve),
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
