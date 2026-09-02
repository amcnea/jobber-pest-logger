import { useState } from "react";
import { productEpaCaption } from "../catalog";
import { downloadCsv } from "../csv";
import type { ApplicationLog } from "../types";

interface Props {
  logs: ApplicationLog[];
}

export function Export({ logs }: Props) {
  const [pdfError, setPdfError] = useState<string | null>(null);

  async function handlePdf() {
    setPdfError(null);
    try {
      const mod = await import("../pdf");
      mod.downloadPdf(logs);
    } catch (err) {
      console.error("jobber-pest-logger: PDF export failed", err);
      setPdfError("Could not load the PDF exporter. Download the Texas TDA CSV, or try again. Print is a summary, not the audit export.");
    }
  }

  return (
    <div>
      <h2>Office export</h2>
      <p className="hint">
        One audit-ready Texas TDA CSV whose columns match 4 TAC § 7.144(a), plus termite extras from
        § 7.144(b) when the stop is termite work, and a simple printable PDF. Real shop products print
        their EPA numbers. Example catalog seeds are labeled &quot;example / not a real EPA number&quot; —
        never as a fake registration number. Weather, time of day (except termite pretreat), and CE are
        not TDA-required and are omitted. Texas only.
      </p>
      <p className="hint">Records are kept 2 years. This app does not enforce retention.</p>

      <div className="card">
        <p>
          <strong>{logs.length}</strong> log{logs.length === 1 ? "" : "s"} on this device.
        </p>
        <p className="hint">Exports stay on your machine. Nothing is uploaded.</p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={logs.length === 0}
          onClick={() => downloadCsv(logs)}
        >
          Download Texas TDA CSV
        </button>
        <div style={{ height: "0.6rem" }} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={logs.length === 0}
          onClick={() => { void handlePdf(); }}
          style={{ width: "100%" }}
        >
          Download PDF
        </button>
        {pdfError && (
          <p className="hint" role="alert">
            {pdfError}
          </p>
        )}
        <div style={{ height: "0.6rem" }} />
        <button type="button" className="btn btn-secondary no-print" onClick={() => window.print()} style={{ width: "100%" }}>
          Print this page
        </button>
      </div>

      <section className="print-logs">
        {logs.map((log) => (
          <article className="card" key={log.id}>
            <strong>
              {log.dateUsed} — {log.serviceAddress}
              {log.sampleData && <span className="chip sample"> example items</span>}
              {log.isTermite && <span className="chip"> termite</span>}
            </strong>
            <p className="log-meta">
              Billing: {log.customerBillingName}, {log.customerBillingAddress}
            </p>
            <p className="log-meta">Target: {log.targetPestOrPurpose}</p>
            <p className="log-meta">
              TPCL {log.shopTpclNumber}
              {log.shopTpclLetter} · applying{" "}
              {log.personnel.find((p) => p.role === "applying")?.name}
            </p>
            {log.jobberJobNumber && (
              <p className="log-meta">Jobber #{log.jobberJobNumber} (not TDA)</p>
            )}
            <ul>
              {log.products.map((p) => (
                <li key={p.lineId}>
                  {p.name}{" "}
                  {p.method === "device"
                    ? `device × ${p.deviceCount}${p.isExample ? ` · ${productEpaCaption(p)}` : ""}`
                    : productEpaCaption(p)}
                </li>
              ))}
            </ul>
            {log.isTermite && (
              <p className="log-meta">
                Termite:{" "}
                {log.termite.isBait
                  ? "bait — area N/A"
                  : `area ${log.termite.areaTreatedSqFt || "—"} sq ft`}
                {log.termite.physicalBarrierMeasurement
                  ? ` · barrier ${log.termite.physicalBarrierMeasurement}`
                  : ""}
                {log.termite.diagramNote ? ` · diagram note: ${log.termite.diagramNote}` : ""}
                {log.termite.isCommercialPretreat
                  ? ` · pretreat tanks ${log.termite.tankCount || "—"} / ${log.termite.tankGallons || "—"} gal ${log.termite.startTime || "—"}–${log.termite.stopTime || "—"}`
                  : ""}
              </p>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
