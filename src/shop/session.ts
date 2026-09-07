import type { ShopSession } from "./types";

/** Small meta key — not part of backup/wipe payload in #1. */
export const SHOP_SESSION_KEY = "jobber-pest-logger:shop-session:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyShopSession(): ShopSession {
  return { shopId: "" };
}

/**
 * Firestore document-ID constraints (local-only when invalid).
 * Rejects empty, `/`, `.`, `..`, reserved `__.*__`, and IDs > 1500 UTF-8 bytes.
 * @see https://firebase.google.com/docs/firestore/quotas
 */
export function isValidShopId(shopId: string): boolean {
  const id = shopId.trim();
  if (!id || id.includes("/")) return false;
  if (id === "." || id === "..") return false;
  // Firestore reserved: IDs matching __.*__
  if (/^__.*__$/.test(id)) return false;
  if (new TextEncoder().encode(id).length > 1500) return false;
  return true;
}


/** Load join session. Missing or invalid ⇒ local (not joined). */
export function loadShopSession(): ShopSession {
  try {
    const raw = localStorage.getItem(SHOP_SESSION_KEY);
    if (!raw) return emptyShopSession();
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return emptyShopSession();
    const shopId = typeof parsed.shopId === "string" ? parsed.shopId.trim() : "";
    return { shopId: isValidShopId(shopId) ? shopId : "" };
  } catch {
    return emptyShopSession();
  }
}

/**
 * Persist join session. Create/join UI lands in a later slice — exported for tests
 * and for #2 wiring. Empty shopId clears the key (back to local).
 */
export function saveShopSession(session: ShopSession): boolean {
  try {
    const shopId = session.shopId.trim();
    if (!isValidShopId(shopId)) {
      localStorage.removeItem(SHOP_SESSION_KEY);
      return true;
    }
    localStorage.setItem(SHOP_SESSION_KEY, JSON.stringify({ shopId }));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save shop session", err);
    return false;
  }
}

export function clearShopSession(): boolean {
  return saveShopSession(emptyShopSession());
}

export function hasJoinedShop(session: ShopSession = loadShopSession()): boolean {
  return isValidShopId(session.shopId);
}
