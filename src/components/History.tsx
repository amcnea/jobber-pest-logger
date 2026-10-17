import { useMemo, useState } from "react";
import { productEpaCaption } from "../catalog";
import { filterLogsByDateUsed, monthRangeLocal } from "../dates";
import { isLogReviewed, reviewFlagsForLog } from "../reviewQueue";
import { groupLogsByServiceAddress, type PropertyBookEntry } from "../storage";
import type { ApplicationLog, Person, ShopProduct } from "../types";
import { useNow } from "../useNow";
import { REVIEWED_LOCK_NOTE } from "./ReviewQueue";

interface Props {
  logs: ApplicationLog[];
  /** Office-only: Edit / Delete on saved logs. Tech keeps Log again / Duplicate (new logs). */
  canEditDelete: boolean;
  onDelete: (id: string) => void;
  onEdit: (log: ApplicationLog) => void;
  onLogAgainHere: (property: PropertyBookEntry) => void;
  onDuplicateLastStop: (property: PropertyBookEntry) => void;
  /** Office: shop list for review flags. Mark reviewed shows only when catalog + onMarkReviewed are set. */
  catalog?: ShopProduct[];
  /** Roster for "Reviewed by". */
  people?: Person[];
  /** Office: lock a log with zero review flags. Returns an error message, or null on success. */
  onMarkReviewed?: (logId: string, personId: string) => string | null;
  /** Pins the clock (tests). */
  now?: Date;
}

