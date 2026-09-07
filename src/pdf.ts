import { jsPDF } from "jspdf";
import { epaExportText, EXAMPLE_EPA_LABEL, inferIsExample, logHasExampleProducts } from "./catalog";
import { LAWGICAL_DISCLAIMER } from "./disclaimer";
import type { ApplicationLog } from "./types";

function person(log: ApplicationLog, role: ApplicationLog["personnel"][number]["role"]) {
  return log.personnel.find((p) => p.role === role);
}

const LINE_H = 5;
const PAGE_H = 279.4; // letter height mm
const MARGIN = 14;
const MAX_WIDTH = 186;

function wrap(doc: jsPDF, text: string, x: number, y: number, maxWidth: number, lineH = LINE_H): number {
  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  doc.text(lines, x, y);
  return y + lines.length * lineH;
}

/** Measure wrapped height (mm) without drawing. */
function wrappedHeight(doc: jsPDF, text: string, maxWidth: number, lineH = LINE_H): number {
  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  return lines.length * lineH;
}

function productLine(p: ApplicationLog["products"][number]): string {
  const epa = epaExportText(p);
  const isEx = inferIsExample(p);
  const epaBit = isEx
    ? `(${EXAMPLE_EPA_LABEL})`
    : p.method === "device"
      ? ""
      : epa
        ? `(EPA ${epa})`
        : "(25(b) / unregistered — no EPA #)";
  if (p.method === "device") {
    const extra = isEx ? ` ${epaBit}` : "";
    return `Device: ${p.name}${extra} × ${p.deviceCount || "?"}`;
  }
  if (p.method === "mixed") {
    const mix = [
      p.mixingRate && `rate ${p.mixingRate}`,
      p.percentAi && `${p.percentAi}% AI`,
      p.mixedTotal && `total ${p.mixedTotal} ${p.mixedUnit}`,
    ]
      .filter(Boolean)
      .join(", ");
    return `Mixed: ${p.name} ${epaBit} ${mix}`.trim();
  }
  return `RTU: ${p.name} ${epaBit} ${p.rtuAmount} ${p.rtuUnit}`.trim();
}

function footerHeight(doc: jsPDF): number {
  const footerLines = doc.splitTextToSize(LAWGICAL_DISCLAIMER, MAX_WIDTH) as string[];
  return footerLines.length * 3.2 + 6;
}

function drawFooter(doc: jsPDF, page: number, pageCount: number): void {
  doc.setPage(page);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(70);
  const footerLines = doc.splitTextToSize(LAWGICAL_DISCLAIMER, MAX_WIDTH) as string[];
  const lineH = 3.2;
  const blockH = footerLines.length * lineH;
  const top = PAGE_H - MARGIN - blockH - 5;
  doc.setDrawColor(200);
  doc.line(MARGIN, top - 2.5, MARGIN + MAX_WIDTH, top - 2.5);
  doc.text(footerLines, MARGIN, top, { lineHeightFactor: 1.15 });
  doc.setFontSize(7);
  doc.text(`Page ${page} of ${pageCount}`, MARGIN + MAX_WIDTH, PAGE_H - 6, { align: "right" });
  doc.setTextColor(0);
}

/** Shop name + report title at the top of each page. Returns y below the header. */
function drawPageHeader(doc: jsPDF, shopName: string | undefined): number {
  let y = MARGIN + 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(0);
  doc.text("Texas TDA pesticide application log", MARGIN, y);
  y += 6;
  const name = shopName?.trim();
  if (name) {
    doc.setFontSize(11);
    y = wrap(doc, name, MARGIN, y, MAX_WIDTH);
    y += 1;
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text("Shop name not set — add it in Settings", MARGIN, y);
    doc.setTextColor(0);
    y += 5;
  }
  doc.setDrawColor(160);
  doc.line(MARGIN, y, MARGIN + MAX_WIDTH, y);
  return y + 5;
}

