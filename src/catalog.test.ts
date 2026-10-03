import { describe, expect, it } from "vitest";
import {
  AMOUNT_UNITS,
  EXAMPLE_EPA_LABEL,
  EXAMPLE_SEEDS,
  activeCatalogProducts,
  catalogHasExampleProducts,
  catalogPickerLabel,
  countExampleCatalogProducts,
  countLogsWithExampleProducts,
  epaExportText,
  exportBlockedByExamples,
  inferIsExample,
  isExampleShopProduct,
  logHasExampleProducts,
  logsHaveExampleProducts,
  looksLikeSampleEpa,
  productEpaCaption,
} from "./catalog";
import { makeApplied, makeShopProduct } from "./test/fixtures";

describe("EXAMPLE_SEEDS / AMOUNT_UNITS", () => {
  it("seeds three obvious examples with no EPA numbers", () => {
    expect(EXAMPLE_SEEDS).toHaveLength(3);
    expect(EXAMPLE_SEEDS.every((p) => p.isExample && p.epaRegNo === null && !p.archived)).toBe(true);
    expect(EXAMPLE_SEEDS.map((p) => p.id)).toEqual([
      "example-rtu-insecticide",
      "example-25b-concentrate",
      "example-insect-monitor",
    ]);
    expect(AMOUNT_UNITS).toEqual(["fl oz", "gal", "oz", "lb", "each"]);
  });
});

describe("looksLikeSampleEpa", () => {
  it("matches SAMPLE- prefixes case-insensitively after trim", () => {
    expect(looksLikeSampleEpa("SAMPLE-1")).toBe(true);
    expect(looksLikeSampleEpa("  sample-xyz  ")).toBe(true);
    expect(looksLikeSampleEpa("Sample-ABC")).toBe(true);
  });

  it("rejects real EPA #s, empty, null and undefined", () => {
    expect(looksLikeSampleEpa("279-3206")).toBe(false);
    expect(looksLikeSampleEpa("")).toBe(false);
    expect(looksLikeSampleEpa("  ")).toBe(false);
    expect(looksLikeSampleEpa(null)).toBe(false);
    expect(looksLikeSampleEpa(undefined)).toBe(false);
    expect(looksLikeSampleEpa("NOT-SAMPLE-1")).toBe(false);
  });
});

describe("inferIsExample", () => {
  it("SAMPLE-* EPA wins over an explicit false", () => {
    expect(inferIsExample({ isExample: false, epaRegNo: "SAMPLE-99" })).toBe(true);
  });

  it("treats sample-/example- catalogIds and built-in seed ids as examples", () => {
    expect(inferIsExample({ catalogId: "sample-bait" })).toBe(true);
    expect(inferIsExample({ catalogId: "example-custom" })).toBe(true);
    expect(inferIsExample({ catalogId: "example-rtu-insecticide", isExample: false })).toBe(true);
    expect(inferIsExample({ catalogId: "talstar" })).toBe(false);
  });

  it("falls back to the isExample flag, defaulting to false", () => {
    expect(inferIsExample({ isExample: true })).toBe(true);
    expect(inferIsExample({ isExample: false })).toBe(false);
    expect(inferIsExample({})).toBe(false);
  });
});

describe("epaExportText", () => {
  const base = { isExample: false, epaRegNo: "279-3206", is25b: false, catalogId: "t", method: "rtu" as const };

  it("emits the example label for example / SAMPLE products", () => {
    expect(epaExportText({ ...base, isExample: true })).toBe(EXAMPLE_EPA_LABEL);
    expect(epaExportText({ ...base, epaRegNo: "SAMPLE-1" })).toBe(EXAMPLE_EPA_LABEL);
    expect(epaExportText({ ...base, catalogId: "example-rtu-insecticide" })).toBe(EXAMPLE_EPA_LABEL);
  });

  it("returns blank for devices, 25(b), and missing EPA #", () => {
    expect(epaExportText({ ...base, method: "device" })).toBe("");
    expect(epaExportText({ ...base, is25b: true })).toBe("");
    expect(epaExportText({ ...base, epaRegNo: null })).toBe("");
    expect(epaExportText({ ...base, epaRegNo: "" })).toBe("");
  });

  it("returns the EPA # for a registered pesticide", () => {
    expect(epaExportText(base)).toBe("279-3206");
  });
});

