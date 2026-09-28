import { createHash } from 'node:crypto';
import { LedgerError, fail, matchedEvidenceFields, normalize, pageBounds, parseBundle, parseSnapshot, references } from './model.js';
import type { Actor, Entry, EvidenceField, Input, Snapshot, State } from './model.js';
import type { Store } from './ports.js';
import { MAX_VERIFY_BYTES, matchQuote } from './verify.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function sameVerifier(stored: Actor, claimed: { kind: string; id: string; model?: string }): boolean {
  return stored.kind === claimed.kind && stored.id === claimed.id && (stored.model ?? null) === (claimed.model ?? null);
}
type VerificationData = Extract<Input, { type: 'verification' }>['data'];
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
      if (ref.kind === 'reviewable' ? target.type === 'review' || target.type === 'verification' : target.type !== ref.kind)
        fail('VALIDATION', `${input.id}: ${ref.role} has wrong record type`);
    }
    for (const input of inputs) {
      if (input.type !== 'verification') continue;
      const evidence = byId.get(input.data.target_evidence_id) ?? this.store.get(input.data.target_evidence_id);
      if (evidence?.type === 'evidence' && evidence.data.source_id !== input.data.target_source_id)
        fail('VALIDATION', `${input.id}: verification names a different source than its evidence`);
      if (evidence?.type === 'evidence' && !evidence.data.quote)
        fail('VALIDATION', `${input.id}: verification target has no quote to match`);
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
  private verificationSummary(entry: Entry) {
    if (entry.type !== 'evidence') return undefined;
    const found = this.store.latestVerification(entry.id);
    if (!found || found.type !== 'verification') return null;
    const source = this.store.get(entry.data.source_id);
    const declaredEdition = source?.type === 'source' ? source.data.version ?? null : null;
    const declaredBytes = source?.type === 'source' ? source.data.content_sha256 ?? null : null;
    const checkedEdition = found.data.edition ?? null, searched = found.data.searched_sha256 ?? null;
    const agreement = (a: string | null, b: string | null) => a && b ? (a === b ? 'match' as const : 'mismatch' as const) : 'unknown' as const;
    return { id: found.id, outcome: found.data.outcome, method: found.data.method, verified_at: found.data.verified_at,
      actor: found.actor, edition: { declared: declaredEdition, checked: checkedEdition, agreement: agreement(declaredEdition, checkedEdition) },
      bytes: { declared: declaredBytes, searched, agreement: agreement(declaredBytes, searched) },
      detail: found.data.detail ?? null };
  }
  private view(entry: Entry) {
    const review = this.store.latestReview(entry.id);
    const state: State = review?.type === 'review' ? review.data.state : 'proposed';
    const warnings: string[] = [];
    if (entry.type !== 'review' && entry.type !== 'verification' && state === 'proposed') warnings.push('not_reviewed');
    if (state === 'rejected' || state === 'withdrawn') warnings.push('inactive_record');
    const verification = this.verificationSummary(entry);
    if (entry.type === 'evidence') warnings.push(verification ? `anchor_${verification.outcome}` : 'anchor_not_verified');
    if (entry.type === 'source') {
      if (!entry.data.version && !entry.data.content_sha256) warnings.push('source_version_not_pinned');
      if (!entry.data.snapshot_uri) warnings.push('no_snapshot_reference');
      if (entry.data.medium === 'conversation') warnings.push('conversation_is_not_independent_corroboration');
    }
    if (entry.type === 'claim' && entry.data.attributed_to === 'unknown') warnings.push('unknown_attribution');
    return entry.type === 'evidence' ? { entry, state, review: review ?? null, warnings, verification } : { entry, state, review: review ?? null, warnings };
  }
  verifyEvidence(input: { evidence_id: string; content: Buffer | null; edition?: string;
    method?: 'verbatim' | 'normalized'; detail?: string; actor: { kind: string; id: string; model?: string };
    request_id: string; dryRun?: boolean }) {
    const { evidence_id, content, edition, detail } = input;
    const method = input.method ?? 'verbatim';
    if (method !== 'verbatim' && method !== 'normalized') fail('VALIDATION', 'method must be verbatim or normalized');
    const evidence = this.required(evidence_id);
    if (evidence.type !== 'evidence') fail('VALIDATION', `${evidence_id}: not evidence`);
    const quote = evidence.data.quote;
    if (!quote) fail('VALIDATION', `${evidence_id}: evidence has no quote to match`);
    const id = `vrf_${createHash('sha256').update(input.request_id).digest('hex')}`;
    const verified_at = this.now();
    let data: VerificationData;
    if (content === null) {
      data = { target_evidence_id: evidence_id, target_source_id: evidence.data.source_id, outcome: 'unreachable',
        method, verified_at, detail: detail ?? 'No checkable content was provided', ...(edition === undefined ? {} : { edition }) };
    } else {
      if (content.length > MAX_VERIFY_BYTES) fail('VALIDATION', `content exceeds the ${MAX_VERIFY_BYTES}-byte verification limit`);
      let text: string;
      // ignoreBOM keeps a leading U+FEFF in the string so character offsets map
      // back onto the searched bytes that searched_sha256 pins.
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
      catch { fail('VALIDATION', 'content is not valid UTF-8 text'); }
      const found = matchQuote({ quote, prefix: evidence.data.prefix, suffix: evidence.data.suffix }, text, method);
      const searched_sha256 = createHash('sha256').update(content).digest('hex');
      const base = { target_evidence_id: evidence_id, target_source_id: evidence.data.source_id, verified_at,
        searched_sha256, searched_bytes: content.length,
        ...(edition === undefined ? {} : { edition }), ...(detail === undefined ? {} : { detail }) };
      if (found.outcome === 'mismatch') {
        data = { ...base, outcome: found.outcome, method };
      } else if (method === 'normalized') {
        data = { ...base, outcome: found.outcome, method, occurrences: found.occurrences };
      } else if (found.outcome === 'match') {
        const start = found.offsets[0]!, passage = text.slice(start, start + quote.length);
        const byte_offset = Buffer.byteLength(text.slice(0, start));
        data = { ...base, outcome: found.outcome, method, occurrences: 1,
          passage_sha256: createHash('sha256').update(passage).digest('hex'), byte_offset, byte_length: Buffer.byteLength(passage) };
      } else {
        data = { ...base, outcome: found.outcome, method, occurrences: found.occurrences,
          occurrence_offsets: found.offsets.slice(0, 50).map(at => Buffer.byteLength(text.slice(0, at))) };
      }
    }
    try {
      const result = this.capture({ version: 1, actor: input.actor, request_id: input.request_id,
        entries: [{ id, type: 'verification', data }] }, input.dryRun ?? false);
      // capture() above already validated the actor; the preview below only renders it.
      const entry = this.store.get(id) ?? { id, type: 'verification' as const, data, created_at: verified_at, actor: input.actor as Actor };
      return { ...result, outcome: data.outcome, verification: this.view(entry) };
    } catch (error) {
      // capture() conflicts on the retry's own timestamp; the same single
      // verification by the same verifier still replays. The failed attempt
      // already observed the winner's committed receipt, so this re-read
      // serializes after concurrent retries instead of racing them.
      if (error instanceof LedgerError && error.code === 'CONFLICT') {
        const replay = this.verifyReplay(input.request_id, id, data, input.actor, input.dryRun ?? false);
        if (replay) return replay;
      }
      throw error;
    }
  }
  private verifyReplay(request_id: string, id: string, data: VerificationData,
    actor: { kind: string; id: string; model?: string }, dryRun: boolean) {
    const receipt = this.store.receipt(request_id);
    if (!receipt || receipt.ids.length !== 1 || receipt.ids[0] !== id) return null;
    const stored = this.store.get(id);
    // verified_at is the retry's own timestamp, not functional content: only a
    // receipt pointing at exactly this verification can replay it.
    if (stored?.type === 'verification' && sameVerifier(stored.actor, actor)
      && canonical({ ...stored.data, verified_at: '' }) === canonical({ ...data, verified_at: '' }))
      return { ...receipt, replayed: true, dry_run: dryRun,
        outcome: stored.data.outcome, verification: this.view(stored) };
    return null;
  }
  search(query: string, options: { kind?: 'claim' | 'source'; limit?: number; offset?: number; includeInactive?: boolean; expand?: 'evidence'; pathLimit?: number; pathOffset?: number } = {}) {
    const { kind = 'claim', limit = 20, offset = 0, includeInactive = false, expand } = options;
    const pathLimit = options.pathLimit === undefined ? limit : options.pathLimit;
    const pathOffset = options.pathOffset === undefined ? 0 : options.pathOffset;
    pageBounds(limit, offset);
    pageBounds(pathLimit, pathOffset);
    if (kind !== 'claim' && kind !== 'source') fail('VALIDATION', 'search kind must be claim or source');
    if (expand !== undefined && expand !== 'evidence') fail('VALIDATION', 'expand must be evidence');
    if (expand && kind !== 'claim') fail('VALIDATION', 'expanded discovery routes to claims only');
    if (!expand && (options.pathLimit !== undefined || options.pathOffset !== undefined)) fail('VALIDATION', 'path paging needs expand');
    if (typeof query !== 'string' || query.length > 500 || query.includes('\u0000')) fail('VALIDATION', 'invalid query');
    const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length || tokens.length > 16) fail('VALIDATION', 'query needs 1..16 literal terms');
    return this.store.transaction(() => {
      if (expand) return this.expanded(tokens, includeInactive, limit, offset, query, pathLimit, pathOffset);
      const rows = this.store.search(kind, tokens, includeInactive, limit + 1, offset);
      return { items: rows.slice(0, limit).map(e => this.view(e)), next_offset: rows.length > limit ? offset + limit : null,
        query, match: 'literal_terms_and', truth_evaluated: false };
    });
  }
  private expanded(tokens: string[], includeInactive: boolean, limit: number, offset: number, query: string, pathLimit: number, pathOffset: number) {
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
    // Numeric instant comparison: mixed precisions ('...00Z' vs '...00.500Z') invert under string order.
    const byRecency = (a: Entry, b: Entry) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id);
    const byPath = (a: Path, b: Path) => Date.parse(b.assessment.created_at) - Date.parse(a.assessment.created_at)
      || a.evidence.id.localeCompare(b.evidence.id) || a.assessment.id.localeCompare(b.assessment.id);
    const items = [...merged.values()]
      .filter(({ claim }) => includeInactive || live(claim))
      .map(({ claim, direct, paths }) => {
        const kept = (includeInactive ? paths : paths.filter(p => live(p.evidence) && live(p.assessment) && live(p.source)))
          .sort(byPath);
        return { ...this.view(claim), direct_match: direct,
          via: kept.slice(pathOffset, pathOffset + pathLimit).map(p => ({ evidence: this.view(p.evidence), assessment: this.view(p.assessment),
            source: this.view(p.source), match_fields: p.match_fields })),
          total_paths: kept.length, paths_truncated: pathOffset > 0 || pathOffset + pathLimit < kept.length,
          via_next_offset: pathOffset + pathLimit < kept.length ? pathOffset + pathLimit : null };
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
