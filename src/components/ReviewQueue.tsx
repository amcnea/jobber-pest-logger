import { useMemo } from "react";
import { buildReviewQueue } from "../reviewQueue";
import type { ApplicationLog, ShopProduct } from "../types";

interface Props {
  logs: ApplicationLog[];
  catalog: ShopProduct[];
  /** Office role only; App also hides the tab and screen for tech sessions. */
  canReview: boolean;
  onEdit: (log: ApplicationLog) => void;
  /** Injected for tests; defaults to the device clock. */
  now?: Date;
}

export function ReviewQueue({ logs, catalog, canReview, onEdit, now }: Props) {
  const entries = useMemo(
    () => (canReview ? buildReviewQueue(logs, catalog, now ?? new Date()) : []),
    [canReview, logs, catalog, now],
  );

  if (!canReview) return null;

  return (
    <div>
      <h2>Review queue</h2>
      <p className="hint">Logs listed here have fields worth checking before export.</p>
      {entries.length === 0 ? (
        <p className="hint" role="status">
          No logs need a look right now.
        </p>
      ) : (
        <ul className="review-queue">
          {entries.map(({ log, flags }) => {
            const applicator = log.personnel.find((p) => p.role === "applying")?.name.trim();
            return (
              <li className="card" key={log.id} aria-label={`Review ${log.id}`}>
                <strong>
                  {log.dateUsed.trim() || "(no date)"} ·{" "}
                  {log.serviceAddress.trim() || "(no service address)"}
                </strong>
                <p className="log-meta">Applicator: {applicator || "(none)"}</p>
                <ul className="warn-list">
                  {flags.map((f) => (
                    <li key={f.field}>{f.text}</li>
                  ))}
                </ul>
                <button type="button" className="btn btn-secondary" onClick={() => onEdit(log)}>
                  Edit
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
