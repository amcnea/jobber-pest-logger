import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_EPA_LABEL } from "./catalog";
import { downloadCsv, logsToCsv, TDA_CSV_COLUMNS } from "./csv";
import type { ExportProvenance } from "./exportProvenance";
import type { AppliedProduct, ApplicationLog } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 parser (quoted fields, "" escapes, CRLF/LF/CR inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function col(name: (typeof TDA_CSV_COLUMNS)[number]): number {
  const i = TDA_CSV_COLUMNS.indexOf(name);
  if (i < 0) throw new Error(`unknown column ${name}`);
  return i;
}

function product(overrides: Partial<AppliedProduct> = {}): AppliedProduct {
  return {
    lineId: "line-1",
    catalogId: "shop-product-1",
    name: "Real Pesticide",
    epaRegNo: "1234-56",
    is25b: false,
    isExample: false,
    method: "rtu",
    rtuAmount: "",
    rtuUnit: "",
    mixingRate: "",
    percentAi: "",
    mixedTotal: "",
    mixedUnit: "",
    deviceCount: "",
    ...overrides,
  };
}

function makeLog(overrides: Partial<ApplicationLog> = {}): ApplicationLog {
  return {
    id: "log-1",
    createdAt: "2026-09-26T12:00:00-05:00",
    sampleData: false,
    jobberJobNumber: "",
    jobberAddress: "",
    customerBillingName: "Jane Doe",
    customerBillingAddress: "1 Main St",
    serviceAddress: "2 Oak Ave",
    poleLocation: "",
    products: [],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-26",
    personnel: [],
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

/** Parse logsToCsv output and return the data rows (header dropped). */
function dataRows(logs: ApplicationLog[]): string[][] {
  const [, ...rows] = parseCsv(logsToCsv(logs));
  return rows;
}

function singleRow(log: ApplicationLog): string[] {
  const rows = dataRows([log]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** The raw (still-escaped) CSV text of the first data row. */
function rawRow(log: ApplicationLog): string {
  const lines = logsToCsv([log]).split("\r\n");
  return lines[1];
}

// ---------------------------------------------------------------------------
// TDA_CSV_COLUMNS
// ---------------------------------------------------------------------------

describe("TDA_CSV_COLUMNS", () => {
  it("has 36 unique columns", () => {
    expect(TDA_CSV_COLUMNS).toHaveLength(36);
    expect(new Set(TDA_CSV_COLUMNS).size).toBe(TDA_CSV_COLUMNS.length);
  });

  it("starts with customer billing name and ends with the optional (non-TDA) Jobber columns", () => {
    expect(TDA_CSV_COLUMNS[0]).toBe("Customer billing name");
    expect(TDA_CSV_COLUMNS.at(-2)).toBe("Jobber job # (optional, not TDA-required)");
    expect(TDA_CSV_COLUMNS.at(-1)).toBe("Jobber address paste (optional, not TDA-required)");
  });
});

// ---------------------------------------------------------------------------
// logsToCsv — structure
// ---------------------------------------------------------------------------

describe("logsToCsv structure", () => {
  it("emits only the header row (CRLF-terminated) for empty input", () => {
    const csv = logsToCsv([]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(2); // header + trailing empty
    expect(parseCsv(csv)).toEqual([[...TDA_CSV_COLUMNS]]);
  });

  it("header round-trips exactly through a CSV parser", () => {
    const [header] = parseCsv(logsToCsv([makeLog()]));
    expect(header).toEqual([...TDA_CSV_COLUMNS]);
  });

  it("emits one row per log, in order, with one cell per column", () => {
    const logs = [
      makeLog({ id: "a", customerBillingName: "First" }),
      makeLog({ id: "b", customerBillingName: "Second" }),
      makeLog({ id: "c", customerBillingName: "Third" }),
    ];
    const rows = dataRows(logs);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveLength(TDA_CSV_COLUMNS.length);
    expect(rows.map((r) => r[col("Customer billing name")])).toEqual(["First", "Second", "Third"]);
  });

  it("uses CRLF between records and ends with a trailing CRLF", () => {
    const csv = logsToCsv([makeLog(), makeLog()]);
    expect(csv.endsWith("\r\n")).toBe(true);
    // No bare LF record separators.
    expect(csv.replaceAll("\r\n", "")).not.toMatch(/\n/);
    expect(csv.split("\r\n")).toHaveLength(4);
  });

  it("maps the basic log fields to their columns", () => {
    const row = singleRow(
      makeLog({
        customerBillingName: "Jane Doe",
        customerBillingAddress: "1 Main St",
        serviceAddress: "2 Oak Ave",
        poleLocation: "Pole 7",
        targetPestOrPurpose: "Fire ants",
        dateUsed: "2026-09-26",
        shopTpclNumber: "12345",
        shopTpclLetter: "B",
        jobberJobNumber: "J-99",
        jobberAddress: "2 Oak Ave, Austin TX",
      }),
    );
    expect(row[col("Customer billing name")]).toBe("Jane Doe");
    expect(row[col("Customer billing address")]).toBe("1 Main St");
    expect(row[col("Service address")]).toBe("2 Oak Ave");
    expect(row[col("Pole location (utility-pole retreatment)")]).toBe("Pole 7");
    expect(row[col("Target pest or purpose")]).toBe("Fire ants");
    expect(row[col("Date used")]).toBe("2026-09-26");
    expect(row[col("Shop TPCL number")]).toBe("12345");
    expect(row[col("Shop TPCL letter")]).toBe("B");
    expect(row[col("Jobber job # (optional, not TDA-required)")]).toBe("J-99");
    expect(row[col("Jobber address paste (optional, not TDA-required)")]).toBe("2 Oak Ave, Austin TX");
  });

  it("leaves product, personnel and termite columns blank for a minimal log", () => {
    const row = singleRow(makeLog());
    const blanks = [
      "Pesticide names",
      "EPA registration numbers (blank if 25(b) / unregistered; example seeds labeled)",
      "25(b) or unregistered products",
      "Devices used",
      "Device counts",
      "Person applying — name",
      "Person supervising — license number",
      "Termite work",
      "Example catalog items (not real EPA numbers)",
    ] as const;
    for (const name of blanks) expect(row[col(name)]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// logsToCsv — escaping
// ---------------------------------------------------------------------------

describe("logsToCsv escaping", () => {
  it("leaves plain values unquoted", () => {
    expect(rawRow(makeLog({ customerBillingName: "Jane Doe" })).startsWith("Jane Doe,")).toBe(true);
  });

  it("quotes values containing commas", () => {
    const log = makeLog({ customerBillingAddress: "1 Main St, Austin, TX" });
    expect(rawRow(log)).toContain('"1 Main St, Austin, TX"');
    expect(singleRow(log)[col("Customer billing address")]).toBe("1 Main St, Austin, TX");
  });

  it('quotes values containing double quotes and doubles the quotes', () => {
    const log = makeLog({ customerBillingName: 'Bob "The Bug Guy" Smith' });
    expect(rawRow(log).startsWith('"Bob ""The Bug Guy"" Smith",')).toBe(true);
    expect(singleRow(log)[col("Customer billing name")]).toBe('Bob "The Bug Guy" Smith');
  });

  it("quotes values containing LF, CR, or CRLF and preserves them", () => {
    for (const value of ["line1\nline2", "line1\rline2", "line1\r\nline2"]) {
      const log = makeLog({ serviceAddress: value });
      expect(logsToCsv([log])).toContain(`"${value}"`);
      const rows = dataRows([log]);
      expect(rows).toHaveLength(1);
      expect(rows[0][col("Service address")]).toBe(value);
    }
  });

  it("round-trips a value mixing commas, quotes and newlines", () => {
    const nasty = 'He said, "hi"\r\nthen left, "bye"';
    expect(singleRow(makeLog({ targetPestOrPurpose: nasty }))[col("Target pest or purpose")]).toBe(nasty);
  });

  it("keeps empty values as empty unquoted cells", () => {
    const log = makeLog({ customerBillingName: "", customerBillingAddress: "" });
    expect(rawRow(log).startsWith(",,")).toBe(true);
  });

  it("passes non-ASCII text through unchanged", () => {
    const log = makeLog({ customerBillingName: "Peña Pest — 東京 🐜" });
    expect(singleRow(log)[col("Customer billing name")]).toBe("Peña Pest — 東京 🐜");
  });

  describe("spreadsheet formula neutralization", () => {
    it.each(["=SUM(A1:A2)", "+1+1", "-1+1", "@SUM(A1)"])(
      "prefixes %s with an apostrophe and quotes it",
      (value) => {
        const log = makeLog({ customerBillingName: value });
        expect(rawRow(log).startsWith(`"'${value}",`)).toBe(true);
        expect(singleRow(log)[col("Customer billing name")]).toBe(`'${value}`);
      },
    );

    it("neutralizes formulas preceded by whitespace (spaces, tab)", () => {
      expect(singleRow(makeLog({ customerBillingName: "  =1+1" }))[0]).toBe("'  =1+1");
      expect(singleRow(makeLog({ customerBillingName: "\t=1+1" }))[0]).toBe("'\t=1+1");
    });

    it("neutralizes a formula that also needs quote escaping", () => {
      const value = '=HYPERLINK("http://evil.example","click, here")';
      const log = makeLog({ customerBillingName: value });
      expect(rawRow(log).startsWith(`"'=HYPERLINK(""http://evil.example"",""click, here"")",`)).toBe(true);
      expect(singleRow(log)[0]).toBe(`'${value}`);
    });

    it("also neutralizes leading-minus values such as negative numbers", () => {
      expect(singleRow(makeLog({ poleLocation: "-5" }))[col("Pole location (utility-pole retreatment)")]).toBe(
        "'-5",
      );
    });

    it("does not touch formula characters that are not leading", () => {
      const log = makeLog({ customerBillingName: "a=b+c-d@e" });
      expect(rawRow(log).startsWith("a=b+c-d@e,")).toBe(true);
    });

    it("quotes values that already start with an apostrophe", () => {
      const log = makeLog({ customerBillingName: "'tis the season" });
      expect(rawRow(log).startsWith(`"'tis the season",`)).toBe(true);
      expect(singleRow(log)[0]).toBe("'tis the season");
    });

    it("neutralizes formula-like values in every column, e.g. date and Jobber fields", () => {
      const row = singleRow(makeLog({ dateUsed: "=NOW()", jobberJobNumber: "+123" }));
      expect(row[col("Date used")]).toBe("'=NOW()");
      expect(row[col("Jobber job # (optional, not TDA-required)")]).toBe("'+123");
    });
  });
});

// ---------------------------------------------------------------------------
// logsToCsv — products
// ---------------------------------------------------------------------------

describe("logsToCsv products", () => {
  const EPA_COL = col("EPA registration numbers (blank if 25(b) / unregistered; example seeds labeled)");
  const B25_COL = col("25(b) or unregistered products");
  const EXAMPLE_COL = col("Example catalog items (not real EPA numbers)");

  it("lists a registered pesticide name and EPA number", () => {
    const row = singleRow(makeLog({ products: [product({ name: "Termidor SC", epaRegNo: "7969-210" })] }));
    expect(row[col("Pesticide names")]).toBe("Termidor SC");
    expect(row[EPA_COL]).toBe("7969-210");
    expect(row[B25_COL]).toBe("");
    expect(row[EXAMPLE_COL]).toBe("");
  });

  it("joins multiple pesticides with '; '", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "B", epaRegNo: "222-2" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("A; B");
    expect(row[EPA_COL]).toBe("111-1; 222-2");
  });

  it("blanks the EPA number and lists the product under 25(b) when is25b", () => {
    const row = singleRow(
      makeLog({ products: [product({ name: "Cedar Oil", is25b: true, epaRegNo: "999-9" })] }),
    );
    expect(row[col("Pesticide names")]).toBe("Cedar Oil");
    expect(row[EPA_COL]).toBe("");
    expect(row[B25_COL]).toBe("Cedar Oil");
  });

  it("treats a pesticide with no EPA number as unregistered", () => {
    const row = singleRow(makeLog({ products: [product({ name: "Mystery", epaRegNo: null })] }));
    expect(row[EPA_COL]).toBe("");
    expect(row[B25_COL]).toBe("Mystery");
  });

  it("labels example seeds instead of printing an EPA number and lists them in the example column", () => {
    const row = singleRow(
      makeLog({
        products: [product({ name: "Example RTU insecticide", catalogId: "example-rtu-insecticide", epaRegNo: null, isExample: true })],
      }),
    );
    expect(row[EPA_COL]).toBe(EXAMPLE_EPA_LABEL);
    // Example seeds are not reported as 25(b)/unregistered real products.
    expect(row[B25_COL]).toBe("");
    expect(row[EXAMPLE_COL]).toBe(`Example RTU insecticide: ${EXAMPLE_EPA_LABEL}`);
  });

  it("never prints a SAMPLE-* EPA number, even when isExample is false", () => {
    const row = singleRow(
      makeLog({ products: [product({ name: "Seed", epaRegNo: "SAMPLE-0001", isExample: false })] }),
    );
    expect(row[EPA_COL]).toBe(EXAMPLE_EPA_LABEL);
    expect(logsToCsv([makeLog({ products: [product({ epaRegNo: "SAMPLE-0001" })] })]).split("\r\n")[1]).not.toContain(
      "SAMPLE-0001",
    );
    expect(row[EXAMPLE_COL]).toBe(`Seed: ${EXAMPLE_EPA_LABEL}`);
  });

  it("treats sample-/example- catalog ids as examples even when isExample is false", () => {
    for (const catalogId of ["sample-foo", "example-bar"]) {
      const row = singleRow(
        makeLog({ products: [product({ name: "X", catalogId, isExample: false, epaRegNo: "123-4" })] }),
      );
      expect(row[EPA_COL]).toBe(EXAMPLE_EPA_LABEL);
      expect(row[EXAMPLE_COL]).toBe(`X: ${EXAMPLE_EPA_LABEL}`);
    }
  });

  it("puts devices in the device columns, not the pesticide/EPA columns", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "Bait Station", method: "device", epaRegNo: "555-5", deviceCount: "12" }),
          product({ lineId: "2", name: "Glue Board", method: "device", epaRegNo: null, deviceCount: "" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("");
    expect(row[EPA_COL]).toBe("");
    expect(row[B25_COL]).toBe("");
    expect(row[col("Devices used")]).toBe("Bait Station; Glue Board");
    expect(row[col("Device counts")]).toBe("Bait Station: 12; Glue Board");
  });

  it("keeps Devices used and Device counts aligned slot for slot when a device has no name", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "Bait Station", method: "device", epaRegNo: null, deviceCount: "12" }),
          product({ lineId: "2", name: "", method: "device", epaRegNo: null, deviceCount: "3" }),
          product({ lineId: "3", name: "Glue Board", method: "device", epaRegNo: null, deviceCount: "5" }),
        ],
      }),
    );
    expect(row[col("Devices used")]).toBe("Bait Station; ; Glue Board");
    expect(row[col("Device counts")]).toBe("Bait Station: 12; : 3; Glue Board: 5");
    expect(row[col("Devices used")].split("; ")).toHaveLength(row[col("Device counts")].split("; ").length);
  });

  it("keeps an empty slot in both device columns for an unnamed device with no count", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "", method: "device", epaRegNo: null, deviceCount: "" }),
          product({ lineId: "2", name: "Glue Board", method: "device", epaRegNo: null, deviceCount: "5" }),
        ],
      }),
    );
    expect(row[col("Devices used")]).toBe("; Glue Board");
    expect(row[col("Device counts")]).toBe("; Glue Board: 5");
  });

  it("leaves both device cells blank when every device is unnamed with no count", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "", method: "device", epaRegNo: null, deviceCount: "" }),
          product({ lineId: "2", name: "", method: "device", epaRegNo: null, deviceCount: "" }),
        ],
      }),
    );
    expect(row[col("Devices used")]).toBe("");
    expect(row[col("Device counts")]).toBe("");
  });

  it("keeps device slots aligned when only some devices have counts", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", method: "device", epaRegNo: null, deviceCount: "" }),
          product({ lineId: "2", name: "", method: "device", epaRegNo: null, deviceCount: "" }),
          product({ lineId: "3", name: "C", method: "device", epaRegNo: null, deviceCount: "2" }),
        ],
      }),
    );
    expect(row[col("Devices used")]).toBe("A; ; C");
    expect(row[col("Device counts")]).toBe("A; ; C: 2");
  });

  it("labels example devices in the device columns", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({
            name: "Example insect monitor",
            catalogId: "example-insect-monitor",
            method: "device",
            epaRegNo: null,
            isExample: true,
            deviceCount: "3",
          }),
        ],
      }),
    );
    expect(row[col("Devices used")]).toBe(`Example insect monitor (${EXAMPLE_EPA_LABEL})`);
    expect(row[col("Device counts")]).toBe(`Example insect monitor: 3 (${EXAMPLE_EPA_LABEL})`);
    expect(row[EXAMPLE_COL]).toBe(`Example insect monitor: ${EXAMPLE_EPA_LABEL}`);
  });

  it("reports RTU totals only for RTU pesticides with an amount, trimming a missing unit", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", method: "rtu", rtuAmount: "16", rtuUnit: "fl oz" }),
          product({ lineId: "2", name: "B", method: "rtu", rtuAmount: "2", rtuUnit: "" }),
          product({ lineId: "3", name: "C", method: "rtu", rtuAmount: "", rtuUnit: "gal" }),
          product({ lineId: "4", name: "D", method: "mixed", rtuAmount: "9", rtuUnit: "gal" }),
        ],
      }),
    );
    expect(row[col("RTU total amount (AI % unchanged)")]).toBe("A: 16 fl oz; B: 2");
  });

  it("reports mixing rate, percent AI and mixed totals only for mixed pesticides", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({
            lineId: "1",
            name: "Conc",
            method: "mixed",
            mixingRate: "0.8 oz/gal",
            percentAi: "0.06",
            mixedTotal: "3",
            mixedUnit: "gal",
          }),
          product({ lineId: "2", name: "Other", method: "mixed", percentAi: "1.5", mixedTotal: "5", mixedUnit: "" }),
          product({ lineId: "3", name: "Rtu", method: "rtu", mixingRate: "9", percentAi: "9", mixedTotal: "9" }),
        ],
      }),
    );
    expect(row[col("Mixing rate")]).toBe("Conc: 0.8 oz/gal");
    expect(row[col("Percent AI")]).toBe("Conc: 0.06%; Other: 1.5%");
    expect(row[col("Total material applied (mixed)")]).toBe("Conc: 3 gal; Other: 5");
  });

  it("escapes product names containing commas/quotes inside joined cells", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: 'Brand "X", 2%', epaRegNo: "1-1" }),
          product({ lineId: "2", name: "Plain", epaRegNo: "2-2" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe('Brand "X", 2%; Plain');
  });

  it("keeps the EPA column aligned with pesticide names when a 25(b) product is in the middle", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "B", epaRegNo: null, is25b: true }),
          product({ lineId: "3", name: "C", epaRegNo: "333-3" }),
        ],
      }),
    );
    const names = row[col("Pesticide names")].split("; ");
    const epas = row[EPA_COL].split("; ");
    expect(epas).toHaveLength(names.length);
    expect(epas[names.indexOf("C")]).toBe("333-3");
  });

  it("renders a blank slot for a 25(b) product between registered ones", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "B", epaRegNo: null, is25b: true }),
          product({ lineId: "3", name: "C", epaRegNo: "333-3" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("A; B; C");
    expect(row[EPA_COL]).toBe("111-1; ; 333-3");
  });

  it("keeps leading and trailing blank slots for 25(b) / unregistered products", () => {
    const leading = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "B", epaRegNo: null, is25b: true }),
          product({ lineId: "2", name: "C", epaRegNo: "333-3" }),
        ],
      }),
    );
    expect(leading[EPA_COL]).toBe("; 333-3");
    const trailing = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "U", epaRegNo: null }),
        ],
      }),
    );
    expect(trailing[EPA_COL]).toBe("111-1; ");
  });

  it("leaves the EPA cell fully blank (not '; ') when every pesticide is 25(b) / unregistered", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "B", epaRegNo: null, is25b: true }),
          product({ lineId: "2", name: "U", epaRegNo: null }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("B; U");
    expect(row[EPA_COL]).toBe("");
    expect(row[B25_COL]).toBe("B; U");
  });

  it("keeps example-seed labels in their own slot alongside blank 25(b) slots", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "Ex", catalogId: "example-rtu-insecticide", epaRegNo: null, isExample: true }),
          product({ lineId: "2", name: "B", epaRegNo: null, is25b: true }),
          product({ lineId: "3", name: "C", epaRegNo: "333-3" }),
        ],
      }),
    );
    expect(row[EPA_COL]).toBe(`${EXAMPLE_EPA_LABEL}; ; 333-3`);
  });

  it("keeps an empty name slot for an unnamed pesticide so names align with EPA numbers", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "", epaRegNo: "222-2" }),
          product({ lineId: "3", name: "C", epaRegNo: "333-3" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("A; ; C");
    expect(row[EPA_COL]).toBe("111-1; 222-2; 333-3");
    expect(row[col("Pesticide names")].split("; ")).toHaveLength(row[EPA_COL].split("; ").length);
  });

  it("keeps leading/trailing empty name slots for unnamed pesticides", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "B", epaRegNo: "222-2" }),
          product({ lineId: "3", name: "", epaRegNo: "333-3" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("; B; ");
    expect(row[EPA_COL]).toBe("111-1; 222-2; 333-3");
  });

  it("leaves the Pesticide names cell blank (not '; ') when every pesticide is unnamed", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "", epaRegNo: "222-2" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("");
    expect(row[EPA_COL]).toBe("111-1; 222-2");
  });

  it("aligns an unnamed pesticide that is also 25(b) (blank in both columns)", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "", epaRegNo: null, is25b: true }),
          product({ lineId: "3", name: "C", epaRegNo: "333-3" }),
        ],
      }),
    );
    expect(row[col("Pesticide names")]).toBe("A; ; C");
    expect(row[EPA_COL]).toBe("111-1; ; 333-3");
  });

  it("ignores devices when building EPA slots", () => {
    const row = singleRow(
      makeLog({
        products: [
          product({ lineId: "1", name: "A", epaRegNo: "111-1" }),
          product({ lineId: "2", name: "Station", method: "device", epaRegNo: null }),
          product({ lineId: "3", name: "C", epaRegNo: "333-3" }),
        ],
      }),
    );
    expect(row[EPA_COL]).toBe("111-1; 333-3");
  });
});

