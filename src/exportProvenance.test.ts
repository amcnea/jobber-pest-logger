import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildExportProvenance,
  localIsoWithOffset,
  provenanceFileSuffix,
  provenanceLines,
  provenanceSummary,
  shopSlugForFilename,
  type ExportProvenance,
} from "./exportProvenance";

// vitest.config.ts pins TZ=America/Chicago (CDT -05:00 / CST -06:00).

/** Run fn with process.env.TZ temporarily switched (Node honors runtime TZ changes). */
function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function prov(overrides: Partial<ExportProvenance> = {}): ExportProvenance {
  return {
    source: "local",
    sourceLabel: "This device's local copy",
    shopId: null,
    dateFrom: null,
    dateTo: null,
    rangeLabel: "All dates",
    recordCount: 3,
    generatedAt: "2026-09-26T19:05:00-05:00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// localIsoWithOffset
// ---------------------------------------------------------------------------

describe("localIsoWithOffset", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats device-local time with a negative offset in CDT", () => {
    expect(localIsoWithOffset(new Date("2026-09-27T00:05:09Z"))).toBe("2026-09-26T19:05:09-05:00");
  });

  it("uses the CST offset in winter", () => {
    expect(localIsoWithOffset(new Date("2026-01-15T18:00:00Z"))).toBe("2026-01-15T12:00:00-06:00");
  });

  it("never emits Z and always matches YYYY-MM-DDTHH:MM:SS±HH:MM", () => {
    const out = withTz("UTC", () => localIsoWithOffset(new Date("2026-09-27T00:05:09Z")));
    expect(out).toBe("2026-09-27T00:05:09+00:00");
    expect(out).toMatch(ISO_WITH_OFFSET);
    expect(out).not.toContain("Z");
  });

  it("uses a positive offset east of UTC", () => {
    expect(withTz("Asia/Tokyo", () => localIsoWithOffset(new Date("2026-09-27T00:05:09Z")))).toBe(
      "2026-09-27T09:05:09+09:00",
    );
  });

  it("handles half-hour and 45-minute offsets", () => {
    const d = new Date("2026-09-27T00:00:00Z");
    expect(withTz("Asia/Kolkata", () => localIsoWithOffset(d))).toBe("2026-09-27T05:30:00+05:30");
    expect(withTz("Asia/Kathmandu", () => localIsoWithOffset(d))).toBe("2026-09-27T05:45:00+05:45");
    // Newfoundland daylight time: -02:30 (negative, non-whole hour).
    expect(withTz("America/St_Johns", () => localIsoWithOffset(d))).toBe("2026-09-26T21:30:00-02:30");
  });

  it("zero-pads hours, minutes, seconds, month and day", () => {
    expect(localIsoWithOffset(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02T03:04:05-06:00");
  });

  it("round-trips to the same instant via Date parsing", () => {
    const d = new Date("2026-03-08T08:30:00Z"); // just after DST start in Chicago
    const iso = localIsoWithOffset(d);
    expect(iso).toBe("2026-03-08T03:30:00-05:00");
    expect(new Date(iso).getTime()).toBe(d.getTime());
  });

  it("reflects the offset change across DST end (fall back)", () => {
    expect(localIsoWithOffset(new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01T01:30:00-05:00");
    expect(localIsoWithOffset(new Date("2026-11-01T07:30:00Z"))).toBe("2026-11-01T01:30:00-06:00");
  });

  it("defaults to now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T00:05:00Z"));
    expect(localIsoWithOffset()).toBe("2026-09-26T19:05:00-05:00");
  });
});

// ---------------------------------------------------------------------------
// buildExportProvenance
// ---------------------------------------------------------------------------

