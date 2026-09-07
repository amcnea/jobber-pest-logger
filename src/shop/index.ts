/** Shared shop store foundation (slice #1). Create/join/PIN/roles come later. */

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
