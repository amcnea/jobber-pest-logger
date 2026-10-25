import { useMemo, useState } from "react";
import { productEpaCaption } from "../catalog";
import { changeStatusLabel } from "../correctionExport";
import { isLogReviewed } from "../reviewQueue";
import { DUPLICATE_ID_SET_ASIDE_REASON } from "../shop/dedupeLogs";
import { loadSetAsideCopies } from "../storage";
import type { ApplicationLog, AppliedProduct, SetAsideCopy } from "../types";

export const SET_ASIDE_VIEWER_HEADING = "Set-aside device copies";

export const SET_ASIDE_VIEWER_HINT =
  "Readable log versions from this device that were set aside when a sync conflict or duplicate log ID was resolved in favor of another copy (distinct from unreadable storage rows). Set-aside copies are not active shop logs and are not in CSV or PDF exports, but they are included in the backup JSON and kept across syncs, example-data resets, and backup restores. Wipe ALL data deletes them from this device — download the backup JSON first if you need them.";

export const SET_ASIDE_EMPTY_TEXT = "No set-aside device copies on this device.";

export function setAsideCountText(n: number): string {
  if (n <= 0) return SET_ASIDE_EMPTY_TEXT;
  if (n === 1) return "1 set-aside device copy on this device.";
  return `${n} set-aside device copies on this device.`;
}

export function setAsideReasonChip(entry: Pick<SetAsideCopy, "reason">): string {
  const reason = entry.reason?.trim() ?? "";
  if (reason === DUPLICATE_ID_SET_ASIDE_REASON) return "Duplicate ID";
  if (reason) return reason;
  return "Sync conflict";
}

export function setAsideReasonText(entry: Pick<SetAsideCopy, "reason" | "setAsideBy">): string {
  const reason = entry.reason?.trim() ?? "";
  const by = entry.setAsideBy.trim();
  if (reason === DUPLICATE_ID_SET_ASIDE_REASON) {
    return by
      ? `Duplicate log ID in shared shop (another copy was kept) · Set aside by ${by}`
      : "Duplicate log ID in shared shop (another copy was kept) · Set aside automatically";
  }
  if (reason) {
    return by
      ? `Reason: ${reason} · Set aside by ${by}`
      : `Reason: ${reason} · Set aside automatically`;
  }
  return by
    ? `Sync conflict (shop copy kept) · Set aside by ${by}`
    : "Sync conflict (shop copy kept)";
}

/** "2026-10-17T19:30:00-05:00" -> "2026-10-17 19:30 (2026-10-17T19:30:00-05:00)" */
export function formatSetAsideTimestamp(iso: string): string {
  const trimmed = iso.trim();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(trimmed);
  return m ? `${m[1]} ${m[2]} (${trimmed})` : trimmed;
}

function formatShortWallTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso.trim());
  return m ? `${m[1]} ${m[2]}` : iso.trim();
}

function formatProductLine(p: AppliedProduct): string {
  const name = p.name.trim() || "(unnamed product)";
  if (p.method === "device") {
    return `${name} × ${p.deviceCount.trim() || "0"}`;
  }
  const epa = productEpaCaption(p) || (p.epaRegNo?.trim() ? `EPA Reg. No. ${p.epaRegNo.trim()}` : "");
  const amount =
    p.method === "rtu"
      ? `${p.rtuAmount} ${p.rtuUnit}`.trim()
      : `${p.mixedTotal} ${p.mixedUnit}`.trim();
  const details = [epa, amount].filter(Boolean).join(", ");
  return details ? `${name} (${details})` : name;
}

export function formatSetAsideProducts(log: ApplicationLog): string {
  if (log.products.length === 0) return "No products";
  return log.products.map(formatProductLine).join("; ");
}

export function formatSetAsideApplicators(log: ApplicationLog): string {
  const applying = log.personnel
    .filter((p) => p.role === "applying" && (p.name.trim() || p.licenseNumber.trim()))
    .map((p) => {
      const name = p.name.trim() || "(unnamed)";
      const lic = p.licenseNumber.trim();
      return lic ? `${name} (${lic})` : name;
    });
  return applying.length > 0 ? applying.join(", ") : "(none)";
}

function formatTpcl(log: ApplicationLog): string {
  const num = log.shopTpclNumber.trim();
  const letter = log.shopTpclLetter.trim();
  if (!num && !letter) return "(none)";
  return [num, letter].filter(Boolean).join(" ");
}

interface Props {
  /** Bump to re-read localStorage when restore, wipe, or conflict resolution happens. */
  refreshKey?: number;
}

