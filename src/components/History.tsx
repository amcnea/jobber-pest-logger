import { productEpaCaption } from "../catalog";
import { groupLogsByServiceAddress, type PropertyBookEntry } from "../storage";
import type { ApplicationLog } from "../types";

interface Props {
  logs: ApplicationLog[];
  onDelete: (id: string) => void;
  onLogAgainHere: (property: PropertyBookEntry) => void;
  onDuplicateLastStop: (property: PropertyBookEntry) => void;
}

function productSummary(log: ApplicationLog): string {
  if (log.products.length === 0) return "No products";
  return log.products
    .map((p) => (p.method === "device" ? `${p.name} × ${p.deviceCount}` : p.name))
    .join(", ");
}

export function History({ logs, onDelete, onLogAgainHere, onDuplicateLastStop }: Props) {
  const groups = groupLogsByServiceAddress(logs);

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
        Prior logs grouped by service address (property book). Use{" "}
        <strong>Log again here</strong> to prefill the property, or{" "}
        <strong>Duplicate last stop</strong> to copy products and pest from the most recent visit.
        Stored only in this browser (localStorage).
      </p>
      {groups.map((group) => (
        <section className="history-group" key={group.key}>
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
              onClick={() => onLogAgainHere(group)}
            >
              Log again here
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onDuplicateLastStop(group)}
            >
              Duplicate last stop
            </button>
          </div>
          {group.logs.map((log) => {
              const hasExample = log.sampleData;
              return (
                <article className="card" key={log.id}>
                  <div className="card-head">
                    <div>
                      <strong>{log.dateUsed}</strong>
                      {hasExample && <span className="chip sample"> example</span>}
                      {log.isTermite && <span className="chip"> termite</span>}
                      <div className="log-meta">{log.customerBillingName}</div>
                      <div className="log-meta">{productSummary(log)}</div>
                      {log.jobberJobNumber && (
                        <div className="log-meta">Jobber #{log.jobberJobNumber} (not TDA)</div>
                      )}
                    </div>
                    <button type="button" className="btn btn-ghost" onClick={() => onDelete(log.id)}>
                      Delete
                    </button>
                  </div>
                  <div className="log-meta">
                    {log.products
                      .filter((p) => p.method !== "device")
                      .map((p) => productEpaCaption(p))
                      .join(" · ")}
                  </div>
                </article>
              );
            })}
        </section>
      ))}
    </div>
  );
}
