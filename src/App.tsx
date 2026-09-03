import { useState } from "react";
import { Export } from "./components/Export";
import { History } from "./components/History";
import { NewLogForm } from "./components/NewLogForm";
import { Products } from "./components/Products";
import { deleteLog, deleteProduct, loadCatalog, loadLogs, upsertLog, upsertProduct } from "./storage";
import type { ApplicationLog, Screen, ShopProduct } from "./types";
import "./App.css";

export default function App() {
  const [screen, setScreen] = useState<Screen>("new");
  const [logs, setLogs] = useState<ApplicationLog[]>(() => loadLogs());
  const [catalog, setCatalog] = useState<ShopProduct[]>(() => loadCatalog());
  const [storageError, setStorageError] = useState<string | null>(null);

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="eyebrow">Texas TDA · Jobber sidecar</div>
        <h1>Jobber Pest Logger</h1>
      </header>
      <div className="banner">
        v1. Shop-owned product list. Schema locked to 4 TAC § 7.144. Texas SPCS shops. Example seeds
        export as &quot;example / not a real EPA number&quot;.
      </div>
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
        <button type="button" className={screen === "export" ? "active" : ""} onClick={() => setScreen("export")}>
          Export
        </button>
      </nav>
      <main className="main">
        {screen === "new" && <NewLogForm catalog={catalog} onSave={handleSave} />}
        {screen === "history" && <History logs={logs} onDelete={handleDelete} />}
        {screen === "products" && (
          <Products catalog={catalog} onUpsert={handleUpsertProduct} onDelete={handleDeleteProduct} />
        )}
        {screen === "export" && <Export logs={logs} />}
      </main>
    </div>
  );
}
