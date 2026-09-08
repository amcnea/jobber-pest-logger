/** Shared shop store — foundation (#1) + create/join (#2) + session PIN/role (#3). */

export type {
  ShopDocument,
  ShopSnapshot,
  ShopSession,
  ShopStore,
  ShopStoreMode,
  ShopStoreResult,
  ShopPinAuth,
  ShopRole,
  PinHashRecord,
} from "./types";

export {
  SHOP_SESSION_KEY,
  SESSION_TTL_MS,
  clearSessionAuth,
  clearShopSession,
  canAccessOffice,
  emptyShopSession,
  hasJoinedShop,
  isSessionAuthenticated,
  isSessionExpired,
  isValidShopId,
  loadShopSession,
  needsShopUnlock,
  normalizeShopSession,
  saveShopSession,
  sessionRole,
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
  bootstrapShopPins,
  changeShopPins,
  createShop,
  joinShop,
  leaveShop,
  shopDocumentHasMeaningfulData,
  signInShop,
  signOutShop,
  type CreateJoinResult,
  type CreateShopPins,
  type RolePinInput,
} from "./createJoin";

export {
  PIN_HASH_ALGORITHM,
  PIN_PBKDF2_ITERATIONS,
  buildShopPinAuth,
  createPinHash,
  isShopRole,
  isValidPin,
  parseShopPinAuth,
  verifyPin,
} from "./pinCrypto";
