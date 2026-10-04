import { describe, expect, it } from "vitest";
import { highlightSegments, type HighlightSegment } from "./highlight";

// Scope: highlightSegments (pure). Invariant checked throughout: joining segment texts
// reproduces the input exactly, and match/non-match runs alternate.

function joined(segs: HighlightSegment[]) {
  return segs.map((s) => s.text).join("");
}

function marks(segs: HighlightSegment[]) {
  return segs.filter((s) => s.match).map((s) => s.text);
}

describe("highlightSegments", () => {
  it("returns one non-match segment for an empty or whitespace query", () => {
    expect(highlightSegments("Bifen IT", "")).toEqual([{ text: "Bifen IT", match: false }]);
    expect(highlightSegments("Bifen IT", "   \t")).toEqual([{ text: "Bifen IT", match: false }]);
  });

  it("returns one non-match segment when nothing matches", () => {
    expect(highlightSegments("Bifen IT", "termidor")).toEqual([{ text: "Bifen IT", match: false }]);
  });

  it("handles empty text", () => {
    expect(highlightSegments("", "x")).toEqual([{ text: "", match: false }]);
    expect(highlightSegments("", "")).toEqual([{ text: "", match: false }]);
  });

  it("marks a match in the middle with surrounding runs", () => {
    expect(highlightSegments("Talstar P Professional", "star")).toEqual([
      { text: "Tal", match: false },
      { text: "star", match: true },
      { text: " P Professional", match: false },
    ]);
  });

  it("marks matches at the start and end without empty segments", () => {
    expect(highlightSegments("Demand CS", "demand")).toEqual([
      { text: "Demand", match: true },
      { text: " CS", match: false },
    ]);
    expect(highlightSegments("Demand CS", "cs")).toEqual([
      { text: "Demand ", match: false },
      { text: "CS", match: true },
    ]);
  });

  it("marks the whole string when the query equals the text", () => {
    expect(highlightSegments("Advion", "ADVION")).toEqual([{ text: "Advion", match: true }]);
  });

  it("is case-insensitive and preserves the original casing in output", () => {
    const segs = highlightSegments("Termidor SC termidor", "TeRmIdOr");
    expect(marks(segs)).toEqual(["Termidor", "termidor"]);
    expect(joined(segs)).toBe("Termidor SC termidor");
  });

  it("trims the query before matching", () => {
    expect(highlightSegments("Suspend SC", "  sc  ")).toEqual([
      { text: "Suspend ", match: false },
      { text: "SC", match: true },
    ]);
  });

  it("keeps inner spaces of the query significant", () => {
    expect(marks(highlightSegments("Talstar P", "star p"))).toEqual(["star P"]);
    expect(highlightSegments("Talstar  P", "star p")).toEqual([{ text: "Talstar  P", match: false }]);
  });

  it("marks every non-overlapping occurrence, left to right", () => {
    expect(highlightSegments("aaaa", "aa")).toEqual([
      { text: "aa", match: true },
      { text: "aa", match: true },
    ]);
    expect(highlightSegments("aaa", "aa")).toEqual([
      { text: "aa", match: true },
      { text: "a", match: false },
    ]);
  });

  it("emits adjacent match segments for back-to-back occurrences", () => {
    expect(highlightSegments("abab-ab", "ab")).toEqual([
      { text: "ab", match: true },
      { text: "ab", match: true },
      { text: "-", match: false },
      { text: "ab", match: true },
    ]);
  });

  it("treats regex metacharacters literally", () => {
    expect(highlightSegments("Product (25b) .*", "(25b)")).toEqual([
      { text: "Product ", match: false },
      { text: "(25b)", match: true },
      { text: " .*", match: false },
    ]);
    expect(marks(highlightSegments("a.c abc", "."))).toEqual(["."]);
  });

  it("matches EPA numbers only as plain substrings (no dash/space folding)", () => {
    expect(marks(highlightSegments("EPA 279-3206", "279-3206"))).toEqual(["279-3206"]);
    expect(highlightSegments("EPA 279-3206", "2793206")).toEqual([{ text: "EPA 279-3206", match: false }]);
    expect(highlightSegments("EPA 279-3206", "279 3206")).toEqual([{ text: "EPA 279-3206", match: false }]);
  });

  it("does not trim the text itself", () => {
    expect(highlightSegments("  Bifen  ", "bifen")).toEqual([
      { text: "  ", match: false },
      { text: "Bifen", match: true },
      { text: "  ", match: false },
    ]);
  });

  it("highlights a trailing Greek sigma when the whole string lowercases to final sigma", () => {
    expect(highlightSegments("ΟΣ", "ΟΣ")).toEqual([{ text: "ΟΣ", match: true }]);
  });

  it("handles non-ASCII text whose lowercase keeps the same length", () => {
    const segs = highlightSegments("Peña Pest ÉCOLE", "école");
    expect(marks(segs)).toEqual(["ÉCOLE"]);
    expect(joined(segs)).toBe("Peña Pest ÉCOLE");
  });

  it("round-trips the input text for a variety of inputs", () => {
    const cases: [string, string][] = [
      ["Bifen I/T", "i/t"],
      ["Maxforce FC Magnum", "m"],
      ["xxxxx", "x"],
      ["Gentrol IGR Concentrate", "ntr"],
    ];
    for (const [text, q] of cases) {
      const segs = highlightSegments(text, q);
      expect(joined(segs)).toBe(text);
      for (let i = 1; i < segs.length; i++) {
        if (!segs[i].match) expect(segs[i - 1].match).toBe(true);
      }
      expect(segs.every((s) => s.text.length > 0)).toBe(true);
    }
  });

  // #86 fixed in source; #106 asks that this regression guard run.
  it("stays aligned when lowercasing changes the text length (e.g. Turkish İ)", () => {
    const segs = highlightSegments("İstanbul Pest", "pest");
    expect(marks(segs)).toEqual(["Pest"]);
    expect(joined(segs)).toBe("İstanbul Pest");
  });
});
