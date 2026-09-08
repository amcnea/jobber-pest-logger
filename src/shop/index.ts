/** Shared shop store — foundation (#1) + create/join/migrate (#2). PIN/roles later. */

export type {
  ShopDocument,
  ShopSnapshot,
  ShopSession,
  ShopStore,
  ShopStoreMode,
  ShopStoreResult,
} from "./types";

export {
  SHOP_SESSION_KEY,
  clearShopSession,
  emptyShopSession,
  hasJoinedShop,
  isValidShopId,
  loadShopSession,
  saveShopSession,
} from "./session";

export {
  getFirebaseConfig,
  isFirebaseConfigured,
  readFirebaseEnv,
  type FirebaseClientConfig,
} from "./firebaseConfig";

export { LocalShopStore, getLocalShopStore } from "./LocalShopStore";
export { RemoteShopStore } from "./RemoteShopStore";
export {
  resolveShopStore,
  shopStoreStatusHint,
  type ResolvedShopStoreInfo,
} from "./resolveShopStore";

export { generateShopCode, normalizeShopCode } from "./shopCode";
export {
  SHOP_MIGRATED_KEY,
  hasMigratedShop,
  markShopMigrated,
} from "./migrateMarker";
export {
  createShop,
  joinShop,
  leaveShop,
  shopDocumentHasMeaningfulData,
  type CreateJoinResult,
} from "./createJoin";
