import { useMemo, useState } from "react";
import {
  keepDeviceCopy,
  listSyncConflicts,
  REUPLOAD_DONE_MSG,
  SET_ASIDE_CONFIRM,
  takeShopCopy,
} from "../shop/conflicts";
import type { LogOutboxEntry } from "../shop/logOutbox";

/** "Keep this device's copy" hint (Lawgical, #175). */
export const KEEP_DEVICE_HINT =
  "Uploads this device's copy to the shop. If the shop still has this log, it's saved as a correction with change history.";
import type { RemoteShopStore } from "../shop/RemoteShopStore";
import type { ApplicationLog, Person } from "../types";

interface Props {
  shopId: string;
  remote: RemoteShopStore;
  people: Person[];
  /** Bump to re-read the outbox (App outboxTick). */
  refreshKey: number;
  /** `error` is set when the device copy was saved but a later step failed. */
  onResolved: (logs: ApplicationLog[], error?: string) => void;
}

type Mode = { kind: "take" } | { kind: "keep" };

function PersonSelect({
  label,
  people,
  value,
  onChange,
}: {
  label: string;
  people: Person[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {people
          .filter((p) => p.name.trim())
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
    </label>
  );
}

function ConflictRow({
  entry,
  shopId,
  remote,
  people,
  onResolved,
  onNote,
}: {
  entry: LogOutboxEntry;
  shopId: string;
  remote: RemoteShopStore;
  people: Person[];
  /** `error` is set when the device copy was saved but a later step failed. */
  onResolved: (logs: ApplicationLog[], error?: string) => void;
  onNote: (text: string) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [personId, setPersonId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = entry.log;

  async function run(action: () => ReturnType<typeof takeShopCopy>) {
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (res.ok) {
        setMode(null);
        if (res.reuploaded) onNote(REUPLOAD_DONE_MSG);
        onResolved(res.logs);
      } else {
        setError(res.error);
        // Saved on this device before the failure: App must take the saved copy (#170).
        if (res.logs) onResolved(res.logs, res.error);
      }
    } finally {
      setBusy(false);
    }
  }

  function submitTake() {
    if (!confirm(SET_ASIDE_CONFIRM)) return;
    void run(() => takeShopCopy(remote, shopId, entry, { setAsideBy: personId, people }));
  }

  function submitKeep() {
    void run(() => keepDeviceCopy(remote, shopId, entry, { changedBy: personId, reason, people }));
  }

  return (
    <li className="card" aria-label={`Conflict ${log.id}`}>
      <strong>
        {log.dateUsed.trim() || "(no date)"} · {log.serviceAddress.trim() || "(no service address)"}
      </strong>
      {!mode && (
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={() => setMode({ kind: "take" })}>
            Take shop copy
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setMode({ kind: "keep" })}>
            Keep this device's copy
          </button>
        </div>
      )}
      {mode?.kind === "take" && (
        <div>
          <PersonSelect label="Set aside by" people={people} value={personId} onChange={setPersonId} />
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={!personId || busy} onClick={submitTake}>
              Take shop copy
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {mode?.kind === "keep" && (
        <div>
          <p className="hint">{KEEP_DEVICE_HINT}</p>
          <PersonSelect label="Changed by" people={people} value={personId} onChange={setPersonId} />
          <label className="field">
            Reason
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!personId || !reason.trim() || busy}
              onClick={submitKeep}
            >
              Save as a correction
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** Office-only list of sync conflicts with the two resolutions. Renders nothing when there are none. */
export function SyncConflicts({ shopId, remote, people, refreshKey, onResolved }: Props) {
  const conflicts = useMemo(
    () => listSyncConflicts(shopId),
    // refreshKey re-reads the outbox after enqueue / flush.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shopId, refreshKey],
  );
  const [note, setNote] = useState<string | null>(null);
  if (conflicts.length === 0 && !note) return null;
  return (
    <section className="card" aria-label="Sync conflicts">
      <h3>Sync conflicts</h3>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      <ul className="review-queue">
        {conflicts.map((entry) => (
          <ConflictRow
            key={entry.entryId}
            entry={entry}
            shopId={shopId}
            remote={remote}
            people={people}
            onResolved={onResolved}
            onNote={setNote}
          />
        ))}
      </ul>
    </section>
  );
}
