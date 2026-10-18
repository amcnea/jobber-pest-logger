import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeJsPDF, pdfRecord } from "./test/fakeJsPdf";
import { uncorrectedExportLogs } from "./test/exportFixtures";
import { makeLog } from "./test/fixtures";
import { MemoryStorage } from "./test/memoryStorage";
import type { ApplicationLog, Person } from "./types";

vi.mock("jspdf", () => ({ jsPDF: FakeJsPDF }));

const { logsToCsv } = await import("./csv");
const { downloadPdf } = await import("./pdf");
const { addSetAsideCopy, buildCorrection, loadLogs, saveLogs } = await import("./storage");
const { changeHistoryCell, correctedLabel, CORRECTION_CSV_COLUMNS, changeHistoryPdfLines } = await import(
  "./correctionExport"
);

// Goldens were generated from main's csv.ts / pdf.ts (before change-history exports existed).
const GOLDEN_CSV = readFileSync(new URL("./test/golden/main-uncorrected.csv", import.meta.url), "utf8");
const GOLDEN_PDF = JSON.parse(
  readFileSync(new URL("./test/golden/main-uncorrected.pdf-calls.json", import.meta.url), "utf8"),
);
const PROVENANCE = {
  source: "local",
  sourceLabel: "This device",
  shopId: null,
  dateFrom: "",
  dateTo: "",
  rangeLabel: "All dates",
  recordCount: 5,
  generatedAt: "2026-10-17T19:00:00-05:00",
} as never;

const BANNED =
  /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const NOW = new Date(2026, 9, 17, 18, 5);

function corrected(): ApplicationLog {
  const base = makeLog({ id: "c1", dateUsed: "2026-09-09", reviewedAt: "2026-10-01T09:00:00-05:00", reviewedBy: "Ana Office" });
  const built = buildCorrection(
    base,
    { ...base, serviceAddress: "101 Main St", customerBillingName: "" },
    { changedBy: "p-ana", reason: "Wrong house number", people: PEOPLE, now: NOW },
  );
  if (!built.ok) throw new Error(built.error);
  return built.log;
}

/** Split a CSV body into rows (cells here never contain "\r\n"). */
function rows(csv: string): string[] {
  expect(csv.endsWith("\r\n")).toBe(true);
  return csv.slice(0, -2).split("\r\n");
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  FakeJsPDF.instances = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CSV change history", () => {
  it("exports uncorrected logs byte-identical to main's output", () => {
    expect(logsToCsv(uncorrectedExportLogs())).toBe(GOLDEN_CSV);
  });

  it("with a corrected log present, uncorrected rows keep main's cells byte for byte plus two empty cells", () => {
    const csv = logsToCsv([...uncorrectedExportLogs(), corrected()]);
    const [header, ...body] = rows(csv);
    const [goldenHeader, ...goldenBody] = rows(GOLDEN_CSV);
    expect(header).toBe(`${goldenHeader},${CORRECTION_CSV_COLUMNS.join(",")}`);
    expect(body).toHaveLength(goldenBody.length + 1);
    goldenBody.forEach((row, i) => expect(body[i]).toBe(`${row},,`));
    const last = body.at(-1)!;
    expect(last).toContain("101 Main St");
    expect(last.endsWith(
      ",Corrected (rev 1),Rev 1 · 2026-10-17T18:05:00-05:00 · Ana Office · Reason: Wrong house number · " +
        "Customer billing name: Pat Customer → (blank); Service address: 100 Main St → 101 Main St",
    )).toBe(true);
  });

  it("lists entries oldest first and shows the latest revision", () => {
    const once = corrected();
    const twice = buildCorrection(once, { ...once, targetPestOrPurpose: "Fire ants" }, {
      changedBy: "p-ana",
      reason: "Pest was fire ants",
      people: PEOPLE,
      now: new Date(2026, 9, 17, 18, 30),
    });
    if (!twice.ok) throw new Error(twice.error);
    expect(correctedLabel(twice.log)).toBe("Corrected (rev 2)");
    const cell = changeHistoryCell(twice.log);
    expect(cell.indexOf("Rev 1 ·")).toBeLessThan(cell.indexOf(" | Rev 2 · 2026-10-17T18:30:00-05:00"));
    expect(cell).toContain("Target pest or purpose: Ants → Fire ants");
  });

  it("does not export set-aside device copies", () => {
    const log = makeLog({ id: "s1" });
    expect(saveLogs([log])).toBe(true);
    addSetAsideCopy({ ...log, serviceAddress: "SET ASIDE ONLY 77" }, { setAsideBy: "p-ana", people: PEOPLE, now: NOW });
    const csv = logsToCsv(loadLogs());
    expect(csv).not.toContain("SET ASIDE ONLY 77");
    downloadPdf(loadLogs(), "Acme", PROVENANCE);
    expect(JSON.stringify(FakeJsPDF.instances[0].texts)).not.toContain("SET ASIDE ONLY 77");
  });

  it("new export wording avoids banned terms", () => {
    const log = corrected();
    for (const s of [...CORRECTION_CSV_COLUMNS, correctedLabel(log), changeHistoryCell(log), ...changeHistoryPdfLines(log)]) {
      expect(s).not.toMatch(BANNED);
    }
  });
});

