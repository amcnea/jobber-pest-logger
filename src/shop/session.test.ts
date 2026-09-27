import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bumpSessionMutationEpoch,
  canAccessOffice,
  canUseOfficeSurfaces,
  clearSessionAuth,
  clearShopSession,
  emptyShopSession,
  enforceSessionExpiry,
  formatDurationMs,
  getSessionMutationEpoch,
  hasJoinedShop,
  isSessionAuthenticated,
  isSessionExpired,
  isValidShopId,
  loadShopSession,
  needsShopUnlock,
  normalizeShopSession,
  saveShopSession,
  sessionAuthIdentityChanged,
  sessionAuthIdentityFingerprint,
  sessionRole,
  SESSION_IDLE_MS,
  SESSION_TTL_MS,
  SHOP_SESSION_KEY,
  touchSessionActivity,
} from "./session";
import type { ShopSession } from "./types";

// Scope: every export of session.ts. localStorage is an in-memory fake and Date is faked,
// so every Date.now() default and nowMs argument line up. Private helpers (isRecord,
// parseVerifiedAt) are covered through normalizeShopSession / loadShopSession.

class MemoryStorage {
  map = new Map<string, string>();
  failSet = false;
  failGet = false;
  failRemove = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    if (this.failGet) throw new Error("getItem failed");
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.failSet) throw new Error("QuotaExceededError");
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    if (this.failRemove) throw new Error("removeItem failed");
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let storage: MemoryStorage;
const NOW_MS = Date.parse("2026-09-27T01:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();
const SHOP = "SHOPABCD";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function authed(overrides: Partial<ShopSession> = {}): ShopSession {
  return { shopId: SHOP, role: "office", verifiedAt: NOW, lastActiveAt: NOW, ...overrides };
}

function stored(): unknown {
  const raw = storage.getItem(SHOP_SESSION_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function put(value: unknown) {
  storage.setItem(SHOP_SESSION_KEY, JSON.stringify(value));
}

describe("SHOP_SESSION_KEY and constants", () => {
  it("uses the v1 session key", () => {
    expect(SHOP_SESSION_KEY).toBe("jobber-pest-logger:shop-session:v1");
  });

  it("TTL is 14 days and idle is 8 hours", () => {
    expect(SESSION_TTL_MS).toBe(14 * DAY);
    expect(SESSION_IDLE_MS).toBe(8 * HOUR);
  });
});

describe("session mutation epoch", () => {
  it("bump increments by one and returns the new value; get reads it", () => {
    const start = getSessionMutationEpoch();
    expect(bumpSessionMutationEpoch()).toBe(start + 1);
    expect(getSessionMutationEpoch()).toBe(start + 1);
    expect(bumpSessionMutationEpoch()).toBe(start + 2);
    expect(getSessionMutationEpoch()).toBe(start + 2);
  });

  it("get does not change the epoch", () => {
    const a = getSessionMutationEpoch();
    getSessionMutationEpoch();
    expect(getSessionMutationEpoch()).toBe(a);
  });
});

describe("sessionAuthIdentityFingerprint / sessionAuthIdentityChanged", () => {
  it("is empty for null, local-only and invalid-shop sessions", () => {
    expect(sessionAuthIdentityFingerprint(null)).toBe("");
    expect(sessionAuthIdentityFingerprint(JSON.stringify({ shopId: "" }))).toBe("");
    expect(sessionAuthIdentityFingerprint(JSON.stringify({ shopId: "a/b" }))).toBe("");
    expect(sessionAuthIdentityFingerprint(JSON.stringify([1, 2]))).toBe("");
    expect(sessionAuthIdentityFingerprint("null")).toBe("");
  });

  it("encodes shopId, role and verifiedAt presence", () => {
    expect(sessionAuthIdentityFingerprint(JSON.stringify(authed()))).toBe(`${SHOP}|office|1`);
    expect(sessionAuthIdentityFingerprint(JSON.stringify(authed({ role: "tech" })))).toBe(
      `${SHOP}|tech|1`,
    );
    expect(sessionAuthIdentityFingerprint(JSON.stringify({ shopId: ` ${SHOP} ` }))).toBe(
      `${SHOP}||0`,
    );
  });

  it("drops a lone role (no verifiedAt) like normalizeShopSession", () => {
    expect(sessionAuthIdentityFingerprint(JSON.stringify({ shopId: SHOP, role: "office" }))).toBe(
      `${SHOP}||0`,
    );
  });

  it("uses the raw string for unparseable JSON", () => {
    expect(sessionAuthIdentityFingerprint("{not json")).toBe("raw:{not json");
    expect(sessionAuthIdentityFingerprint("")).toBe("raw:");
  });

  it("ignores lastActiveAt and the verifiedAt value", () => {
    const a = JSON.stringify(authed());
    const b = JSON.stringify(authed({ lastActiveAt: iso(NOW_MS + 60_000) }));
    const c = JSON.stringify(authed({ verifiedAt: iso(NOW_MS - HOUR), lastActiveAt: NOW }));
    expect(sessionAuthIdentityChanged(a, b)).toBe(false);
    expect(sessionAuthIdentityChanged(a, c)).toBe(false);
  });

  it("detects shop, role, sign-out, leave and corrupt changes", () => {
    const a = JSON.stringify(authed());
    expect(sessionAuthIdentityChanged(a, JSON.stringify(authed({ shopId: "OTHERSHP" })))).toBe(true);
    expect(sessionAuthIdentityChanged(a, JSON.stringify(authed({ role: "tech" })))).toBe(true);
    expect(sessionAuthIdentityChanged(a, JSON.stringify({ shopId: SHOP }))).toBe(true);
    expect(sessionAuthIdentityChanged(a, null)).toBe(true);
    expect(sessionAuthIdentityChanged(a, "garbage")).toBe(true);
    expect(sessionAuthIdentityChanged("garbage", "garbage2")).toBe(true);
  });

  it("treats null and local-only as the same identity", () => {
    expect(sessionAuthIdentityChanged(null, JSON.stringify({ shopId: "" }))).toBe(false);
    expect(sessionAuthIdentityChanged(null, null)).toBe(false);
  });
});

describe("formatDurationMs", () => {
  it("formats seconds with a 1s floor", () => {
    expect(formatDurationMs(0)).toBe("1s");
    expect(formatDurationMs(-5_000)).toBe("1s");
    expect(formatDurationMs(400)).toBe("1s");
    expect(formatDurationMs(1_000)).toBe("1s");
    expect(formatDurationMs(30_000)).toBe("30s");
    expect(formatDurationMs(59_000)).toBe("59s");
  });

  it("formats minutes with singular/plural", () => {
    expect(formatDurationMs(60_000)).toBe("1 minute");
    expect(formatDurationMs(90_000)).toBe("2 minutes");
    expect(formatDurationMs(45 * 60_000)).toBe("45 minutes");
  });

  it("formats hours below 48h with singular/plural", () => {
    expect(formatDurationMs(HOUR)).toBe("1 hour");
    expect(formatDurationMs(SESSION_IDLE_MS)).toBe("8 hours");
    expect(formatDurationMs(47 * HOUR)).toBe("47 hours");
  });

  it("formats days from 48h", () => {
    expect(formatDurationMs(48 * HOUR)).toBe("2 days");
    expect(formatDurationMs(SESSION_TTL_MS)).toBe("14 days");
    expect(formatDurationMs(60 * HOUR)).toBe("3 days"); // 2.5 rounds up
  });

  // Known bug, see #85 (backlog): values just under a unit boundary round up into the
  // smaller unit's label.
  // Expected: 59_999 ms → "1 minute" and 3_599_999 ms → "1 hour".
  // Actual:   "60s" and "60 minutes" (Math.round before the unit is chosen).
  it.skip("does not show 60s / 60 minutes just below a unit boundary", () => {
    expect(formatDurationMs(59_999)).toBe("1 minute");
    expect(formatDurationMs(3_599_999)).toBe("1 hour");
  });
});

describe("emptyShopSession", () => {
  it("returns a fresh local-only session each call", () => {
    const a = emptyShopSession();
    expect(a).toEqual({ shopId: "" });
    a.shopId = "X";
    expect(emptyShopSession()).toEqual({ shopId: "" });
  });
});

describe("isValidShopId", () => {
  it("accepts normal ids and trims whitespace", () => {
    expect(isValidShopId(SHOP)).toBe(true);
    expect(isValidShopId(`  ${SHOP}  `)).toBe(true);
    expect(isValidShopId("a.b")).toBe(true);
    expect(isValidShopId("...")).toBe(true);
    expect(isValidShopId("__x")).toBe(true);
    expect(isValidShopId("x__")).toBe(true);
  });

  it("rejects empty, slash, dot and dot-dot", () => {
    expect(isValidShopId("")).toBe(false);
    expect(isValidShopId("   ")).toBe(false);
    expect(isValidShopId("a/b")).toBe(false);
    expect(isValidShopId("/")).toBe(false);
    expect(isValidShopId(".")).toBe(false);
    expect(isValidShopId(" .. ")).toBe(false);
  });

  it("rejects reserved __.*__ ids", () => {
    expect(isValidShopId("__x__")).toBe(false);
    expect(isValidShopId("____")).toBe(false);
  });

  it("allows short underscore ids that do not match __.*__", () => {
    expect(isValidShopId("__")).toBe(true);
    expect(isValidShopId("___")).toBe(true);
  });

  it("limits ids to 1500 UTF-8 bytes (not characters)", () => {
    expect(isValidShopId("a".repeat(1500))).toBe(true);
    expect(isValidShopId("a".repeat(1501))).toBe(false);
    expect(isValidShopId("é".repeat(750))).toBe(true); // 2 bytes each = 1500
    expect(isValidShopId("é".repeat(751))).toBe(false);
  });
});

describe("normalizeShopSession", () => {
  it("returns empty for non-records and invalid shop ids", () => {
    for (const raw of [null, undefined, 1, "x", [], [SHOP]]) {
      expect(normalizeShopSession(raw)).toEqual({ shopId: "" });
    }
    expect(normalizeShopSession({})).toEqual({ shopId: "" });
    expect(normalizeShopSession({ shopId: 5 })).toEqual({ shopId: "" });
    expect(normalizeShopSession({ shopId: "__x__", role: "office", verifiedAt: NOW })).toEqual({
      shopId: "",
    });
  });

  it("keeps a trimmed shopId", () => {
    expect(normalizeShopSession({ shopId: `  ${SHOP} ` })).toEqual({ shopId: SHOP });
  });

  it("keeps role + verifiedAt only together", () => {
    expect(normalizeShopSession({ shopId: SHOP, role: "office" })).toEqual({ shopId: SHOP });
    expect(normalizeShopSession({ shopId: SHOP, verifiedAt: NOW })).toEqual({ shopId: SHOP });
    expect(normalizeShopSession({ shopId: SHOP, role: "admin", verifiedAt: NOW })).toEqual({
      shopId: SHOP,
    });
    expect(normalizeShopSession({ shopId: SHOP, role: "office", verifiedAt: "not a date" })).toEqual(
      { shopId: SHOP },
    );
    expect(normalizeShopSession({ shopId: SHOP, role: "office", verifiedAt: "  " })).toEqual({
      shopId: SHOP,
    });
    expect(normalizeShopSession({ shopId: SHOP, role: "office", verifiedAt: 123 })).toEqual({
      shopId: SHOP,
    });
  });

  it("defaults lastActiveAt to verifiedAt and trims timestamps", () => {
    expect(normalizeShopSession({ shopId: SHOP, role: "tech", verifiedAt: ` ${NOW} ` })).toEqual({
      shopId: SHOP,
      role: "tech",
      verifiedAt: NOW,
      lastActiveAt: NOW,
    });
    expect(
      normalizeShopSession({ shopId: SHOP, role: "tech", verifiedAt: NOW, lastActiveAt: "bogus" }),
    ).toEqual({ shopId: SHOP, role: "tech", verifiedAt: NOW, lastActiveAt: NOW });
    const later = iso(NOW_MS + 1000);
    expect(
      normalizeShopSession({ shopId: SHOP, role: "office", verifiedAt: NOW, lastActiveAt: later }),
    ).toEqual({ shopId: SHOP, role: "office", verifiedAt: NOW, lastActiveAt: later });
  });

  it("drops unknown extra keys", () => {
    expect(normalizeShopSession({ shopId: SHOP, pin: "1234" })).toEqual({ shopId: SHOP });
  });
});

describe("loadShopSession", () => {
  it("returns empty when missing, corrupt or unreadable", () => {
    expect(loadShopSession()).toEqual({ shopId: "" });
    storage.setItem(SHOP_SESSION_KEY, "{oops");
    expect(loadShopSession()).toEqual({ shopId: "" });
    storage.setItem(SHOP_SESSION_KEY, "");
    expect(loadShopSession()).toEqual({ shopId: "" });
    storage.failGet = true;
    expect(loadShopSession()).toEqual({ shopId: "" });
  });

  it("returns the normalized stored session", () => {
    put({ shopId: ` ${SHOP} `, role: "office", verifiedAt: NOW });
    expect(loadShopSession()).toEqual(authed());
  });

  it("does not check expiry (an old session still loads with its role)", () => {
    put(authed({ verifiedAt: iso(NOW_MS - 30 * DAY), lastActiveAt: iso(NOW_MS - 30 * DAY) }));
    expect(loadShopSession().role).toBe("office");
  });
});

describe("isSessionExpired", () => {
  it("is expired without a parseable verifiedAt", () => {
    expect(isSessionExpired({ shopId: SHOP }, NOW_MS)).toBe(true);
    expect(isSessionExpired({ shopId: SHOP, role: "office", verifiedAt: "nope" }, NOW_MS)).toBe(true);
  });

  it("is fresh right after verify", () => {
    expect(isSessionExpired(authed(), NOW_MS)).toBe(false);
  });

  it("treats future verifiedAt or lastActiveAt as expired (clock skew)", () => {
    expect(isSessionExpired(authed({ verifiedAt: iso(NOW_MS + 1) }), NOW_MS)).toBe(true);
    expect(isSessionExpired(authed({ lastActiveAt: iso(NOW_MS + 1) }), NOW_MS)).toBe(true);
  });

  it("applies the idle limit from lastActiveAt (exclusive boundary)", () => {
    const s = authed();
    expect(isSessionExpired(s, NOW_MS + SESSION_IDLE_MS)).toBe(false);
    expect(isSessionExpired(s, NOW_MS + SESSION_IDLE_MS + 1)).toBe(true);
  });

  it("falls back to verifiedAt for idle when lastActiveAt is missing", () => {
    const s: ShopSession = { shopId: SHOP, role: "office", verifiedAt: NOW };
    expect(isSessionExpired(s, NOW_MS + SESSION_IDLE_MS)).toBe(false);
    expect(isSessionExpired(s, NOW_MS + SESSION_IDLE_MS + 1)).toBe(true);
  });

  it("is expired when lastActiveAt is unparseable", () => {
    expect(isSessionExpired(authed({ lastActiveAt: "bad" }), NOW_MS)).toBe(true);
  });

  it("applies the absolute TTL from verifiedAt even with recent activity", () => {
    const verified = NOW_MS - SESSION_TTL_MS;
    const s = authed({ verifiedAt: iso(verified), lastActiveAt: NOW });
    expect(isSessionExpired(s, NOW_MS)).toBe(false);
    expect(isSessionExpired(s, NOW_MS + 1)).toBe(true);
  });

  it("defaults to the stored session and Date.now()", () => {
    put(authed());
    expect(isSessionExpired()).toBe(false);
    vi.setSystemTime(NOW_MS + SESSION_IDLE_MS + 1);
    expect(isSessionExpired()).toBe(true);
    storage.clear();
    expect(isSessionExpired()).toBe(true);
  });
});

describe("isSessionAuthenticated / canAccessOffice / sessionRole", () => {
  it("authenticated office: all true, role office", () => {
    const s = authed();
    expect(isSessionAuthenticated(s, NOW_MS)).toBe(true);
    expect(canAccessOffice(s)).toBe(true);
    expect(sessionRole(s)).toBe("office");
  });

  it("authenticated tech: authenticated but not office", () => {
    const s = authed({ role: "tech" });
    expect(isSessionAuthenticated(s)).toBe(true);
    expect(canAccessOffice(s)).toBe(false);
    expect(sessionRole(s)).toBe("tech");
  });

  it("local-only, invalid shop, missing role/verifiedAt, bad role: not authenticated", () => {
    const cases: ShopSession[] = [
      { shopId: "" },
      authed({ shopId: "a/b" }),
      { shopId: SHOP },
      { shopId: SHOP, role: "office" },
      { shopId: SHOP, verifiedAt: NOW },
      { shopId: SHOP, role: "admin" as unknown as "office", verifiedAt: NOW },
    ];
    for (const s of cases) {
      expect(isSessionAuthenticated(s)).toBe(false);
      expect(canAccessOffice(s)).toBe(false);
      expect(sessionRole(s)).toBeNull();
    }
  });

  it("expired sessions are not authenticated", () => {
    const s = authed();
    expect(isSessionAuthenticated(s, NOW_MS + SESSION_IDLE_MS + 1)).toBe(false);
    vi.setSystemTime(NOW_MS + SESSION_IDLE_MS + 1);
    expect(canAccessOffice(s)).toBe(false);
    expect(sessionRole(s)).toBeNull();
  });

  it("default to the stored session", () => {
    expect(isSessionAuthenticated()).toBe(false);
    expect(sessionRole()).toBeNull();
    put(authed());
    expect(isSessionAuthenticated()).toBe(true);
    expect(canAccessOffice()).toBe(true);
    expect(sessionRole()).toBe("office");
  });
});

describe("canUseOfficeSurfaces", () => {
  it("allows local-only and authenticated office", () => {
    expect(canUseOfficeSurfaces({ shopId: "" })).toBe(true);
    expect(canUseOfficeSurfaces(authed())).toBe(true);
  });

  it("denies authenticated tech", () => {
    expect(canUseOfficeSurfaces(authed({ role: "tech" }))).toBe(false);
  });

  it("denies a remembered shop that needs unlock (missing or expired PIN)", () => {
    expect(canUseOfficeSurfaces({ shopId: SHOP })).toBe(false);
    vi.setSystemTime(NOW_MS + SESSION_IDLE_MS + 1);
    expect(canUseOfficeSurfaces(authed())).toBe(false);
  });

  it("defaults to the stored session", () => {
    expect(canUseOfficeSurfaces()).toBe(true);
    put({ shopId: SHOP });
    expect(canUseOfficeSurfaces()).toBe(false);
    put(authed({ role: "tech" }));
    expect(canUseOfficeSurfaces()).toBe(false);
    put(authed());
    expect(canUseOfficeSurfaces()).toBe(true);
  });
});

describe("hasJoinedShop / needsShopUnlock", () => {
  it("joined means a valid shopId", () => {
    expect(hasJoinedShop({ shopId: "" })).toBe(false);
    expect(hasJoinedShop({ shopId: "." })).toBe(false);
    expect(hasJoinedShop({ shopId: SHOP })).toBe(true);
    expect(hasJoinedShop(authed())).toBe(true);
  });

  it("needs unlock when joined but not authenticated", () => {
    expect(needsShopUnlock({ shopId: "" })).toBe(false);
    expect(needsShopUnlock({ shopId: SHOP })).toBe(true);
    expect(needsShopUnlock(authed())).toBe(false);
    vi.setSystemTime(NOW_MS + SESSION_TTL_MS + 1);
    expect(needsShopUnlock(authed())).toBe(true);
  });

  it("default to the stored session", () => {
    expect(hasJoinedShop()).toBe(false);
    expect(needsShopUnlock()).toBe(false);
    put({ shopId: SHOP });
    expect(hasJoinedShop()).toBe(true);
    expect(needsShopUnlock()).toBe(true);
  });
});

describe("saveShopSession", () => {
  it("persists an authenticated session with all four fields", () => {
    expect(saveShopSession(authed())).toBe(true);
    expect(stored()).toEqual(authed());
  });

  it("fills lastActiveAt from verifiedAt when missing", () => {
    saveShopSession({ shopId: SHOP, role: "tech", verifiedAt: NOW });
    expect(stored()).toEqual({ shopId: SHOP, role: "tech", verifiedAt: NOW, lastActiveAt: NOW });
  });

  it("trims shopId and drops extra keys", () => {
    saveShopSession({ ...authed({ shopId: `  ${SHOP}  ` }), pin: "1234" } as ShopSession);
    expect(stored()).toEqual(authed());
  });

  it("keeps only shopId when role/verifiedAt are incomplete", () => {
    saveShopSession({ shopId: SHOP, role: "office" });
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("keeps only shopId when the session is already expired", () => {
    saveShopSession(authed({ verifiedAt: iso(NOW_MS - SESSION_TTL_MS - 1) }));
    expect(stored()).toEqual({ shopId: SHOP });
    saveShopSession(authed({ lastActiveAt: iso(NOW_MS - SESSION_IDLE_MS - 1) }));
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("removes the key for empty or invalid shopIds", () => {
    put(authed());
    expect(saveShopSession({ shopId: "" })).toBe(true);
    expect(storage.getItem(SHOP_SESSION_KEY)).toBeNull();
    put(authed());
    expect(saveShopSession(authed({ shopId: "__bad__" }))).toBe(true);
    expect(storage.getItem(SHOP_SESSION_KEY)).toBeNull();
  });

  it("returns false and logs when storage throws", () => {
    storage.failSet = true;
    expect(saveShopSession(authed())).toBe(false);
    expect(console.error).toHaveBeenCalled();
    storage.failRemove = true;
    expect(saveShopSession({ shopId: "" })).toBe(false);
  });

  it("round-trips through loadShopSession", () => {
    saveShopSession(authed({ role: "tech" }));
    expect(loadShopSession()).toEqual(authed({ role: "tech" }));
  });
});

describe("clearShopSession / clearSessionAuth", () => {
  it("clearShopSession removes the key entirely", () => {
    put(authed());
    expect(clearShopSession()).toBe(true);
    expect(storage.getItem(SHOP_SESSION_KEY)).toBeNull();
    expect(loadShopSession()).toEqual({ shopId: "" });
  });

  it("clearShopSession returns false when removal fails", () => {
    put(authed());
    storage.failRemove = true;
    expect(clearShopSession()).toBe(false);
  });

  it("clearSessionAuth keeps the shopId and drops auth", () => {
    put(authed());
    expect(clearSessionAuth()).toBe(true);
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("clearSessionAuth uses a passed session and trims its shopId", () => {
    expect(clearSessionAuth(authed({ shopId: ` OTHERSHP ` }))).toBe(true);
    expect(stored()).toEqual({ shopId: "OTHERSHP" });
  });

  it("clearSessionAuth with no valid shop clears everything", () => {
    put(authed());
    expect(clearSessionAuth({ shopId: "" })).toBe(true);
    expect(storage.getItem(SHOP_SESSION_KEY)).toBeNull();
  });

  it("clearSessionAuth returns false when storage fails", () => {
    storage.failSet = true;
    expect(clearSessionAuth(authed())).toBe(false);
  });
});

describe("enforceSessionExpiry", () => {
  it("does nothing for local-only or signed-out sessions", () => {
    expect(enforceSessionExpiry({ shopId: "" }, NOW_MS)).toBe(false);
    put({ shopId: SHOP });
    expect(enforceSessionExpiry({ shopId: SHOP }, NOW_MS)).toBe(false);
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("does nothing while the session is fresh", () => {
    put(authed());
    expect(enforceSessionExpiry(authed(), NOW_MS + HOUR)).toBe(false);
    expect(stored()).toEqual(authed());
  });

  it("clears auth (keeps shopId) when idle expired", () => {
    put(authed());
    expect(enforceSessionExpiry(authed(), NOW_MS + SESSION_IDLE_MS + 1)).toBe(true);
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("clears a half-populated session (role without verifiedAt)", () => {
    put({ shopId: SHOP });
    expect(enforceSessionExpiry({ shopId: SHOP, role: "office" }, NOW_MS)).toBe(true);
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("defaults to the stored session and Date.now()", () => {
    put(authed());
    expect(enforceSessionExpiry()).toBe(false);
    vi.setSystemTime(NOW_MS + SESSION_TTL_MS + 1);
    expect(enforceSessionExpiry()).toBe(true);
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("returns false when clearing fails", () => {
    storage.failSet = true;
    expect(enforceSessionExpiry(authed(), NOW_MS + SESSION_IDLE_MS + 1)).toBe(false);
  });
});

describe("touchSessionActivity", () => {
  it("is a no-op returning true for local-only and signed-out sessions", () => {
    expect(touchSessionActivity(NOW_MS)).toBe(true);
    expect(storage.getItem(SHOP_SESSION_KEY)).toBeNull();
    put({ shopId: SHOP });
    expect(touchSessionActivity(NOW_MS)).toBe(true);
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("bumps lastActiveAt for a live authenticated session", () => {
    put(authed());
    const later = NOW_MS + 2 * HOUR;
    vi.setSystemTime(later);
    expect(touchSessionActivity(later)).toBe(true);
    expect(stored()).toEqual(authed({ lastActiveAt: iso(later) }));
  });

  it("uses Date.now() by default", () => {
    put(authed());
    const later = NOW_MS + 60_000;
    vi.setSystemTime(later);
    expect(touchSessionActivity()).toBe(true);
    expect(stored()).toEqual(authed({ lastActiveAt: iso(later) }));
  });

  it("repeated touches keep an active session alive past the idle window", () => {
    put(authed());
    for (let t = 1; t <= 3; t++) {
      const at = NOW_MS + t * 7 * HOUR;
      vi.setSystemTime(at);
      touchSessionActivity(at);
    }
    expect(isSessionAuthenticated(loadShopSession())).toBe(true);
  });

  it("clears auth instead when already expired", () => {
    put(authed());
    const later = NOW_MS + SESSION_IDLE_MS + 1;
    vi.setSystemTime(later);
    expect(touchSessionActivity(later)).toBe(true);
    expect(stored()).toEqual({ shopId: SHOP });
  });

  it("returns false when the write fails", () => {
    put(authed());
    storage.failSet = true;
    expect(touchSessionActivity(NOW_MS + 1000)).toBe(false);
  });

  it("returns false when clearing an expired session fails", () => {
    put(authed());
    storage.failSet = true;
    expect(touchSessionActivity(NOW_MS + SESSION_IDLE_MS + 1)).toBe(false);
  });

  it("does not rewrite when another tab changed the session between reads", () => {
    put(authed());
    const original = storage.getItem.bind(storage);
    let reads = 0;
    // First read sees our session; the re-read sees another tab's sign-out.
    storage.getItem = (k: string) => {
      reads += 1;
      if (k === SHOP_SESSION_KEY && reads === 2) return JSON.stringify({ shopId: SHOP });
      return original(k);
    };
    const setSpy = vi.spyOn(storage, "setItem");
    expect(touchSessionActivity(NOW_MS + 1000)).toBe(true);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("does not rewrite when another tab switched role, shop or verifiedAt", () => {
    const variants = [
      authed({ role: "tech" }),
      authed({ shopId: "OTHERSHP" }),
      authed({ verifiedAt: iso(NOW_MS - 1000), lastActiveAt: NOW }),
    ];
    for (const other of variants) {
      put(authed());
      const original = MemoryStorage.prototype.getItem.bind(storage);
      let reads = 0;
      storage.getItem = (k: string) => {
        reads += 1;
        if (k === SHOP_SESSION_KEY && reads === 2) return JSON.stringify(other);
        return original(k);
      };
      const setSpy = vi.spyOn(storage, "setItem");
      expect(touchSessionActivity(NOW_MS + 1000)).toBe(true);
      expect(setSpy).not.toHaveBeenCalled();
      setSpy.mockRestore();
    }
  });
});
