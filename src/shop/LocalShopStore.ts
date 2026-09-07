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

export class LocalShopStore implements ShopStore {
  readonly mode = "local" as const;

  async getShop(): Promise<ShopStoreResult<ShopDocument>> {
    try {
      const doc: ShopDocument = {
        version: BACKUP_VERSION,
        updatedAt: new Date().toISOString(),
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
  async putShop(doc: ShopDocument): Promise<ShopStoreResult<void>> {
    try {
      const logsOk = saveLogs(doc.logs);
      const catalogOk = saveCatalog(doc.catalog);
      const peopleOk = savePeople(doc.people);
      const settingsOk = saveSettings(doc.settings);
      if (!(logsOk && catalogOk && peopleOk && settingsOk)) {
        return {
          ok: false,
          error: "Could not save shop data on this device (storage full or blocked).",
        };
      }
      return { ok: true, value: undefined };
    } catch (err) {
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
