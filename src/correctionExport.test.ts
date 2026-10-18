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
        "customerBillingName: Pat Customer → (blank); serviceAddress: 100 Main St → 101 Main St",
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
    expect(cell).toContain("targetPestOrPurpose: Ants → Fire ants");
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
    expect(after).toContain("    customerBillingName: Pat Customer -> (blank)");
    expect(after).toContain("    serviceAddress: 100 Main St -> 101 Main St");
    expect(flat.join("\n")).not.toContain("→");
  });
});