// ---------------------------------------------------------------------------
// logsToCsv — personnel
// ---------------------------------------------------------------------------

describe("logsToCsv personnel", () => {
  it("maps each role to its name and license columns", () => {
    const row = singleRow(
      makeLog({
        personnel: [
          { role: "supervising", name: "Sam Super", licenseNumber: "S-2" },
          { role: "applying", name: "Alice Apply", licenseNumber: "A-1" },
          { role: "receiving_training", name: "Tom Trainee", licenseNumber: "T-3" },
        ],
      }),
    );
    expect(row[col("Person applying — name")]).toBe("Alice Apply");
    expect(row[col("Person applying — license number")]).toBe("A-1");
    expect(row[col("Person supervising — name")]).toBe("Sam Super");
    expect(row[col("Person supervising — license number")]).toBe("S-2");
    expect(row[col("Person receiving training — name")]).toBe("Tom Trainee");
    expect(row[col("Person receiving training — license number")]).toBe("T-3");
  });

  it("leaves missing roles blank", () => {
    const row = singleRow(makeLog({ personnel: [{ role: "applying", name: "Solo", licenseNumber: "L-1" }] }));
    expect(row[col("Person applying — name")]).toBe("Solo");
    expect(row[col("Person supervising — name")]).toBe("");
    expect(row[col("Person supervising — license number")]).toBe("");
    expect(row[col("Person receiving training — name")]).toBe("");
  });

  it("uses the first person listed for a role", () => {
    const row = singleRow(
      makeLog({
        personnel: [
          { role: "applying", name: "First", licenseNumber: "1" },
          { role: "applying", name: "Second", licenseNumber: "2" },
        ],
      }),
    );
    expect(row[col("Person applying — name")]).toBe("First");
  });
});

