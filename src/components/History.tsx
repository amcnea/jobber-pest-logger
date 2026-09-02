import { groupLogsByServiceAddress } from "../storage";
import type { ApplicationLog } from "../types";

interface Props {
  logs: ApplicationLog[];
  onDelete: (id: string) => void;
}

function productSummary(log: ApplicationLog): string {
  if (log.products.length === 0) return "No products";
  return log.products
    .map((p) => (p.method === "device" ? `${p.name} × ${p.deviceCount}` : p.name))
    .join(", ");
}

export function History({ logs, onDelete }: Props) {
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
      <p className="hint">Prior logs grouped by service address. Stored only in this browser (localStorage).</p>
      {groups.map((group) => (
        <section className="history-group" key={group.address}>
          <h3>{group.address}</h3>
          {group.logs
            .slice()
            .sort((a, b) => b.dateUsed.localeCompare(a.dateUsed) || b.createdAt.localeCompare(a.createdAt))
            .map((log) => (
              <article className="card" key={log.id}>
                <div className="card-head">
                  <div>
                    <strong>{log.dateUsed}</strong> <span className="chip sample">SAMPLE</span>
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
                    .map((p) => p.epaRegNo ?? "25(b) no EPA #")
                    .join(" · ")}
                </div>
              </article>
            ))}
        </section>
      ))}
    </div>
  );
}
