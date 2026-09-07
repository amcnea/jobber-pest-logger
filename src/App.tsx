import { useMemo, useState } from "react";
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

  const peopleWarnings = useMemo(() => collectPeopleWarnings(people), [people]);
  const firstRunSteps = useMemo(
    () => getFirstRunSteps({ settings, people, catalog, lastBackupAt }),
    [settings, people, catalog, lastBackupAt],
  );
  const isEditing =
    draftSeed !== null && logs.some((l) => l.id === draftSeed.id);

  function openNewLog(draft: ApplicationLog | null) {
    setDraftSeed(draft);
    setDraftKey((k) => k + 1);
    setScreen("new");
  }

  /** Open an existing saved log into New log form; upsert keeps the same id. */
  function handleEdit(log: ApplicationLog) {
    openNewLog(log);
  }

  function handleSave(log: ApplicationLog): boolean {
    const result = upsertLog(log);
    setLogs(result.logs);
    if (!result.saved) {
      setStorageError("Could not save on this device (storage full or blocked).");
      return false;
    }
    setStorageError(null);
    setDraftSeed(null);
    setScreen("history");
    return true;
  }

  function handleDelete(id: string) {
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
    return {
      ok: true,
      summary: "All device data wiped. Example seeds re-added for a fresh first-run.",
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

  function handleRestored(data: {
    logs: ApplicationLog[];
    catalog: ShopProduct[];
    people: Person[];
    settings: ShopSettings;
  }) {
    setLogs(data.logs);
    setCatalog(data.catalog);
    setPeople(data.people);
    setSettings(data.settings);
    setStorageError(null);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="eyebrow">Texas TDA · Jobber sidecar</div>
        <h1>Jobber Pest Logger</h1>
      </header>
      <div className="banner">
        v1.6. Thin PWA polish (A2HS tip + manifest). Schema locked to 4 TAC § 7.144. Texas SPCS
        shops. Example seeds and incomplete records block real CSV/PDF export.
      </div>
      <FirstRunChecklist steps={firstRunSteps} onGo={setScreen} />
      <ShopPilotCard />
      <A2hsTip />
      {peopleWarnings.length > 0 && (
        <div className="banner banner-due" role="status">
          <strong>License / CE reminders</strong> (in-app only; not TDA-required; no SMS). License:
          past due or within 30 days. CE: overdue or year-end (Nov/Dec) for calendar-year CEUs.
          <ul className="warn-list">
            {peopleWarnings.map((w) => (
              <li key={w.personId}>
                <button type="button" className="linkish" onClick={() => setScreen("people")}>
                  {w.personName}
                </button>
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
      <nav className="tabs">
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
          onClick={() => setScreen("history")}
        >
          History
        </button>
        <button
          type="button"
          className={screen === "products" ? "active" : ""}
          onClick={() => setScreen("products")}
        >
          Products
        </button>
        <button
          type="button"
          className={screen === "people" ? "active" : ""}
          onClick={() => setScreen("people")}
        >
          People
        </button>
        <button
          type="button"
          className={screen === "settings" ? "active" : ""}
          onClick={() => setScreen("settings")}
        >
          Settings
        </button>
        <button type="button" className={screen === "export" ? "active" : ""} onClick={() => setScreen("export")}>
          Export
        </button>
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
            onDelete={handleDelete}
            onEdit={handleEdit}
            onLogAgainHere={handleLogAgainHere}
            onDuplicateLastStop={handleDuplicateLastStop}
          />
        )}
        {screen === "products" && (
          <Products
            catalog={catalog}
            onUpsert={handleUpsertProduct}
            onDelete={handleDeleteProduct}
            onRemoveExamples={handleRemoveExampleProducts}
          />
        )}
        {screen === "people" && (
          <People people={people} onUpsert={handleUpsertPerson} onDelete={handleDeletePerson} />
        )}
        {screen === "settings" && (
          <Settings
            settings={settings}
            lastBackupAt={lastBackupAt}
            onSave={handleSaveSettings}
            onRestored={handleRestored}
            onBackupStampChange={setLastBackupAt}
            onClearExamples={handleClearExamples}
            onWipeAll={handleWipeAll}
          />
        )}
        {screen === "export" && (
          <Export
            logs={logs}
            catalog={catalog}
            settings={settings}
            lastBackupAt={lastBackupAt}
            onRemoveExamples={handleRemoveExampleProducts}
            onGo={(s) => setScreen(s)}
          />
        )}
      </main>
    </div>
  );
}
