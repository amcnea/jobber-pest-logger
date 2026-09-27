import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMigratedShop, markShopMigrated, SHOP_MIGRATED_KEY } from "./migrateMarker";

// Persistence is localStorage; tests use an in-memory stand-in (no real browser storage).
class MemoryStorage {
  map = new Map<string, string>();
  failSet = false;
  failGet = false;
  getItem(k: string) {
    if (this.failGet) throw new Error("getItem failed");
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.failSet) throw new Error("QuotaExceededError");
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stored(): unknown {
  const raw = storage.getItem(SHOP_MIGRATED_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("SHOP_MIGRATED_KEY", () => {
  it("is the versioned app key", () => {
    expect(SHOP_MIGRATED_KEY).toBe("jobber-pest-logger:shop-migrated:v1");
  });
});

describe("hasMigratedShop", () => {
  it("is false when nothing is stored", () => {
    expect(hasMigratedShop("SHOP1")).toBe(false);
  });

  it("is false for blank shop ids without reading storage", () => {
    storage.failGet = true;
    expect(hasMigratedShop("")).toBe(false);
    expect(hasMigratedShop("   ")).toBe(false);
  });

  it("is true only for shops marked exactly true", () => {
    storage.setItem(SHOP_MIGRATED_KEY, JSON.stringify({ A: true, B: "true", C: 1, D: false, E: null }));
    expect(hasMigratedShop("A")).toBe(true);
    for (const id of ["B", "C", "D", "E", "Z"]) expect(hasMigratedShop(id)).toBe(false);
  });

  it("trims the query and the stored keys", () => {
    storage.setItem(SHOP_MIGRATED_KEY, JSON.stringify({ "  A  ": true }));
    expect(hasMigratedShop(" A ")).toBe(true);
    expect(hasMigratedShop("A")).toBe(true);
  });

  it("is case-sensitive", () => {
    storage.setItem(SHOP_MIGRATED_KEY, JSON.stringify({ ABCD: true }));
    expect(hasMigratedShop("abcd")).toBe(false);
  });

  it("treats corrupt JSON, arrays, primitives and null as no markers", () => {
    for (const raw of ["{nope", "[]", '["A"]', "true", "42", '"A"', "null"]) {
      storage.setItem(SHOP_MIGRATED_KEY, raw);
      expect(hasMigratedShop("A"), raw).toBe(false);
    }
  });

  it("treats a throwing storage as no markers", () => {
    storage.failGet = true;
    expect(hasMigratedShop("A")).toBe(false);
  });

  it("is false for inherited object keys", () => {
    storage.setItem(SHOP_MIGRATED_KEY, JSON.stringify({}));
    expect(hasMigratedShop("toString")).toBe(false);
    expect(hasMigratedShop("__proto__")).toBe(false);
  });
});

describe("markShopMigrated", () => {
  it("rejects blank shop ids and writes nothing", () => {
    expect(markShopMigrated("")).toBe(false);
    expect(markShopMigrated("  ")).toBe(false);
    expect(storage.getItem(SHOP_MIGRATED_KEY)).toBeNull();
  });

  it("marks a trimmed shop id and persists it as JSON", () => {
    expect(markShopMigrated("  SHOP1 ")).toBe(true);
    expect(stored()).toEqual({ SHOP1: true });
    expect(hasMigratedShop("SHOP1")).toBe(true);
  });

  it("keeps markers for other shops (per-shop, not global)", () => {
    markShopMigrated("A");
    markShopMigrated("B");
    expect(stored()).toEqual({ A: true, B: true });
    expect(hasMigratedShop("A")).toBe(true);
    expect(hasMigratedShop("B")).toBe(true);
    expect(hasMigratedShop("C")).toBe(false);
  });

  it("is idempotent", () => {
    markShopMigrated("A");
    markShopMigrated("A");
    expect(stored()).toEqual({ A: true });
  });

  it("cleans invalid stored entries when it rewrites the map", () => {
    storage.setItem(SHOP_MIGRATED_KEY, JSON.stringify({ " A ": true, B: "yes", C: false, "  ": true }));
    markShopMigrated("D");
    expect(stored()).toEqual({ A: true, D: true });
  });

  it("recovers from a corrupt stored value by starting fresh", () => {
    storage.setItem(SHOP_MIGRATED_KEY, "{corrupt");
    expect(markShopMigrated("A")).toBe(true);
    expect(stored()).toEqual({ A: true });
  });

  it("returns false and logs when the write fails", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    storage.failSet = true;
    expect(markShopMigrated("A")).toBe(false);
    expect(err).toHaveBeenCalledOnce();
    expect(hasMigratedShop("A")).toBe(false);
  });

  it("survives leave + rejoin: the marker stays keyed by shop id", () => {
    markShopMigrated("SHOP1");
    // Session changes do not touch this key; a later rejoin still sees the marker.
    expect(hasMigratedShop("SHOP1")).toBe(true);
  });
});
