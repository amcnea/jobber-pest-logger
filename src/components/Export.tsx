import { useState } from "react";
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
        One audit-ready Texas TDA CSV whose columns match 4 TAC § 7.144(a), plus a simple printable PDF.
        Sample catalog rows are marked SAMPLE. Weather, time of day (except termite pretreat), and CE are not
        TDA-required and are omitted.
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
          Download Texas TDA CSV (SAMPLE)
        </button>
        <div style={{ height: "0.6rem" }} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={logs.length === 0}
          onClick={() => { void handlePdf(); }}
          style={{ width: "100%" }}
        >
          Download PDF (SAMPLE)
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
              {log.dateUsed} — {log.serviceAddress} <span className="chip sample">SAMPLE</span>
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
            <ul>
              {log.products.map((p) => (
                <li key={p.lineId}>
                  {p.name}{" "}
                  {p.method === "device"
                    ? `device × ${p.deviceCount}`
                    : p.epaRegNo
                      ? `EPA ${p.epaRegNo}`
                      : "25(b) no EPA #"}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </div>
  );
}
