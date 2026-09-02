import { jsPDF } from "jspdf";
import { epaExportText, EXAMPLE_EPA_LABEL, inferIsExample, logHasExampleProducts } from "./catalog";
import type { ApplicationLog } from "./types";

function person(log: ApplicationLog, role: ApplicationLog["personnel"][number]["role"]) {
  return log.personnel.find((p) => p.role === role);
}

const LINE_H = 5;

function wrap(doc: jsPDF, text: string, x: number, y: number, maxWidth: number): number {
  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  doc.text(lines, x, y);
  return y + lines.length * LINE_H;
}

/** Measure wrapped height (mm) without drawing. */
function wrappedHeight(doc: jsPDF, text: string, maxWidth: number): number {
  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  return lines.length * LINE_H;
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

export function downloadPdf(logs: ApplicationLog[]): void {
  const doc = new jsPDF({ unit: "mm", format: "letter" });
  const margin = 14;
  const maxWidth = 186;
  let y = 18;

  const addPageIfNeeded = (needed: number) => {
    if (y + needed > 270) {
      doc.addPage();
      y = 18;
    }
  };

  const hasExamples = logHasExampleProducts(logs.flatMap((l) => l.products));

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Texas TDA pesticide application log", margin, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  y = wrap(
    doc,
    "Jobber Pest Logger v1. Columns follow 4 TAC § 7.144(a) for Texas SPCS shops. Termite extras follow § 7.144(b) when the stop is termite work. Keep records 2 years. Not a substitute for TDA counsel.",
    margin,
    y,
    maxWidth,
  );
  if (hasExamples) {
    y += 2;
    y = wrap(
      doc,
      `Some products are example catalog seeds. Those rows are labeled "${EXAMPLE_EPA_LABEL}" and are not EPA registration numbers.`,
      margin,
      y,
      maxWidth,
    );
  }
  y += 4;

  if (logs.length === 0) {
    doc.text("No application logs saved on this device.", margin, y);
  }

  logs.forEach((log, i) => {
    addPageIfNeeded(55);
    doc.setDrawColor(180);
    doc.line(margin, y, margin + maxWidth, y);
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    const exampleMark = logHasExampleProducts(log.products) ? "  [includes example catalog items]" : "";
    doc.text(`Log ${i + 1} — ${log.dateUsed || "(no date)"}${exampleMark}`, margin, y);
    y += 6;
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
      if (t.physicalBarrierMeasurement) lines.push(`  Physical-barrier measurement: ${t.physicalBarrierMeasurement}`);
      lines.push(`  Diagram note (text, not a drawing): ${t.diagramNote || "—"}`);
      if (t.isCommercialPretreat) {
        lines.push(
          `  Commercial pretreat: tanks ${t.tankCount || "—"}, gal ${t.tankGallons || "—"}, ${t.startTime || "—"}–${t.stopTime || "—"}`,
        );
      }
    }

    for (const line of lines) {
      const h = wrappedHeight(doc, line, maxWidth);
      addPageIfNeeded(h + 1);
      y = wrap(doc, line, margin, y, maxWidth);
      y += 1;
    }
    y += 3;
  });

  doc.save("texas-tda-application-logs.pdf");
}
