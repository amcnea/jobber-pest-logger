import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SEEDS } from "./catalog";
import {
  applyBackup,
  BACKUP_NAG_DAYS,
  BACKUP_VERSION,
  backupNagMessage,
  buildBackup,
  clearExampleDemoData,
  deleteLog,
  deletePerson,
  deleteProduct,
  derivePropertyBook,
  dismissA2hsTip,
  dismissPilotCard,
  displayServiceAddress,
  downloadBackup,
  emptyPerson,
  emptySettings,
  emptyShopProduct,
  firstRunIncomplete,
  formatLastBackupLabel,
  getFirstRunSteps,
  groupLogsByServiceAddress,
  loadA2hsTipDismissed,
  CATALOG_QUARANTINE_KEY,
  loadCatalog,
  loadCatalogQuarantine,
  loadLastBackupAt,
  loadLogs,
  loadLogsQuarantine,
  loadPeople,
  loadPeopleQuarantine,
  LOGS_QUARANTINE_KEY,
  PEOPLE_QUARANTINE_KEY,
  loadPilotCardDismissed,
  loadSettings,
  markLastBackupNow,
  normalizeLog,
  normalizeServiceAddressKey,
  parseBackup,
  parseShopSections,
  peopleForRole,
  removeExampleProductsFromCatalog,
  saveCatalog,
  saveLogs,
  savePeople,
  saveSettings,
  upsertLog,
  upsertPerson,
  upsertProduct,
  wipeAllDeviceData,
  type DeviceBackup,
  type ShopSections,
} from "./storage";
import type { ApplicationLog, AppliedProduct, Person, ShopProduct, ShopSettings } from "./types";

// Scope: public behavior of src/storage.ts on an in-memory localStorage.
// storage.ts imports only ./catalog, ./ids and ./types (no Firebase), so nothing is mocked
// except browser globals: localStorage (always) and document/URL/window for downloadBackup.
// vitest.config.ts pins TZ=America/Chicago; Date is faked per test.

const LOGS_KEY = "jobber-pest-logger:logs:v1";
const CATALOG_KEY = "jobber-pest-logger:catalog:v1";
const PEOPLE_KEY = "jobber-pest-logger:people:v1";
const SETTINGS_KEY = "jobber-pest-logger:settings:v1";
const LAST_BACKUP_KEY = "jobber-pest-logger:last-backup:v1";
const PILOT_CARD_KEY = "jobber-pest-logger:pilot-card-dismissed:v1";
const A2HS_TIP_KEY = "jobber-pest-logger:a2hs-tip-dismissed:v1";
const SHOP_SESSION_KEY = "jobber-pest-logger:shop-session:v1";

class MemoryStorage {
  map = new Map<string, string>();
  failSet = false;
  failGet = false;
  failRemove = false;
  failSetKeys = new Set<string>();
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
    if (this.failRemove) throw new Error("removeItem failed");
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let storage: MemoryStorage;
const NOW = new Date("2026-09-26T15:00:00.000Z"); // Sat Sep 26 2026, 10:00 CDT

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function product(overrides: Partial<AppliedProduct> = {}): AppliedProduct {
  return {
    lineId: "line-1",
    catalogId: "prod-1",
    name: "Real Bifenthrin",
    epaRegNo: "279-3206",
    is25b: false,
    isExample: false,
    method: "rtu",
    rtuAmount: "16",
    rtuUnit: "fl oz",
    mixingRate: "",
    percentAi: "",
    mixedTotal: "",
    mixedUnit: "gal",
    deviceCount: "",
    ...overrides,
  };
}

function exampleLine(overrides: Partial<AppliedProduct> = {}): AppliedProduct {
  return product({
    lineId: "line-ex",
    catalogId: "example-rtu-insecticide",
    name: "Example RTU insecticide",
    epaRegNo: null,
    isExample: true,
    ...overrides,
  });
}

function makeLog(id: string, overrides: Partial<ApplicationLog> = {}): ApplicationLog {
  return {
    id,
    createdAt: "2026-09-26T12:00:00.000Z",
    sampleData: false,
    jobberJobNumber: "J-1",
    jobberAddress: "",
    customerBillingName: "Jane",
    customerBillingAddress: "1 Main",
    serviceAddress: "2 Oak St",
    poleLocation: "",
    products: [product()],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-26",
    personnel: [{ role: "applying", name: "Alice", licenseNumber: "L-1" }],
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
    ...overrides,
  };
}

function shopProduct(overrides: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id: "prod-1",
    name: "Real Bifenthrin",
    epaRegNo: "279-3206",
    is25b: false,
    kind: "pesticide",
    isExample: false,
    archived: false,
    ...overrides,
  };
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "p1",
    name: "Alice Tech",
    licenseNumber: "L-1",
    roleTags: ["applying"],
    licenseExpiry: "2027-06-30",
    ceDueDate: "",
    ...overrides,
  };
}

const SETTINGS: ShopSettings = { shopName: "Acme Pest", shopTpclNumber: "12345", shopTpclLetter: "B" };

function put(key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value));
}

