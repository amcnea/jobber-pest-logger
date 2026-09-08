import { isShopRole, type ShopRole } from "./pinCrypto";
import type { ShopSession } from "./types";

/** Small meta key — not part of backup/wipe payload in #1. */
export const SHOP_SESSION_KEY = "jobber-pest-logger:shop-session:v1";

/** Soft session lifetime after PIN verify (re-enter PIN when stale). */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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

function parseVerifiedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const iso = value.trim();
  if (Number.isNaN(Date.parse(iso))) return undefined;
  return iso;
}

/**
 * Normalize a session object. Drops role/verifiedAt unless both are valid together.
 * Does not treat a hand-edited role alone as authenticated.
 */
export function normalizeShopSession(raw: unknown): ShopSession {
  if (!isRecord(raw)) return emptyShopSession();
  const shopIdRaw = typeof raw.shopId === "string" ? raw.shopId.trim() : "";
  const shopId = isValidShopId(shopIdRaw) ? shopIdRaw : "";
  if (!shopId) return emptyShopSession();

  const role = isShopRole(raw.role) ? raw.role : undefined;
  const verifiedAt = parseVerifiedAt(raw.verifiedAt);
  if (role && verifiedAt) {
    return { shopId, role, verifiedAt };
  }
  // Remembered shop only (signed out) — never keep a lone role flag.
  return { shopId };
}

/** Load join session. Missing or invalid ⇒ local (not joined). */
export function loadShopSession(): ShopSession {
  try {
    const raw = localStorage.getItem(SHOP_SESSION_KEY);
    if (!raw) return emptyShopSession();
    return normalizeShopSession(JSON.parse(raw) as unknown);
  } catch {
    return emptyShopSession();
  }
}

export function isSessionExpired(
  session: ShopSession = loadShopSession(),
  nowMs: number = Date.now(),
): boolean {
  if (!session.verifiedAt) return true;
  const t = Date.parse(session.verifiedAt);
  if (Number.isNaN(t)) return true;
  if (t > nowMs) return true;
  return nowMs - t > SESSION_TTL_MS;
}

/**
 * True when this device has a non-expired PIN-verified role for a shop.
 * Local-only (no shopId) is never "authenticated" in the shared sense.
 */
export function isSessionAuthenticated(
  session: ShopSession = loadShopSession(),
  nowMs: number = Date.now(),
): boolean {
  if (!isValidShopId(session.shopId)) return false;
  if (!isShopRole(session.role) || !session.verifiedAt) return false;
  return !isSessionExpired(session, nowMs);
}

/** Office-only helper for #4 gates (and light Settings locks in #3). */
export function canAccessOffice(session: ShopSession = loadShopSession()): boolean {
  return isSessionAuthenticated(session) && session.role === "office";
}

export function sessionRole(session: ShopSession = loadShopSession()): ShopRole | null {
  return isSessionAuthenticated(session) ? (session.role ?? null) : null;
}

/**
 * Persist session. Empty shopId clears the key (back to local).
 * Authenticated writes require role + verifiedAt; otherwise only shopId is kept.
 */
export function saveShopSession(session: ShopSession): boolean {
  try {
    const normalized = normalizeShopSession(session);
    if (!isValidShopId(normalized.shopId)) {
      localStorage.removeItem(SHOP_SESSION_KEY);
      return true;
    }
    const payload: ShopSession = { shopId: normalized.shopId };
    if (
      normalized.role &&
      normalized.verifiedAt &&
      !isSessionExpired(normalized)
    ) {
      payload.role = normalized.role;
      payload.verifiedAt = normalized.verifiedAt;
    }
    localStorage.setItem(SHOP_SESSION_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error("jobber-pest-logger: could not save shop session", err);
    return false;
  }
}

/** Clear shopId + role + auth (leave shop). */
export function clearShopSession(): boolean {
  return saveShopSession(emptyShopSession());
}

/**
 * Sign out: drop role + verifiedAt, keep shopId so unlock can skip re-typing the code.
 */
export function clearSessionAuth(session: ShopSession = loadShopSession()): boolean {
  const shopId = session.shopId.trim();
  if (!isValidShopId(shopId)) {
    return clearShopSession();
  }
  return saveShopSession({ shopId });
}

export function hasJoinedShop(session: ShopSession = loadShopSession()): boolean {
  return isValidShopId(session.shopId);
}

/** True when a shopId is remembered but PIN session is missing or expired. */
export function needsShopUnlock(session: ShopSession = loadShopSession()): boolean {
  return hasJoinedShop(session) && !isSessionAuthenticated(session);
}