describe("PDF change history", () => {
  it("draws uncorrected logs exactly as main did (every text, rule and filename)", () => {
    downloadPdf(uncorrectedExportLogs(), "Acme Pest", PROVENANCE);
    expect(JSON.parse(JSON.stringify(pdfRecord(FakeJsPDF.instances[0])))).toEqual(GOLDEN_PDF);
  });

  it("marks a corrected log and lists its changes; earlier uncorrected logs are unchanged", () => {
    downloadPdf([...uncorrectedExportLogs(), corrected()], "Acme Pest", PROVENANCE);
    const texts = FakeJsPDF.instances[0].texts;
    const flat = texts.map((t) => (Array.isArray(t.text) ? t.text.join("") : t.text));
    const titleIdx = flat.findIndex((t) => t.startsWith("Log 6 — 2026-09-09"));
    expect(flat[titleIdx]).toBe("Log 6 — 2026-09-09  [Corrected (rev 1)]");
    // Everything drawn before the corrected log matches main's output call for call.
    expect(JSON.parse(JSON.stringify(texts.slice(0, titleIdx)))).toEqual(GOLDEN_PDF.texts.slice(0, titleIdx));
    const after = flat.slice(titleIdx);
    expect(after).toContain("Change history (original values kept):");
    expect(after).toContain("  Rev 1 — 2026-10-17T18:05:00-05:00 — Ana Office — Reason: Wrong house number");
    expect(after).toContain("    Customer billing name: Pat Customer -> (blank)");
    expect(after).toContain("    Service address: 100 Main St -> 101 Main St");
    expect(flat.join("\n")).not.toContain("→");
  });
});

const {
  DEVICE_NAME_LABEL,
  fieldLabel,
  LOG_FIELD_LABELS,
  PERSONNEL_FIELD_LABELS,
  PRODUCT_FIELD_LABELS,
  REUPLOADED_LABEL,
  changeStatusLabel,
  TERMITE_FIELD_LABELS,
} = await import("./correctionExport");
const { TDA_CSV_COLUMNS } = await import("./csv");
const { buildReupload } = await import("./storage");
const { makeApplied } = await import("./test/fixtures");