export function downloadPdf(logs: ApplicationLog[], shopName?: string): void {
  const doc = new jsPDF({ unit: "mm", format: "letter" });
  const contentBottom = () => PAGE_H - footerHeight(doc) - 2;

  let y = drawPageHeader(doc, shopName);

  const ensureSpace = (needed: number) => {
    if (y + needed <= contentBottom()) return;
    doc.addPage();
    y = drawPageHeader(doc, shopName);
  };

  const hasExamples = logHasExampleProducts(logs.flatMap((l) => l.products));

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const schemaNote =
    "Columns follow 4 TAC § 7.144(a) for Texas SPCS shops. Termite extras follow § 7.144(b) when the stop is termite work. Full disclaimer is on every page footer.";
  ensureSpace(wrappedHeight(doc, schemaNote, MAX_WIDTH) + 2);
  y = wrap(doc, schemaNote, MARGIN, y, MAX_WIDTH);
  y += 2;

  if (hasExamples) {
    const exampleNote = `Some products are example catalog seeds. Those rows are labeled "${EXAMPLE_EPA_LABEL}" and are not EPA registration numbers.`;
    ensureSpace(wrappedHeight(doc, exampleNote, MAX_WIDTH) + 2);
    y = wrap(doc, exampleNote, MARGIN, y, MAX_WIDTH);
    y += 2;
  }

  if (logs.length === 0) {
    ensureSpace(LINE_H + 2);
    doc.text("No application logs saved on this device.", MARGIN, y);
    y += LINE_H;
  }

  logs.forEach((log, i) => {
    // Prefer starting a log block on a fresh page when little room remains
    const minBlock = 28;
    ensureSpace(minBlock);
    if (y > MARGIN + 20) {
      doc.setDrawColor(180);
      doc.line(MARGIN, y, MARGIN + MAX_WIDTH, y);
      y += 5;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    const exampleMark = logHasExampleProducts(log.products)
      ? "  [includes example catalog items]"
      : "";
    const title = `Log ${i + 1} — ${log.dateUsed || "(no date)"}${exampleMark}`;
    ensureSpace(wrappedHeight(doc, title, MAX_WIDTH, 5.5) + 4);
    y = wrap(doc, title, MARGIN, y, MAX_WIDTH, 5.5);
    y += 3;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);

    const applying = person(log, "applying");
    const supervising = person(log, "supervising");
    const training = person(log, "receiving_training");

    const lines: string[] = [
      `Customer billing: ${log.customerBillingName} — ${log.customerBillingAddress}`,
      `Service address: ${log.serviceAddress}${log.poleLocation ? ` (pole: ${log.poleLocation})` : ""}`,
      `Target pest / purpose: ${log.targetPestOrPurpose}`,
      `Date used: ${log.dateUsed}`,
      `Shop TPCL: ${log.shopTpclNumber}${log.shopTpclLetter ? log.shopTpclLetter : ""}`,
    ];
    if (log.jobberJobNumber || log.jobberAddress) {
      lines.push(
        `Jobber link (not TDA-required): ${[log.jobberJobNumber, log.jobberAddress].filter(Boolean).join(" — ")}`,
      );
    }
    lines.push(
      `Applying: ${applying?.name ?? ""} ${applying?.licenseNumber ?? ""}`.trim(),
      `Supervising: ${supervising?.name ?? ""} ${supervising?.licenseNumber ?? ""}`.trim(),
      `Receiving training: ${training?.name ?? ""} ${training?.licenseNumber ?? ""}`.trim(),
    );

    for (const p of log.products) {
      lines.push(productLine(p));
    }

    if (log.isTermite) {
      const t = log.termite;
      lines.push("Termite extras (§ 7.144(b)):");
      if (!t.isBait) lines.push(`  Area treated: ${t.areaTreatedSqFt || "—"} sq ft`);
      else lines.push("  Bait — area treated N/A");
      if (t.physicalBarrierMeasurement) {
        lines.push(`  Physical-barrier measurement: ${t.physicalBarrierMeasurement}`);
      }
      lines.push(`  Diagram note (text, not a drawing): ${t.diagramNote || "—"}`);
      if (t.isCommercialPretreat) {
        lines.push(
          `  Commercial pretreat: tanks ${t.tankCount || "—"}, gal ${t.tankGallons || "—"}, ${t.startTime || "—"}–${t.stopTime || "—"}`,
        );
      }
    }

    for (const line of lines) {
      const h = wrappedHeight(doc, line, MAX_WIDTH);
      ensureSpace(h + 1);
      y = wrap(doc, line, MARGIN, y, MAX_WIDTH);
      y += 1;
    }
    y += 4;
  });

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    drawFooter(doc, i, pageCount);
  }

  doc.save("texas-tda-application-logs.pdf");
}
