import { jsPDF } from "jspdf";
import type { ApplicationLog } from "./types";

function person(log: ApplicationLog, role: ApplicationLog["personnel"][number]["role"]) {
  return log.personnel.find((p) => p.role === role);
}

function wrap(doc: jsPDF, text: string, x: number, y: number, maxWidth: number): number {
  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  doc.text(lines, x, y);
  return y + lines.length * 5;
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

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Texas TDA pesticide application log (SAMPLE)", margin, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  y = wrap(
    doc,
    "Placeholder export for Jobber Pest Logger v1. Columns follow 4 TAC § 7.144(a) for SPCS shops. Catalog EPA numbers are SAMPLE placeholders, not EPA data. Keep records 2 years. Not a substitute for TDA counsel.",
    margin,
    y,
    maxWidth,
  );
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
    doc.text(`Log ${i + 1} — ${log.dateUsed || "(no date)"}  [SAMPLE]`, margin, y);
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
      if (p.method === "device") {
        lines.push(`Device: ${p.name} × ${p.deviceCount || "?"}`);
      } else if (p.method === "mixed") {
        const mix = [
          p.mixingRate && `rate ${p.mixingRate}`,
          p.percentAi && `${p.percentAi}% AI`,
          p.mixedTotal && `total ${p.mixedTotal} ${p.mixedUnit}`,
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `Mixed: ${p.name} (EPA ${p.epaRegNo ?? "none — 25(b)/unregistered"}) ${mix}`.trim(),
        );
      } else {
        lines.push(
          `RTU: ${p.name} (EPA ${p.epaRegNo ?? "none — 25(b)/unregistered"}) ${p.rtuAmount} ${p.rtuUnit}`.trim(),
        );
      }
    }

    if (log.isTermite) {
      const t = log.termite;
      lines.push("Termite extras (§ 7.144(b) stub):");
      if (!t.isBait) lines.push(`  Area treated: ${t.areaTreatedSqFt || "—"} sq ft`);
      else lines.push("  Bait — area treated N/A");
      if (t.physicalBarrierMeasurement) lines.push(`  Barrier: ${t.physicalBarrierMeasurement}`);
      lines.push(`  Diagram: ${t.diagramNote || "(placeholder — not captured in v1)"}`);
      if (t.isCommercialPretreat) {
        lines.push(
          `  Commercial pretreat: tanks ${t.tankCount || "—"}, gal ${t.tankGallons || "—"}, ${t.startTime || "—"}–${t.stopTime || "—"}`,
        );
      }
    }

    for (const line of lines) {
      addPageIfNeeded(8);
      y = wrap(doc, line, margin, y, maxWidth);
      y += 1;
    }
    y += 3;
  });

  doc.save("texas-tda-application-logs-SAMPLE.pdf");
}
