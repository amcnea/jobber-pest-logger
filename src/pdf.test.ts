import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_EPA_LABEL } from "./catalog";
import { LAWGICAL_DISCLAIMER } from "./disclaimer";
import type { ExportProvenance } from "./exportProvenance";
import type { AppliedProduct, ApplicationLog } from "./types";

// pdf.ts exports only downloadPdf; its helpers (productLine, wrap, wrappedHeight,
// measureFooter, drawFooter, drawPageHeader) are private. They are exercised
// through downloadPdf with jspdf replaced at the module boundary by a recording
// fake, so tests assert on the text/layout calls, never on rendered PDF bytes.
//
// Fake text metrics: splitTextToSize wraps at floor(maxWidth / 2) characters
// (93 chars for the 186 mm content width); getTextWidth = 2 mm per character.

interface TextCall {
  page: number;
  text: string | string[];
  x: number;
  y: number;
  opts?: Record<string, unknown>;
}

class FakeJsPDF {
  static instances: FakeJsPDF[] = [];
  options: unknown;
  page = 1;
  pages = 1;
  fontSize = 16;
  font = { fontName: "helvetica", fontStyle: "normal" };
  textColor = "#000000";
  texts: TextCall[] = [];
  lines: { page: number; y: number }[] = [];
  saved: string[] = [];
  constructor(options: unknown) {
    this.options = options;
    FakeJsPDF.instances.push(this);
  }
  splitTextToSize(text: string, maxWidth: number): string[] {
    const n = Math.floor(maxWidth / 2);
    const out: string[] = [];
    for (const para of String(text).split("\n")) {
      if (para.length === 0) out.push("");
      for (let i = 0; i < para.length; i += n) out.push(para.slice(i, i + n));
    }
    return out;
  }
  getTextWidth(s: string) {
    return s.length * 2;
  }
  text(text: string | string[], x: number, y: number, opts?: Record<string, unknown>) {
    this.texts.push({ page: this.page, text, x, y, opts });
    return this;
  }
  line(_x1: number, y1: number) {
    this.lines.push({ page: this.page, y: y1 });
    return this;
  }
  addPage() {
    this.pages += 1;
    this.page = this.pages;
    return this;
  }
  setPage(n: number) {
    this.page = n;
    return this;
  }
  getNumberOfPages() {
    return this.pages;
  }
  getFontSize() {
    return this.fontSize;
  }
  setFontSize(n: number) {
    this.fontSize = n;
    return this;
  }
  getFont() {
    return this.font;
  }
  setFont(fontName: string, fontStyle: string) {
    this.font = { fontName, fontStyle };
    return this;
  }
  getTextColor() {
    return this.textColor;
  }
  setTextColor() {
    return this;
  }
  setDrawColor() {
    return this;
  }
  save(name: string) {
    this.saved.push(name);
  }
}

vi.mock("jspdf", () => ({ jsPDF: FakeJsPDF }));

const { downloadPdf } = await import("./pdf");