describe("buildExportProvenance", () => {
  const now = new Date("2026-09-27T00:05:00Z"); // 19:05 CDT Sep 26

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a local, all-dates provenance", () => {
    expect(buildExportProvenance({ kind: "local", recordCount: 0, now })).toEqual({
      source: "local",
      sourceLabel: "This device's local copy",
      shopId: null,
      dateFrom: null,
      dateTo: null,
      rangeLabel: "All dates",
      recordCount: 0,
      generatedAt: "2026-09-26T19:05:00-05:00",
    });
  });

  it("labels each source kind", () => {
    expect(buildExportProvenance({ kind: "shared", recordCount: 1, now }).sourceLabel).toBe(
      "Shared shop snapshot",
    );
    expect(buildExportProvenance({ kind: "shared-fallback-local", recordCount: 1, now }).sourceLabel).toBe(
      "This device's local copy (shared shop pull failed — may not match the full shop)",
    );
    expect(buildExportProvenance({ kind: "local", recordCount: 1, now }).sourceLabel).toBe(
      "This device's local copy",
    );
  });

  it("keeps a trimmed shop id for shared kinds and drops it for local", () => {
    expect(buildExportProvenance({ kind: "shared", shopId: "  shop-42 ", recordCount: 1, now }).shopId).toBe(
      "shop-42",
    );
    expect(
      buildExportProvenance({ kind: "shared-fallback-local", shopId: "shop-42", recordCount: 1, now }).shopId,
    ).toBe("shop-42");
    expect(buildExportProvenance({ kind: "local", shopId: "shop-42", recordCount: 1, now }).shopId).toBeNull();
  });

  it("normalizes blank/missing shop ids to null", () => {
    expect(buildExportProvenance({ kind: "shared", shopId: "   ", recordCount: 1, now }).shopId).toBeNull();
    expect(buildExportProvenance({ kind: "shared", shopId: "", recordCount: 1, now }).shopId).toBeNull();
    expect(buildExportProvenance({ kind: "shared", shopId: null, recordCount: 1, now }).shopId).toBeNull();
    expect(buildExportProvenance({ kind: "shared", recordCount: 1, now }).shopId).toBeNull();
  });

  it("builds range labels for both, from-only and to-only bounds", () => {
    const both = buildExportProvenance({ kind: "local", dateFrom: "2026-09-01", dateTo: "2026-09-30", recordCount: 1, now });
    expect(both).toMatchObject({ dateFrom: "2026-09-01", dateTo: "2026-09-30", rangeLabel: "2026-09-01 to 2026-09-30" });
    const from = buildExportProvenance({ kind: "local", dateFrom: "2026-09-01", recordCount: 1, now });
    expect(from).toMatchObject({ dateFrom: "2026-09-01", dateTo: null, rangeLabel: "From 2026-09-01" });
    const to = buildExportProvenance({ kind: "local", dateTo: "2026-09-30", recordCount: 1, now });
    expect(to).toMatchObject({ dateFrom: null, dateTo: "2026-09-30", rangeLabel: "Through 2026-09-30" });
  });

  it("trims date bounds", () => {
    const p = buildExportProvenance({ kind: "local", dateFrom: " 2026-09-01 ", dateTo: "\t2026-09-30\n", recordCount: 1, now });
    expect(p.dateFrom).toBe("2026-09-01");
    expect(p.dateTo).toBe("2026-09-30");
  });

  it("ignores non-YYYY-MM-DD bounds (same rules as filterLogsByDateUsed)", () => {
    const p = buildExportProvenance({ kind: "local", dateFrom: "9/1/2026", dateTo: "2026-9-30", recordCount: 1, now });
    expect(p).toMatchObject({ dateFrom: null, dateTo: null, rangeLabel: "All dates" });
    expect(buildExportProvenance({ kind: "local", dateFrom: "", dateTo: "   ", recordCount: 1, now }).rangeLabel).toBe(
      "All dates",
    );
  });

  it("lets an explicit rangeLabel override the computed one without touching the bounds", () => {
    const p = buildExportProvenance({
      kind: "local",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      rangeLabel: "Full backup (all records)",
      recordCount: 10,
      now,
    });
    expect(p.rangeLabel).toBe("Full backup (all records)");
    expect(p.dateFrom).toBe("2026-09-01");
    expect(p.dateTo).toBe("2026-09-30");
  });

  it("passes recordCount through", () => {
    expect(buildExportProvenance({ kind: "local", recordCount: 1234, now }).recordCount).toBe(1234);
  });

  it("stamps generatedAt in device-local time with offset, defaulting to now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T18:00:00Z"));
    const p = buildExportProvenance({ kind: "local", recordCount: 1 });
    expect(p.generatedAt).toBe("2026-01-15T12:00:00-06:00");
    expect(p.generatedAt).toMatch(ISO_WITH_OFFSET);
  });
});

// ---------------------------------------------------------------------------
// provenanceLines
// ---------------------------------------------------------------------------

