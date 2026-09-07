/**
 * LocalShopStore — wraps existing storage.ts loaders/savers.
 * Does not rewrite storage; backup / restore / wipe keep working unchanged.
 */

import {
  BACKUP_VERSION,
  loadCatalog,
  loadLastBackupAt,
  loadLogs,
  loadPeople,
  loadSettings,
  saveCatalog,
  saveLogs,
  savePeople,
  saveSettings,
} from "../storage";
import type { ShopDocument, ShopStore, ShopStoreResult } from "./types";

/** Last successful putShop write time — not part of backup/wipe payload in #1. */
const LOCAL_UPDATED_AT_KEY = "jobber-pest-logger:shop-updated-at:v1";

function readLocalUpdatedAt(): string | null {
  try {
    const raw = localStorage.getItem(LOCAL_UPDATED_AT_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/** Best-effort stamp; failures are ignored so callers can still report data save success. */
function writeLocalUpdatedAt(iso: string): void {
  try {
    localStorage.setItem(LOCAL_UPDATED_AT_KEY, iso);
  } catch (err) {
    console.error("jobber-pest-logger: could not stamp local shop updatedAt", err);
  }
}

export class LocalShopStore implements ShopStore {
  readonly mode = "local" as const;

  async getShop(): Promise<ShopStoreResult<ShopDocument>> {
    try {
      let updatedAt = readLocalUpdatedAt();
      if (!updatedAt) {
        // First read before any put — seed a stable stamp so later sync/diff is not "now" every call.
        updatedAt = new Date().toISOString();
        writeLocalUpdatedAt(updatedAt);
      }
      const doc: ShopDocument = {
        version: BACKUP_VERSION,
        updatedAt,
        logs: loadLogs(),
        catalog: loadCatalog(),
        people: loadPeople(),
        settings: loadSettings(),
        lastBackupAt: loadLastBackupAt(),
      };
      return { ok: true, value: doc };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load local shop data.";
      return { ok: false, error: message };
    }
  }

  /**
   * Writes logs / catalog / people / settings via existing savers.
   * lastBackupAt remains owned by markLastBackupNow / wipe / downloadBackup
   * (included on getShop for document shape; not overwritten here).
   */
  async putShop(doc: ShopDocument): Promise<ShopStoreResult<{ updatedAt: string }>> {
    // Same four section keys as applyBackup in storage.ts — snapshot before multi-key write.
    const keys = [
      "jobber-pest-logger:logs:v1",
      "jobber-pest-logger:catalog:v1",
      "jobber-pest-logger:people:v1",
      "jobber-pest-logger:settings:v1",
    ] as const;
    const snapshot: Record<string, string | null> = {};
    try {
      for (const key of keys) {
        snapshot[key] = localStorage.getItem(key);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not snapshot local shop data before save.";
      return { ok: false, error: message };
    }

    const rollback = () => {
      try {
        for (const key of keys) {
          const prev = snapshot[key];
          if (prev === null) localStorage.removeItem(key);
          else localStorage.setItem(key, prev);
        }
      } catch (err) {
        console.error("jobber-pest-logger: could not roll back failed putShop", err);
      }
    };

    try {
      const logsOk = saveLogs(doc.logs);
      const catalogOk = saveCatalog(doc.catalog);
      const peopleOk = savePeople(doc.people);
      const settingsOk = saveSettings(doc.settings);
      if (!(logsOk && catalogOk && peopleOk && settingsOk)) {
        rollback();
        return {
          ok: false,
          error: "Could not save shop data on this device (storage full or blocked).",
        };
      }
      // Stamp after successful data writes; meta failure must not fail the put.
      // Return the committed stamp so callers can CAS against the same value on next put.
      const updatedAt = new Date().toISOString();
      writeLocalUpdatedAt(updatedAt);
      return { ok: true, value: { updatedAt } };
    } catch (err) {
      rollback();
      const message = err instanceof Error ? err.message : "Could not save local shop data.";
      return { ok: false, error: message };
    }
  }

  /** Stub — live listen is a later slice. */
  subscribe(_onChange: (doc: ShopDocument) => void): () => void {
    return () => {};
  }
}

let localSingleton: LocalShopStore | null = null;

export function getLocalShopStore(): LocalShopStore {
  if (!localSingleton) localSingleton = new LocalShopStore();
  return localSingleton;
}