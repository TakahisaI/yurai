/** Stored content and actor identities are declarations, never authenticated facts. */
export type Actor = { kind: 'human' | 'agent' | 'import'; id: string; model?: string; run_id?: string };
export type State = 'proposed' | 'accepted' | 'rejected' | 'withdrawn';
export interface Bodies {
  source: { title: string; medium: string; uri?: string; identifiers?: Record<string, string>;
    version?: string; accessed_at?: string; snapshot_uri?: string; content_sha256?: string; note?: string };
  claim: { text: string; kind: 'assertion' | 'hypothesis' | 'inference'; attributed_to: string;
    scope?: string; why?: string };
  evidence: { source_id: string; quote?: string; locator?: string; prefix?: string; suffix?: string;
    paraphrase?: string };
  assessment: { claim_id: string; evidence_id: string;
    stance: 'reports' | 'supports' | 'challenges' | 'qualifies' | 'context'; rationale: string };
  relation: { from_claim_id: string; to_claim_id: string;
    relation: 'supports' | 'contradicts' | 'qualifies' | 'extends' | 'related' | 'supersedes'; rationale: string };
  review: { target_id: string; state: State; rationale: string };
  verification: { target_evidence_id: string; target_source_id: string;
    outcome: 'match' | 'mismatch' | 'multiple' | 'unreachable';
    method: 'verbatim' | 'normalized'; verified_at: string; detail?: string;
    searched_sha256?: string; searched_bytes?: number;
    passage_sha256?: string; byte_offset?: number; byte_length?: number;
    occurrences?: number; occurrence_offsets?: number[]; edition?: string };
}
export type Kind = keyof Bodies;
export type Input = { [K in Kind]: { id: string; type: K; data: Bodies[K] } }[Kind];
export type Entry = Input & { created_at: string; actor: Actor };
export type Bundle = { version: 1; request_id: string; actor: Actor; entries: Input[] };
export type Receipt = { request_id: string; digest: string; ids: string[] };
export type Snapshot = { format: 'yurai.snapshot'; version: 1; entries: Entry[]; receipts: Receipt[] };
export class LedgerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'LedgerError'; }
}
export function fail(code: string, message: string): never { throw new LedgerError(code, message); }

// A deliberately small JSON Schema subset. The very same definitions drive validation
// and `yurai schema`; unknown keys fail instead of silently discarding agent input.
type Schema = { type?: string; const?: unknown; enum?: readonly string[]; properties?: Record<string, Schema>;
  required?: string[]; additionalProperties?: false | Schema; items?: Schema; oneOf?: Schema[];
  minLength?: number; maxLength?: number; pattern?: string; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number };
const text = (max = 8000): Schema => ({ type: 'string', minLength: 1, maxLength: max });
const integer = (minimum = 0, maximum = 9007199254740991): Schema => ({ type: 'integer', minimum, maximum });
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const array = (items: Schema, minItems = 0, maxItems = 100000): Schema =>
  ({ type: 'array', items, minItems, maxItems });
