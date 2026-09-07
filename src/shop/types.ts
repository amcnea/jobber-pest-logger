/** Shared shop document + store API (slice #1 foundation). */

import type { ApplicationLog, Person, ShopProduct, ShopSettings } from "../types";

/** Aligns with DeviceBackup field shapes; updatedAt replaces exportedAt for live docs. */
export interface ShopDocument {
  version: string;
  /** ISO timestamp of last put/write. */
  updatedAt: string;
  logs: ApplicationLog[];
  catalog: ShopProduct[];
  people: Person[];
  settings: ShopSettings;
  /** Optional last successful backup download stamp (device or shop). */
  lastBackupAt?: string | null;
}

/** Alias for read snapshots (same shape as ShopDocument). */
export type ShopSnapshot = ShopDocument;

export type ShopStoreMode = "local" | "shared";

export type ShopStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; /** True when remote CAS detected a newer snapshot. */ conflict?: boolean };

/**
 * Get/put shop document. Subscribe is deferred to a later slice (offline/live).
 * App may keep using storage.ts loaders for #1; this API is the shared foundation.
 */
export interface ShopStore {
  readonly mode: ShopStoreMode;
  getShop(): Promise<ShopStoreResult<ShopDocument>>;
  putShop(doc: ShopDocument): Promise<ShopStoreResult<void>>;
  /**
   * Live updates — TODO slice #3+ (shared listen / offline queue).
   * Stub returns an unsubscribe no-op so callers can wire later without API churn.
   */
  subscribe?(
    _onChange: (doc: ShopDocument) => void,
  ): () => void;
}

/** Device session: empty / missing shopId ⇒ local-only (office desk default). */
export interface ShopSession {
  /** Firestore shops/{shopId} when joined; empty string means not joined. */
  shopId: string;
}