function stored(key: string): unknown {
  const raw = storage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function ids(list: { id: string }[]) {
  return list.map((x) => x.id);
}

function validBackup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: BACKUP_VERSION,
    exportedAt: "2026-09-25T12:00:00.000Z",
    logs: [makeLog("L1")],
    catalog: [shopProduct()],
    people: [person()],
    settings: SETTINGS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

describe("normalizeLog", () => {
  it("accepts a well-formed log unchanged", () => {
    expect(normalizeLog(makeLog("L1"))).toEqual(makeLog("L1"));
  });

  it("rejects non-objects and logs with missing or mistyped fields", () => {
    for (const v of [null, undefined, 1, "x", [], [makeLog("L1")]]) expect(normalizeLog(v)).toBeNull();
    const base = makeLog("L1") as unknown as Record<string, unknown>;
    for (const key of [
      "id",
      "createdAt",
      "serviceAddress",
      "dateUsed",
      "customerBillingName",
      "sampleData",
      "isTermite",
      "jobberJobNumber",
      "jobberAddress",
      "customerBillingAddress",
      "poleLocation",
      "targetPestOrPurpose",
      "shopTpclNumber",
      "shopTpclLetter",
      "products",
      "personnel",
      "termite",
    ]) {
      const { [key]: _omit, ...rest } = base;
      expect(normalizeLog(rest), `missing ${key}`).toBeNull();
    }
    expect(normalizeLog({ ...base, isTermite: "no" })).toBeNull();
  });

  it("rejects a log with any invalid product line or personnel row", () => {
    expect(normalizeLog(makeLog("L1", { products: [{ ...product(), method: "spray" } as never] }))).toBeNull();
    expect(normalizeLog(makeLog("L1", { products: [{ ...product(), rtuAmount: 16 } as never] }))).toBeNull();
    expect(
      normalizeLog(makeLog("L1", { personnel: [{ role: "boss", name: "x", licenseNumber: "" } as never] })),
    ).toBeNull();
  });

  it("rejects a log with an invalid termite block", () => {
    const termite = { ...makeLog("L1").termite, isBait: "yes" };
    expect(normalizeLog(makeLog("L1", { termite: termite as never }))).toBeNull();
    expect(normalizeLog(makeLog("L1", { termite: null as never }))).toBeNull();
  });

  it("recomputes sampleData from product lines", () => {
    expect(normalizeLog(makeLog("L1", { sampleData: true }))!.sampleData).toBe(false);
    expect(normalizeLog(makeLog("L1", { products: [exampleLine()] }))!.sampleData).toBe(true);
  });

  it("infers example lines from SAMPLE-/example- markers even when isExample is false", () => {
    const sample = normalizeLog(
      makeLog("L1", { products: [product({ epaRegNo: "SAMPLE-123", isExample: false })] }),
    )!;
    expect(sample.products[0].isExample).toBe(true);
    expect(sample.products[0].epaRegNo).toBeNull();
    expect(sample.sampleData).toBe(true);
    const seed = normalizeLog(makeLog("L1", { products: [exampleLine({ isExample: false })] }))!;
    expect(seed.products[0].isExample).toBe(true);
  });

  it("treats a missing product isExample as false for real products (legacy rows)", () => {
    const { isExample: _x, ...legacy } = product();
    const log = normalizeLog(makeLog("L1", { products: [legacy as AppliedProduct] }))!;
    expect(log.products[0].isExample).toBe(false);
    expect(log.products[0].epaRegNo).toBe("279-3206");
  });

  it("drops EPA numbers for device and 25(b) lines", () => {
    const log = normalizeLog(
      makeLog("L1", {
        products: [
          product({ lineId: "a", method: "device", epaRegNo: "1-2" }),
          product({ lineId: "b", is25b: true, epaRegNo: "3-4" }),
          product({ lineId: "c", method: "mixed", epaRegNo: "5-6" }),
        ],
      }),
    )!;
    expect(log.products.map((p) => p.epaRegNo)).toEqual([null, null, "5-6"]);
  });

  it("drops unknown extra top-level keys", () => {
    const log = normalizeLog({ ...makeLog("L1"), extra: "x" }) as unknown as Record<string, unknown>;
    expect(log.extra).toBeUndefined();
  });
});

describe("loadLogs / saveLogs", () => {
  it("returns [] when missing, corrupt, not an array or unreadable", () => {
    expect(loadLogs()).toEqual([]);
    storage.setItem(LOGS_KEY, "{nope");
    expect(loadLogs()).toEqual([]);
    put(LOGS_KEY, { id: "L1" });
    expect(loadLogs()).toEqual([]);
    storage.failGet = true;
    expect(loadLogs()).toEqual([]);
  });

  it("round-trips logs in order", () => {
    expect(saveLogs([makeLog("A"), makeLog("B")])).toBe(true);
    expect(ids(loadLogs())).toEqual(["A", "B"]);
    expect(loadLogs()[0]).toEqual(makeLog("A"));
  });

  it("drops invalid rows but keeps valid ones", () => {
    put(LOGS_KEY, [makeLog("A"), { id: "broken" }, 42, makeLog("B")]);
    expect(ids(loadLogs())).toEqual(["A", "B"]);
  });

  it("saveLogs returns false and logs on quota errors", () => {
    storage.failSet = true;
    expect(saveLogs([makeLog("A")])).toBe(false);
    expect(console.error).toHaveBeenCalled();
    expect(storage.getItem(LOGS_KEY)).toBeNull();
  });
});

describe("upsertLog / deleteLog", () => {
  it("inserts new logs at the front (newest first)", () => {
    upsertLog(makeLog("A"));
    upsertLog(makeLog("B"));
    const res = upsertLog(makeLog("C"));
    expect(res.saved).toBe(true);
    expect(ids(res.logs)).toEqual(["C", "B", "A"]);
    expect(ids(loadLogs())).toEqual(["C", "B", "A"]);
  });

  it("replaces an existing log in place without duplicating it", () => {
    saveLogs([makeLog("C"), makeLog("B"), makeLog("A")]);
    const res = upsertLog(makeLog("B", { customerBillingName: "Edited" }));
    expect(ids(res.logs)).toEqual(["C", "B", "A"]);
    expect(res.logs[1].customerBillingName).toBe("Edited");
    expect(loadLogs()[1].customerBillingName).toBe("Edited");
  });

  it("on save failure returns the previous list and saved:false", () => {
    saveLogs([makeLog("A")]);
    storage.failSet = true;
    const res = upsertLog(makeLog("B"));
    expect(res.saved).toBe(false);
    expect(ids(res.logs)).toEqual(["A"]);
    storage.failSet = false;
    expect(ids(loadLogs())).toEqual(["A"]);
  });

  it("a save after load keeps the main key normalized and quarantines the raw failed row", () => {
    const legacy = { id: "legacy-without-termite" };
    put(LOGS_KEY, [makeLog("A"), legacy]);
    upsertLog(makeLog("B"));
    expect((stored(LOGS_KEY) as { id: string }[]).map((l) => l.id)).toEqual(["B", "A"]);
    expect(loadLogsQuarantine()).toEqual([legacy]);
    expect(stored(LOGS_QUARANTINE_KEY)).toEqual([legacy]);
  });

  it("keeps two same-id raw logs when content differs and still collapses identical rows", () => {
    const legacy = { id: "legacy-without-termite", note: "first" };
    const sameId = { id: "legacy-without-termite", note: "second" };
    put(LOGS_KEY, [makeLog("A"), legacy, sameId, 42, 42]);
    loadLogs();
    loadLogs();
    upsertLog(makeLog("B"));
    upsertLog(makeLog("C"));
    // Full JSON, not id: different content both stay. Identical 42 collapses to one.
    expect(loadLogsQuarantine()).toEqual([legacy, sameId, 42]);
    expect((stored(LOGS_KEY) as { id: string }[]).map((l) => l.id)).toEqual(["C", "B", "A"]);
  });

  it("does not rewrite the main log key when the quarantine write fails", () => {
    const legacy = { id: "legacy-without-termite" };
    put(LOGS_KEY, [makeLog("A"), legacy]);
    storage.failSetKeys.add(LOGS_QUARANTINE_KEY);
    expect(saveLogs([makeLog("B")])).toBe(false);
    expect(stored(LOGS_KEY)).toEqual([makeLog("A"), legacy]);
    const res = upsertLog(makeLog("B"));
    expect(res.saved).toBe(false);
    expect(stored(LOGS_KEY)).toEqual([makeLog("A"), legacy]);
    expect(loadLogsQuarantine()).toEqual([]);
  });

  it("rewrites the main log key when the bad row is already quarantined", () => {
    const legacy = { id: "legacy-without-termite" };
    put(LOGS_KEY, [makeLog("A"), legacy]);
    put(LOGS_QUARANTINE_KEY, [legacy]);
    storage.failSetKeys.add(LOGS_QUARANTINE_KEY);
    const res = upsertLog(makeLog("B"));
    expect(res.saved).toBe(true);
    expect((stored(LOGS_KEY) as { id: string }[]).map((l) => l.id)).toEqual(["B", "A"]);
    expect(loadLogsQuarantine()).toEqual([legacy]);
  });

  it("duplicate stored ids are all replaced by upsert and all removed by delete", () => {
    put(LOGS_KEY, [makeLog("A"), makeLog("A", { customerBillingName: "Dup" })]);
    const res = upsertLog(makeLog("A", { customerBillingName: "Edited" }));
    expect(res.logs.map((l) => l.customerBillingName)).toEqual(["Edited", "Edited"]);
    expect(deleteLog("A").logs).toEqual([]);
  });

  it("deleteLog removes by id and persists", () => {
    saveLogs([makeLog("A"), makeLog("B"), makeLog("C")]);
    const res = deleteLog("B");
    expect(res).toEqual({ logs: [makeLog("A"), makeLog("C")], saved: true });
    expect(ids(loadLogs())).toEqual(["A", "C"]);
  });

  it("deleteLog of an unknown id is a successful no-op", () => {
    saveLogs([makeLog("A")]);
    expect(deleteLog("zzz")).toEqual({ logs: [makeLog("A")], saved: true });
  });

  it("deleteLog on save failure keeps the current list", () => {
    saveLogs([makeLog("A"), makeLog("B")]);
    storage.failSet = true;
    const res = deleteLog("A");
    expect(res.saved).toBe(false);
    expect(ids(res.logs)).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// Property book
// ---------------------------------------------------------------------------

describe("service address helpers", () => {
  it("normalizeServiceAddressKey trims, collapses whitespace and case-folds", () => {
    expect(normalizeServiceAddressKey("  2  Oak\tSt \n")).toBe("2 oak st");
    expect(normalizeServiceAddressKey("")).toBe("(no service address)");
    expect(normalizeServiceAddressKey("   ")).toBe("(no service address)");
    expect(normalizeServiceAddressKey(undefined as unknown as string)).toBe("(no service address)");
  });

  it("displayServiceAddress trims and collapses but keeps case", () => {
    expect(displayServiceAddress("  2  Oak\tSt ")).toBe("2 Oak St");
    expect(displayServiceAddress(" ")).toBe("(no service address)");
    expect(displayServiceAddress(null as unknown as string)).toBe("(no service address)");
  });
});

describe("groupLogsByServiceAddress / derivePropertyBook", () => {
  it("returns [] for no logs", () => {
    expect(groupLogsByServiceAddress([])).toEqual([]);
  });

  it("groups by normalized address, newest log first, last-seen fields from newest", () => {
    const old = makeLog("old", {
      serviceAddress: "2 oak st",
      dateUsed: "2026-09-01",
      customerBillingName: "Old Name",
      poleLocation: "P1",
    });
    const newer = makeLog("new", {
      serviceAddress: " 2  Oak St ",
      dateUsed: "2026-09-20",
      customerBillingName: "New Name",
      customerBillingAddress: "9 Elm",
      poleLocation: "P2",
      jobberAddress: "Jobber 2 Oak",
    });
    const other = makeLog("other", { serviceAddress: "1 Birch Rd" });
    const book = groupLogsByServiceAddress([old, other, newer]);
    expect(book.map((e) => e.key)).toEqual(["1 birch rd", "2 oak st"]);
    const oak = book[1];
    expect(oak.serviceAddress).toBe("2 Oak St");
    expect(oak.customerBillingName).toBe("New Name");
    expect(oak.customerBillingAddress).toBe("9 Elm");
    expect(oak.poleLocation).toBe("P2");
    expect(oak.jobberAddress).toBe("Jobber 2 Oak");
    expect(ids(oak.logs)).toEqual(["new", "old"]);
    expect(oak.lastLog.id).toBe("new");
  });

  it("breaks dateUsed ties with createdAt", () => {
    const a = makeLog("a", { createdAt: "2026-09-26T10:00:00.000Z" });
    const b = makeLog("b", { createdAt: "2026-09-26T11:00:00.000Z" });
    expect(ids(groupLogsByServiceAddress([a, b])[0].logs)).toEqual(["b", "a"]);
  });

  it("puts blank addresses under a placeholder entry", () => {
    const book = groupLogsByServiceAddress([makeLog("a", { serviceAddress: "  " })]);
    expect(book[0].key).toBe("(no service address)");
    expect(book[0].serviceAddress).toBe("(no service address)");
  });

  it("sorts entries by display address", () => {
    const book = groupLogsByServiceAddress([
      makeLog("c", { serviceAddress: "300 Cedar" }),
      makeLog("a", { serviceAddress: "100 Ash" }),
      makeLog("b", { serviceAddress: "200 Beech" }),
    ]);
    expect(book.map((e) => e.serviceAddress)).toEqual(["100 Ash", "200 Beech", "300 Cedar"]);
  });

  it("does not mutate the input array", () => {
    const logs = [makeLog("a", { dateUsed: "2026-01-01" }), makeLog("b", { dateUsed: "2026-02-01" })];
    groupLogsByServiceAddress(logs);
    expect(ids(logs)).toEqual(["a", "b"]);
  });

  it("derivePropertyBook is the same grouping", () => {
    const logs = [makeLog("a"), makeLog("b", { serviceAddress: "9 Pine" })];
    expect(derivePropertyBook(logs)).toEqual(groupLogsByServiceAddress(logs));
  });
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("loadCatalog / saveCatalog", () => {
  it("seeds and persists the example catalog when missing", () => {
    const cat = loadCatalog();
    expect(cat).toEqual(EXAMPLE_SEEDS);
    expect(cat[0]).not.toBe(EXAMPLE_SEEDS[0]); // copies, not the shared constants
    expect(stored(CATALOG_KEY)).toEqual(EXAMPLE_SEEDS);
  });

  it("re-seeds when corrupt or not an array", () => {
    storage.setItem(CATALOG_KEY, "{bad");
    expect(loadCatalog()).toEqual(EXAMPLE_SEEDS);
    expect(stored(CATALOG_KEY)).toEqual(EXAMPLE_SEEDS);
    put(CATALOG_KEY, { id: "x" });
    expect(loadCatalog()).toEqual(EXAMPLE_SEEDS);
  });

  it("keeps an empty array (user deleted everything) without re-seeding", () => {
    put(CATALOG_KEY, []);
    expect(loadCatalog()).toEqual([]);
    expect(stored(CATALOG_KEY)).toEqual([]);
  });

  it("returns seeds even when the seed cannot be written", () => {
    storage.failSet = true;
    expect(loadCatalog()).toEqual(EXAMPLE_SEEDS);
  });

  it("returns seeds when storage reads throw", () => {
    storage.failGet = true;
    expect(loadCatalog()).toEqual(EXAMPLE_SEEDS);
  });

  it("round-trips products and drops invalid rows", () => {
    expect(saveCatalog([shopProduct(), shopProduct({ id: "dev", kind: "device", epaRegNo: null })])).toBe(true);
    expect(ids(loadCatalog())).toEqual(["prod-1", "dev"]);
    put(CATALOG_KEY, [shopProduct(), { id: "bad", kind: "spray" }]);
    expect(ids(loadCatalog())).toEqual(["prod-1"]);
  });

  it("quarantines invalid catalog rows before a later save prunes the main key", () => {
    const bad = { id: "bad", kind: "spray" };
    put(CATALOG_KEY, [shopProduct(), bad]);
    const res = upsertProduct(shopProduct({ id: "new" }));
    expect(res.saved).toBe(true);
    expect(ids(res.catalog)).toEqual(["new", "prod-1"]);
    expect((stored(CATALOG_KEY) as { id: string }[]).map((p) => p.id)).toEqual(["new", "prod-1"]);
    expect(loadCatalogQuarantine()).toEqual([bad]);
  });

  it("does not rewrite the catalog main key when the quarantine write fails", () => {
    const bad = { id: "bad", kind: "spray" };
    put(CATALOG_KEY, [shopProduct(), bad]);
    storage.failSetKeys.add(CATALOG_QUARANTINE_KEY);
    expect(saveCatalog([shopProduct({ id: "new" })])).toBe(false);
    expect(stored(CATALOG_KEY)).toEqual([shopProduct(), bad]);
    const res = upsertProduct(shopProduct({ id: "new" }));
    expect(res.saved).toBe(false);
    expect(stored(CATALOG_KEY)).toEqual([shopProduct(), bad]);
    expect(loadCatalogQuarantine()).toEqual([]);
  });

  it("keeps two same-id catalog rows when content differs and collapses identical ones", () => {
    const bad = { id: "bad", kind: "spray" };
    const sameId = { ...bad, name: "again" };
    put(CATALOG_KEY, [shopProduct(), bad, bad, sameId]);
    loadCatalog();
    loadCatalog();
    expect(loadCatalogQuarantine()).toEqual([bad, sameId]);
  });

  it("does not quarantine when the catalog is missing, corrupt, or not an array", () => {
    loadCatalog();
    expect(storage.getItem(CATALOG_QUARANTINE_KEY)).toBeNull();
    storage.clear();
    storage.setItem(CATALOG_KEY, "{bad");
    expect(loadCatalog()).toEqual(EXAMPLE_SEEDS);
    expect(storage.getItem(CATALOG_QUARANTINE_KEY)).toBeNull();
    storage.clear();
    put(CATALOG_KEY, { id: "x" });
    expect(loadCatalog()).toEqual(EXAMPLE_SEEDS);
    expect(storage.getItem(CATALOG_QUARANTINE_KEY)).toBeNull();
  });

  it("normalizes legacy rows: missing isExample/archived, example markers, EPA drops", () => {
    put(CATALOG_KEY, [
      { id: "a", name: "A", epaRegNo: "1-2", is25b: false, kind: "pesticide" },
      { id: "b", name: "B", epaRegNo: "SAMPLE-9", is25b: false, kind: "pesticide", isExample: false },
      { id: "c", name: "C", epaRegNo: "3-4", is25b: true, kind: "device" },
      { id: "d", name: "D", epaRegNo: "5-6", is25b: true, kind: "pesticide" },
    ]);
    expect(loadCatalog()).toEqual([
      shopProduct({ id: "a", name: "A", epaRegNo: "1-2" }),
      shopProduct({ id: "b", name: "B", epaRegNo: null, isExample: true }),
      shopProduct({ id: "c", name: "C", epaRegNo: null, is25b: false, kind: "device" }),
      shopProduct({ id: "d", name: "D", epaRegNo: null, is25b: true }),
    ]);
  });

  it("saveCatalog returns false on quota errors", () => {
    storage.failSet = true;
    expect(saveCatalog([shopProduct()])).toBe(false);
  });
});

describe("upsertProduct / deleteProduct", () => {
  beforeEach(() => {
    saveCatalog([shopProduct({ id: "a" }), shopProduct({ id: "b" })]);
  });

  it("inserts new products at the front", () => {
    const res = upsertProduct(shopProduct({ id: "c" }));
    expect(res.saved).toBe(true);
    expect(ids(res.catalog)).toEqual(["c", "a", "b"]);
    expect(ids(loadCatalog())).toEqual(["c", "a", "b"]);
  });

  it("replaces existing products in place", () => {
    const res = upsertProduct(shopProduct({ id: "b", name: "Renamed", archived: true }));
    expect(ids(res.catalog)).toEqual(["a", "b"]);
    expect(loadCatalog()[1]).toEqual(shopProduct({ id: "b", name: "Renamed", archived: true }));
  });

  it("on failure returns the prior catalog", () => {
    storage.failSet = true;
    expect(upsertProduct(shopProduct({ id: "c" }))).toEqual({
      catalog: [shopProduct({ id: "a" }), shopProduct({ id: "b" })],
      saved: false,
    });
    expect(deleteProduct("a").saved).toBe(false);
    expect(deleteProduct("a").catalog).toHaveLength(2);
  });

  it("deleteProduct removes by id", () => {
    expect(ids(deleteProduct("a").catalog)).toEqual(["b"]);
    expect(ids(loadCatalog())).toEqual(["b"]);
  });
});

describe("removeExampleProductsFromCatalog", () => {
  it("removes example seeds and SAMPLE rows, keeping real products", () => {
    saveCatalog([...EXAMPLE_SEEDS, shopProduct(), shopProduct({ id: "s", epaRegNo: "SAMPLE-1" })]);
    const res = removeExampleProductsFromCatalog();
    expect(res).toEqual({ catalog: [shopProduct()], saved: true, removed: 4 });
    expect(stored(CATALOG_KEY)).toEqual([shopProduct()]);
  });

  it("is a no-op (no write) when there are no examples", () => {
    saveCatalog([shopProduct()]);
    storage.failSet = true;
    expect(removeExampleProductsFromCatalog()).toEqual({
      catalog: [shopProduct()],
      saved: true,
      removed: 0,
    });
  });

  it("reports removed:0 and the prior catalog on save failure", () => {
    saveCatalog([...EXAMPLE_SEEDS, shopProduct()]);
    storage.failSet = true;
    const res = removeExampleProductsFromCatalog();
    expect(res.saved).toBe(false);
    expect(res.removed).toBe(0);
    expect(res.catalog).toHaveLength(4);
  });
});

describe("clearExampleDemoData", () => {
  function seedDemo() {
    saveCatalog([...EXAMPLE_SEEDS, shopProduct()]);
    saveLogs([
      makeLog("examples-only", { products: [exampleLine()] }),
      makeLog("mixed", { products: [exampleLine(), product({ lineId: "real" })] }),
      makeLog("real", { products: [product()] }),
      makeLog("empty", { products: [] }),
    ]);
    savePeople([person()]);
    saveSettings(SETTINGS);
    markLastBackupNow();
  }

  it("removes example-only logs, strips example lines from mixed logs, keeps the rest", () => {
    seedDemo();
    const res = clearExampleDemoData();
    expect(res.saved).toBe(true);
    expect(res.removedCatalog).toBe(3);
    expect(res.removedLogs).toBe(1);
    expect(res.strippedLogs).toBe(1);
    expect(res.catalog).toEqual([shopProduct()]);
    expect(ids(res.logs)).toEqual(["mixed", "real", "empty"]);
    const mixed = res.logs[0];
    expect(mixed.products.map((p) => p.lineId)).toEqual(["real"]);
    expect(mixed.sampleData).toBe(false);
    expect(ids(loadLogs())).toEqual(["mixed", "real", "empty"]);
  });

  it("does not touch people, settings or the backup stamp", () => {
    seedDemo();
    const stamp = storage.getItem(LAST_BACKUP_KEY);
    clearExampleDemoData();
    expect(loadPeople()).toEqual([person()]);
    expect(loadSettings()).toEqual(SETTINGS);
    expect(storage.getItem(LAST_BACKUP_KEY)).toBe(stamp);
  });

  it("is a no-op for a device with no example data", () => {
    saveCatalog([shopProduct()]);
    saveLogs([makeLog("real")]);
    expect(clearExampleDemoData()).toEqual({
      catalog: [shopProduct()],
      logs: [makeLog("real")],
      saved: true,
      removedCatalog: 0,
      removedLogs: 0,
      strippedLogs: 0,
    });
  });

  it("reports log counts as 0 and returns current logs when the log write fails", () => {
    seedDemo();
    storage.failSetKeys.add(LOGS_KEY);
    const res = clearExampleDemoData();
    expect(res.saved).toBe(false);
    expect(res.removedLogs).toBe(0);
    expect(res.strippedLogs).toBe(0);
    expect(res.logs).toHaveLength(4);
    // Catalog cleanup is independent and still persisted.
    expect(res.removedCatalog).toBe(3);
    expect(stored(CATALOG_KEY)).toEqual([shopProduct()]);
  });

  it("still cleans logs when only the catalog write fails", () => {
    seedDemo();
    storage.failSetKeys.add(CATALOG_KEY);
    const res = clearExampleDemoData();
    expect(res.saved).toBe(false);
    expect(res.removedCatalog).toBe(0);
    expect(res.removedLogs).toBe(1);
    expect(ids(loadLogs())).toEqual(["mixed", "real", "empty"]);
  });
});

describe("emptyShopProduct", () => {
  it("returns a blank real pesticide with a fresh id", () => {
    const a = emptyShopProduct();
    const b = emptyShopProduct();
    expect(a).toEqual({
      id: expect.any(String),
      name: "",
      epaRegNo: null,
      is25b: false,
      kind: "pesticide",
      isExample: false,
      archived: false,
    });
    expect(a.id).not.toBe("");
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

describe("loadPeople / savePeople", () => {
  it("returns [] when missing, corrupt, not an array or unreadable", () => {
    expect(loadPeople()).toEqual([]);
    storage.setItem(PEOPLE_KEY, "nope");
    expect(loadPeople()).toEqual([]);
    put(PEOPLE_KEY, { id: "p" });
    expect(loadPeople()).toEqual([]);
    storage.failGet = true;
    expect(loadPeople()).toEqual([]);
  });

  it("round-trips people and drops invalid rows", () => {
    expect(savePeople([person(), person({ id: "p2" })])).toBe(true);
    expect(ids(loadPeople())).toEqual(["p1", "p2"]);
    put(PEOPLE_KEY, [person(), { ...person({ id: "bad" }), roleTags: ["boss"] }, { id: "x" }]);
    expect(ids(loadPeople())).toEqual(["p1"]);
  });

  it("quarantines invalid people before a later save prunes the main key", () => {
    const bad = { id: "x" };
    put(PEOPLE_KEY, [person(), bad]);
    const res = upsertPerson(person({ id: "p2" }));
    expect(res.saved).toBe(true);
    expect(ids(res.people)).toEqual(["p2", "p1"]);
    expect((stored(PEOPLE_KEY) as { id: string }[]).map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(loadPeopleQuarantine()).toEqual([bad]);
    expect(stored(PEOPLE_QUARANTINE_KEY)).toEqual([bad]);
  });

  it("does not rewrite the people main key when the quarantine write fails", () => {
    const bad = { id: "x" };
    put(PEOPLE_KEY, [person(), bad]);
    storage.failSetKeys.add(PEOPLE_QUARANTINE_KEY);
    expect(savePeople([person({ id: "p2" })])).toBe(false);
    expect(stored(PEOPLE_KEY)).toEqual([person(), bad]);
    const res = upsertPerson(person({ id: "p2" }));
    expect(res.saved).toBe(false);
    expect(stored(PEOPLE_KEY)).toEqual([person(), bad]);
    expect(loadPeopleQuarantine()).toEqual([]);
  });

  it("keeps two same-id people when content differs and collapses identical ones", () => {
    const bad = { id: "x", name: 1 };
    const sameId = { id: "x", name: 2 };
    put(PEOPLE_KEY, [person(), bad, bad, sameId]);
    loadPeople();
    upsertPerson(person({ id: "p2" }));
    loadPeople();
    upsertPerson(person({ id: "p3" }));
    expect(loadPeopleQuarantine()).toEqual([bad, sameId]);
  });

  it("dedupes role tags and defaults a missing/null ceDueDate to ''", () => {
    const { ceDueDate: _c, ...noCe } = person({ id: "a" });
    put(PEOPLE_KEY, [
      { ...person(), roleTags: ["applying", "supervising", "applying"] },
      noCe,
      { ...person({ id: "b" }), ceDueDate: null },
    ]);
    const people = loadPeople();
    expect(people[0].roleTags).toEqual(["applying", "supervising"]);
    expect(people[1].ceDueDate).toBe("");
    expect(people[2].ceDueDate).toBe("");
  });

  it("savePeople returns false on quota errors", () => {
    storage.failSet = true;
    expect(savePeople([person()])).toBe(false);
  });
});

describe("upsertPerson / deletePerson / emptyPerson / peopleForRole", () => {
  it("upsert inserts at the front and replaces in place", () => {
    upsertPerson(person({ id: "a" }));
    upsertPerson(person({ id: "b" }));
    expect(ids(loadPeople())).toEqual(["b", "a"]);
    const res = upsertPerson(person({ id: "a", name: "Renamed" }));
    expect(ids(res.people)).toEqual(["b", "a"]);
    expect(loadPeople()[1].name).toBe("Renamed");
  });

  it("upsert/delete return the prior roster on failure", () => {
    savePeople([person()]);
    storage.failSet = true;
    expect(upsertPerson(person({ id: "z" }))).toEqual({ people: [person()], saved: false });
    expect(deletePerson("p1")).toEqual({ people: [person()], saved: false });
  });

  it("delete removes by id", () => {
    savePeople([person({ id: "a" }), person({ id: "b" })]);
    expect(deletePerson("a")).toEqual({ people: [person({ id: "b" })], saved: true });
  });

  it("emptyPerson defaults to the applying role with a fresh id", () => {
    const a = emptyPerson();
    expect(a).toEqual({
      id: expect.any(String),
      name: "",
      licenseNumber: "",
      roleTags: ["applying"],
      licenseExpiry: "",
      ceDueDate: "",
    });
    expect(a.id).not.toBe(emptyPerson().id);
  });

  it("peopleForRole lists tagged people first, then everyone else, keeping order", () => {
    const roster = [
      person({ id: "a", roleTags: ["applying"] }),
      person({ id: "b", roleTags: ["supervising"] }),
      person({ id: "c", roleTags: ["applying", "supervising"] }),
      person({ id: "d", roleTags: [] }),
    ];
    expect(ids(peopleForRole(roster, "supervising"))).toEqual(["b", "c", "a", "d"]);
    expect(ids(peopleForRole(roster, "receiving_training"))).toEqual(["a", "b", "c", "d"]);
    expect(peopleForRole([], "applying")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Settings, flags, backup stamp
// ---------------------------------------------------------------------------

describe("settings", () => {
  it("emptySettings returns fresh blank settings", () => {
    const a = emptySettings();
    expect(a).toEqual({ shopName: "", shopTpclNumber: "", shopTpclLetter: "" });
    a.shopName = "x";
    expect(emptySettings().shopName).toBe("");
  });

  it("loadSettings falls back to empty for missing, corrupt, wrong shape or unreadable", () => {
    expect(loadSettings()).toEqual(emptySettings());
    storage.setItem(SETTINGS_KEY, "{");
    expect(loadSettings()).toEqual(emptySettings());
    put(SETTINGS_KEY, { shopName: "A" });
    expect(loadSettings()).toEqual(emptySettings());
    put(SETTINGS_KEY, [SETTINGS]);
    expect(loadSettings()).toEqual(emptySettings());
    storage.failGet = true;
    expect(loadSettings()).toEqual(emptySettings());
  });

  it("round-trips and trims settings", () => {
    expect(saveSettings({ shopName: "  Acme Pest ", shopTpclNumber: " 12345", shopTpclLetter: "B " })).toBe(true);
    expect(loadSettings()).toEqual(SETTINGS);
  });

  it("drops extra keys", () => {
    put(SETTINGS_KEY, { ...SETTINGS, secret: "x" });
    expect(loadSettings()).toEqual(SETTINGS);
  });

  it("saveSettings returns false on quota errors", () => {
    storage.failSet = true;
    expect(saveSettings(SETTINGS)).toBe(false);
  });
});

describe("dismissible tips", () => {
  it("A2HS tip: not dismissed by default, dismiss persists '1'", () => {
    expect(loadA2hsTipDismissed()).toBe(false);
    expect(dismissA2hsTip()).toBe(true);
    expect(storage.getItem(A2HS_TIP_KEY)).toBe("1");
    expect(loadA2hsTipDismissed()).toBe(true);
  });

  it("pilot card: not dismissed by default, dismiss persists '1'", () => {
    expect(loadPilotCardDismissed()).toBe(false);
    expect(dismissPilotCard()).toBe(true);
    expect(storage.getItem(PILOT_CARD_KEY)).toBe("1");
    expect(loadPilotCardDismissed()).toBe(true);
  });

  it("only the exact '1' counts as dismissed", () => {
    storage.setItem(A2HS_TIP_KEY, "true");
    storage.setItem(PILOT_CARD_KEY, "0");
    expect(loadA2hsTipDismissed()).toBe(false);
    expect(loadPilotCardDismissed()).toBe(false);
  });

  it("read failures report not dismissed; write failures return false", () => {
    storage.setItem(A2HS_TIP_KEY, "1");
    storage.failGet = true;
    expect(loadA2hsTipDismissed()).toBe(false);
    expect(loadPilotCardDismissed()).toBe(false);
    storage.failGet = false;
    storage.failSet = true;
    expect(dismissA2hsTip()).toBe(false);
    expect(dismissPilotCard()).toBe(false);
  });
});

describe("markLastBackupNow / loadLastBackupAt", () => {
  it("defaults to never", () => {
    expect(loadLastBackupAt()).toBeNull();
  });

  it("stores {at: iso} using now by default or a passed date", () => {
    expect(markLastBackupNow()).toBe(true);
    expect(stored(LAST_BACKUP_KEY)).toEqual({ at: NOW.toISOString() });
    expect(loadLastBackupAt()).toBe(NOW.toISOString());
    const d = new Date("2026-01-02T03:04:05.000Z");
    markLastBackupNow(d);
    expect(loadLastBackupAt()).toBe(d.toISOString());
  });

  it("also reads the legacy plain-string format, trimmed", () => {
    put(LAST_BACKUP_KEY, " 2026-09-01T00:00:00.000Z ");
    expect(loadLastBackupAt()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("ignores invalid dates, wrong shapes, corrupt JSON and read errors", () => {
    for (const v of ["not a date", "", { at: "nope" }, { at: 5 }, { when: NOW.toISOString() }, [NOW.toISOString()], 123, null]) {
      put(LAST_BACKUP_KEY, v);
      expect(loadLastBackupAt(), JSON.stringify(v)).toBeNull();
    }
    storage.setItem(LAST_BACKUP_KEY, "{oops");
    expect(loadLastBackupAt()).toBeNull();
    markLastBackupNow();
    storage.failGet = true;
    expect(loadLastBackupAt()).toBeNull();
  });

  it("markLastBackupNow returns false on quota errors", () => {
    storage.failSet = true;
    expect(markLastBackupNow()).toBe(false);
  });
});

describe("formatLastBackupLabel", () => {
  it("handles never and invalid stamps", () => {
    expect(formatLastBackupLabel(null)).toBe("Last backup: never");
    expect(formatLastBackupLabel("")).toBe("Last backup: never");
    expect(formatLastBackupLabel("garbage")).toBe("Last backup: unknown");
  });

  it("formats a valid stamp in device-local time (medium date, short time)", () => {
    const iso = "2026-09-05T20:45:00.000Z"; // 3:45 PM CDT
    const expected = new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const label = formatLastBackupLabel(iso);
    expect(label).toBe(`Last backup: ${expected}`);
    expect(label).toContain("2026");
    expect(label).toMatch(/3:45/);
  });
});

describe("backupNagMessage", () => {
  it("nags when never backed up", () => {
    expect(backupNagMessage(null)).toBe(
      "No backup on this device yet. Download a backup JSON when you can — soft reminder only, not blocking.",
    );
  });

  it("nags on an invalid stamp", () => {
    expect(backupNagMessage("nope")).toBe(
      "Backup stamp looks invalid. Download a fresh backup when you can — soft reminder only.",
    );
  });

  it("is quiet up to exactly BACKUP_NAG_DAYS, nags after", () => {
    expect(BACKUP_NAG_DAYS).toBe(7);
    const day = 86_400_000;
    expect(backupNagMessage(new Date(NOW.getTime() - day).toISOString())).toBeNull();
    expect(backupNagMessage(new Date(NOW.getTime() - 7 * day).toISOString())).toBeNull();
    expect(backupNagMessage(new Date(NOW.getTime() - 7 * day - 1).toISOString())).toBe(
      "Last backup was more than 7 days ago. Consider downloading a fresh backup — soft reminder only, not blocking.",
    );
  });

  it("uses the passed now", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    expect(backupNagMessage(iso, new Date("2026-01-02T00:00:00.000Z"))).toBeNull();
    expect(backupNagMessage(iso, new Date("2026-02-01T00:00:00.000Z"))).not.toBeNull();
  });

  it("does not nag for a future stamp (clock skew)", () => {
    expect(backupNagMessage(new Date(NOW.getTime() + 86_400_000).toISOString())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

describe("wipeAllDeviceData", () => {
  function seedDevice() {
    saveLogs([makeLog("L1")]);
    saveCatalog([shopProduct()]);
    savePeople([person()]);
    saveSettings(SETTINGS);
    markLastBackupNow();
    dismissA2hsTip();
    dismissPilotCard();
  }

  it("clears every app key, re-seeds examples, and reports the fresh state", () => {
    seedDevice();
    const res = wipeAllDeviceData();
    expect(res).toEqual({
      saved: true,
      catalog: EXAMPLE_SEEDS,
      logs: [],
      people: [],
      settings: emptySettings(),
      lastBackupAt: null,
    });
    expect(loadLogs()).toEqual([]);
    expect(loadCatalog()).toEqual(EXAMPLE_SEEDS);
    expect(loadPeople()).toEqual([]);
    expect(loadSettings()).toEqual(emptySettings());
    expect(loadLastBackupAt()).toBeNull();
    expect(loadA2hsTipDismissed()).toBe(false);
    expect(loadPilotCardDismissed()).toBe(false);
  });

  it("leaves unrelated keys (e.g. the shop session) alone", () => {
    seedDevice();
    storage.setItem(SHOP_SESSION_KEY, '{"shopId":"X"}');
    storage.setItem("other-app", "keep");
    wipeAllDeviceData();
    expect(storage.getItem(SHOP_SESSION_KEY)).toBe('{"shopId":"X"}');
    expect(storage.getItem("other-app")).toBe("keep");
  });

  it("returns current data with saved:false when the snapshot read fails", () => {
    seedDevice();
    storage.failGet = true;
    const res = wipeAllDeviceData();
    expect(res.saved).toBe(false);
    storage.failGet = false;
    expect(ids(loadLogs())).toEqual(["L1"]);
  });

  for (const key of [CATALOG_KEY, LOGS_KEY, PEOPLE_KEY, SETTINGS_KEY]) {
    it(`rolls back everything when writing ${key.split(":")[1]} fails`, () => {
      seedDevice();
      const before = new Map(storage.map);
      storage.failOnceKeys.add(key);
      const res = wipeAllDeviceData();
      expect(res.saved).toBe(false);
      expect(storage.map).toEqual(before);
      expect(ids(res.logs)).toEqual(["L1"]);
      expect(res.catalog).toEqual([shopProduct()]);
      expect(res.people).toEqual([person()]);
      expect(res.settings).toEqual(SETTINGS);
      expect(res.lastBackupAt).toBe(NOW.toISOString());
    });
  }

  it("rolls back when removing a flag key throws", () => {
    seedDevice();
    const before = new Map(storage.map);
    storage.failRemove = true;
    const res = wipeAllDeviceData();
    expect(res.saved).toBe(false);
    expect(storage.map).toEqual(before);
  });

  it("rollback removes keys that did not exist before", () => {
    storage.failOnceKeys.add(SETTINGS_KEY);
    const res = wipeAllDeviceData();
    expect(res.saved).toBe(false);
    // Only the catalog is left: the returned state is re-read with loadCatalog(), which
    // seeds examples on an empty device (same as a first launch).
    expect([...storage.map.keys()]).toEqual([CATALOG_KEY]);
    expect(res.catalog).toEqual(EXAMPLE_SEEDS);
    expect(res.logs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backup build / parse / apply / download
// ---------------------------------------------------------------------------

describe("buildBackup", () => {
  it("captures the four sections, version and exportedAt=now", () => {
    saveLogs([makeLog("L1")]);
    saveCatalog([shopProduct()]);
    savePeople([person()]);
    saveSettings(SETTINGS);
    markLastBackupNow();
    expect(buildBackup()).toEqual({
      version: BACKUP_VERSION,
      exportedAt: NOW.toISOString(),
      logs: [makeLog("L1")],
      catalog: [shopProduct()],
      people: [person()],
      settings: SETTINGS,
    });
  });

  it("on an empty device includes seeded examples and empty sections", () => {
    const b = buildBackup();
    expect(b.catalog).toEqual(EXAMPLE_SEEDS);
    expect(b.logs).toEqual([]);
    expect(b.people).toEqual([]);
    expect(b.settings).toEqual(emptySettings());
  });
});

describe("parseShopSections", () => {
  const good = { logs: [makeLog("L1")], catalog: [shopProduct()], people: [person()], settings: SETTINGS };

  it("accepts valid sections and normalizes them", () => {
    const res = parseShopSections({ ...good, settings: { ...SETTINGS, shopName: " Acme Pest " } });
    expect(res).toEqual({ ok: true, sections: good });
  });

  it("accepts empty arrays", () => {
    expect(parseShopSections({ logs: [], catalog: [], people: [], settings: emptySettings() })).toEqual({
      ok: true,
      sections: { logs: [], catalog: [], people: [], settings: emptySettings() },
    });
  });

  it("rejects non-array sections and non-object settings with specific errors", () => {
    expect(parseShopSections({ ...good, logs: {} })).toEqual({ ok: false, error: "Shop logs must be an array." });
    expect(parseShopSections({ ...good, catalog: null })).toEqual({
      ok: false,
      error: "Shop catalog must be an array.",
    });
    expect(parseShopSections({ ...good, people: "x" })).toEqual({
      ok: false,
      error: "Shop people must be an array.",
    });
    expect(parseShopSections({ ...good, settings: [] })).toEqual({
      ok: false,
      error: "Shop settings must be an object.",
    });
  });

  it("rejects (does not drop) any invalid row", () => {
    expect(parseShopSections({ ...good, logs: [makeLog("L1"), { id: "x" }] })).toEqual({
      ok: false,
      error: "Shop contains invalid application log(s).",
    });
    expect(parseShopSections({ ...good, catalog: [{ id: "x" }] })).toEqual({
      ok: false,
      error: "Shop contains invalid catalog product(s).",
    });
    expect(parseShopSections({ ...good, people: [{ id: "x" }] })).toEqual({
      ok: false,
      error: "Shop contains invalid people row(s).",
    });
    expect(parseShopSections({ ...good, settings: { shopName: "x" } })).toEqual({
      ok: false,
      error: "Shop settings are invalid.",
    });
  });

  it("checks sections in order logs → catalog → people → settings", () => {
    expect(parseShopSections({ logs: 1, catalog: 1, people: 1, settings: 1 })).toEqual({
      ok: false,
      error: "Shop logs must be an array.",
    });
  });
});

describe("parseBackup", () => {
  it("accepts a valid backup and returns normalized contents", () => {
    const res = parseBackup(validBackup());
    expect(res).toEqual({
      ok: true,
      backup: {
        version: BACKUP_VERSION,
        exportedAt: "2026-09-25T12:00:00.000Z",
        logs: [makeLog("L1")],
        catalog: [shopProduct()],
        people: [person()],
        settings: SETTINGS,
      },
    });
  });

  it("round-trips JSON produced by buildBackup", () => {
    saveLogs([makeLog("L1")]);
    savePeople([person()]);
    const json = JSON.stringify(buildBackup(), null, 2);
    const res = parseBackup(JSON.parse(json));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.backup).toEqual(buildBackup());
  });

  it("trims version and exportedAt and ignores meta / unknown keys", () => {
    const res = parseBackup(
      validBackup({ version: ` ${BACKUP_VERSION} `, exportedAt: " 2026-09-25T12:00:00.000Z ", meta: { a: 1 }, x: 2 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backup.version).toBe(BACKUP_VERSION);
    expect(res.backup.exportedAt).toBe("2026-09-25T12:00:00.000Z");
    expect(res.backup.meta).toBeUndefined();
    expect(Object.keys(res.backup).sort()).toEqual(
      ["catalog", "exportedAt", "logs", "people", "settings", "version"].sort(),
    );
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, "x", 1, [], [validBackup()]]) {
      expect(parseBackup(v)).toEqual({ ok: false, error: "Backup must be a JSON object." });
    }
  });

  it("rejects missing or unsupported versions", () => {
    expect(parseBackup(validBackup({ version: undefined }))).toEqual({
      ok: false,
      error: "Backup is missing a version stamp.",
    });
    expect(parseBackup(validBackup({ version: "  " }))).toEqual({
      ok: false,
      error: "Backup is missing a version stamp.",
    });
    expect(parseBackup(validBackup({ version: 1.2 }))).toEqual({
      ok: false,
      error: "Backup is missing a version stamp.",
    });
    expect(parseBackup(validBackup({ version: "1.1" }))).toEqual({
      ok: false,
      error: `Unsupported backup version "1.1". This app expects ${BACKUP_VERSION}.`,
    });
  });

  it("rejects missing or invalid exportedAt", () => {
    expect(parseBackup(validBackup({ exportedAt: undefined }))).toEqual({
      ok: false,
      error: "Backup is missing exportedAt.",
    });
    expect(parseBackup(validBackup({ exportedAt: " " }))).toEqual({
      ok: false,
      error: "Backup is missing exportedAt.",
    });
    expect(parseBackup(validBackup({ exportedAt: "yesterday" }))).toEqual({
      ok: false,
      error: "Backup exportedAt is not a valid date.",
    });
  });

  it("maps section errors to backup-flavored wording", () => {
    expect(parseBackup(validBackup({ logs: undefined }))).toEqual({
      ok: false,
      error: "Backup logs must be an array.",
    });
    expect(parseBackup(validBackup({ catalog: {} }))).toEqual({
      ok: false,
      error: "Backup catalog must be an array.",
    });
    expect(parseBackup(validBackup({ people: null }))).toEqual({
      ok: false,
      error: "Backup people must be an array.",
    });
    expect(parseBackup(validBackup({ settings: "x" }))).toEqual({
      ok: false,
      error: "Backup settings must be an object.",
    });
    expect(parseBackup(validBackup({ logs: [{ id: "bad" }] }))).toEqual({
      ok: false,
      error: "Backup contains invalid application log(s).",
    });
    expect(parseBackup(validBackup({ catalog: [{}] }))).toEqual({
      ok: false,
      error: "Backup contains invalid catalog product(s).",
    });
    expect(parseBackup(validBackup({ people: [{}] }))).toEqual({
      ok: false,
      error: "Backup contains invalid people row(s).",
    });
    expect(parseBackup(validBackup({ settings: {} }))).toEqual({
      ok: false,
      error: "Backup settings are invalid.",
    });
  });

  it("does not write storage", () => {
    parseBackup(validBackup());
    expect(storage.map.size).toBe(0);
  });
});

describe("applyBackup", () => {
  function backup(overrides: Partial<DeviceBackup> = {}): DeviceBackup {
    return {
      version: BACKUP_VERSION,
      exportedAt: "2026-09-25T12:00:00.000Z",
      logs: [makeLog("NEW")],
      catalog: [shopProduct({ id: "new-prod" })],
      people: [person({ id: "new-p" })],
      settings: SETTINGS,
      ...overrides,
    };
  }

  it("replaces all four sections", () => {
    saveLogs([makeLog("OLD")]);
    saveCatalog([shopProduct({ id: "old-prod" })]);
    savePeople([person({ id: "old-p" })]);
    expect(applyBackup(backup())).toBe(true);
    expect(ids(loadLogs())).toEqual(["NEW"]);
    expect(ids(loadCatalog())).toEqual(["new-prod"]);
    expect(ids(loadPeople())).toEqual(["new-p"]);
    expect(loadSettings()).toEqual(SETTINGS);
  });

  it("does not touch the backup stamp, dismissed flags or session", () => {
    markLastBackupNow();
    dismissPilotCard();
    storage.setItem(SHOP_SESSION_KEY, "s");
    applyBackup(backup());
    expect(loadLastBackupAt()).toBe(NOW.toISOString());
    expect(loadPilotCardDismissed()).toBe(true);
    expect(storage.getItem(SHOP_SESSION_KEY)).toBe("s");
  });

  it("parse → apply → load restores a device", () => {
    const parsed = parseBackup(JSON.parse(JSON.stringify(validBackup())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(applyBackup(parsed.backup)).toBe(true);
    expect(loadLogs()).toEqual([makeLog("L1")]);
    expect(loadCatalog()).toEqual([shopProduct()]);
    expect(loadPeople()).toEqual([person()]);
    expect(loadSettings()).toEqual(SETTINGS);
  });

  it("rejects an unsupported version without writing", () => {
    expect(applyBackup(backup({ version: "0.9" }))).toBe(false);
    expect(storage.map.size).toBe(0);
    expect(applyBackup(backup({ version: ` ${BACKUP_VERSION} ` }))).toBe(true);
  });

  it("returns false without writing when the snapshot read fails", () => {
    storage.failGet = true;
    expect(applyBackup(backup())).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  for (const key of [LOGS_KEY, CATALOG_KEY, PEOPLE_KEY, SETTINGS_KEY]) {
    it(`rolls back all sections when writing ${key.split(":")[1]} fails`, () => {
      saveLogs([makeLog("OLD")]);
      saveCatalog([shopProduct({ id: "old-prod" })]);
      const before = new Map(storage.map);
      storage.failOnceKeys.add(key);
      expect(applyBackup(backup())).toBe(false);
      expect(storage.map).toEqual(before);
    });
  }

  it("returns false even when the rollback also fails", () => {
    saveLogs([makeLog("OLD")]);
    storage.failSet = true;
    expect(applyBackup(backup())).toBe(false);
  });
});

describe("downloadBackup", () => {
  type FakeAnchor = {
    href: string;
    download: string;
    rel: string;
    style: { display: string };
    click: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let anchor: FakeAnchor;
  let blobs: Blob[];
  let appendChild: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let setTimeoutSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    anchor = { href: "", download: "", rel: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
    blobs = [];
    appendChild = vi.fn();
    revokeObjectURL = vi.fn();
    setTimeoutSpy = vi.fn((fn: () => void) => {
      fn();
      return 0;
    });
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild } });
    vi.stubGlobal("window", { setTimeout: setTimeoutSpy });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((b: Blob) => {
        blobs.push(b);
        return "blob:fake";
      }),
      revokeObjectURL,
    });
  });

  async function downloadedJson(): Promise<Record<string, unknown>> {
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("application/json;charset=utf-8");
    return JSON.parse(await blobs[0].text()) as Record<string, unknown>;
  }

  it("downloads this device's backup, clicks a hidden anchor and stamps lastBackupAt", async () => {
    saveLogs([makeLog("L1")]);
    downloadBackup();
    const json = await downloadedJson();
    expect(json).toEqual(JSON.parse(JSON.stringify(buildBackup())));
    expect(anchor.href).toBe("blob:fake");
    expect(anchor.rel).toBe("noopener");
    expect(anchor.style.display).toBe("none");
    expect(anchor.download).toBe("jobber-pest-logger-backup-2026-09-26.json");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    expect(loadLastBackupAt()).toBe(NOW.toISOString());
  });

  it("names the default file with the UTC date of exportedAt (evening CT shows tomorrow)", () => {
    vi.setSystemTime(new Date("2026-09-27T01:30:00.000Z")); // Sat Sep 26, 8:30 PM CDT
    downloadBackup();
    expect(anchor.download).toBe("jobber-pest-logger-backup-2026-09-27.json");
  });

  it("pretty-prints the JSON with 2-space indentation", async () => {
    downloadBackup();
    const text = await blobs[0].text();
    expect(text).toBe(JSON.stringify(buildBackup(), null, 2));
  });

  it("uses provided sections instead of local storage", async () => {
    saveLogs([makeLog("LOCAL")]);
    const sections: ShopSections = {
      logs: [makeLog("SHARED")],
      catalog: [shopProduct({ id: "shared" })],
      people: [],
      settings: SETTINGS,
    };
    downloadBackup(sections);
    const json = await downloadedJson();
    expect(json.version).toBe(BACKUP_VERSION);
    expect(json.exportedAt).toBe(NOW.toISOString());
    expect((json.logs as ApplicationLog[]).map((l) => l.id)).toEqual(["SHARED"]);
    expect(json.catalog).toEqual([shopProduct({ id: "shared" })]);
    expect(json.meta).toBeUndefined();
  });

  it("adds provenance meta and uses the provided file suffix", async () => {
    downloadBackup(undefined, { fileSuffix: "local-generated-2026-09-26", provenance: { source: "local" } });
    const json = await downloadedJson();
    expect(json.meta).toEqual({ source: "local" });
    expect(anchor.download).toBe("jobber-pest-logger-backup-local-generated-2026-09-26.json");
  });

  it("downloaded JSON parses back with parseBackup (meta ignored)", async () => {
    saveLogs([makeLog("L1")]);
    savePeople([person()]);
    downloadBackup(undefined, { fileSuffix: "x", provenance: { a: 1 } });
    const res = parseBackup(await downloadedJson());
    expect(res.ok).toBe(true);
  });

  it("still returns (no throw) when the stamp write fails", () => {
    storage.failSetKeys.add(LAST_BACKUP_KEY);
    expect(() => downloadBackup()).not.toThrow();
    expect(anchor.click).toHaveBeenCalled();
    expect(loadLastBackupAt()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

describe("getFirstRunSteps / firstRunIncomplete", () => {
  const fresh = { settings: emptySettings(), people: [], catalog: [...EXAMPLE_SEEDS], lastBackupAt: null };

  it("a fresh device has all four steps pending", () => {
    const steps = getFirstRunSteps(fresh);
    expect(steps).toEqual([
      { id: "shop", label: "Set shop name / TPCL", done: false, screen: "settings" },
      { id: "people", label: "Add people to the roster", done: false, screen: "people" },
      { id: "products", label: "Add real (non-example) products", done: false, screen: "products" },
      { id: "backup", label: "Download a backup", done: false, screen: "settings" },
    ]);
    expect(firstRunIncomplete(steps)).toBe(true);
  });

  it("shop is done with a name or a TPCL number (whitespace does not count)", () => {
    const done = (s: ShopSettings) => getFirstRunSteps({ ...fresh, settings: s })[0].done;
    expect(done({ ...emptySettings(), shopName: "Acme" })).toBe(true);
    expect(done({ ...emptySettings(), shopTpclNumber: "123" })).toBe(true);
    expect(done({ ...emptySettings(), shopName: "  ", shopTpclNumber: " " })).toBe(false);
    expect(done({ ...emptySettings(), shopTpclLetter: "B" })).toBe(false);
  });

  it("people, products and backup steps", () => {
    const steps = getFirstRunSteps({
      settings: SETTINGS,
      people: [person()],
      catalog: [...EXAMPLE_SEEDS, shopProduct()],
      lastBackupAt: NOW.toISOString(),
    });
    expect(steps.map((s) => s.done)).toEqual([true, true, true, true]);
    expect(firstRunIncomplete(steps)).toBe(false);
    expect(getFirstRunSteps({ ...fresh, catalog: [shopProduct({ epaRegNo: "SAMPLE-1" })] })[2].done).toBe(false);
    expect(getFirstRunSteps({ ...fresh, catalog: [] })[2].done).toBe(false);
    expect(getFirstRunSteps({ ...fresh, lastBackupAt: "  " })[3].done).toBe(false);
  });

  it("firstRunIncomplete is false for an empty list", () => {
    expect(firstRunIncomplete([])).toBe(false);
  });
});