describe("readable change-history labels", () => {
  it("every label is an existing CSV export column label", () => {
    const columns = new Set<string>(TDA_CSV_COLUMNS);
    for (const label of [
      ...Object.values(LOG_FIELD_LABELS),
      ...Object.values(TERMITE_FIELD_LABELS),
      ...Object.values(PERSONNEL_FIELD_LABELS),
      ...Object.values(PRODUCT_FIELD_LABELS),
      DEVICE_NAME_LABEL,
    ]) {
      expect(columns.has(label), label).toBe(true);
    }
  });

  const v = {
    products: [
      makeApplied({ lineId: "a", name: "Talstar P" }),
      makeApplied({ lineId: "b", name: "  " }),
      makeApplied({ lineId: "c", name: "Glue board", method: "device", epaRegNo: null, rtuAmount: "", deviceCount: "3" }),
    ],
  };

  it("ignores inherited keys like constructor / toString (#188)", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(fieldLabel(key)).toBe(key);
      expect(fieldLabel(`termite.${key}`)).toBe(`termite.${key}`);
      expect(fieldLabel(`personnel[applying].${key}`)).toBe(`personnel[applying].${key}`);
      expect(fieldLabel(`personnel[${key}#2].name`)).toBe(`personnel[${key}#2].name`);
      expect(fieldLabel(`personnel[applying#2].${key}`)).toBe(`personnel[applying#2].${key}`);
      expect(fieldLabel(`products[a].${key}`, v)).toBe(`products[a].${key}`);
    }
  });

  it("maps top-level, termite and personnel paths", () => {
    expect(fieldLabel("serviceAddress")).toBe("Service address");
    expect(fieldLabel("termite.tankCount")).toBe("Pretreat tank count");
    expect(fieldLabel("personnel[applying].licenseNumber")).toBe("Person applying — license number");
  });

  it("product lines read '<product name>: <column>', 'Product N' when the name is blank", () => {
    expect(fieldLabel("products[a].rtuAmount", v)).toBe("Talstar P: RTU total amount (AI % unchanged)");
    expect(fieldLabel("products[a].name", v)).toBe("Talstar P: Pesticide names");
    expect(fieldLabel("products[b].mixingRate", v)).toBe("Product 2: Mixing rate");
    expect(fieldLabel("products[c].name", v)).toBe("Glue board: Devices used");
    expect(fieldLabel("products[c].deviceCount", v)).toBe("Glue board: Device counts");
  });

  it("a removed line takes its name from the version before the change", () => {
    expect(fieldLabel("products[a].rtuAmount", { products: [] }, v)).toBe("Talstar P: RTU total amount (AI % unchanged)");
  });

  it("#175: method / catalogId and extra personnel rows get readable labels", () => {
    expect(fieldLabel("products[a].method", v)).toBe("Talstar P: Application method");
    expect(fieldLabel("products[b].catalogId", v)).toBe("Product 2: Shop catalog entry");
    expect(fieldLabel("personnel[applying#2].name")).toBe("Applying 2: Name");
    expect(fieldLabel("personnel[supervising#3].licenseNumber")).toBe("Supervising 3: License number");
    expect(fieldLabel("personnel[receiving_training#2].name")).toBe("Receiving training 2: Name");
    for (const s of ["Application method", "Shop catalog entry", "Applying 2: Name"]) expect(s).not.toMatch(BANNED);
  });

  it("unknown fields fall back to the raw path", () => {
    expect(fieldLabel("somethingNew")).toBe("somethingNew");
    expect(fieldLabel("products[zz].rtuAmount", v)).toBe("products[zz].rtuAmount");
    expect(fieldLabel("products[zz].method", v)).toBe("products[zz].method");
    expect(fieldLabel("personnel[owner#2].name")).toBe("personnel[owner#2].name");
    expect(fieldLabel("personnel[applying#2].email")).toBe("personnel[applying#2].email");
  });

  it("CSV history cell uses product names from the corrected log", () => {
    const base = makeLog({ id: "p1", products: [makeApplied({ lineId: "a", name: "Talstar P", rtuAmount: "16" })] });
    const built = buildCorrection(base, { ...base, products: [{ ...base.products[0], rtuAmount: "12" }] }, {
      changedBy: "p-ana",
      reason: "Measured again",
      people: PEOPLE,
      now: NOW,
    });
    if (!built.ok) throw new Error(built.error);
    expect(changeHistoryCell(built.log)).toBe(
      "Rev 1 · 2026-10-17T18:05:00-05:00 · Ana Office · Reason: Measured again · Talstar P: RTU total amount (AI % unchanged): 16 → 12",
    );
  });
});

describe("re-upload record in exports", () => {
  function reup(log: ApplicationLog, at = NOW) {
    const res = buildReupload(log, { reuploadedBy: "p-ana", reason: "Shop copy was deleted", people: PEOPLE, now: at });
    if (!res.ok) throw new Error(res.error);
    return res.log;
  }

  it("CSV: status 'Re-uploaded' and a history cell; uncorrected rows keep main's cells", () => {
    const log = reup(makeLog({ id: "r1", dateUsed: "2026-09-10" }));
    const [header, ...body] = rows(logsToCsv([...uncorrectedExportLogs(), log]));
    const [goldenHeader, ...goldenBody] = rows(GOLDEN_CSV);
    expect(header).toBe(`${goldenHeader},${CORRECTION_CSV_COLUMNS.join(",")}`);
    goldenBody.forEach((row, i) => expect(body[i]).toBe(`${row},,`));
    expect(body.at(-1)!.endsWith(",Re-uploaded,Re-uploaded · 2026-10-17T18:05:00-05:00 · Ana Office · Reason: Shop copy was deleted")).toBe(true);
  });

  it("corrections and re-uploads list oldest first; status shows both", () => {
    const corr = corrected(); // corrected at 18:05
    const log = reup(corr, new Date(2026, 9, 17, 18, 0)); // re-uploaded earlier, at 18:00
    expect(changeStatusLabel(log)).toBe("Corrected (rev 1); Re-uploaded");
    const cell = changeHistoryCell(log);
    expect(cell.startsWith("Re-uploaded · 2026-10-17T18:00:00-05:00 · Ana Office · Reason: Shop copy was deleted | Rev 1 ·")).toBe(true);
  });

  it("PDF: title mark and history line", () => {
    const log = reup(makeLog({ id: "r1", dateUsed: "2026-09-10" }));
    downloadPdf([log], "Acme Pest", PROVENANCE);
    const flat = FakeJsPDF.instances[0].texts.map((t) => (Array.isArray(t.text) ? t.text.join("") : t.text));
    expect(flat).toContain("Log 1 — 2026-09-10  [Re-uploaded]");
    expect(flat).toContain("Change history (original values kept):");
    expect(flat).toContain("  Re-uploaded — 2026-10-17T18:05:00-05:00 — Ana Office — Reason: Shop copy was deleted");
  });

  it("new wording avoids banned terms", () => {
    const log = reup(corrected());
    for (const s of [REUPLOADED_LABEL, changeStatusLabel(log), changeHistoryCell(log), ...changeHistoryPdfLines(log)]) {
      expect(s).not.toMatch(BANNED);
    }
  });
});

