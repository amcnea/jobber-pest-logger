import { useMemo } from "react";
import { buildReviewQueue, isLogReviewed } from "../reviewQueue";
import type { ApplicationLog, ShopProduct } from "../types";
import { useNow } from "../useNow";

export const REVIEWED_LOCK_NOTE = "Reviewed logs can't be edited in place; original values kept.";

interface Props {
  logs: ApplicationLog[];
  catalog: ShopProduct[];
  /** Office role only; App also hides the tab and screen for tech sessions. */
  canReview: boolean;
  onEdit: (log: ApplicationLog) => void;
  /** Office: open a reviewed log in the correction form. */
  onCorrect?: (log: ApplicationLog) => void;
  /** Pins the clock (tests). Omit to use the device clock, refreshed each minute / on focus. */
  now?: Date;
}

export function ReviewQueue({ logs, catalog, canReview, onEdit, onCorrect, now }: Props) {
  const clock = useNow(now);
  const entries = useMemo(
    () => (canReview ? buildReviewQueue(logs, catalog, clock) : []),
    [canReview, logs, catalog, clock],
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
            const reviewed = isLogReviewed(log);
            return (
              <li className="card" key={log.id} aria-label={`Review ${log.id}`}>
                <strong>
                  {log.dateUsed.trim() || "(no date)"} ·{" "}
                  {log.serviceAddress.trim() || "(no service address)"}
                </strong>
                {reviewed && <span className="chip"> Reviewed</span>}
                <p className="log-meta">Applicator: {applicator || "(none)"}</p>
                <ul className="warn-list">
                  {flags.map((f) => (
                    <li key={f.field}>{f.text}</li>
                  ))}
                </ul>
                {reviewed ? (
                  <>
                    <p className="hint">{REVIEWED_LOCK_NOTE}</p>
                    {onCorrect && (
                      <button type="button" className="btn btn-secondary" onClick={() => onCorrect(log)}>
                        Correct this log
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" className="btn btn-secondary" onClick={() => onEdit(log)}>
                    Edit
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