// ---------------------------------------------------------------------------
// logsToCsv — termite
// ---------------------------------------------------------------------------

describe("logsToCsv termite", () => {
  const filledTermite: ApplicationLog["termite"] = {
    areaTreatedSqFt: "1500",
    isBait: false,
    physicalBarrierMeasurement: "120 linear ft",
    diagramNote: "North wall",
    isCommercialPretreat: true,
    tankCount: "2",
    tankGallons: "100",
    startTime: "08:00",
    stopTime: "10:30",
  };
  const termiteCols = [
    "Termite work",
    "Area treated (sq ft; blank if bait)",
    "Termite bait",
    "Physical-barrier measurement",
    "Diagram note (text, not a drawing)",
    "Commercial pretreat (not baits/wood/barriers)",
    "Pretreat tank count",
    "Pretreat tank gallons",
    "Pretreat start time",
    "Pretreat stop time",
  ] as const;

  it("blanks every termite column when isTermite is false, even if termite data is present", () => {
    const row = singleRow(makeLog({ isTermite: false, termite: { ...filledTermite, isBait: true } }));
    for (const name of termiteCols) expect(row[col(name)]).toBe("");
  });

  it("fills all termite and pretreat columns for a non-bait commercial pretreat", () => {
    const row = singleRow(makeLog({ isTermite: true, termite: filledTermite }));
    expect(row[col("Termite work")]).toBe("yes");
    expect(row[col("Area treated (sq ft; blank if bait)")]).toBe("1500");
    expect(row[col("Termite bait")]).toBe("");
    expect(row[col("Physical-barrier measurement")]).toBe("120 linear ft");
    expect(row[col("Diagram note (text, not a drawing)")]).toBe("North wall");
    expect(row[col("Commercial pretreat (not baits/wood/barriers)")]).toBe("yes");
    expect(row[col("Pretreat tank count")]).toBe("2");
    expect(row[col("Pretreat tank gallons")]).toBe("100");
    expect(row[col("Pretreat start time")]).toBe("08:00");
    expect(row[col("Pretreat stop time")]).toBe("10:30");
  });

  it("blanks the area treated for bait jobs", () => {
    const row = singleRow(makeLog({ isTermite: true, termite: { ...filledTermite, isBait: true } }));
    expect(row[col("Termite bait")]).toBe("yes");
    expect(row[col("Area treated (sq ft; blank if bait)")]).toBe("");
  });

  it("blanks pretreat tank/time columns when not a commercial pretreat", () => {
    const row = singleRow(
      makeLog({ isTermite: true, termite: { ...filledTermite, isCommercialPretreat: false } }),
    );
    expect(row[col("Commercial pretreat (not baits/wood/barriers)")]).toBe("");
    expect(row[col("Pretreat tank count")]).toBe("");
    expect(row[col("Pretreat tank gallons")]).toBe("");
    expect(row[col("Pretreat start time")]).toBe("");
    expect(row[col("Pretreat stop time")]).toBe("");
    // Non-pretreat termite fields still export.
    expect(row[col("Physical-barrier measurement")]).toBe("120 linear ft");
  });
});

