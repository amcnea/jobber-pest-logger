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
  canAccessOffice,
  changeShopPins,
  createShop,
  hasJoinedShop,
  isFirebaseConfigured,
  isSessionAuthenticated,
  joinShop,
  leaveShop,
  loadShopSession,
  sessionRole,
  shopStoreStatusHint,
  signOutShop,
  type ShopRole,
} from "../shop";
import { ShopSessionGate } from "./ShopSessionGate";

interface Props {
  settings: ShopSettings;
  lastBackupAt: string | null;
  /** Set by App before remount so wipe/restore success survives the key bump. */
  flash?: { slot: "backup" | "demo"; text: string } | null;
  /** App clears settingsFlash after Settings seeds local banners from flash. */
  onFlashConsumed?: () => void;
  /** Bumps when App / banner unlock changes shop session — sync local UI without tick loop. */
  sessionRevision?: number;
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
  sessionRevision = 0,
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
  const [joinRole, setJoinRole] = useState<ShopRole>("tech");
  const [joinPin, setJoinPin] = useState("");
  const [officePin, setOfficePin] = useState("");
  const [officePinConfirm, setOfficePinConfirm] = useState("");
  const [techPin, setTechPin] = useState("");
  const [techPinConfirm, setTechPinConfirm] = useState("");
  const [changeOfficePin, setChangeOfficePin] = useState("");
  const [changeOfficePinConfirm, setChangeOfficePinConfirm] = useState("");
  const [changeTechPin, setChangeTechPin] = useState("");
  const [changeTechPinConfirm, setChangeTechPinConfirm] = useState("");
  const [showChangePins, setShowChangePins] = useState(false);
  const [shopBusy, setShopBusy] = useState(false);
  const [shopMsg, setShopMsg] = useState<string | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);
  const [shopHint, setShopHint] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [joined, setJoined] = useState(() => hasJoinedShop());
  const [authenticated, setAuthenticated] = useState(() => isSessionAuthenticated());
  const [role, setRole] = useState(() => sessionRole());
  const [sessionShopId, setSessionShopId] = useState(() => loadShopSession().shopId);
  const fileRef = useRef<HTMLInputElement>(null);

  const firebaseOk = isFirebaseConfigured();
  const officeOk = canAccessOffice();
  const lastBackupLabel = formatLastBackupLabel(lastBackupAt);
  const nag = backupNagMessage(lastBackupAt);

  /** Sync local Settings state from session storage — does NOT bump App tick. */
  function syncShopSessionUi(nextShopId?: string) {
    const session = loadShopSession();
    const id = nextShopId ?? session.shopId;
    setSessionShopId(id);
    setJoined(hasJoinedShop(session));
    setAuthenticated(isSessionAuthenticated(session));
    setRole(sessionRole(session));
  }

  /** Sync then notify App (create/join/leave/sign-out from Settings). */
  function refreshShopSessionUi(nextShopId?: string) {
    syncShopSessionUi(nextShopId);
    onShopSessionChange?.();
  }

  function clearPinDrafts() {
    setOfficePin("");
    setOfficePinConfirm("");
    setTechPin("");
    setTechPinConfirm("");
    setJoinPin("");
    setChangeOfficePin("");
    setChangeOfficePinConfirm("");
    setChangeTechPin("");
    setChangeTechPinConfirm("");
  }

  async function handleCreateShop() {
    setShopBusy(true);
    setShopMsg(null);
    setShopError(null);
    setShopHint(null);
    setCreatedCode(null);
    try {
      const result = await createShop({
        officePin,
        officePinConfirm,
        techPin,
        techPinConfirm,
      });
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      setCreatedCode(result.shopId);
      setShopMsg(result.message);
      if (result.hint) setShopHint(result.hint);
      clearPinDrafts();
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
      const result = await joinShop(joinCode, { role: joinRole, pin: joinPin });
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      setJoinCode("");
      setJoinPin("");
      setShopMsg(result.message);
      if (result.hint) setShopHint(result.hint);
      refreshShopSessionUi(result.shopId);
    } finally {
      setShopBusy(false);
    }
  }

  async function handleChangePins() {
    setShopBusy(true);
    setShopMsg(null);
    setShopError(null);
    setShopHint(null);
    try {
      const result = await changeShopPins({
        officePin: changeOfficePin,
        officePinConfirm: changeOfficePinConfirm,
        techPin: changeTechPin,
        techPinConfirm: changeTechPinConfirm,
      });
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      setShopMsg(result.message);
      clearPinDrafts();
      setShowChangePins(false);
      refreshShopSessionUi(result.shopId);
    } finally {
      setShopBusy(false);
    }
  }

  function handleSignOut() {
    setShopMsg(null);
    setShopError(null);
    setShopHint(null);
    setCreatedCode(null);
    const result = signOutShop();
    if (!result.ok) {
      setShopError(result.error);
      return;
    }
    setShopMsg(result.message);
    refreshShopSessionUi(result.shopId);
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
    clearPinDrafts();
    refreshShopSessionUi("");
  }

  // Explicit consume: App clears settingsFlash once we seeded local banners.
  useEffect(() => {
    if (flash != null) {
      onFlashConsumed?.();
    }
  }, [flash, onFlashConsumed]);

  // Banner unlock bumps sessionRevision; sync without calling onShopSessionChange (no tick loop).
  useEffect(() => {
    syncShopSessionUi();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when App bumps revision
  }, [sessionRevision]);

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
        Optional multi-device shop via Firebase. Local-only until you create or join with a PIN.
        Requires Firebase env from <code>.env.example</code>. PINs are salted hashes on the shop
        document — never stored plaintext in session. Cloud sync is <strong>not</strong> the 2-year
        premises retention path — keep Export / backup and the Lawgical disclaimer.
      </p>
      <div className="card settings-backup-actions shop-card">
        {!firebaseOk && (
          <p className="hint" role="status">
            Firebase is not configured on this build. Create / Join / Unlock stay disabled; this
            device remains local-only (no PIN gate).
          </p>
        )}
        {firebaseOk && joined && !authenticated && (
          <ShopSessionGate
            initialShopCode={sessionShopId}
            onSessionChange={() => refreshShopSessionUi()}
          />
        )}
        {joined && sessionShopId && authenticated ? (
          <>
            <p className="hint" role="status">
              Mode: <strong>{firebaseOk ? "shared" : "local only"}</strong>
              {role ? (
                <>
                  {" "}
                  · role: <strong>{role}</strong>
                </>
              ) : null}
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
                Full office/tech screen gates land in #4 — <code>canAccessOffice()</code> /{" "}
                <code>session.role</code> are ready.
              </p>
            )}
            <div className="shop-session-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={shopBusy}
                onClick={handleSignOut}
              >
                Sign out
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={shopBusy || (authenticated && role === "tech")}
                title={
                  role === "tech"
                    ? "Tech can sign out; leave shop is office-preferred (or unlock as office)."
                    : undefined
                }
                onClick={handleLeaveShop}
              >
                Leave shop
              </button>
            </div>
            {role === "tech" && (
              <p className="hint">
                Signed in as tech. Leave shop is disabled here — sign out, or ask office to leave from
                an office session. Role-gated screens arrive in #4.
              </p>
            )}
            {officeOk && firebaseOk && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={shopBusy}
                  onClick={() => setShowChangePins((v) => !v)}
                >
                  {showChangePins ? "Hide change PINs" : "Change office / tech PINs…"}
                </button>
                {showChangePins && (
                  <div className="shop-bootstrap">
                    <label className="field">
                      New office PIN
                      <input
                        type="password"
                        inputMode="numeric"
                        value={changeOfficePin}
                        onChange={(e) => setChangeOfficePin(e.target.value)}
                        disabled={shopBusy}
                        autoComplete="new-password"
                      />
                    </label>
                    <label className="field">
                      Confirm office PIN
                      <input
                        type="password"
                        inputMode="numeric"
                        value={changeOfficePinConfirm}
                        onChange={(e) => setChangeOfficePinConfirm(e.target.value)}
                        disabled={shopBusy}
                        autoComplete="new-password"
                      />
                    </label>
                    <label className="field">
                      New tech PIN
                      <input
                        type="password"
                        inputMode="numeric"
                        value={changeTechPin}
                        onChange={(e) => setChangeTechPin(e.target.value)}
                        disabled={shopBusy}
                        autoComplete="new-password"
                      />
                    </label>
                    <label className="field">
                      Confirm tech PIN
                      <input
                        type="password"
                        inputMode="numeric"
                        value={changeTechPinConfirm}
                        onChange={(e) => setChangeTechPinConfirm(e.target.value)}
                        disabled={shopBusy}
                        autoComplete="new-password"
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={shopBusy}
                      onClick={() => {
                        void handleChangePins();
                      }}
                    >
                      Save new PINs
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        ) : !joined ? (
          <>
            <p className="hint" role="status">
              Mode: <strong>local only</strong>
            </p>
            {firebaseOk && (
              <>
                <h3 className="shop-subhead">Create shop (office)</h3>
                <p className="hint">
                  Sets salted office + tech PIN hashes on the new shop document. You stay signed in as
                  office.
                </p>
                <label className="field">
                  Office PIN (4–8 digits)
                  <input
                    type="password"
                    inputMode="numeric"
                    value={officePin}
                    onChange={(e) => {
                      setShopError(null);
                      setOfficePin(e.target.value);
                    }}
                    disabled={!firebaseOk || shopBusy}
                    autoComplete="new-password"
                  />
                </label>
                <label className="field">
                  Confirm office PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    value={officePinConfirm}
                    onChange={(e) => setOfficePinConfirm(e.target.value)}
                    disabled={!firebaseOk || shopBusy}
                    autoComplete="new-password"
                  />
                </label>
                <label className="field">
                  Tech PIN (4–8 digits)
                  <input
                    type="password"
                    inputMode="numeric"
                    value={techPin}
                    onChange={(e) => setTechPin(e.target.value)}
                    disabled={!firebaseOk || shopBusy}
                    autoComplete="new-password"
                  />
                </label>
                <label className="field">
                  Confirm tech PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    value={techPinConfirm}
                    onChange={(e) => setTechPinConfirm(e.target.value)}
                    disabled={!firebaseOk || shopBusy}
                    autoComplete="new-password"
                  />
                </label>
              </>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                !firebaseOk ||
                shopBusy ||
                !officePin.trim() ||
                !techPin.trim()
              }
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
            {firebaseOk && (
              <>
                <h3 className="shop-subhead">Join shop</h3>
                <p className="hint">Requires shop code + role + matching PIN from the office.</p>
              </>
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
            {firebaseOk && (
              <>
                <fieldset className="shop-role-fieldset" disabled={shopBusy}>
                  <legend>Role</legend>
                  <label className="shop-role-option">
                    <input
                      type="radio"
                      name="shop-join-role"
                      checked={joinRole === "office"}
                      onChange={() => setJoinRole("office")}
                    />
                    Office
                  </label>
                  <label className="shop-role-option">
                    <input
                      type="radio"
                      name="shop-join-role"
                      checked={joinRole === "tech"}
                      onChange={() => setJoinRole("tech")}
                    />
                    Tech
                  </label>
                </fieldset>
                <label className="field">
                  PIN for that role
                  <input
                    type="password"
                    inputMode="numeric"
                    value={joinPin}
                    onChange={(e) => {
                      setShopError(null);
                      setJoinPin(e.target.value);
                    }}
                    placeholder="4–8 digits"
                    disabled={shopBusy}
                    autoComplete="one-time-code"
                    aria-label="PIN for selected role"
                  />
                </label>
              </>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!firebaseOk || shopBusy || !joinCode.trim() || !joinPin.trim()}
              onClick={() => {
                void handleJoinShop();
              }}
            >
              Join shop
            </button>
          </>
        ) : (
          <>
            <p className="hint" role="status">
              Mode: <strong>locked</strong> — shop code remembered
            </p>
            <p className="shop-code-display" role="status">
              Shop code: <strong className="shop-code">{sessionShopId}</strong>
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={shopBusy}
              onClick={handleLeaveShop}
            >
              Leave shop
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
          disabled={authenticated && role === "tech"}
          title={
            authenticated && role === "tech"
              ? "Wipe is office-only while signed into a shared shop as tech."
              : undefined
          }
          onClick={() => {
            setDemoMsg(null);
            if (authenticated && role === "tech") return;
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
        {authenticated && role === "tech" && (
          <p className="hint">Wipe is disabled for tech sessions (office helper stub for #4).</p>
        )}
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