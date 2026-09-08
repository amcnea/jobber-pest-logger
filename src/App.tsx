import { useCallback, useEffect, useMemo, useState } from "react";
import { Export } from "./components/Export";
import { FirstRunChecklist } from "./components/FirstRunChecklist";
import { A2hsTip } from "./components/A2hsTip";
import { ShopPilotCard } from "./components/ShopPilotCard";
import { History } from "./components/History";
import { NewLogForm } from "./components/NewLogForm";
import { People } from "./components/People";
import { Products } from "./components/Products";
import { Settings } from "./components/Settings";
import {
  draftDuplicateLastStop,
  draftLogAgainHere,
} from "./formDefaults";
import { collectPeopleWarnings } from "./peopleWarnings";
import {
  deleteLog,
  deletePerson,
  deleteProduct,
  getFirstRunSteps,
  loadCatalog,
  loadLastBackupAt,
  loadLogs,
  loadPeople,
  loadSettings,
  removeExampleProductsFromCatalog,
  clearExampleDemoData,
  wipeAllDeviceData,
  saveSettings,
  upsertLog,
  upsertPerson,
  upsertProduct,
  type PropertyBookEntry,
} from "./storage";
import type { ApplicationLog, Person, Screen, ShopProduct, ShopSettings } from "./types";
import {
  canUseOfficeSurfaces,
  flushLogOutbox,
  isFirebaseConfigured,
  loadShopSession,
  needsShopUnlock,
  outboxEntriesForShop,
  RemoteShopStore,
  resolveShopStore,
  sessionRole,
  shopStoreStatusHint,
  syncLogToRemote,
} from "./shop";
import { ShopSessionGate } from "./components/ShopSessionGate";
import "./App.css";

