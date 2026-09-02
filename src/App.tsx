import { useState } from "react";
import { Export } from "./components/Export";
import { History } from "./components/History";
import { NewLogForm } from "./components/NewLogForm";
import { deleteLog, loadLogs, upsertLog } from "./storage";
import type { ApplicationLog, Screen } from "./types";
import "./App.css";

export default function App() {
  const [screen, setScreen] = useState<Screen>("new");
  const [logs, setLogs] = useState<ApplicationLog[]>(() => loadLogs());

  function handleSave(log: ApplicationLog) {
    setLogs(upsertLog(log));
    setScreen("history");
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this log from this device?")) return;
    setLogs(deleteLog(id));
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="eyebrow">Texas TDA · Jobber sidecar</div>
        <h1>Jobber Pest Logger</h1>
      </header>
      <div className="banner">
        v1 placeholder. SAMPLE catalog only — not EPA data. Schema locked to 4 TAC § 7.144. Texas SPCS shops.
      </div>
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
        <button type="button" className={screen === "export" ? "active" : ""} onClick={() => setScreen("export")}>
          Export
        </button>
      </nav>
      <main className="main">
        {screen === "new" && <NewLogForm onSave={handleSave} />}
        {screen === "history" && <History logs={logs} onDelete={handleDelete} />}
        {screen === "export" && <Export logs={logs} />}
      </main>
    </div>
  );
}
