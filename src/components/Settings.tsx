import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
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
import {
  createShop,
  hasJoinedShop,
  isFirebaseConfigured,
  joinShop,
  leaveShop,
  loadShopSession,
  shopStoreStatusHint,
} from "../shop";

interface Props {
  settings: ShopSettings;
  lastBackupAt: string | null;
  /** Set by App before remount so wipe/restore success survives the key bump. */
  flash?: { slot: "backup" | "demo"; text: string } | null;
  /** App clears settingsFlash after Settings seeds local banners from flash. */
  onFlashConsumed?: () => void;
  /** Bump topbar / store status after create, join, or leave. */
  onShopSessionChange?: () => void;
  onSave: (settings: ShopSettings) => boolean;
  onRestored: (
    data: {
      logs: ApplicationLog[];
      catalog: ShopProduct[];
      people: Person[];
      settings: ShopSettings;
    },
    flash?: string,
  ) => void;
  onBackupStampChange: (iso: string | null) => void;
  onClearExamples: () => { ok: boolean; summary: string };
  onWipeAll: () => { ok: boolean; summary: string };
}

export function Settings({
  settings,
  lastBackupAt,
  flash = null,
  onFlashConsumed,
  onShopSessionChange,
  onSave,
  onRestored,
  onBackupStampChange,
  onClearExamples,
  onWipeAll,
}: Props) {
  const [draft, setDraft] = useState<ShopSettings>(settings);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(
    flash?.slot === "backup" ? flash.text : null,
  );
  const [backupError, setBackupError] = useState<string | null>(null);
  const [demoMsg, setDemoMsg] = useState<string | null>(
    flash?.slot === "demo" ? flash.text : null,
  );
  const [joinCode, setJoinCode] = useState("");
  const [shopBusy, setShopBusy] = useState(false);
  const [shopMsg, setShopMsg] = useState<string | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);
  const [shopHint, setShopHint] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [joined, setJoined] = useState(() => hasJoinedShop());
  const [sessionShopId, setSessionShopId] = useState(() => loadShopSession().shopId);
  const fileRef = useRef<HTMLInputElement>(null);

  const firebaseOk = isFirebaseConfigured();
  const lastBackupLabel = formatLastBackupLabel(lastBackupAt);
  const nag = backupNagMessage(lastBackupAt);

  function refreshShopSessionUi(nextShopId?: string) {
    const session = loadShopSession();
    const id = nextShopId ?? session.shopId;
    setSessionShopId(id);
    setJoined(hasJoinedShop(session));
    onShopSessionChange?.();
  }

  async function handleCreateShop() {
    setShopBusy(true);
    setShopMsg(null);
    setShopError(null);
    setShopHint(null);
    setCreatedCode(null);
    try {
      const result = await createShop();
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      setCreatedCode(result.shopId);
      setShopMsg(result.message);
      if (result.hint) setShopHint(result.hint);
      refreshShopSessionUi(result.shopId);
    } finally {
      setShopBusy(false);
    }
  }

  async function handleJoinShop() {
    setShopBusy(true);
    setShopMsg(null);
    setShopError(null);
    setShopHint(null);
    setCreatedCode(null);
    try {
      const result = await joinShop(joinCode);
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      setJoinCode("");
      setShopMsg(result.message);
      if (result.hint) setShopHint(result.hint);
      refreshShopSessionUi(result.shopId);
    } finally {
      setShopBusy(false);
    }
  }

  function handleLeaveShop() {
    setShopMsg(null);
    setShopError(null);
    setShopHint(null);
    setCreatedCode(null);
    const result = leaveShop();
    if (!result.ok) {
      setShopError(result.error);
      return;
    }
    setShopMsg(result.message);
    refreshShopSessionUi("");
  }

  // Explicit consume: App clears settingsFlash once we seeded local banners.
  useEffect(() => {
    if (flash != null) {
      onFlashConsumed?.();
    }
  }, [flash, onFlashConsumed]);

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

    const restoreFlash = `Restored backup (v${result.backup.version}) from ${result.backup.exportedAt}. Device data replaced.`;
    onRestored(
      {
        logs: result.backup.logs,
        catalog: result.backup.catalog,
        people: result.backup.people,
        settings: result.backup.settings,
      },
      restoreFlash,
    );
    // App remounts Settings via key; flash prop carries the success banner.
  }

  return (
    <div>
      <p className="hint store-status-settings" role="status">
        {shopStoreStatusHint()}
      </p>

      <h2>Shared shop</h2>
      <p className="hint">
        Optional multi-device shop via Firebase. Local-only until you create or join. Requires
        Firebase env from <code>.env.example</code>. Shop code is the join secret until a later PIN
        slice. Cloud sync is <strong>not</strong> the 2-year premises retention path — keep Export /
        backup and the Lawgical disclaimer.
      </p>
      <div className="card settings-backup-actions shop-card">
        {!firebaseOk && (
          <p className="hint" role="status">
            Firebase is not configured on this build. Create / Join stay disabled; this device remains
            local-only.
          </p>
        )}
        {joined && sessionShopId ? (
          <>
            <p className="hint" role="status">
              Mode: <strong>{firebaseOk ? "shared" : "local only"}</strong>
            </p>
            {!firebaseOk && (
              <p className="hint" role="status">
                Saved shop session is inactive without Firebase — this device stays local-only.
                Leave clears the saved session.
              </p>
            )}
            <p className="shop-code-display" role="status">
              Shop code: <strong className="shop-code">{sessionShopId}</strong>
            </p>
            {firebaseOk && (
              <p className="hint">
                Day-to-day screens still read/write this device&apos;s localStorage. Create and first
                migrate upload a shop snapshot to Firestore; live shared read/write is a later slice.
              </p>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={shopBusy}
              onClick={handleLeaveShop}
            >
              Leave shop
            </button>
          </>
        ) : (
          <>
            <p className="hint" role="status">
              Mode: <strong>local only</strong>
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!firebaseOk || shopBusy}
              onClick={() => {
                void handleCreateShop();
              }}
            >
              {shopBusy ? "Working…" : "Create shop"}
            </button>
            {createdCode && (
              <p className="shop-code-display" role="status">
                Share this code with the office:{" "}
                <strong className="shop-code">{createdCode}</strong>
              </p>
            )}
            <label className="field">
              Join with shop code
              <input
                value={joinCode}
                onChange={(e) => {
                  setShopError(null);
                  setJoinCode(e.target.value);
                }}
                placeholder="e.g. ABCD2345"
                autoComplete="off"
                spellCheck={false}
                disabled={!firebaseOk || shopBusy}
                aria-label="Shop code to join"
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!firebaseOk || shopBusy || !joinCode.trim()}
              onClick={() => {
                void handleJoinShop();
              }}
            >
              Join shop
            </button>
          </>
        )}
        {shopMsg && (
          <p className="hint" role="status">
            {shopMsg}
          </p>
        )}
        {shopHint && (
          <p className="nag" role="status">
            {shopHint}
          </p>
        )}
        {shopError && (
          <p className="hint" role="alert">
            {shopError}
          </p>
        )}
      </div>

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


      <h2>Demo / reset</h2>
      <p className="hint">
        Soft demo reset clears example catalog seeds and any logs that only used them. Real products,
        people, settings, and backups stay. A full wipe needs an explicit confirm — it removes real
        shop data on this device and re-seeds examples.
      </p>
      <div className="card settings-backup-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setDemoMsg(null);
            const result = onClearExamples();
            setDemoMsg(result.summary);
          }}
        >
          Clear example / demo data
        </button>
        <button
          type="button"
          className="btn btn-ghost danger-wipe"
          onClick={() => {
            setDemoMsg(null);
            if (
              !confirm(
                "Wipe ALL Jobber Pest Logger data on this device? Logs, real products, people, and settings will be deleted. Example seeds will be re-added. This cannot be undone.",
              )
            ) {
              return;
            }
            if (
              !confirm(
                "Last chance: permanently wipe real shop data (logs, products, people, settings) on this device?",
              )
            ) {
              return;
            }
            const result = onWipeAll();
            // Success remounts Settings; App passes flash. Keep failure banner here.
            if (!result.ok) setDemoMsg(result.summary);
          }}
        >
          Wipe all data on this device…
        </button>
        {demoMsg && (
          <p className="hint" role="status">
            {demoMsg}
          </p>
        )}
      </div>

      <p className="disclaimer">{LAWGICAL_DISCLAIMER}</p>
    </div>
  );
}