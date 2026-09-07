/**
 * resolveShopStore — local by default; remote only when Firebase is configured
 * AND this device has a joined shop id in the session meta key.
 */

import { getFirebaseConfig, isFirebaseConfigured } from "./firebaseConfig";
import { getLocalShopStore } from "./LocalShopStore";
import { RemoteShopStore } from "./RemoteShopStore";
import { hasJoinedShop, loadShopSession } from "./session";
import type { ShopStore, ShopStoreMode } from "./types";

export interface ResolvedShopStoreInfo {
  store: ShopStore;
  mode: ShopStoreMode;
  /** Non-empty when mode === "shared". */
  shopId: string | null;
  firebaseConfigured: boolean;
}

/**
 * Returns LocalShopStore unless both Firebase env and a joined shopId are present.
 * Never instantiates RemoteShopStore when Firebase is not configured.
 */
export function resolveShopStore(): ResolvedShopStoreInfo {
  const firebaseConfigured = isFirebaseConfigured();
  const session = loadShopSession();
  const joined = hasJoinedShop(session);

  if (firebaseConfigured && joined) {
    const config = getFirebaseConfig();
    if (config) {
      const shopId = session.shopId.trim();
      return {
        store: new RemoteShopStore(config, shopId),
        mode: "shared",
        shopId,
        firebaseConfigured: true,
      };
    }
  }

  return {
    store: getLocalShopStore(),
    mode: "local",
    shopId: null,
    firebaseConfigured,
  };
}

/** Calm status copy for Settings / topbar — no fake roles. */
export function shopStoreStatusHint(
  info: ResolvedShopStoreInfo = resolveShopStore(),
): string {
  if (!info.firebaseConfigured) {
    return "This device: local only (Firebase env not set — see .env.example)";
  }
  if (info.mode === "shared" && info.shopId) {
    // Create/join uploaded a snapshot; day-to-day screens still use storage.ts until #3/#6.
    return `Joined shop ${info.shopId} — snapshot synced on create/migrate; day-to-day still device-local until live sync`;
  }
  return "This device: local only (shared shop not joined)";
}
