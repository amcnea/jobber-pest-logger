import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { LAWGICAL_DISCLAIMER } from "../disclaimer";
import {
  applyBackup,
  backupNagMessage,
  downloadBackup,
  formatLastBackupLabel,
  loadLastBackupAt,
  parseBackup,
} from "../storage";
import type { ApplicationLog, Person, ShopProduct, ShopSettings } from "../types";

interface Props {
  settings: ShopSettings;
  lastBackupAt: string | null;
  onSave: (settings: ShopSettings) => boolean;
  onRestored: (data: {
    logs: ApplicationLog[];
    catalog: ShopProduct[];
    people: Person[];
    settings: ShopSettings;
  }) => void;
  onBackupStampChange: (iso: string | null) => void;
}

export function Settings({
  settings,
  lastBackupAt,
  onSave,
  onRestored,
  onBackupStampChange,
}: Props) {
  const [draft, setDraft] = useState<ShopSettings>(settings);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const lastBackupLabel = formatLastBackupLabel(lastBackupAt);
  const nag = backupNagMessage(lastBackupAt);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSavedMsg(null);
    const next: ShopSettings = {
      shopName: draft.shopName.trim(),
      shopTpclNumber: draft.shopTpclNumber.trim(),
      shopTpclLetter: draft.shopTpclLetter.trim(),
    };
    const ok = onSave(next);
    if (ok) {
      setDraft(next);
      setSavedMsg("Shop settings saved on this device.");
    }
  }

  async function handleRestoreFile(e: ChangeEvent<HTMLInputElement>) {
    setBackupMsg(null);
    setBackupError(null);
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    let parsed: unknown;
    try {
      const text = await file.text();
      parsed = JSON.parse(text) as unknown;
    } catch {
      setBackupError("Could not read that file as JSON.");
      return;
    }

    const result = parseBackup(parsed);
    if (!result.ok) {
      setBackupError(result.error);
      return;
    }

    const confirmed = confirm(
      "Restore this backup? It replaces all logs, catalog, people, and settings currently saved on this device.",
    );
    if (!confirmed) return;

    const applied = applyBackup(result.backup);
    if (!applied) {
      setBackupError("Could not write restored data (storage full or blocked).");
      return;
    }

    onRestored({
      logs: result.backup.logs,
      catalog: result.backup.catalog,
      people: result.backup.people,
      settings: result.backup.settings,
    });
    setDraft(result.backup.settings);
    setBackupMsg(
      `Restored backup (v${result.backup.version}) from ${result.backup.exportedAt}. Device data replaced.`,
    );
  }

  return (
    <div>
      <h2>Shop settings</h2>
      <p className="hint">
        Shop name and TPCL live under their own localStorage key (separate from logs, catalog, and
        people). New logs prefill TPCL number and letter from here. Not a new TDA-required field —
        TPCL already sits on each application log.
      </p>

      <form className="card" onSubmit={submit} noValidate>
        <label className="field">
          Shop name
          <input
            value={draft.shopName}
            onChange={(e) => {
              setSavedMsg(null);
              setDraft((d) => ({ ...d, shopName: e.target.value }));
            }}
            placeholder="Acme Pest Control"
            autoComplete="organization"
          />
        </label>
        <div className="row row-tpcl">
          <label className="field">
            Shop TPCL number
            <input
              value={draft.shopTpclNumber}
              onChange={(e) => {
                setSavedMsg(null);
                setDraft((d) => ({ ...d, shopTpclNumber: e.target.value }));
              }}
              placeholder="TPCL"
              autoComplete="off"
            />
          </label>
          <label className="field">
            TPCL letter (if any)
            <input
              value={draft.shopTpclLetter}
              onChange={(e) => {
                setSavedMsg(null);
                setDraft((d) => ({ ...d, shopTpclLetter: e.target.value }));
              }}
              placeholder="A"
              maxLength={4}
              autoComplete="off"
              inputMode="text"
              aria-label="TPCL letter if any"
            />
          </label>
        </div>
        <div className="sticky-save sticky-actions">
          <button type="submit" className="btn btn-primary">
            Save shop settings
          </button>
          {savedMsg && (
            <p className="hint" role="status">
              {savedMsg}
            </p>
          )}
        </div>
      </form>

      <h2>Backup &amp; restore</h2>
      <p className="hint">
        Download one JSON file with logs, catalog, people, settings, and a version stamp. Restore
        replaces everything on this device after you confirm. Invalid or garbage files are rejected.
      </p>
      <p className="hint" role="status">
        {lastBackupLabel}
      </p>
      {nag && (
        <p className="nag" role="status">
          {nag}
        </p>
      )}
      <div className="card settings-backup-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setBackupError(null);
            downloadBackup();
            onBackupStampChange(loadLastBackupAt());
            setBackupMsg("Backup downloaded.");
          }}
        >
          Download backup JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          aria-label="Restore backup JSON file"
          tabIndex={-1}
          onChange={(ev) => {
            void handleRestoreFile(ev);
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => fileRef.current?.click()}
        >
          Restore from file…
        </button>
        {backupMsg && (
          <p className="hint" role="status">
            {backupMsg}
          </p>
        )}
        {backupError && (
          <p className="hint" role="alert">
            {backupError}
          </p>
        )}
      </div>

      <p className="disclaimer">{LAWGICAL_DISCLAIMER}</p>
    </div>
  );
}