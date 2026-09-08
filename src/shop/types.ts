/** Shared shop document + store API (slice #1 foundation; #3 session/PIN). */

import type { ApplicationLog, Person, ShopProduct, ShopSettings } from "../types";
import type { ShopPinAuth, ShopRole } from "./pinCrypto";

export type { ShopPinAuth, ShopRole, PinHashRecord } from "./pinCrypto";

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
  /**
   * PIN hashes for office/tech (#3). Present on shared shops after create / PIN bootstrap.
   * Never stores plaintext PINs.
   */
  auth?: ShopPinAuth;
  /**
   * Client-only: remote `auth` key was present but failed parse (corrupt / unreadable).
   * Never write this field to Firestore — strip on put.
   */
  authUnreadable?: boolean;
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
  /**
   * Persist shop document. On success, `value.updatedAt` is the committed
   * write timestamp (callers must use it for the next CAS put).
   */
  putShop(doc: ShopDocument): Promise<ShopStoreResult<{ updatedAt: string }>>;
  /**
   * Live updates — TODO later slice (shared listen / offline queue).
   * Stub returns an unsubscribe no-op so callers can wire later without API churn.
   */
  subscribe?(
    _onChange: (doc: ShopDocument) => void,
  ): () => void;
}

/**
 * Device session meta (#3).
 * - `shopId` alone may be remembered after sign-out (convenience).
 * - `role` + `verifiedAt` mean PIN was verified against remote hashes for this device session.
 * - Raw PINs are never stored here.
 */
export interface ShopSession {
  /** Firestore shops/{shopId} when joined/remembered; empty string means not joined. */
  shopId: string;
  /** Set only after successful PIN verification (or create as office). */
  role?: ShopRole;
  /** ISO timestamp of last successful PIN verify — used for soft expiry. */
  verifiedAt?: string;
}