describe("#212: another reviewed version in exports", () => {
  const CSV_LINE = "Another reviewed version of this log exists in the shop data. It is kept in the backup JSON.";
  const PDF_MARK = "[Another reviewed version exists]";
  const flag = (...ids: string[]) => ({ anotherReviewedVersion: new Set(ids) });
  const pdfTexts = () => FakeJsPDF.instances.at(-1)!.texts.map((t) => (Array.isArray(t.text) ? t.text.join("") : t.text));

  it("unflagged exports stay byte-identical to main (no flags, empty flags, flags for logs not exported)", () => {
    for (const flags of [undefined, flag(), flag("not-here")]) {
      expect(logsToCsv(uncorrectedExportLogs(), flags)).toBe(GOLDEN_CSV);
      FakeJsPDF.instances = [];
      downloadPdf(uncorrectedExportLogs(), "Acme Pest", PROVENANCE, flags);
      expect(JSON.parse(JSON.stringify(pdfRecord(FakeJsPDF.instances[0])))).toEqual(GOLDEN_PDF);
    }
  });

  it("CSV: a flagged log gets the line in the change-history column; unflagged rows keep main's cells", () => {
    const logs = uncorrectedExportLogs();
    const flaggedId = logs[1].id;
    const [header, ...body] = rows(logsToCsv(logs, flag(flaggedId)));
    const [goldenHeader, ...goldenBody] = rows(GOLDEN_CSV);
    expect(header).toBe(`${goldenHeader},${CORRECTION_CSV_COLUMNS.join(",")}`);
    goldenBody.forEach((row, i) => expect(body[i]).toBe(i === 1 ? `${row},,${CSV_LINE}` : `${row},,`));
  });

  it("CSV: joined after re-upload / correction entries with ' | '", () => {
    const res = buildReupload(corrected(), { reuploadedBy: "p-ana", reason: "Shop copy was deleted", people: PEOPLE, now: NOW });
    if (!res.ok) throw new Error(res.error);
    const log = res.log;
    expect(changeHistoryCell(log, flag(log.id))).toBe(`${changeHistoryCell(log)} | ${CSV_LINE}`);
    expect(changeHistoryCell(log, flag("other"))).toBe(changeHistoryCell(log));
    const last = rows(logsToCsv([log], flag(log.id))).at(-1)!;
    expect(last.endsWith(` | ${CSV_LINE}`)).toBe(true);
  });

  it("PDF: flagged log title gets the suffix after any status mark; others don't", () => {
    const logs = uncorrectedExportLogs();
    downloadPdf([...logs, corrected()], "Acme Pest", PROVENANCE, flag(logs[0].id, "c1"));
    const flat = pdfTexts();
    expect(flat.filter((t) => t.includes(PDF_MARK))).toEqual([
      `Log 1 — ${logs[0].dateUsed.trim() || "(no date)"}  ${PDF_MARK}`,
      `Log 6 — 2026-09-09  [Corrected (rev 1)]  ${PDF_MARK}`,
    ]);
    expect(flat.find((t) => t.startsWith("Log 2 — "))).not.toContain(PDF_MARK);
  });

  it("wording avoids banned terms", () => {
    expect(CSV_LINE).not.toMatch(BANNED);
    expect(PDF_MARK).not.toMatch(BANNED);
  });
});