// ---------------------------------------------------------------------------
// downloadCsv (DOM stubbed; default test environment is node)
// ---------------------------------------------------------------------------

describe("downloadCsv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubDom() {
    const anchor = {
      href: "",
      download: "",
      rel: "",
      style: { display: "" },
      click: vi.fn(),
      remove: vi.fn(),
    };
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return "blob:fake";
    });
    const revokeObjectURL = vi.fn();
    const appendChild = vi.fn();
    const setTimeoutFn = vi.fn((fn: () => void) => {
      fn();
      return 0;
    });
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild } });
    vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
    vi.stubGlobal("window", { setTimeout: setTimeoutFn });
    return { anchor, blobs, appendChild, revokeObjectURL };
  }

  const provenance: ExportProvenance = {
    source: "shared",
    sourceLabel: "Shared shop snapshot",
    shopId: "shop-1",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    rangeLabel: "2026-09-01 to 2026-09-30",
    recordCount: 1,
    generatedAt: "2026-09-26T19:00:00-05:00",
  };

  it("downloads the logsToCsv body as a UTF-8 text/csv blob and cleans up", async () => {
    const { anchor, blobs, appendChild, revokeObjectURL } = stubDom();
    const logs = [makeLog({ customerBillingName: "A, B" })];
    downloadCsv(logs);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("text/csv;charset=utf-8");
    expect(await blobs[0].text()).toBe(logsToCsv(logs));
    expect(anchor.href).toBe("blob:fake");
    expect(anchor.download).toBe("texas-tda-application-logs.csv");
    expect(anchor.rel).toBe("noopener");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("adds the shop slug and provenance suffix to the filename", () => {
    const { anchor } = stubDom();
    downloadCsv([makeLog()], "Peña Pest Co.", provenance);
    expect(anchor.download).toBe(
      "texas-tda-application-logs-pena-pest-co-2026-09-01_to_2026-09-30-shared-generated-2026-09-26.csv",
    );
  });

  it("omits the slug when the shop name has no ASCII-sluggable characters", () => {
    const { anchor } = stubDom();
    downloadCsv([makeLog()], "東京", provenance);
    expect(anchor.download).toBe(
      "texas-tda-application-logs-2026-09-01_to_2026-09-30-shared-generated-2026-09-26.csv",
    );
  });
});
