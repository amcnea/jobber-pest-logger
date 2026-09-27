import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SEEDS } from "../catalog";
import { BACKUP_VERSION, emptySettings } from "../storage";
import type { ApplicationLog, Person, ShopProduct, ShopSettings } from "../types";
import { getLocalShopStore, LocalShopStore } from "./LocalShopStore";
import type { ShopDocument } from "./types";

// Scope: LocalShopStore public API (mode, getShop, putShop, subscribe, getLocalShopStore).
// localStorage is an in-memory fake; storage.ts loaders/savers run for real on top of it.
// Private helpers (readLocalUpdatedAt / writeLocalUpdatedAt) are covered only via the API.

const LOGS_KEY = "jobber-pest-logger:logs:v1";
const CATALOG_KEY = "jobber-pest-logger:catalog:v1";
const PEOPLE_KEY = "jobber-pest-logger:people:v1";
const SETTINGS_KEY = "jobber-pest-logger:settings:v1";
const UPDATED_AT_KEY = "jobber-pest-logger:shop-updated-at:v1";
const LAST_BACKUP_KEY = "jobber-pest-logger:last-backup:v1";

class MemoryStorage {
  map = new Map<string, string>();
  failSet = false;
  failGet = false;
  /** Keys whose setItem throws (simulates quota on one section). */
  failSetKeys = new Set<string>();
  /** Keys whose next setItem throws once (transient quota), then succeed again. */
  failOnceKeys = new Set<string>();
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
    if (this.failSet || this.failSetKeys.has(k)) throw new Error("QuotaExceededError");
    if (this.failOnceKeys.delete(k)) throw new Error("QuotaExceededError");
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
const NOW = new Date("2026-09-27T01:00:00.000Z");

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeLog(id: string): ApplicationLog {
  return {
    id,
    createdAt: NOW.toISOString(),
    sampleData: false,
    jobberJobNumber: "J-1",
    jobberAddress: "",
    customerBillingName: "Jane",
    customerBillingAddress: "1 Main",
    serviceAddress: "2 Oak",
    poleLocation: "",
    products: [],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-26",
    personnel: [],
    shopTpclNumber: "1",
    shopTpclLetter: "",
    isTermite: false,
    termite: {
      areaTreatedSqFt: "",
      isBait: false,
      physicalBarrierMeasurement: "",
      diagramNote: "",
      isCommercialPretreat: false,
      tankCount: "",
      tankGallons: "",
      startTime: "",
      stopTime: "",
    },
  };
}

const PRODUCT: ShopProduct = {
  id: "prod-1",
  name: "Real Bifenthrin",
  epaRegNo: "279-3206",
  is25b: false,
  kind: "pesticide",
  isExample: false,
  archived: false,
};

const PERSON: Person = {
  id: "p1",
  name: "Alice Tech",
  licenseNumber: "L-1",
  roleTags: ["applying"],
  licenseExpiry: "2027-06-30",
  ceDueDate: "",
};

const SETTINGS: ShopSettings = { shopName: "Acme Pest", shopTpclNumber: "12345", shopTpclLetter: "B" };

function makeDoc(overrides: Partial<ShopDocument> = {}): ShopDocument {
  return {
    version: BACKUP_VERSION,
    updatedAt: "2020-01-01T00:00:00.000Z",
    logs: [makeLog("L1"), makeLog("L2")],
    catalog: [PRODUCT],
    people: [PERSON],
    settings: SETTINGS,
    lastBackupAt: null,
    ...overrides,
  };
}

describe("LocalShopStore basics", () => {
  it("reports local mode", () => {
    expect(new LocalShopStore().mode).toBe("local");
  });

  it("subscribe returns a no-op unsubscribe and never calls the listener", () => {
    const store = new LocalShopStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("getLocalShopStore returns one shared LocalShopStore instance", () => {
    const a = getLocalShopStore();
    const b = getLocalShopStore();
    expect(a).toBeInstanceOf(LocalShopStore);
    expect(a).toBe(b);
  });
});

describe("LocalShopStore.getShop", () => {
  it("on an empty device returns defaults and seeds updatedAt with now", async () => {
    const res = await new LocalShopStore().getShop();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      version: BACKUP_VERSION,
      updatedAt: NOW.toISOString(),
      logs: [],
      catalog: EXAMPLE_SEEDS.map((p) => ({ ...p })),
      people: [],
      settings: emptySettings(),
      lastBackupAt: null,
    });
    expect(storage.getItem(UPDATED_AT_KEY)).toBe(NOW.toISOString());
  });

  it("keeps the seeded updatedAt stable across later reads", async () => {
    const store = new LocalShopStore();
    await store.getShop();
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const res = await store.getShop();
    expect(res.ok && res.value.updatedAt).toBe(NOW.toISOString());
  });

  it("returns a stored updatedAt trimmed", async () => {
    storage.setItem(UPDATED_AT_KEY, "  2026-01-02T03:04:05.000Z  ");
    const res = await new LocalShopStore().getShop();
    expect(res.ok && res.value.updatedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("treats a whitespace-only stored updatedAt as missing and re-seeds it", async () => {
    storage.setItem(UPDATED_AT_KEY, "   ");
    const res = await new LocalShopStore().getShop();
    expect(res.ok && res.value.updatedAt).toBe(NOW.toISOString());
    expect(storage.getItem(UPDATED_AT_KEY)).toBe(NOW.toISOString());
  });

  it("returns stored logs, catalog, people, settings and lastBackupAt", async () => {
    storage.setItem(LOGS_KEY, JSON.stringify([makeLog("L1")]));
    storage.setItem(CATALOG_KEY, JSON.stringify([PRODUCT]));
    storage.setItem(PEOPLE_KEY, JSON.stringify([PERSON]));
    storage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS));
    storage.setItem(LAST_BACKUP_KEY, JSON.stringify("2026-09-01T12:00:00.000Z"));
    storage.setItem(UPDATED_AT_KEY, "2026-09-20T00:00:00.000Z");
    const res = await new LocalShopStore().getShop();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.version).toBe(BACKUP_VERSION);
    expect(res.value.updatedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(res.value.logs.map((l) => l.id)).toEqual(["L1"]);
    expect(res.value.catalog).toEqual([PRODUCT]);
    expect(res.value.people).toEqual([PERSON]);
    expect(res.value.settings).toEqual(SETTINGS);
    expect(res.value.lastBackupAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("fails with a stamp error when the first-read updatedAt seed cannot be written", async () => {
    storage.failSetKeys.add(UPDATED_AT_KEY);
    const res = await new LocalShopStore().getShop();
    expect(res).toEqual({
      ok: false,
      error: "Could not stamp local shop updatedAt on this device (storage full or blocked).",
    });
  });

  it("does not need to write when updatedAt already exists (read-only storage is fine)", async () => {
    storage.setItem(UPDATED_AT_KEY, "2026-09-20T00:00:00.000Z");
    storage.setItem(CATALOG_KEY, JSON.stringify([PRODUCT]));
    storage.failSet = true;
    const res = await new LocalShopStore().getShop();
    expect(res.ok).toBe(true);
    expect(res.ok && res.value.catalog).toEqual([PRODUCT]);
  });

  it("when reads throw, falls back to a seeded stamp and loader defaults", async () => {
    // readLocalUpdatedAt and every loader swallow read errors, so getShop still succeeds
    // as long as the updatedAt seed can be written.
    storage.failGet = true;
    const res = await new LocalShopStore().getShop();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.updatedAt).toBe(NOW.toISOString());
    expect(res.value.logs).toEqual([]);
    expect(res.value.people).toEqual([]);
    expect(res.value.settings).toEqual(emptySettings());
    expect(res.value.lastBackupAt).toBeNull();
  });
});

describe("LocalShopStore.putShop", () => {
  it("writes all four sections, stamps updatedAt with now and returns it", async () => {
    const res = await new LocalShopStore().putShop(makeDoc());
    expect(res).toEqual({ ok: true, value: { updatedAt: NOW.toISOString() } });
    expect(JSON.parse(storage.getItem(LOGS_KEY)!).map((l: ApplicationLog) => l.id)).toEqual([
      "L1",
      "L2",
    ]);
    expect(JSON.parse(storage.getItem(CATALOG_KEY)!)).toEqual([PRODUCT]);
    expect(JSON.parse(storage.getItem(PEOPLE_KEY)!)).toEqual([PERSON]);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!)).toEqual(SETTINGS);
    expect(storage.getItem(UPDATED_AT_KEY)).toBe(NOW.toISOString());
  });

  it("ignores the incoming doc.updatedAt (uses the local clock)", async () => {
    const res = await new LocalShopStore().putShop(makeDoc({ updatedAt: "1999-01-01T00:00:00.000Z" }));
    expect(res.ok && res.value.updatedAt).toBe(NOW.toISOString());
  });

  it("does not write or overwrite lastBackupAt", async () => {
    await new LocalShopStore().putShop(makeDoc({ lastBackupAt: "2026-09-01T00:00:00.000Z" }));
    expect(storage.getItem(LAST_BACKUP_KEY)).toBeNull();

    storage.setItem(LAST_BACKUP_KEY, JSON.stringify("2026-08-01T00:00:00.000Z"));
    await new LocalShopStore().putShop(makeDoc({ lastBackupAt: null }));
    expect(storage.getItem(LAST_BACKUP_KEY)).toBe(JSON.stringify("2026-08-01T00:00:00.000Z"));
  });

  it("round-trips: getShop after putShop returns the saved sections and new stamp", async () => {
    const store = new LocalShopStore();
    const doc = makeDoc();
    const put = await store.putShop(doc);
    const got = await store.getShop();
    expect(got.ok).toBe(true);
    if (!got.ok || !put.ok) return;
    expect(got.value.updatedAt).toBe(put.value.updatedAt);
    expect(got.value.logs.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(got.value.catalog).toEqual(doc.catalog);
    expect(got.value.people).toEqual(doc.people);
    expect(got.value.settings).toEqual(doc.settings);
  });

  it("a later put moves updatedAt forward", async () => {
    const store = new LocalShopStore();
    await store.putShop(makeDoc());
    const later = new Date(NOW.getTime() + 5_000);
    vi.setSystemTime(later);
    const res = await store.putShop(makeDoc());
    expect(res.ok && res.value.updatedAt).toBe(later.toISOString());
    expect(storage.getItem(UPDATED_AT_KEY)).toBe(later.toISOString());
  });

  it("fails with a snapshot error message when reading prior values throws", async () => {
    storage.failGet = true;
    const res = await new LocalShopStore().putShop(makeDoc());
    expect(res).toEqual({ ok: false, error: "getItem failed" });
    expect(storage.map.size).toBe(0);
  });

  for (const key of [LOGS_KEY, CATALOG_KEY, PEOPLE_KEY, SETTINGS_KEY]) {
    it(`rolls back every section to prior values when saving ${key.split(":")[1]} fails`, async () => {
      const prior: Record<string, string> = {
        [LOGS_KEY]: JSON.stringify([makeLog("OLD")]),
        [CATALOG_KEY]: JSON.stringify([]),
        [PEOPLE_KEY]: JSON.stringify([]),
        [SETTINGS_KEY]: JSON.stringify(emptySettings()),
      };
      for (const [k, v] of Object.entries(prior)) storage.setItem(k, v);
      storage.setItem(UPDATED_AT_KEY, "2026-01-01T00:00:00.000Z");
      // Transient failure: the rollback's restore of this key succeeds. (With a key that
      // fails permanently, rollback stops at the first throwing restore — see the
      // "rollback itself fails" case below.)
      storage.failOnceKeys.add(key);

      const res = await new LocalShopStore().putShop(makeDoc());
      expect(res).toEqual({
        ok: false,
        error: "Could not save shop data on this device (storage full or blocked).",
      });
      for (const [k, v] of Object.entries(prior)) expect(storage.getItem(k)).toBe(v);
      expect(storage.getItem(UPDATED_AT_KEY)).toBe("2026-01-01T00:00:00.000Z");
    });
  }

  it("rolls back by removing keys that did not exist before a failed save", async () => {
    storage.failSetKeys.add(SETTINGS_KEY);
    const res = await new LocalShopStore().putShop(makeDoc());
    expect(res.ok).toBe(false);
    for (const k of [LOGS_KEY, CATALOG_KEY, PEOPLE_KEY, SETTINGS_KEY, UPDATED_AT_KEY]) {
      expect(storage.getItem(k)).toBeNull();
    }
  });

  it("rolls back all sections when only the updatedAt stamp write fails", async () => {
    storage.setItem(LOGS_KEY, JSON.stringify([makeLog("OLD")]));
    storage.failSetKeys.add(UPDATED_AT_KEY);
    const res = await new LocalShopStore().putShop(makeDoc());
    expect(res).toEqual({
      ok: false,
      error: "Could not stamp local shop updatedAt on this device (storage full or blocked).",
    });
    expect(storage.getItem(LOGS_KEY)).toBe(JSON.stringify([makeLog("OLD")]));
    expect(storage.getItem(CATALOG_KEY)).toBeNull();
    expect(storage.getItem(PEOPLE_KEY)).toBeNull();
    expect(storage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it("returns the save error even when the rollback itself fails", async () => {
    storage.failSet = true; // every write fails, including rollback restores
    const res = await new LocalShopStore().putShop(makeDoc());
    expect(res).toEqual({
      ok: false,
      error: "Could not save shop data on this device (storage full or blocked).",
    });
  });

  it("rolls back when a section cannot be serialized", async () => {
    storage.setItem(LOGS_KEY, JSON.stringify([makeLog("OLD")]));
    // JSON.stringify of a BigInt throws inside the saver's try — the saver catches it and
    // returns false, so this surfaces as the generic save error with a rollback.
    const bad = makeDoc({ settings: { ...SETTINGS, shopName: 1n as unknown as string } });
    const res = await new LocalShopStore().putShop(bad);
    expect(res).toEqual({
      ok: false,
      error: "Could not save shop data on this device (storage full or blocked).",
    });
    expect(storage.getItem(LOGS_KEY)).toBe(JSON.stringify([makeLog("OLD")]));
    expect(storage.getItem(CATALOG_KEY)).toBeNull();
  });
});
