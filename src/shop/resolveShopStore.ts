/**
 * resolveShopStore — local by default; remote only when Firebase is configured
 * AND this device has a PIN-authenticated shop session (#3). Server auth is
 * Firebase Anonymous uid + shop.members (#5); localStorage is UI-only.
 */

import { getFirebaseConfig, isFirebaseConfigured } from "./firebaseConfig";
import { getLocalShopStore } from "./LocalShopStore";
import { RemoteShopStore } from "./RemoteShopStore";
import {
  hasJoinedShop,
  isSessionAuthenticated,
  loadShopSession,
  sessionRole,
} from "./session";
import type { ShopRole } from "./types";
import type { ShopStore, ShopStoreMode } from "./types";

export interface ResolvedShopStoreInfo {
  store: ShopStore;
  mode: ShopStoreMode;
  /** Non-empty when a shopId is remembered (may be locked). */
  shopId: string | null;
  /** Present when PIN-authenticated. */
  role: ShopRole | null;
  /** True when shopId is remembered but PIN session is missing/expired. */
  locked: boolean;
  firebaseConfigured: boolean;
}

/**
 * Returns LocalShopStore unless Firebase env and a PIN-verified session are present.
 * Remembered shopId without auth does not open shared mode (must unlock).
 */
export function resolveShopStore(): ResolvedShopStoreInfo {
  const firebaseConfigured = isFirebaseConfigured();
  const session = loadShopSession();
  const joined = hasJoinedShop(session);
  const authenticated = isSessionAuthenticated(session);
  const shopId = joined ? session.shopId.trim() : null;
  const role = sessionRole(session);
  const locked = joined && !authenticated;

  if (firebaseConfigured && authenticated && shopId) {
    const config = getFirebaseConfig();
    if (config) {
      return {
        store: new RemoteShopStore(config, shopId),
        mode: "shared",
        shopId,
        role,
        locked: false,
        firebaseConfigured: true,
      };
    }
  }

  return {
    store: getLocalShopStore(),
    mode: "local",
    shopId,
    role: null,
    locked,
    firebaseConfigured,
  };
}

/** Calm status copy for Settings / topbar. */
export function shopStoreStatusHint(
  info: ResolvedShopStoreInfo = resolveShopStore(),
): string {
  if (!info.firebaseConfigured) {
    return "This device: local only (Firebase env not set — see .env.example)";
  }
  if (info.locked && info.shopId) {
    return `Shop ${info.shopId} remembered — enter role + PIN to unlock`;
  }
  if (info.mode === "shared" && info.shopId && info.role) {
    return `Shop ${info.shopId} · ${info.role} — logs sync to cloud (outbox retries if offline)`;
  }
  return "This device: local only (shared shop not joined)";
}