/** "2026-10-17T17:05:00-05:00" → "2026-10-17 17:05" (reviewer's local wall time). */
function reviewedLabel(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

function MarkReviewed({
  log,
  people,
  hasFlags,
  onMarkReviewed,
}: {
  log: ApplicationLog;
  people: Person[];
  hasFlags: boolean;
  onMarkReviewed: (logId: string, personId: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const named = people.filter((p) => p.name.trim());

  if (hasFlags) {
    return (
      <p className="hint history-review-note">
        Mark reviewed is available once this log is off the Review queue.
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        Mark reviewed
      </button>
    );
  }
  return (
    <div className="history-review-form">
      {named.length === 0 ? (
        <p className="hint">Add people first to mark a log reviewed.</p>
      ) : (
        <label className="field">
          Reviewed by
          <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
            <option value="">Choose…</option>
            {named.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!personId}
          onClick={() => {
            const err = onMarkReviewed(log.id, personId);
            setError(err);
            if (!err) setOpen(false);
          }}
        >
          Mark reviewed
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function productSummary(log: ApplicationLog): string {
  if (log.products.length === 0) return "No products";
  return log.products
    .map((p) => (p.method === "device" ? `${p.name} × ${p.deviceCount}` : p.name))
    .join(", ");
}

export function History({
  logs,
  canEditDelete,
  onDelete,
  onEdit,
  onLogAgainHere,
  onDuplicateLastStop,
  catalog,
  people = [],
  onMarkReviewed,
  now,
}: Props) {
  const clock = useNow(now);
  const reviewEnabled = canEditDelete && catalog !== undefined && onMarkReviewed !== undefined;
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const rangeActive = ymd.test(dateFrom.trim()) || ymd.test(dateTo.trim());
  const hasDateInput = Boolean(dateFrom.trim() || dateTo.trim());

  const filtered = useMemo(
    () => filterLogsByDateUsed(logs, dateFrom, dateTo),
    [logs, dateFrom, dateTo],
  );
  const groups = useMemo(() => groupLogsByServiceAddress(filtered), [filtered]);
  // Property actions use the true latest visit across all logs, not the date-filtered group (#92).
  const fullByKey = useMemo(
    () => new Map(groupLogsByServiceAddress(logs).map((g) => [g.key, g])),
    [logs],
  );

  function applyThisMonth() {
    const { from, to } = monthRangeLocal();
    setDateFrom(from);
    setDateTo(to);
  }

  function clearDates() {
    setDateFrom("");
    setDateTo("");
  }

  function handleDelete(log: ApplicationLog) {
    const label = `${log.dateUsed || "this log"} at ${log.serviceAddress.trim() || "unknown address"}`;
    if (!confirm(`Delete ${label} from this device? This cannot be undone.`)) return;
    onDelete(log.id);
  }

  if (logs.length === 0) {
    return (
      <div className="empty">
        <p>No logs on this device yet.</p>
        <p className="hint">Save an application after a stop. History is grouped by service address.</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Property-level history</h2>
      <p className="hint">
        Prior logs grouped by service address (property book).{" "}
        {canEditDelete ? (
          <>
            Use <strong>Edit</strong> to update a saved log, <strong>Log again here</strong> to
            prefill the property, or <strong>Duplicate last stop</strong> for products and pest from
            the most recent visit.
          </>
        ) : (
          <>
            Use <strong>Log again here</strong> or <strong>Duplicate last stop</strong> to start a
            new log (tech cannot edit or delete saved logs — ask office).
          </>
        )}{" "}
        Stored only in this browser (localStorage).
      </p>

      <div className="card history-filters">
        <h3>Date used</h3>
        <p className="hint">
          Filter by <strong>date used</strong> (device-local YYYY-MM-DD). Leave blank for all logs.
        </p>
        <div className="row export-date-row">
          <label className="field">
            From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
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
            disabled={!hasDateInput}
          >
            Clear dates
          </button>
        </div>
        <p className="hint" role="status">
          Showing {filtered.length} of {logs.length} log{logs.length === 1 ? "" : "s"}
          {rangeActive ? " in range" : ""}.
        </p>
      </div>

      {filtered.length === 0 && (
        <p className="hint">No logs in this date range. Clear dates or widen the range.</p>
      )}

      {groups.map((group) => (
        <section className="history-group" key={group.key}>
          <div className="history-group-head">
            <h3>{group.serviceAddress}</h3>
            {(group.customerBillingName || group.poleLocation) && (
              <div className="log-meta property-meta">
                {group.customerBillingName && <span>{group.customerBillingName}</span>}
                {group.poleLocation && <span> · Pole: {group.poleLocation}</span>}
              </div>
            )}
            <div className="property-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onLogAgainHere(fullByKey.get(group.key) ?? group)}
              >
                Log again here
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onDuplicateLastStop(fullByKey.get(group.key) ?? group)}
              >
                Duplicate last stop
              </button>
            </div>
          </div>
          {group.logs.map((log) => {
            const epaBits = log.products
              .filter((p) => p.method !== "device")
              .map((p) => productEpaCaption(p))
              .filter(Boolean)
              .join(" · ");
            const reviewed = isLogReviewed(log);
            const hasFlags =
              reviewEnabled && !reviewed && reviewFlagsForLog(log, catalog ?? [], clock).length > 0;
            return (
              <article className="card history-log-card" key={log.id}>
                <div className="card-head history-log-head">
                  <div className="history-log-main">
                    <div className="history-log-title">
                      <strong>{log.dateUsed}</strong>
                      {log.sampleData && <span className="chip sample">example</span>}
                      {log.isTermite && <span className="chip">termite</span>}
                      {reviewed && <span className="chip">Reviewed</span>}
                    </div>
                    {reviewed && (
                      <div className="log-meta history-log-line">
                        Reviewed {reviewedLabel(log.reviewedAt ?? "")} by {log.reviewedBy}
                      </div>
                    )}
                    <div className="log-meta history-log-line">{productSummary(log)}</div>
                    {epaBits && <div className="log-meta history-log-line">{epaBits}</div>}
                    {log.jobberJobNumber && (
                      <div className="log-meta history-log-line">
                        Jobber #{log.jobberJobNumber} (not TDA)
                      </div>
                    )}
                  </div>
                  {canEditDelete && (
                    <div className="card-actions history-log-actions">
                      {!reviewed && (
                        <button type="button" className="btn btn-secondary" onClick={() => onEdit(log)}>
                          Edit
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost" onClick={() => handleDelete(log)}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
                {canEditDelete && reviewed && <p className="hint">{REVIEWED_LOCK_NOTE}</p>}
                {reviewEnabled && !reviewed && onMarkReviewed && (
                  <MarkReviewed
                    log={log}
                    people={people}
                    hasFlags={hasFlags}
                    onMarkReviewed={onMarkReviewed}
                  />
                )}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}