export function SetAsideViewer({ refreshKey = 0 }: Props) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const copies = useMemo(() => {
    void refreshKey;
    const loaded = loadSetAsideCopies();
    // Show most recently set-aside copies first; tie-break by reverse storage order.
    return loaded
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => {
        const cmp = b.entry.setAsideAt.localeCompare(a.entry.setAsideAt);
        return cmp !== 0 ? cmp : b.idx - a.idx;
      })
      .map((x) => x.entry);
  }, [refreshKey]);

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <section aria-label={SET_ASIDE_VIEWER_HEADING}>
      <h2>{SET_ASIDE_VIEWER_HEADING}</h2>
      <p className="hint">{SET_ASIDE_VIEWER_HINT}</p>
      {copies.length === 0 ? (
        <div className="card">
          <p className="hint" role="status">
            {SET_ASIDE_EMPTY_TEXT}
          </p>
        </div>
      ) : (
        <>
          <p className="hint" role="status">
            {setAsideCountText(copies.length)}
          </p>
          <div className="set-aside-list">
            {copies.map((entry) => {
              const log = entry.deviceCopy;
              const reviewed = isLogReviewed(log);
              const rev = log.revision ?? 0;
              const statusChip = changeStatusLabel(log);
              const expanded = Boolean(expandedIds[entry.id]);
              const savedAt = log.createdAt.trim();
              return (
                <article
                  className="card history-log-card set-aside-card"
                  key={entry.id}
                  aria-label={`Set-aside copy ${entry.logId}`}
                >
                  <div className="card-head history-log-head">
                    <div className="history-log-main">
                      <div className="history-log-title">
                        <strong>
                          {log.dateUsed.trim() || "(no date)"} ·{" "}
                          {log.serviceAddress.trim() || "(no service address)"}
                        </strong>
                        <span className="chip">{setAsideReasonChip(entry)}</span>
                        <span className="chip">Rev {rev}</span>
                        <span className="chip">{reviewed ? "Reviewed" : "Unreviewed"}</span>
                        {statusChip && <span className="chip">{statusChip}</span>}
                        {log.isTermite && <span className="chip">termite</span>}
                        {log.sampleData && <span className="chip sample">example</span>}
                      </div>
                      <div className="log-meta history-log-line">{setAsideReasonText(entry)}</div>
                      <div className="log-meta history-log-line">
                        Set aside: {formatSetAsideTimestamp(entry.setAsideAt)}
                        {entry.shopId.trim() ? ` · Shop: ${entry.shopId.trim()}` : ""} · Log ID:{" "}
                        {entry.logId}
                      </div>
                      <div className="log-meta history-log-line">
                        Customer: {log.customerBillingName.trim() || "(none)"} · Service address:{" "}
                        {log.serviceAddress.trim() || "(none)"}
                        {log.targetPestOrPurpose.trim()
                          ? ` · Target: ${log.targetPestOrPurpose.trim()}`
                          : ""}
                      </div>
                      <div className="log-meta history-log-line">
                        Products: {formatSetAsideProducts(log)}
                      </div>
                      <div className="log-meta history-log-line">
                        Applicator: {formatSetAsideApplicators(log)}
                      </div>
                      <div className="log-meta history-log-line">
                        {reviewed
                          ? `Review: Reviewed ${formatShortWallTime(log.reviewedAt ?? "")} by ${log.reviewedBy}`
                          : "Review: Not reviewed"}{" "}
                        · Revision: {rev}
                        {savedAt ? ` · Saved: ${savedAt}` : ""}
                      </div>
                    </div>
                    <div className="card-actions history-log-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-expanded={expanded}
                        onClick={() => toggleExpanded(entry.id)}
                      >
                        {expanded ? "Hide full details" : "Show full details"}
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="set-aside-details">
                      <div className="log-meta history-log-line">
                        Customer billing address: {log.customerBillingAddress.trim() || "(none)"} ·
                        Shop TPCL: {formatTpcl(log)}
                        {log.poleLocation.trim() ? ` · Pole: ${log.poleLocation.trim()}` : ""}
                        {log.jobberJobNumber.trim()
                          ? ` · Jobber #${log.jobberJobNumber.trim()} (not TDA)`
                          : ""}
                      </div>
                      {log.history && log.history.length > 0 && (
                        <div className="log-meta history-log-line">
                          Change history ({log.history.length}):{" "}
                          {log.history
                            .map(
                              (h) =>
                                `Rev ${h.revision} (${formatShortWallTime(h.changedAt)} by ${h.changedBy}: ${h.reason})`,
                            )
                            .join("; ")}
                        </div>
                      )}
                      {log.reuploads && log.reuploads.length > 0 && (
                        <div className="log-meta history-log-line">
                          Re-uploads ({log.reuploads.length}):{" "}
                          {log.reuploads
                            .map(
                              (r) =>
                                `${formatShortWallTime(r.reuploadedAt)} by ${r.reuploadedBy}: ${r.reason}`,
                            )
                            .join("; ")}
                        </div>
                      )}
                      <div className="log-meta history-log-line">Device copy JSON snapshot</div>
                      <pre className="set-aside-json">{JSON.stringify(log, null, 2)}</pre>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