beforeEach(() => {
  FakeJsPDF.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function product(overrides: Partial<AppliedProduct> = {}): AppliedProduct {
  return {
    lineId: "l1",
    catalogId: "prod-1",
    name: "Real Pesticide",
    epaRegNo: "1234-56",
    is25b: false,
    isExample: false,
    method: "rtu",
    rtuAmount: "16",
    rtuUnit: "fl oz",
    mixingRate: "",
    percentAi: "",
    mixedTotal: "",
    mixedUnit: "gal",
    deviceCount: "",
    ...overrides,
  };
}

function makeLog(overrides: Partial<ApplicationLog> = {}): ApplicationLog {
  return {
    id: "log-1",
    createdAt: "2026-09-26T12:00:00.000Z",
    sampleData: false,
    jobberJobNumber: "",
    jobberAddress: "",
    customerBillingName: "Jane Doe",
    customerBillingAddress: "1 Main St",
    serviceAddress: "2 Oak Ave",
    poleLocation: "",
    products: [product()],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-26",
    personnel: [
      { role: "applying", name: "Alice", licenseNumber: "A-1" },
      { role: "supervising", name: "Sam", licenseNumber: "S-2" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ],
    shopTpclNumber: "12345",
    shopTpclLetter: "B",
    isTermite: false,
    termite: {
      areaTreatedSqFt: "",
      isBait: false,
      physicalBarrierMeasurement: "",
      diagramNote: "",
      isCommercialPretreat: false,
      tankCount: "",
      tankGallons: "",
      startTime: "",
      stopTime: "",
    },
    ...overrides,
  };
}

const provenance: ExportProvenance = {
  source: "shared",
  sourceLabel: "Shared shop snapshot",
  shopId: "SHOPABCD",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  rangeLabel: "2026-09-01 to 2026-09-30",
  recordCount: 1,
  generatedAt: "2026-09-26T19:05:00-05:00",
};

function render(logs: ApplicationLog[], shopName?: string, prov?: ExportProvenance): FakeJsPDF {
  downloadPdf(logs, shopName, prov);
  expect(FakeJsPDF.instances).toHaveLength(1);
  return FakeJsPDF.instances[0];
}

/** Every drawn line of text, flattened, in draw order. */
function allText(doc: FakeJsPDF): string[] {
  return doc.texts.flatMap((t) => (Array.isArray(t.text) ? t.text : [t.text]));
}

/** Body lines (drawn via wrap) for the whole document, joined back per call. */
function joinedCalls(doc: FakeJsPDF): string[] {
  return doc.texts.map((t) => (Array.isArray(t.text) ? t.text.join("") : t.text));
}

function productLines(logs: ApplicationLog[]): string[] {
  return joinedCalls(render(logs)).filter((l) => /^(RTU|Mixed|Device): /.test(l));
}

// ---------------------------------------------------------------------------
// Document setup, filename, header, footer
// ---------------------------------------------------------------------------

describe("downloadPdf document", () => {
  it("creates a letter-size mm document and saves with the default filename", () => {
    const doc = render([makeLog()]);
    expect(doc.options).toEqual({ unit: "mm", format: "letter" });
    expect(doc.saved).toEqual(["texas-tda-application-logs.pdf"]);
  });

  it("adds the provenance suffix to the filename", () => {
    const doc = render([makeLog()], "Acme", provenance);
    expect(doc.saved).toEqual([
      "texas-tda-application-logs-2026-09-01_to_2026-09-30-shared-generated-2026-09-26.pdf",
    ]);
  });

  it("draws the report title and shop name in the page header", () => {
    const text = allText(render([makeLog()], "  Acme Pest Co  "));
    expect(text[0]).toBe("Texas TDA pesticide application log");
    expect(text[1]).toBe("Acme Pest Co");
  });

  it("shows a 'shop name not set' hint when the shop name is blank or missing", () => {
    for (const name of [undefined, "", "   "]) {
      FakeJsPDF.instances = [];
      expect(allText(render([makeLog()], name))).toContain("Shop name not set — add it in Settings");
    }
  });

  it("caps a long shop name at two lines ending with an ellipsis that fits the width", () => {
    const long = "A".repeat(93 * 3);
    const doc = render([makeLog()], long);
    const header = doc.texts[1].text as string[];
    expect(header).toHaveLength(2);
    expect(header[0]).toBe("A".repeat(93));
    expect(header[1].endsWith("…")).toBe(true);
    expect(doc.getTextWidth(header[1])).toBeLessThanOrEqual(186);
  });

  it("does not add an ellipsis when the shop name fits in two lines", () => {
    const doc = render([makeLog()], "B".repeat(150));
    const header = doc.texts[1].text as string[];
    expect(header).toEqual(["B".repeat(93), "B".repeat(57)]);
  });

  it("draws the full, unmodified disclaimer and a page number on every page", () => {
    const logs = Array.from({ length: 12 }, (_, i) => makeLog({ id: `l${i}` }));
    const doc = render(logs);
    expect(doc.pages).toBeGreaterThan(1);
    for (let p = 1; p <= doc.pages; p++) {
      const onPage = doc.texts.filter((t) => t.page === p);
      const footer = onPage.find((t) => t.opts && "lineHeightFactor" in t.opts)!;
      expect((footer.text as string[]).join("")).toBe(LAWGICAL_DISCLAIMER);
      expect(onPage.some((t) => t.text === `Page ${p} of ${doc.pages}`)).toBe(true);
      // Header repeats on every page.
      expect(onPage.some((t) => t.text === "Texas TDA pesticide application log")).toBe(true);
    }
  });

  it("puts the provenance summary above the disclaimer in the footer", () => {
    const doc = render([makeLog()], "Acme", provenance);
    const footer = doc.texts.find((t) => t.opts && "lineHeightFactor" in t.opts)!;
    const joined = (footer.text as string[]).join("");
    expect(joined.startsWith("Source: shared shop snapshot · shop SHOPABCD · Range: 2026-09-01 to 2026-09-30")).toBe(true);
    expect(joined.endsWith(LAWGICAL_DISCLAIMER)).toBe(true);
  });

  it("prints the page-1 provenance block when provenance is given", () => {
    const text = joinedCalls(render([makeLog()], "Acme", provenance));
    expect(text).toContain("Source: Shared shop snapshot");
    expect(text).toContain("Shop ID: SHOPABCD");
    expect(text).toContain("Date range (date used): 2026-09-01 to 2026-09-30");
    expect(text).toContain("Records: 1");
    expect(text).toContain("Generated: 2026-09-26T19:05:00-05:00 (device-local time)");
  });

  it("omits the provenance block without provenance", () => {
    expect(joinedCalls(render([makeLog()])).some((l) => l.startsWith("Source:"))).toBe(false);
  });

  it("always prints the § 7.144 schema note", () => {
    expect(joinedCalls(render([]))).toContain(
      "Columns follow 4 TAC § 7.144(a) for Texas SPCS shops. Termite extras follow § 7.144(b) when the stop is termite work. Full disclaimer is on every page footer.",
    );
  });

  it("prints the no-logs message for an empty export", () => {
    const doc = render([]);
    expect(allText(doc)).toContain("No application logs saved on this device.");
    expect(doc.pages).toBe(1);
  });

  it("keeps all body text above the footer band on every page", () => {
    const logs = Array.from({ length: 15 }, (_, i) =>
      makeLog({ id: `l${i}`, isTermite: true, termite: { ...makeLog().termite, isCommercialPretreat: true } }),
    );
    const doc = render(logs, "Acme", provenance);
    const footerTops = new Map<number, number>();
    for (const t of doc.texts) if (t.opts && "lineHeightFactor" in t.opts) footerTops.set(t.page, t.y);
    for (const t of doc.texts) {
      if (t.opts) continue; // footer and page number
      const n = Array.isArray(t.text) ? t.text.length : 1;
      expect(t.y + (n - 1) * 5).toBeLessThan(footerTops.get(t.page)! - 2.5);
    }
  });
});

// ---------------------------------------------------------------------------
// Example-seed notes
// ---------------------------------------------------------------------------

describe("example catalog notes", () => {
  it("adds the example note and marks the log title when a log has example products", () => {
    const log = makeLog({ products: [product({ catalogId: "example-rtu-insecticide", isExample: true, epaRegNo: null })] });
    const text = joinedCalls(render([log]));
    expect(text).toContain(
      `Some products are example catalog seeds. Those rows are labeled "${EXAMPLE_EPA_LABEL}" and are not EPA registration numbers.`,
    );
    expect(text).toContain("Log 1 — 2026-09-26  [includes example catalog items]");
  });

  it("adds neither without example products", () => {
    const text = joinedCalls(render([makeLog()]));
    expect(text.some((l) => l.startsWith("Some products are example"))).toBe(false);
    expect(text).toContain("Log 1 — 2026-09-26");
  });

  it("marks only the logs that contain examples", () => {
    const ex = makeLog({ id: "b", products: [product({ epaRegNo: "SAMPLE-1" })] });
    const text = joinedCalls(render([makeLog(), ex]));
    expect(text).toContain("Log 1 — 2026-09-26");
    expect(text).toContain("Log 2 — 2026-09-26  [includes example catalog items]");
  });
});

// ---------------------------------------------------------------------------
// Per-log lines
// ---------------------------------------------------------------------------

describe("per-log lines", () => {
  it("prints the § 7.144(a) record lines", () => {
    const text = joinedCalls(render([makeLog()]));
    expect(text).toEqual(
      expect.arrayContaining([
        "Log 1 — 2026-09-26",
        "Customer billing: Jane Doe — 1 Main St",
        "Service address: 2 Oak Ave",
        "Target pest / purpose: Ants",
        "Date used: 2026-09-26",
        "Shop TPCL: 12345B",
        "Applying: Alice A-1",
        "Supervising: Sam S-2",
        "Receiving training:",
      ]),
    );
  });

  it("numbers logs in order", () => {
    const text = joinedCalls(render([makeLog({ dateUsed: "2026-09-01" }), makeLog({ id: "b", dateUsed: "2026-09-02" })]));
    expect(text.indexOf("Log 1 — 2026-09-01")).toBeLessThan(text.indexOf("Log 2 — 2026-09-02"));
  });

  it("uses '(no date)' in the title when the date is empty", () => {
    expect(joinedCalls(render([makeLog({ dateUsed: "" })]))).toContain("Log 1 — (no date)");
  });

  it("uses '(no date)' in the title when the date is whitespace-only", () => {
    expect(joinedCalls(render([makeLog({ dateUsed: "   " })]))).toContain("Log 1 — (no date)");
  });

  it("uses the same trimmed dateUsed for the title and the Date used line (#91)", () => {
    // Regression: title and "Date used:" once diverged when whitespace was trimmed in only one place.
    for (const [dateUsed, shown] of [
      ["", "(no date)"],
      ["   ", "(no date)"],
      [" 2026-09-26 ", "2026-09-26"],
    ] as const) {
      FakeJsPDF.instances = [];
      const text = joinedCalls(render([makeLog({ dateUsed })]));
      expect(text).toContain(`Log 1 — ${shown}`);
      expect(text).toContain(`Date used: ${shown}`);
    }
  });

  it("trims a padded date in the title", () => {
    expect(joinedCalls(render([makeLog({ dateUsed: " 2026-09-26 " })]))).toContain("Log 1 — 2026-09-26");
  });

  it("adds the pole location only when present", () => {
    expect(joinedCalls(render([makeLog({ poleLocation: "Pole 7" })]))).toContain("Service address: 2 Oak Ave (pole: Pole 7)");
  });

  it("omits the TPCL letter when blank", () => {
    expect(joinedCalls(render([makeLog({ shopTpclLetter: "" })]))).toContain("Shop TPCL: 12345");
  });

  it("adds a Jobber line only when a job number or address exists, joining what is present", () => {
    expect(joinedCalls(render([makeLog()])).some((l) => l.startsWith("Jobber link"))).toBe(false);
    FakeJsPDF.instances = [];
    expect(joinedCalls(render([makeLog({ jobberJobNumber: "J-9", jobberAddress: "2 Oak, Austin" })]))).toContain(
      "Jobber link (not TDA-required): J-9 — 2 Oak, Austin",
    );
    FakeJsPDF.instances = [];
    expect(joinedCalls(render([makeLog({ jobberAddress: "2 Oak, Austin" })]))).toContain(
      "Jobber link (not TDA-required): 2 Oak, Austin",
    );
  });

  it("prints blank personnel roles without trailing spaces", () => {
    const text = joinedCalls(render([makeLog({ personnel: [] })]));
    expect(text).toEqual(expect.arrayContaining(["Applying:", "Supervising:", "Receiving training:"]));
  });

  it("wraps long lines and advances y by one line height per wrapped line", () => {
    const longPest = "x".repeat(250);
    const doc = render([makeLog({ targetPestOrPurpose: longPest })]);
    const idx = doc.texts.findIndex((t) => Array.isArray(t.text) && t.text.join("") === `Target pest / purpose: ${longPest}`);
    const call = doc.texts[idx];
    expect((call.text as string[]).length).toBe(3);
    // wrap() returns y + 3 * 5, then +1 gap before the next line.
    expect(doc.texts[idx + 1].y).toBe(call.y + 3 * 5 + 1);
  });
});

// ---------------------------------------------------------------------------
// productLine (via downloadPdf)
// ---------------------------------------------------------------------------

describe("product lines", () => {
  it("RTU with EPA number, amount and unit", () => {
    expect(productLines([makeLog({ products: [product()] })])).toEqual(["RTU: Real Pesticide (EPA 1234-56) 16 fl oz"]);
  });

  it("RTU 25(b) / unregistered shows the no-EPA note", () => {
    expect(productLines([makeLog({ products: [product({ is25b: true, epaRegNo: "9-9" })] })])).toEqual([
      "RTU: Real Pesticide (25(b) / unregistered — no EPA #) 16 fl oz",
    ]);
    FakeJsPDF.instances = [];
    expect(productLines([makeLog({ products: [product({ epaRegNo: null })] })])).toEqual([
      "RTU: Real Pesticide (25(b) / unregistered — no EPA #) 16 fl oz",
    ]);
  });

  it("example seeds show the example label, never an EPA number", () => {
    const lines = productLines([
      makeLog({ products: [product({ name: "Seed", epaRegNo: "SAMPLE-0001", isExample: false })] }),
    ]);
    expect(lines).toEqual([`RTU: Seed (${EXAMPLE_EPA_LABEL}) 16 fl oz`]);
    expect(lines[0]).not.toContain("SAMPLE-0001");
  });

  it("RTU with no amount trims trailing whitespace", () => {
    expect(productLines([makeLog({ products: [product({ rtuAmount: "", rtuUnit: "" })] })])).toEqual([
      "RTU: Real Pesticide (EPA 1234-56)",
    ]);
  });

  it("mixed lines list rate, % AI and total that are present, comma-separated", () => {
    const lines = productLines([
      makeLog({
        products: [
          product({ lineId: "1", name: "A", method: "mixed", mixingRate: "0.8 oz/gal", percentAi: "0.06", mixedTotal: "3", mixedUnit: "gal" }),
          product({ lineId: "2", name: "B", method: "mixed", percentAi: "1.5", mixedTotal: "", mixedUnit: "gal" }),
          product({ lineId: "3", name: "C", method: "mixed", mixingRate: "", percentAi: "", mixedTotal: "" }),
        ],
      }),
    ]);
    expect(lines).toEqual([
      "Mixed: A (EPA 1234-56) rate 0.8 oz/gal, 0.06% AI, total 3 gal",
      "Mixed: B (EPA 1234-56) 1.5% AI",
      "Mixed: C (EPA 1234-56)",
    ]);
  });

  it("devices show name and count, with '?' when the count is blank, and no EPA", () => {
    const lines = productLines([
      makeLog({
        products: [
          product({ lineId: "1", name: "Bait Station", method: "device", epaRegNo: "555-5", deviceCount: "12" }),
          product({ lineId: "2", name: "Glue Board", method: "device", epaRegNo: null, deviceCount: "" }),
        ],
      }),
    ]);
    expect(lines).toEqual(["Device: Bait Station × 12", "Device: Glue Board × ?"]);
  });

  it("example devices carry the example label", () => {
    const lines = productLines([
      makeLog({
        products: [
          product({ name: "Example insect monitor", catalogId: "example-insect-monitor", method: "device", isExample: true, epaRegNo: null, deviceCount: "3" }),
        ],
      }),
    ]);
    expect(lines).toEqual([`Device: Example insect monitor (${EXAMPLE_EPA_LABEL}) × 3`]);
  });

  it("prints one line per product, in order", () => {
    const lines = productLines([
      makeLog({
        products: [
          product({ lineId: "1", name: "First" }),
          product({ lineId: "2", name: "Second", method: "device", deviceCount: "1" }),
          product({ lineId: "3", name: "Third", method: "mixed", mixedTotal: "1", mixedUnit: "gal" }),
        ],
      }),
    ]);
    expect(lines.map((l) => l.split(":")[0])).toEqual(["RTU", "Device", "Mixed"]);
  });
});

// ---------------------------------------------------------------------------
// Termite extras
// ---------------------------------------------------------------------------

describe("termite extras", () => {
  const termite = (o: Partial<ApplicationLog["termite"]>) => ({ ...makeLog().termite, ...o });

  it("omits the termite block for non-termite work", () => {
    expect(joinedCalls(render([makeLog({ termite: termite({ areaTreatedSqFt: "99" }) })])).some((l) => l.startsWith("Termite extras"))).toBe(false);
  });

  it("prints area (dash when blank), diagram note (dash when blank)", () => {
    const text = joinedCalls(render([makeLog({ isTermite: true })]));
    expect(text).toEqual(
      expect.arrayContaining(["Termite extras (§ 7.144(b)):", "  Area treated: — sq ft", "  Diagram note (text, not a drawing): —"]),
    );
    expect(text.some((l) => l.includes("Physical-barrier"))).toBe(false);
    expect(text.some((l) => l.includes("Commercial pretreat"))).toBe(false);
  });

  it("prints bait instead of area for bait jobs", () => {
    const text = joinedCalls(render([makeLog({ isTermite: true, termite: termite({ isBait: true, areaTreatedSqFt: "500" }) })]));
    expect(text).toContain("  Bait — area treated N/A");
    expect(text.some((l) => l.includes("Area treated:"))).toBe(false);
  });

  it("prints barrier measurement and filled pretreat details", () => {
    const text = joinedCalls(
      render([
        makeLog({
          isTermite: true,
          termite: termite({
            areaTreatedSqFt: "1500",
            physicalBarrierMeasurement: "120 ft",
            diagramNote: "North wall",
            isCommercialPretreat: true,
            tankCount: "2",
            tankGallons: "100",
            startTime: "08:00",
            stopTime: "10:30",
          }),
        }),
      ]),
    );
    expect(text).toEqual(
      expect.arrayContaining([
        "  Area treated: 1500 sq ft",
        "  Physical-barrier measurement: 120 ft",
        "  Diagram note (text, not a drawing): North wall",
        "  Commercial pretreat: tanks 2, gal 100, 08:00–10:30",
      ]),
    );
  });

  it("uses dashes for blank pretreat fields", () => {
    const text = joinedCalls(render([makeLog({ isTermite: true, termite: termite({ isCommercialPretreat: true }) })]));
    expect(text).toContain("  Commercial pretreat: tanks —, gal —, —–—");
  });
});
