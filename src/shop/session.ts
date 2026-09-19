import { isShopRole, type ShopRole } from "./pinCrypto";
import type { ShopSession } from "./types";

/** Small meta key — not part of backup/wipe payload in #1. */
export const SHOP_SESSION_KEY = "jobber-pest-logger:shop-session:v1";

/** Bumped by leaveShop so in-flight signInShop cannot restore a left session. */
let sessionMutationEpoch = 0;

export function bumpSessionMutationEpoch(): number {
  sessionMutationEpoch += 1;
  return sessionMutationEpoch;
}

export function getSessionMutationEpoch(): number {
  return sessionMutationEpoch;
}

/** Soft absolute lifetime after PIN verify (re-enter PIN when stale). */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Idle lifetime after last UI activity (#8).
 * Shared desk / phone: inactivity clears auth without wiping local shop data.
 */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;

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

/** Human-readable duration for Settings chrome (idle / TTL labels). */
export function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (ms < 48 * 3_600_000) {
    const h = Math.round(ms / 3_600_000);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(ms / (24 * 3_600_000));
  return `${d} day${d === 1 ? "" : "s"}`;
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
    const lastActiveAt = parseVerifiedAt(raw.lastActiveAt) ?? verifiedAt;
    return { shopId, role, verifiedAt, lastActiveAt };
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

/**
 * True when absolute TTL (from verifiedAt) or idle (from lastActiveAt) has elapsed.
 * Missing verifiedAt ⇒ expired. Future timestamps ⇒ treat as expired (clock skew).
 */
export function isSessionExpired(
  session: ShopSession = loadShopSession(),
  nowMs: number = Date.now(),
): boolean {
  if (!session.verifiedAt) return true;
  const verifiedMs = Date.parse(session.verifiedAt);
  if (Number.isNaN(verifiedMs)) return true;
  if (verifiedMs > nowMs) return true;
  if (nowMs - verifiedMs > SESSION_TTL_MS) return true;

  const activeIso = session.lastActiveAt ?? session.verifiedAt;
  const activeMs = Date.parse(activeIso);
  if (Number.isNaN(activeMs)) return true;
  if (activeMs > nowMs) return true;
  if (nowMs - activeMs > SESSION_IDLE_MS) return true;
  return false;
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

/** Office-only helper for PIN change / leave / wipe (authenticated office). */
export function canAccessOffice(session: ShopSession = loadShopSession()): boolean {
  return isSessionAuthenticated(session) && session.role === "office";
}

export function sessionRole(session: ShopSession = loadShopSession()): ShopRole | null {
  return isSessionAuthenticated(session) ? (session.role ?? null) : null;
}

/**
 * Office UI surfaces (Products, People, Settings, Export, History edit/delete).
 * Denied for PIN-authenticated tech (#4) and for a remembered shared shop that still
 * needs unlock (expired/missing PIN) — that is not local-only mode.
 * Local-only (no shopId) and authenticated office keep full UI.
 * Distinct from canAccessOffice(), which requires an authenticated office role.
 */
export function canUseOfficeSurfaces(session: ShopSession = loadShopSession()): boolean {
  if (hasJoinedShop(session) && !isSessionAuthenticated(session)) return false;
  return sessionRole(session) !== "tech";
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
      payload.lastActiveAt = normalized.lastActiveAt ?? normalized.verifiedAt;
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
 * Sign out: drop role + verifiedAt (+ lastActiveAt), keep shopId so unlock can skip re-typing the code.
 * Does not wipe logs, catalog, people, or settings.
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

/**
 * If role/verifiedAt are present but idle or absolute TTL elapsed, clear auth (keep shopId).
 * Local data is untouched. Returns true when auth was cleared.
 */
export function enforceSessionExpiry(
  session: ShopSession = loadShopSession(),
  nowMs: number = Date.now(),
): boolean {
  if (!hasJoinedShop(session)) return false;
  if (!session.role && !session.verifiedAt) return false;
  if (!isSessionExpired(session, nowMs)) return false;
  return clearSessionAuth(session);
}

/**
 * Bump lastActiveAt for an authenticated session (throttled by callers).
 * If already expired, clears auth instead. Returns false only on storage failure.
 */
export function touchSessionActivity(nowMs: number = Date.now()): boolean {
  const session = loadShopSession();
  if (!hasJoinedShop(session) || !session.role || !session.verifiedAt) {
    return true;
  }
  if (isSessionExpired(session, nowMs)) {
    return clearSessionAuth(session);
  }
  const iso = new Date(nowMs).toISOString();
  return saveShopSession({
    shopId: session.shopId,
    role: session.role,
    verifiedAt: session.verifiedAt,
    lastActiveAt: iso,
  });
}
