/** One run of text for search highlighting; `match` runs are rendered in a <mark>. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Build a lowercased form of `text` together with a map from each lowercased index back to the
 * original string. Some code points expand when lowercased (e.g. "İ" U+0130 → "i̇", 2 UTF-16
 * units), so indices into `text.toLowerCase()` cannot be used to slice `text` directly.
 *
 * `toOrig[i]` is the start index in `text` of the code point that produced `lower[i]`.
 * `toOrig[lower.length]` is `text.length`, so a half-open range `[a, b)` in lower space maps to
 * `[toOrig[a], toOrig[b])` in the original when `b` lands on a code-point boundary.
 */
function lowerWithOrigMap(text: string): { lower: string; toOrig: number[] } {
  let lower = "";
  const toOrig: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const lowerPiece = text.slice(i, i + len).toLowerCase();
    for (let k = 0; k < lowerPiece.length; k++) {
      toOrig.push(i);
      lower += lowerPiece[k]!;
    }
    i += len;
  }
  toOrig.push(text.length);
  return { lower, toOrig };
}

/** Exclusive original end index for a match ending at lower index `end` (exclusive). */
function origEndFor(toOrig: number[], end: number): number {
  if (end <= 0) return toOrig[0] ?? 0;
  // If the match ended mid-expansion of a code point, snap to the end of that code point so the
  // highlighted slice never splits a single original character.
  const lastOrig = toOrig[end - 1]!;
  let snapped = end;
  while (snapped < toOrig.length - 1 && toOrig[snapped] === lastOrig) {
    snapped++;
  }
  return toOrig[snapped]!;
}

/**
 * Split `text` into segments marking every non-overlapping, case-insensitive occurrence of the
 * trimmed `query`. Empty/whitespace query or no match returns a single non-match segment.
 * Plain substring only: an EPA reg. no. that matches only after ignoring spaces/dashes
 * (see starterMatchesQuery) is not highlighted.
 *
 * Match positions are found in a length-aware lowercase map so highlights stay aligned when
 * lowercasing expands a character (see #86, Turkish "İ").
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, match: false }];
  const { lower, toOrig } = lowerWithOrigMap(text);
  const segments: HighlightSegment[] = [];
  let lowerStart = 0;
  let origStart = 0;
  let at = lower.indexOf(q);
  while (at !== -1) {
    const matchOrigStart = toOrig[at]!;
    const matchOrigEnd = origEndFor(toOrig, at + q.length);
    if (matchOrigStart > origStart) {
      segments.push({ text: text.slice(origStart, matchOrigStart), match: false });
    }
    segments.push({ text: text.slice(matchOrigStart, matchOrigEnd), match: true });
    lowerStart = at + q.length;
    origStart = matchOrigEnd;
    at = lower.indexOf(q, lowerStart);
  }
  if (segments.length === 0) return [{ text, match: false }];
  if (origStart < text.length) segments.push({ text: text.slice(origStart), match: false });
  return segments;
}