const id: Schema = { ...text(128), pattern: '^[A-Za-z][A-Za-z0-9_.:-]+$' };
const timestamp: Schema = { ...text(32), pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$' };
const hash: Schema = { ...text(64), pattern: '^[a-f0-9]{64}$' };
const actorSchema = object({ kind: choice('human', 'agent', 'import'), id: text(200),
  model: text(200), run_id: text(200) }, ['kind', 'id']);
const bodySchemas: Record<Kind, Schema> = {
  source: object({ title: text(1000), medium: text(100), uri: text(4000),
    identifiers: { type: 'object', additionalProperties: text(1000) }, version: text(500),
    accessed_at: timestamp, snapshot_uri: text(4000), content_sha256: hash, note: text() }, ['title', 'medium']),
  claim: object({ text: text(), kind: choice('assertion', 'hypothesis', 'inference'),
    attributed_to: text(1000), scope: text(), why: text() }, ['text', 'kind', 'attributed_to']),
  evidence: object({ source_id: id, quote: text(16000), locator: text(2000), prefix: text(2000),
    suffix: text(2000), paraphrase: text() }, ['source_id']),
  assessment: object({ claim_id: id, evidence_id: id,
    stance: choice('reports', 'supports', 'challenges', 'qualifies', 'context'), rationale: text() }),
  relation: object({ from_claim_id: id, to_claim_id: id,
    relation: choice('supports', 'contradicts', 'qualifies', 'extends', 'related', 'supersedes'), rationale: text() }),
  review: object({ target_id: id, state: choice('proposed', 'accepted', 'rejected', 'withdrawn'), rationale: text() }),
  verification: object({ target_evidence_id: id, target_source_id: id,
    outcome: choice('match', 'mismatch', 'multiple', 'unreachable'), method: choice('verbatim', 'normalized'),
    verified_at: timestamp, detail: text(2000), searched_sha256: hash, searched_bytes: integer(),
    passage_sha256: hash, byte_offset: integer(), byte_length: integer(1), occurrences: integer(1),
    occurrence_offsets: array(integer(), 0, 50), edition: text(500) },
    ['target_evidence_id', 'target_source_id', 'outcome', 'method', 'verified_at']),
};
const kinds = Object.keys(bodySchemas) as Kind[];
const inputSchemas = kinds.map(type => object({ id, type: { const: type }, data: bodySchemas[type] }));
const entrySchemas = kinds.map(type => object({ id, type: { const: type }, data: bodySchemas[type],
  created_at: timestamp, actor: actorSchema }));
export const bundleSchema = object({ version: { const: 1 }, request_id: id, actor: actorSchema,
  entries: array({ oneOf: inputSchemas }, 1, 200) });
export const snapshotSchema = object({ format: { const: 'yurai.snapshot' }, version: { const: 1 },
  entries: array({ oneOf: entrySchemas }), receipts: array(object({ request_id: id, digest: hash, ids: array(id, 1, 200) })) });
export const inputSchema = { oneOf: inputSchemas };

function validate(value: unknown, schema: Schema, path: string): void {
  const bad = (message: string): never => fail('VALIDATION', `${path}: ${message}`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(s => {
      try { validate(value, s, path); return true; } catch (e) { if (e instanceof LedgerError) return false; throw e; }
    });
    if (matches.length !== 1) bad('must match exactly one documented record shape (check type, required and unknown fields)');
    return;
  }
  if ('const' in schema && value !== schema.const) bad(`must be ${JSON.stringify(schema.const)}`);
  if (schema.type === 'string') {
    if (typeof value !== 'string') bad('must be a string');
    const s = value as string;
    if (!s.trim() || s.includes('\u0000')) bad('must be nonblank and contain no NUL');
    if (s.length < (schema.minLength ?? 0) || s.length > (schema.maxLength ?? Infinity)) bad('invalid length');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(s)) bad('invalid format');
    if (schema.enum && !schema.enum.includes(s)) bad(`must be one of ${schema.enum.join(', ')}`);
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) bad('must be an integer');
    const n = value as number;
    if (n < (schema.minimum ?? -Infinity) || n > (schema.maximum ?? Infinity)) bad('out of range');
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) bad('must be an array');
    const a = value as unknown[];
    if (a.length < (schema.minItems ?? 0) || a.length > (schema.maxItems ?? Infinity)) bad('invalid item count');
    a.forEach((v, i) => validate(v, schema.items ?? {}, `${path}[${i}]`));
  } else if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) bad('must be an object');
    const o = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(o, key)) bad(`missing ${key}`);
    for (const [key, v] of Object.entries(o)) {
      const rule = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties?.[key] : undefined;
      if (rule) validate(v, rule, `${path}.${key}`);
      else if (schema.additionalProperties === false) bad(`unknown field ${key}`);
      else if (schema.additionalProperties) validate(v, schema.additionalProperties, `${path}.${key}`);
    }
  }
}
function semantic(input: Input): void {
  if (input.type === 'evidence') {
    if (!input.data.quote && !input.data.locator) fail('VALIDATION', `${input.id}: evidence needs quote or locator`);
    if ((input.data.prefix || input.data.suffix) && !input.data.quote) fail('VALIDATION', `${input.id}: quote context requires quote`);
  }
  if (input.type === 'source') {
    for (const uri of [input.data.uri, input.data.snapshot_uri]) if (uri) {
      try { new URL(uri); } catch { fail('VALIDATION', `${input.id}: expected absolute URI; it will not be fetched`); }
    }
    const t = input.data.accessed_at;
    if (t && !validTime(t)) fail('VALIDATION', `${input.id}: invalid accessed_at`);
    if (!input.data.uri && !Object.keys(input.data.identifiers ?? {}).length)
      fail('VALIDATION', `${input.id}: source needs uri or at least one identifier`);
  }
  if (input.type === 'relation' && input.data.from_claim_id === input.data.to_claim_id)
    fail('VALIDATION', `${input.id}: self-relations are not allowed`);
  if (input.type === 'verification') {
    const d = input.data, no = (...keys: (keyof typeof d)[]) => keys.some(k => d[k] !== undefined);
    if (!validTime(d.verified_at)) fail('VALIDATION', `${input.id}: invalid verified_at`);
    if (d.outcome === 'unreachable') {
      if (!d.detail) fail('VALIDATION', `${input.id}: unreachable needs a reason in detail`);
      if (no('searched_sha256', 'searched_bytes', 'passage_sha256', 'byte_offset', 'byte_length', 'occurrences', 'occurrence_offsets'))
        fail('VALIDATION', `${input.id}: unreachable records no checked bytes`);
    } else {
      if (d.searched_sha256 === undefined || d.searched_bytes === undefined)
        fail('VALIDATION', `${input.id}: checked outcomes pin the searched bytes`);
      if (d.outcome === 'match' && (d.occurrences === undefined
        || (d.method === 'verbatim' && (d.passage_sha256 === undefined || d.byte_offset === undefined || d.byte_length === undefined))))
        fail('VALIDATION', `${input.id}: match pins the passage`);
      if (d.outcome === 'multiple' && (d.occurrences === undefined || d.occurrences < 2
        || (d.method === 'verbatim' && !d.occurrence_offsets?.length)))
        fail('VALIDATION', `${input.id}: multiple pins candidates`);
      if (d.outcome === 'mismatch' && no('passage_sha256', 'byte_offset', 'byte_length', 'occurrences', 'occurrence_offsets'))
        fail('VALIDATION', `${input.id}: mismatch references no passage`);
      if (d.method === 'normalized' && no('passage_sha256', 'byte_offset', 'byte_length', 'occurrence_offsets'))
        fail('VALIDATION', `${input.id}: normalized offsets do not map to source bytes`);
    }
  }
}
function validTime(t: string): boolean {
  const n = Date.parse(t);
  return Number.isFinite(n) && new Date(n).toISOString() === (t.length === 20 ? t.replace('Z', '.000Z') : t);
}
export function parseBundle(value: unknown): Bundle {
  validate(value, bundleSchema, 'bundle');
  const bundle = value as Bundle;
  bundle.entries.forEach(semantic);
  return bundle;
}
export function parseSnapshot(value: unknown): Snapshot {
  validate(value, snapshotSchema, 'snapshot');
  const snapshot = value as Snapshot;
  snapshot.entries.forEach(e => { semantic(e); if (!validTime(e.created_at)) fail('VALIDATION', `${e.id}: invalid created_at`); });
  return snapshot;
}
export function references(input: Input): { id: string; role: string; kind: Kind | 'reviewable' }[] {
  switch (input.type) {
    case 'evidence': return [{ id: input.data.source_id, role: 'source', kind: 'source' }];
    case 'assessment': return [{ id: input.data.claim_id, role: 'claim', kind: 'claim' },
      { id: input.data.evidence_id, role: 'evidence', kind: 'evidence' }];
    case 'relation': return [{ id: input.data.from_claim_id, role: 'from', kind: 'claim' },
      { id: input.data.to_claim_id, role: 'to', kind: 'claim' }];
    case 'review': return [{ id: input.data.target_id, role: 'target', kind: 'reviewable' }];
    case 'verification': return [{ id: input.data.target_evidence_id, role: 'evidence', kind: 'evidence' },
      { id: input.data.target_source_id, role: 'source', kind: 'source' }];
    default: return [];
  }
}
export function pageBounds(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000)
    fail('VALIDATION', 'limit must be 1..100; offset must be 0..1000000');
}
export function normalize(s: string): string { return s.normalize('NFKC').toLowerCase(); }
export type EvidenceField = 'quote' | 'paraphrase';
/** Lexical rule for expanded discovery: every token must occur in the joined
 *  content fields (mirrors direct-search AND semantics); reports the fields
 *  holding at least one token. Locators are pointers, not content, and stay out. */
export function matchedEvidenceFields(data: { quote?: string; paraphrase?: string }, tokens: string[]): EvidenceField[] {
  const fields: EvidenceField[] = ['quote', 'paraphrase'];
  const joined = normalize(fields.map(f => data[f]).filter(Boolean).join('\n'));
  if (!tokens.every(t => joined.includes(t))) return [];
  return fields.filter(f => data[f] !== undefined && tokens.some(t => normalize(data[f] as string).includes(t)));
}
