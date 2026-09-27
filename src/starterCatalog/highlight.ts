/** One run of text for search highlighting; `match` runs are rendered in a <mark>. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into segments marking every non-overlapping, case-insensitive occurrence of the
 * trimmed `query`. Empty/whitespace query or no match returns a single non-match segment.
 * Plain substring only: an EPA reg. no. that matches only after ignoring spaces/dashes
 * (see starterMatchesQuery) is not highlighted.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let start = 0;
  let at = lower.indexOf(q);
  while (at !== -1) {
    if (at > start) segments.push({ text: text.slice(start, at), match: false });
    segments.push({ text: text.slice(at, at + q.length), match: true });
    start = at + q.length;
    at = lower.indexOf(q, start);
  }
  if (segments.length === 0) return [{ text, match: false }];
  if (start < text.length) segments.push({ text: text.slice(start), match: false });
  return segments;
}