describe("provenanceLines", () => {
  it("lists source, range, records and generated time (no shop line when no shop id)", () => {
    expect(provenanceLines(prov())).toEqual([
      "Source: This device's local copy",
      "Date range (date used): All dates",
      "Records: 3",
      "Generated: 2026-09-26T19:05:00-05:00 (device-local time)",
    ]);
  });

  it("adds a Shop ID line right after the source when present", () => {
    const lines = provenanceLines(
      prov({ source: "shared", sourceLabel: "Shared shop snapshot", shopId: "shop-42", rangeLabel: "From 2026-09-01" }),
    );
    expect(lines).toEqual([
      "Source: Shared shop snapshot",
      "Shop ID: shop-42",
      "Date range (date used): From 2026-09-01",
      "Records: 3",
      "Generated: 2026-09-26T19:05:00-05:00 (device-local time)",
    ]);
  });

  it("works end-to-end with buildExportProvenance", () => {
    const p = buildExportProvenance({
      kind: "shared-fallback-local",
      shopId: "abc",
      dateTo: "2026-09-30",
      recordCount: 0,
      now: new Date("2026-09-27T00:05:00Z"),
    });
    expect(provenanceLines(p)).toEqual([
      "Source: This device's local copy (shared shop pull failed — may not match the full shop)",
      "Shop ID: abc",
      "Date range (date used): Through 2026-09-30",
      "Records: 0",
      "Generated: 2026-09-26T19:05:00-05:00 (device-local time)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// provenanceSummary
// ---------------------------------------------------------------------------

describe("provenanceSummary", () => {
  it("summarizes a local export", () => {
    expect(provenanceSummary(prov())).toBe(
      "Source: this device's local copy · Range: All dates · 3 records · Generated 2026-09-26T19:05:00-05:00",
    );
  });

  it("summarizes a shared export with shop id", () => {
    expect(provenanceSummary(prov({ source: "shared", shopId: "shop-42" }))).toBe(
      "Source: shared shop snapshot · shop shop-42 · Range: All dates · 3 records · Generated 2026-09-26T19:05:00-05:00",
    );
  });

  it("summarizes a shared-fallback export", () => {
    expect(provenanceSummary(prov({ source: "shared-fallback-local", shopId: "s1" }))).toBe(
      "Source: local copy (shared pull failed) · shop s1 · Range: All dates · 3 records · Generated 2026-09-26T19:05:00-05:00",
    );
  });

  it("uses singular 'record' only for exactly 1", () => {
    expect(provenanceSummary(prov({ recordCount: 1 }))).toContain("· 1 record ·");
    expect(provenanceSummary(prov({ recordCount: 0 }))).toContain("· 0 records ·");
    expect(provenanceSummary(prov({ recordCount: 2 }))).toContain("· 2 records ·");
  });
});

// ---------------------------------------------------------------------------
// provenanceFileSuffix
// ---------------------------------------------------------------------------

describe("provenanceFileSuffix", () => {
  it("encodes range, source and generated local date", () => {
    expect(provenanceFileSuffix(prov({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }))).toBe(
      "2026-09-01_to_2026-09-30-local-generated-2026-09-26",
    );
    expect(provenanceFileSuffix(prov({ dateFrom: "2026-09-01" }))).toBe("from-2026-09-01-local-generated-2026-09-26");
    expect(provenanceFileSuffix(prov({ dateTo: "2026-09-30" }))).toBe("through-2026-09-30-local-generated-2026-09-26");
    expect(provenanceFileSuffix(prov())).toBe("all-dates-local-generated-2026-09-26");
  });

  it("maps each source kind to a short tag", () => {
    expect(provenanceFileSuffix(prov({ source: "shared" }))).toBe("all-dates-shared-generated-2026-09-26");
    expect(provenanceFileSuffix(prov({ source: "shared-fallback-local" }))).toBe(
      "all-dates-local-fallback-generated-2026-09-26",
    );
  });

  it("omits the range when withRange is false (full backups)", () => {
    expect(provenanceFileSuffix(prov({ dateFrom: "2026-09-01", dateTo: "2026-09-30" }), false)).toBe(
      "local-generated-2026-09-26",
    );
  });

  it("uses the device-local generated date, not the UTC date", () => {
    // 19:05 CDT Sep 26 is already Sep 27 in UTC.
    const p = buildExportProvenance({ kind: "shared", recordCount: 1, now: new Date("2026-09-27T00:05:00Z") });
    expect(provenanceFileSuffix(p)).toBe("all-dates-shared-generated-2026-09-26");
  });

  it("uses the rangeLabel-independent bounds (override label does not leak into the filename)", () => {
    const p = buildExportProvenance({
      kind: "local",
      dateFrom: "2026-09-01",
      rangeLabel: "Custom label, with spaces",
      recordCount: 1,
      now: new Date("2026-09-27T00:05:00Z"),
    });
    expect(provenanceFileSuffix(p)).toBe("from-2026-09-01-local-generated-2026-09-26");
  });

  it("produces filename-safe output", () => {
    const p = buildExportProvenance({
      kind: "shared-fallback-local",
      shopId: "weird / id",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      recordCount: 1,
      now: new Date("2026-09-27T00:05:00Z"),
    });
    expect(provenanceFileSuffix(p)).toMatch(/^[a-z0-9_-]+$/);
  });
});

// ---------------------------------------------------------------------------
// shopSlugForFilename
// ---------------------------------------------------------------------------

describe("shopSlugForFilename", () => {
  it("lowercases and hyphenates plain ASCII names", () => {
    expect(shopSlugForFilename("Acme Pest Control")).toBe("acme-pest-control");
  });

  it("collapses runs of punctuation/whitespace into one hyphen and trims edge hyphens", () => {
    expect(shopSlugForFilename("  Bugs & Co., LLC!!  ")).toBe("bugs-co-llc");
    expect(shopSlugForFilename("--A--B--")).toBe("a-b");
    expect(shopSlugForFilename("a\t\nb")).toBe("a-b");
  });

  it("keeps digits", () => {
    expect(shopSlugForFilename("Pest 911 / 24x7")).toBe("pest-911-24x7");
  });

  it("strips diacritics instead of replacing them with hyphens (#64)", () => {
    expect(shopSlugForFilename("Peña Pest")).toBe("pena-pest");
    expect(shopSlugForFilename("Café Crème Exterminators")).toBe("cafe-creme-exterminators");
    expect(shopSlugForFilename("Ünïcödé Ñame")).toBe("unicode-name");
  });

  it("handles precomposed and decomposed input identically", () => {
    expect(shopSlugForFilename("Pen\u0303a")).toBe(shopSlugForFilename("Pe\u00f1a"));
  });

  it("transliterates letters that don't decompose under NFKD", () => {
    expect(shopSlugForFilename("Straße")).toBe("strasse");
    expect(shopSlugForFilename("Ærø Œuvre")).toBe("aero-oeuvre");
    expect(shopSlugForFilename("Łódź Đak")).toBe("lodz-dak");
    expect(shopSlugForFilename("Þór Ðóttir")).toBe("thor-dottir");
  });

  it("transliterates uppercase forms (lowercased first)", () => {
    expect(shopSlugForFilename("ØRSTED ÆBLE ŁUK")).toBe("orsted-aeble-luk");
  });

  it("expands compatibility characters via NFKD", () => {
    expect(shopSlugForFilename("ﬁne Pest")).toBe("fine-pest");
    expect(shopSlugForFilename("Ｆｕｌｌ Width")).toBe("full-width");
  });

  it("returns an empty string when nothing sluggable survives", () => {
    expect(shopSlugForFilename("東京")).toBe("");
    expect(shopSlugForFilename("Москва")).toBe("");
    expect(shopSlugForFilename("!!!")).toBe("");
    expect(shopSlugForFilename("")).toBe("");
    expect(shopSlugForFilename("   ")).toBe("");
  });

  it("keeps the Latin part of mixed-script names", () => {
    expect(shopSlugForFilename("東京 Pest Co")).toBe("pest-co");
  });

  it("caps the slug at 40 characters", () => {
    const long = "a".repeat(60);
    expect(shopSlugForFilename(long)).toBe("a".repeat(40));
    expect(shopSlugForFilename("Extremely Long Pest Control Company Name That Goes On").length).toBeLessThanOrEqual(40);
  });

  it("does not leave a trailing hyphen when the 40-char cut lands on a separator", () => {
    // 39 letters + space + more: the cut keeps "…a-" and the trailing hyphen must be trimmed.
    const slug = shopSlugForFilename(`${"a".repeat(39)} bbbb`);
    expect(slug).toBe("a".repeat(39));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("only ever outputs [a-z0-9-] with no leading/trailing hyphen", () => {
    for (const name of ["Peña Pest", "Straße & Söhne", "東京 Pest", "  -x-  ", "A.B.C. 123"]) {
      const slug = shopSlugForFilename(name);
      expect(slug).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/);
    }
  });
});