export default function App() {
  const [screen, setScreen] = useState<Screen>("new");
  const [logs, setLogs] = useState<ApplicationLog[]>(() => loadLogs());
  const [catalog, setCatalog] = useState<ShopProduct[]>(() => loadCatalog());
  const [people, setPeople] = useState<Person[]>(() => loadPeople());
  const [settings, setSettings] = useState<ShopSettings>(() => loadSettings());
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => loadLastBackupAt());
  const [storageError, setStorageError] = useState<string | null>(null);
  /** Prefill for New log (from History). Remount via draftKey when set. */
  const [draftSeed, setDraftSeed] = useState<ApplicationLog | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  /** Remount Settings shop form after wipe/restore so draft matches props. */
  const [settingsFormKey, setSettingsFormKey] = useState(0);
  /** Survives Settings remount so wipe/restore success banners stay visible. */
  const [settingsFlash, setSettingsFlash] = useState<{
    slot: "backup" | "demo";
    text: string;
  } | null>(null);
  /** Bumps topbar store-status after create / join / leave. */
  const [shopSessionTick, setShopSessionTick] = useState(0);
  /** Bumps outbox banner after enqueue / flush. */
  const [outboxTick, setOutboxTick] = useState(0);
  const [outboxFlushing, setOutboxFlushing] = useState(false);
  const [outboxMessage, setOutboxMessage] = useState<string | null>(null);

  const consumeSettingsFlash = useCallback(() => {
    setSettingsFlash(null);
  }, []);

  const handleShopSessionChange = useCallback(() => {
    setShopSessionTick((n) => n + 1);
    setOutboxTick((n) => n + 1);
  }, []);

  const refreshOutboxBanner = useCallback(() => {
    setOutboxTick((n) => n + 1);
  }, []);

  const flushPendingLogs = useCallback(async () => {
    const info = resolveShopStore();
    if (info.mode !== "shared" || !info.shopId || !(info.store instanceof RemoteShopStore)) {
      return;
    }
    if (outboxEntriesForShop(info.shopId).length === 0) {
      refreshOutboxBanner();
      return;
    }
    setOutboxFlushing(true);
    setOutboxMessage(null);
    try {
      const result = await flushLogOutbox(info.store, info.shopId);
      if (result.ok) {
        setOutboxMessage(
          result.flushed > 0
            ? `Synced ${result.flushed} queued log${result.flushed === 1 ? "" : "s"} to the shop.`
            : null,
        );
      } else {
        setOutboxMessage(result.error ?? "Could not sync queued logs. Will retry when online.");
      }
    } finally {
      setOutboxFlushing(false);
      refreshOutboxBanner();
    }
  }, [refreshOutboxBanner]);

  // Flush outbox on mount, online, and visibility (shared mode only).
  useEffect(() => {
    void flushPendingLogs();
    const onOnline = () => {
      void flushPendingLogs();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") void flushPendingLogs();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [flushPendingLogs, shopSessionTick]);

  // Re-read session when tick bumps (create/join/leave/sign-in/sign-out).
  const shopSession = loadShopSession();
  const activeRole = sessionRole(shopSession);
  /** Local-only + office: full UI. Authenticated tech: New log + History only (#4). */
  const allowOfficeSurfaces = canUseOfficeSurfaces(shopSession);

  /** Navigate; clear flash when leaving Settings so remount cannot resurrect it.
   *  Tech deep-links to office screens redirect to New log. */
  function go(s: Screen) {
    const next =
      !allowOfficeSurfaces && s !== "new" && s !== "history" ? "new" : s;
    if (screen === "settings" && next !== "settings") {
      setSettingsFlash(null);
    }
    setScreen(next);
  }

  // If session flips to tech while on an office screen, snap to New log.
  useEffect(() => {
    if (!allowOfficeSurfaces && screen !== "new" && screen !== "history") {
      setSettingsFlash(null);
      setScreen("new");
    }
  }, [allowOfficeSurfaces, screen]);

  const peopleWarnings = useMemo(() => collectPeopleWarnings(people), [people]);
  const firstRunSteps = useMemo(
    () => getFirstRunSteps({ settings, people, catalog, lastBackupAt }),
    [settings, people, catalog, lastBackupAt],
  );
  const isEditing =
    allowOfficeSurfaces &&
    draftSeed !== null &&
    logs.some((l) => l.id === draftSeed.id);

  function openNewLog(draft: ApplicationLog | null) {
    setDraftSeed(draft);
    setDraftKey((k) => k + 1);
    go("new");
  }

  /** Open an existing saved log into New log form; upsert keeps the same id. Office only. */
  function handleEdit(log: ApplicationLog) {
    if (!allowOfficeSurfaces) {
      openNewLog(null);
      return;
    }
    openNewLog(log);
  }

  function handleSave(log: ApplicationLog): boolean {
    // Tech may create new logs; editing an existing id is office-only.
    if (!allowOfficeSurfaces && logs.some((l) => l.id === log.id)) {
      setStorageError("Tech sessions can create new logs but not edit saved ones. Ask office.");
      return false;
    }
    const result = upsertLog(log);
    setLogs(result.logs);
    if (!result.saved) {
      setStorageError("Could not save on this device (storage full or blocked).");
      return false;
    }
    setStorageError(null);
    setDraftSeed(null);
    // Shared mode: push to Firestore; on network blip keep full log in outbox (#6).
    const info = resolveShopStore();
    if (info.mode === "shared" && info.shopId && info.store instanceof RemoteShopStore) {
      const remote = info.store;
      const shopId = info.shopId;
      void (async () => {
        const sync = await syncLogToRemote(remote, shopId, log);
        if (!sync.ok) {
          setOutboxMessage(
            sync.queued
              ? "Saved on this device. Cloud sync pending — will retry when online."
              : `Saved on this device, but could not queue cloud sync: ${sync.error}`,
          );
        } else {
          setOutboxMessage(null);
        }
        refreshOutboxBanner();
      })();
    }
    go("history");
    return true;
  }

  function handleDelete(id: string) {
    if (!allowOfficeSurfaces) {
      setStorageError("Tech sessions cannot delete saved logs. Ask office.");
      return;
    }
    // Confirm lives in History (includes date + address in the prompt).
    const result = deleteLog(id);
    setLogs(result.logs);
    setStorageError(result.saved ? null : "Could not update saved logs on this device.");
  }

  function handleLogAgainHere(property: PropertyBookEntry) {
    openNewLog(draftLogAgainHere(property, settings));
  }

  function handleDuplicateLastStop(property: PropertyBookEntry) {
    openNewLog(draftDuplicateLastStop(property.lastLog, people, settings));
  }

  function handleUpsertProduct(product: ShopProduct): boolean {
    const result = upsertProduct(product);
    setCatalog(result.catalog);
    if (!result.saved) {
      setStorageError("Could not save the shop list on this device (storage full or blocked).");
      return false;
    }
    setStorageError(null);
    return true;
  }

  function handleDeleteProduct(id: string) {
    const result = deleteProduct(id);
    setCatalog(result.catalog);
    setStorageError(result.saved ? null : "Could not update the shop list on this device.");
  }

  function handleRemoveExampleProducts(): boolean {
    const result = removeExampleProductsFromCatalog();
    setCatalog(result.catalog);
    if (!result.saved) {
      setStorageError("Could not update the shop list on this device.");
      return false;
    }
    setStorageError(null);
    return true;
  }

  function handleClearExamples(): { ok: boolean; summary: string } {
    const result = clearExampleDemoData();
    setCatalog(result.catalog);
    setLogs(result.logs);
    if (!result.saved) {
      setStorageError("Could not clear example data on this device.");
      return { ok: false, summary: "Could not clear example data on this device." };
    }
    setStorageError(null);
    const bits = [
      result.removedCatalog
        ? `${result.removedCatalog} example product${result.removedCatalog === 1 ? "" : "s"} removed from catalog`
        : "no example products in catalog",
      result.removedLogs
        ? `${result.removedLogs} demo log${result.removedLogs === 1 ? "" : "s"} deleted`
        : null,
      result.strippedLogs
        ? `${result.strippedLogs} log${result.strippedLogs === 1 ? "" : "s"} stripped of example lines`
        : null,
    ].filter(Boolean);
    return { ok: true, summary: `Example / demo data cleared (${bits.join("; ")}).` };
  }

  function handleWipeAll(): { ok: boolean; summary: string } {
    const result = wipeAllDeviceData();
    setCatalog(result.catalog);
    setLogs(result.logs);
    setPeople(result.people);
    setSettings(result.settings);
    setLastBackupAt(result.lastBackupAt);
    setDraftSeed(null);
    if (!result.saved) {
      setStorageError("Could not wipe data on this device.");
      return { ok: false, summary: "Could not wipe data on this device." };
    }
    setStorageError(null);
    const summary = "All device data wiped. Example seeds re-added for a fresh first-run.";
    setSettingsFlash({ slot: "demo", text: summary });
    setSettingsFormKey((k) => k + 1);
    return {
      ok: true,
      summary,
    };
  }

  function handleUpsertPerson(person: Person): boolean {
    const result = upsertPerson(person);
    setPeople(result.people);
    if (!result.saved) {
      setStorageError("Could not save the roster on this device (storage full or blocked).");
      return false;
    }
    setStorageError(null);
    return true;
  }

  function handleDeletePerson(id: string) {
    const result = deletePerson(id);
    setPeople(result.people);
    setStorageError(result.saved ? null : "Could not update the roster on this device.");
  }

  function handleSaveSettings(next: ShopSettings): boolean {
    const ok = saveSettings(next);
    if (!ok) {
      setStorageError("Could not save shop settings on this device (storage full or blocked).");
      return false;
    }
    setSettings(next);
    setStorageError(null);
    return true;
  }

  function handleRestored(
    data: {
      logs: ApplicationLog[];
      catalog: ShopProduct[];
      people: Person[];
      settings: ShopSettings;
    },
    flash?: string,
  ) {
    setLogs(data.logs);
    setCatalog(data.catalog);
    setPeople(data.people);
    setSettings(data.settings);
    setSettingsFlash(flash ? { slot: "backup", text: flash } : null);
    setSettingsFormKey((k) => k + 1);
    setStorageError(null);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="eyebrow">Texas TDA · Jobber sidecar</div>
        <h1>Jobber Pest Logger</h1>
        <p className="store-status" role="status">
          {/* shopSessionTick forces re-read after Settings create/join/leave/sign-in */}
          {shopSessionTick >= 0 && shopStoreStatusHint(resolveShopStore())}
        </p>
        {activeRole && (
          <p className="role-chrome" role="status">
            Signed in as <strong>{activeRole}</strong>
            {!allowOfficeSurfaces && (
              <> · New log + History only (office manages catalog, people, settings, export)</>
            )}
          </p>
        )}
      </header>
      <div className="banner">
        v1.6. Thin PWA polish (A2HS tip + manifest). Schema locked to 4 TAC § 7.144. Texas SPCS
        shops. Example seeds and incomplete records block real CSV/PDF export.
      </div>
      {allowOfficeSurfaces && <FirstRunChecklist steps={firstRunSteps} onGo={go} />}
      <ShopPilotCard />
      <A2hsTip />
      {shopSessionTick >= 0 &&
        isFirebaseConfigured() &&
        needsShopUnlock(loadShopSession()) && (
          <div className="shop-unlock-banner" role="region" aria-label="Shared shop unlock">
            <ShopSessionGate
              initialShopCode={loadShopSession().shopId}
              onSessionChange={handleShopSessionChange}
              compact
            />
          </div>
        )}
      {peopleWarnings.length > 0 && (
        <div className="banner banner-due" role="status">
          <strong>License / CE reminders</strong> (in-app only; not TDA-required; no SMS). License:
          past due or within 30 days. CE: overdue or year-end (Nov/Dec) for calendar-year CEUs.
          <ul className="warn-list">
            {peopleWarnings.map((w) => (
              <li key={w.personId}>
                {allowOfficeSurfaces ? (
                  <button type="button" className="linkish" onClick={() => go("people")}>
                    {w.personName}
                  </button>
                ) : (
                  <strong>{w.personName}</strong>
                )}
                : {w.messages.join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {storageError && (
        <div className="banner" role="alert">
          {storageError}
        </div>
      )}
      {outboxTick >= 0 &&
        (() => {
          const info = resolveShopStore();
          const pending =
            info.mode === "shared" && info.shopId
              ? outboxEntriesForShop(info.shopId).length
              : 0;
          if (pending === 0 && !outboxMessage) return null;
          return (
            <div className="banner banner-due" role="status">
              {pending > 0 ? (
                <>
                  <strong>
                    {pending} log{pending === 1 ? "" : "s"} waiting to sync
                  </strong>
                  Saved on this device; cloud put failed or offline. § 7.144 fields are kept in the
                  outbox until sync succeeds.
                  <div style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={outboxFlushing}
                      onClick={() => void flushPendingLogs()}
                    >
                      {outboxFlushing ? "Syncing…" : "Retry sync now"}
                    </button>
                  </div>
                </>
              ) : (
                outboxMessage
              )}
              {pending > 0 && outboxMessage ? (
                <p className="hint" style={{ marginTop: "0.35rem" }}>
                  {outboxMessage}
                </p>
              ) : null}
            </div>
          );
        })()}
      <nav className={allowOfficeSurfaces ? "tabs" : "tabs tabs-tech"} aria-label="Main">
        <button
          type="button"
          className={screen === "new" ? "active" : ""}
          onClick={() => {
            // Fresh blank form when leaving History prefill; leave an in-progress blank alone.
            if (screen === "new" && draftSeed === null) return;
            openNewLog(null);
          }}
        >
          New log
        </button>
        <button
          type="button"
          className={screen === "history" ? "active" : ""}
          onClick={() => go("history")}
        >
          History
        </button>
        {allowOfficeSurfaces && (
          <>
            <button
              type="button"
              className={screen === "products" ? "active" : ""}
              onClick={() => go("products")}
            >
              Products
            </button>
            <button
              type="button"
              className={screen === "people" ? "active" : ""}
              onClick={() => go("people")}
            >
              People
            </button>
            <button
              type="button"
              className={screen === "settings" ? "active" : ""}
              onClick={() => go("settings")}
            >
              Settings
            </button>
            <button
              type="button"
              className={screen === "export" ? "active" : ""}
              onClick={() => go("export")}
            >
              Export
            </button>
          </>
        )}
      </nav>
      <main className="main">
        {screen === "new" && (
          <NewLogForm
            key={draftKey}
            catalog={catalog}
            people={people}
            settings={settings}
            initialDraft={draftSeed}
            isEditing={isEditing}
            onSave={handleSave}
          />
        )}
        {screen === "history" && (
          <History
            logs={logs}
            canEditDelete={allowOfficeSurfaces}
            onDelete={handleDelete}
            onEdit={handleEdit}
            onLogAgainHere={handleLogAgainHere}
            onDuplicateLastStop={handleDuplicateLastStop}
          />
        )}
        {allowOfficeSurfaces && screen === "products" && (
          <Products
            catalog={catalog}
            onUpsert={handleUpsertProduct}
            onDelete={handleDeleteProduct}
            onRemoveExamples={handleRemoveExampleProducts}
          />
        )}
        {allowOfficeSurfaces && screen === "people" && (
          <People people={people} onUpsert={handleUpsertPerson} onDelete={handleDeletePerson} />
        )}
        {allowOfficeSurfaces && screen === "settings" && (
          <Settings
            key={settingsFormKey}
            settings={settings}
            lastBackupAt={lastBackupAt}
            flash={settingsFlash}
            onFlashConsumed={consumeSettingsFlash}
            sessionRevision={shopSessionTick}
            onShopSessionChange={handleShopSessionChange}
            onSave={handleSaveSettings}
            onRestored={handleRestored}
            onBackupStampChange={setLastBackupAt}
            onClearExamples={handleClearExamples}
            onWipeAll={handleWipeAll}
          />
        )}
        {allowOfficeSurfaces && screen === "export" && (
          <Export
            logs={logs}
            catalog={catalog}
            settings={settings}
            lastBackupAt={lastBackupAt}
            onRemoveExamples={handleRemoveExampleProducts}
            onGo={go}
          />
        )}
      </main>
    </div>
  );
}
