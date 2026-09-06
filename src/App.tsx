import { useMemo, useState } from "react";
import { Export } from "./components/Export";
import { History } from "./components/History";
import { NewLogForm } from "./components/NewLogForm";
import { People } from "./components/People";
import { Products } from "./components/Products";
import { Settings } from "./components/Settings";
import { collectPeopleWarnings } from "./peopleWarnings";
import {
  deleteLog,
  deletePerson,
  deleteProduct,
  loadCatalog,
  loadLogs,
  loadPeople,
  loadSettings,
  saveSettings,
  upsertLog,
  upsertPerson,
  upsertProduct,
} from "./storage";
import type { ApplicationLog, Person, Screen, ShopProduct, ShopSettings } from "./types";
import "./App.css";

export default function App() {
  const [screen, setScreen] = useState<Screen>("new");
  const [logs, setLogs] = useState<ApplicationLog[]>(() => loadLogs());
  const [catalog, setCatalog] = useState<ShopProduct[]>(() => loadCatalog());
  const [people, setPeople] = useState<Person[]>(() => loadPeople());
  const [settings, setSettings] = useState<ShopSettings>(() => loadSettings());
  const [storageError, setStorageError] = useState<string | null>(null);

  const peopleWarnings = useMemo(() => collectPeopleWarnings(people), [people]);

  function handleSave(log: ApplicationLog): boolean {
    const result = upsertLog(log);
    setLogs(result.logs);
    if (!result.saved) {
      setStorageError("Could not save on this device (storage full or blocked).");
      return false;
    }
    setStorageError(null);
    setScreen("history");
    return true;
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this log from this device?")) return;
    const result = deleteLog(id);
    setLogs(result.logs);
    setStorageError(result.saved ? null : "Could not update saved logs on this device.");
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
        v1.2. Shop settings + export date range + device backup. Schema locked to 4 TAC § 7.144.
        Texas SPCS shops. Example seeds export as &quot;example / not a real EPA number&quot;.
      </div>
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
        <button type="button" className={screen === "new" ? "active" : ""} onClick={() => setScreen("new")}>
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
          <NewLogForm catalog={catalog} people={people} settings={settings} onSave={handleSave} />
        )}
        {screen === "history" && <History logs={logs} onDelete={handleDelete} />}
        {screen === "products" && (
          <Products catalog={catalog} onUpsert={handleUpsertProduct} onDelete={handleDeleteProduct} />
        )}
        {screen === "people" && (
          <People people={people} onUpsert={handleUpsertPerson} onDelete={handleDeletePerson} />
        )}
        {screen === "settings" && (
          <Settings settings={settings} onSave={handleSaveSettings} onRestored={handleRestored} />
        )}
        {screen === "export" && <Export logs={logs} settings={settings} />}
      </main>
    </div>
  );
}
