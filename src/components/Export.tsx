import { useMemo, useState } from "react";
import { exportBlockedByExamples, productEpaCaption } from "../catalog";
import { downloadCsv } from "../csv";
import { filterLogsByDateUsed, monthRangeLocal } from "../dates";
import { LAWGICAL_DISCLAIMER } from "../disclaimer";
import { backupNagMessage, formatLastBackupLabel } from "../storage";
import type { ApplicationLog, Screen, ShopProduct, ShopSettings } from "../types";

interface Props {
  logs: ApplicationLog[];
  catalog: ShopProduct[];
  settings: ShopSettings;
  lastBackupAt: string | null;
  onRemoveExamples: () => boolean;
  onGo: (screen: Screen) => void;
}

export function Export({
  logs,
  catalog,
  settings,
  lastBackupAt,
  onRemoveExamples,
  onGo,
}: Props) {
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exampleMsg, setExampleMsg] = useState<string | null>(null);

  const lastBackupLabel = formatLastBackupLabel(lastBackupAt);
  const nag = backupNagMessage(lastBackupAt);

  const filtered = useMemo(
    () => filterLogsByDateUsed(logs, dateFrom, dateTo),
    [logs, dateFrom, dateTo],
  );

  const exampleGate = useMemo(
    () => exportBlockedByExamples(catalog, logs),
    [catalog, logs],
  );
  const exportBlocked = exampleGate.blocked;

  const shopName = settings.shopName.trim();
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const rangeActive = ymd.test(dateFrom.trim()) || ymd.test(dateTo.trim());

  function applyThisMonth() {
    const { from, to } = monthRangeLocal();
    setDateFrom(from);
    setDateTo(to);
  }

  function clearDates() {
    setDateFrom("");
    setDateTo("");
  }

  async function handlePdf() {
    if (exportBlocked) return;
    setPdfError(null);
    try {
      const mod = await import("../pdf");
      mod.downloadPdf(filtered, shopName || undefined);
    } catch (err) {
      console.error("jobber-pest-logger: PDF export failed", err);
      setPdfError(
        "Could not load the PDF exporter. Download the Texas TDA CSV, or try again. Print is a summary, not the audit export.",
      );
    }
  }

  function handleRemoveExamples() {
    setExampleMsg(null);
    const ok = onRemoveExamples();
    if (!ok) {
      setExampleMsg("Could not remove example products from the catalog on this device.");
      return;
    }
    setExampleMsg(
      "Example products removed from the catalog. If any saved logs still list example items, edit or delete those logs in History before exporting.",
    );
  }

  return (
    <div>
      <h2>Office export</h2>
      <p className="hint">
        One audit-ready Texas TDA CSV whose columns match 4 TAC § 7.144(a), plus termite extras from
        § 7.144(b) when the stop is termite work, and a simple printable PDF. Real shop products print
        their EPA numbers. Example catalog seeds are blocked from real export until removed — they
        must never ship as audit records. Weather, time of day (except termite pretreat), and CE are
        not TDA-required and are omitted. Texas only.
      </p>
      <p className="hint">Records are kept 2 years. This app does not enforce retention.</p>
      <p className="disclaimer">{LAWGICAL_DISCLAIMER}</p>
      <p className="hint" role="status">
        {lastBackupLabel}
      </p>
      {nag && (
        <p className="nag" role="status">
          {nag} Use Settings → Download backup JSON.
        </p>
      )}

      {exportBlocked && (
        <div className="nag nag-block" role="status">
          <strong>Example seeds still present — CSV/PDF export disabled</strong>
          <p>
            Clear example / SAMPLE products before a real office export. Logging is still allowed;
            this gate is only for CSV and PDF.
          </p>
          <ul className="warn-list">
            {exampleGate.catalogExamples > 0 && (
              <li>
                {exampleGate.catalogExamples} example product
                {exampleGate.catalogExamples === 1 ? "" : "s"} on the shop catalog
              </li>
            )}
            {exampleGate.logExamples > 0 && (
              <li>
                {exampleGate.logExamples} saved log
                {exampleGate.logExamples === 1 ? "" : "s"} still reference example products — edit
                or delete them in{" "}
                <button type="button" className="linkish" onClick={() => onGo("history")}>
                  History
                </button>
              </li>
            )}
          </ul>
          {exampleGate.catalogExamples > 0 && (
            <button type="button" className="btn btn-primary" onClick={handleRemoveExamples}>
              Remove example products from catalog
            </button>
          )}
          {exampleMsg && (
            <p className="hint" role="status">
              {exampleMsg}
            </p>
          )}
        </div>
      )}
      {!exportBlocked && exampleMsg && (
        <p className="hint" role="status">
          {exampleMsg}
        </p>
      )}

      <div className="card">
        <h3>Date range</h3>
        <p className="hint">
          Filter by <strong>date used</strong> (device-local YYYY-MM-DD). CSV and PDF use the filtered
          set. Leave both blank for all logs on this device.
        </p>
        <div className="row export-date-row">
          <label className="field">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="field">
            To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
        </div>
        <div className="row export-date-row">
          <button type="button" className="btn btn-secondary" onClick={applyThisMonth}>
            This month
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={clearDates}
            disabled={!rangeActive}
          >
            Clear dates
          </button>
        </div>
      </div>

      <div className="card">
        {shopName && (
          <p>
            <strong>{shopName}</strong>
          </p>
        )}
        <p>
          <strong>{filtered.length}</strong> log{filtered.length === 1 ? "" : "s"}
          {rangeActive ? " in range" : " on this device"}
          {rangeActive && logs.length !== filtered.length
            ? ` (${logs.length} total on device)`
            : ""}
          .
        </p>
        <p className="hint">Exports stay on your machine. Nothing is uploaded.</p>
        <div className="export-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={filtered.length === 0 || exportBlocked}
            onClick={() => {
              if (exportBlocked) return;
              downloadCsv(filtered, shopName || undefined);
            }}
          >
            Download Texas TDA CSV
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={filtered.length === 0 || exportBlocked}
            onClick={() => {
              void handlePdf();
            }}
          >
            Download PDF
          </button>
          {pdfError && (
            <p className="hint" role="alert">
              {pdfError}
            </p>
          )}
          <button
            type="button"
            className="btn btn-secondary no-print"
            onClick={() => window.print()}
          >
            Print this page
          </button>
        </div>
      </div>

      <section className="print-logs">
        {shopName && (
          <p className="hint">
            <strong>{shopName}</strong>
            {settings.shopTpclNumber
              ? ` · TPCL ${settings.shopTpclNumber}${settings.shopTpclLetter}`
              : ""}
          </p>
        )}
        {filtered.map((log) => (
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