describe("productEpaCaption", () => {
  it("labels examples, devices, 25(b) and registered pesticides", () => {
    expect(productEpaCaption({ isExample: true, is25b: false, epaRegNo: null })).toBe(EXAMPLE_EPA_LABEL);
    expect(productEpaCaption({ isExample: false, is25b: false, epaRegNo: "SAMPLE-1" })).toBe(EXAMPLE_EPA_LABEL);
    expect(productEpaCaption({ isExample: false, is25b: false, epaRegNo: null, method: "device" })).toBe("device");
    expect(productEpaCaption({ isExample: false, is25b: false, epaRegNo: null, kind: "device" })).toBe("device");
    expect(productEpaCaption({ isExample: false, is25b: true, epaRegNo: null })).toBe("25(b) · no EPA #");
    expect(productEpaCaption({ isExample: false, is25b: false, epaRegNo: null })).toBe("25(b) · no EPA #");
    expect(productEpaCaption({ isExample: false, is25b: false, epaRegNo: "279-3206" })).toBe("EPA 279-3206");
  });
});

describe("catalogPickerLabel", () => {
  it("annotates devices, examples, 25(b) and registered pesticides", () => {
    expect(catalogPickerLabel(makeShopProduct({ kind: "device", name: "Glue" }))).toBe("Glue (device)");
    expect(catalogPickerLabel(makeShopProduct({ kind: "device", name: "Glue", isExample: true }))).toBe(
      "Glue (device · example)",
    );
    expect(catalogPickerLabel(makeShopProduct({ name: "Ex", isExample: true, epaRegNo: null }))).toBe(
      `Ex (${EXAMPLE_EPA_LABEL})`,
    );
    expect(catalogPickerLabel(makeShopProduct({ name: "Ess", is25b: true, epaRegNo: null }))).toBe(
      "Ess (25(b) — no EPA #)",
    );
    expect(catalogPickerLabel(makeShopProduct({ name: "T", epaRegNo: null }))).toBe("T (25(b) — no EPA #)");
    expect(catalogPickerLabel(makeShopProduct({ name: "Talstar P", epaRegNo: "279-3206" }))).toBe(
      "Talstar P (279-3206)",
    );
  });
});

describe("example detection aggregates", () => {
  const real = makeShopProduct();
  const ex = makeShopProduct({ id: "example-rtu-insecticide", name: "Ex", isExample: true, epaRegNo: null });
  const sampleEpa = makeShopProduct({ id: "odd", name: "Odd", epaRegNo: "SAMPLE-9", isExample: false });

  it("isExampleShopProduct / catalogHas / count", () => {
    expect(isExampleShopProduct(ex)).toBe(true);
    expect(isExampleShopProduct(sampleEpa)).toBe(true);
    expect(isExampleShopProduct(real)).toBe(false);
    expect(catalogHasExampleProducts([real])).toBe(false);
    expect(catalogHasExampleProducts([real, ex])).toBe(true);
    expect(countExampleCatalogProducts([real, ex, sampleEpa])).toBe(2);
  });

  it("logHasExampleProducts / logsHave / count", () => {
    const clean = [makeApplied()];
    const dirty = [makeApplied({ isExample: true, epaRegNo: null })];
    expect(logHasExampleProducts(clean)).toBe(false);
    expect(logHasExampleProducts(dirty)).toBe(true);
    expect(logHasExampleProducts([makeApplied({ catalogId: "example-rtu-insecticide", isExample: false })])).toBe(true);
    expect(logsHaveExampleProducts([{ products: clean }])).toBe(false);
    expect(logsHaveExampleProducts([{ products: clean, sampleData: true }])).toBe(true);
    expect(logsHaveExampleProducts([{ products: dirty }])).toBe(true);
    expect(countLogsWithExampleProducts([{ products: clean }, { products: dirty }, { products: clean, sampleData: true }])).toBe(2);
  });

  it("exportBlockedByExamples combines catalog and log counts", () => {
    expect(exportBlockedByExamples([real], [{ products: [makeApplied()] }])).toEqual({
      blocked: false,
      catalogExamples: 0,
      logExamples: 0,
    });
    expect(exportBlockedByExamples([ex], [{ products: [makeApplied()] }])).toEqual({
      blocked: true,
      catalogExamples: 1,
      logExamples: 0,
    });
    expect(exportBlockedByExamples([real], [{ products: [makeApplied({ isExample: true })] }])).toEqual({
      blocked: true,
      catalogExamples: 0,
      logExamples: 1,
    });
  });
});

describe("activeCatalogProducts", () => {
  it("drops archived rows and keeps active ones", () => {
    const a = makeShopProduct({ id: "a" });
    const b = makeShopProduct({ id: "b", archived: true });
    expect(activeCatalogProducts([a, b])).toEqual([a]);
    expect(activeCatalogProducts([])).toEqual([]);
  });
});
