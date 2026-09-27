/** Pure quote matching. No filesystem, network, or database access. */
/** Largest checkable byte sequence. Matching pins hashes, never stores file content. */
export const MAX_VERIFY_BYTES = 4 * 1024 * 1024;
/** Normalized comparison: NFKC, lowercase, every whitespace run collapsed to one space, trimmed. */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}
/** All character offsets where quote occurs and the optional affixes adjoin. Overlaps included. */
export function findOccurrences(content: string, quote: string, prefix?: string, suffix?: string): number[] {
  const hits: number[] = [];
  for (let at = content.indexOf(quote); at >= 0; at = content.indexOf(quote, at + 1)) {
    if (prefix && content.slice(Math.max(0, at - prefix.length), at) !== prefix) continue;
    if (suffix && content.slice(at + quote.length, at + quote.length + suffix.length) !== suffix) continue;
    hits.push(at);
  }
  return hits;
}
export function matchQuote(evidence: { quote: string; prefix?: string | undefined; suffix?: string | undefined },
  content: string, method: 'verbatim' | 'normalized'): { outcome: 'match' | 'mismatch' | 'multiple'; occurrences: number; offsets: number[] } {
  let offsets: number[];
  if (method === 'verbatim') {
    offsets = evidence.quote ? findOccurrences(content, evidence.quote, evidence.prefix, evidence.suffix) : [];
  } else {
    // Normalized: the affixes join the quote before folding, so boundary
    // whitespace folds as one span instead of being trimmed off each fragment.
    const needle = evidence.quote.trim()
      ? normalizeForMatch(`${evidence.prefix ?? ''}${evidence.quote}${evidence.suffix ?? ''}`) : '';
    offsets = needle ? findOccurrences(normalizeForMatch(content), needle) : [];
  }
  if (!offsets.length) return { outcome: 'mismatch', occurrences: 0, offsets: [] };
  if (offsets.length > 1) return { outcome: 'multiple', occurrences: offsets.length, offsets };
  return { outcome: 'match', occurrences: 1, offsets };
}
