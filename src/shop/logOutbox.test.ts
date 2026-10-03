import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationLog } from "../types";
import {
  enqueueLogOutbox,
  flushLogOutbox,
  loadLogOutbox,
  LOG_OUTBOX_KEY,
  OUTBOX_LOCK_NAME,
  OUTBOX_LOCK_WAIT_MS,
  outboxEntriesForShop,
  removeOutboxLogIds,
  removeOutboxVersions,
  syncLogToRemote,
  type LogOutboxEntry,
} from "./logOutbox";
import type { RemoteShopStore } from "./RemoteShopStore";
import { SHOP_SESSION_KEY } from "./session";
import type { ShopDocument, ShopStoreResult } from "./types";

// Scope: queue / merge / dedupe / ordering / retry / state-transition logic only.
// - No real Firestore, network, or IndexedDB: `RemoteShopStore` is a type-only
//   import in logOutbox.ts, and every test passes a hand-written in-memory fake.
// - localStorage (the outbox's persistence) is replaced by an in-memory Map so
//   the queue logic can be exercised deterministically in the node environment.

// ---------------------------------------------------------------------------
// In-memory localStorage
// ---------------------------------------------------------------------------

class MemoryStorage {
  map = new Map<string, string>();
  failSet = false;
  failGet = false;
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
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let storage: MemoryStorage;
const NOW = new Date("2026-09-27T00:05:00.000Z");
const SHOP = "SHOPABCD";
const OTHER = "OTHERSHP";

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  signIn(SHOP);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function signIn(shopId: string) {
  storage.setItem(
    SHOP_SESSION_KEY,
    JSON.stringify({ shopId, role: "tech", verifiedAt: NOW.toISOString(), lastActiveAt: NOW.toISOString() }),
  );
}

function rawOutbox(): unknown[] {
  return JSON.parse(storage.getItem(LOG_OUTBOX_KEY) ?? "[]") as unknown[];
}

function writeRaw(value: unknown) {
  storage.setItem(LOG_OUTBOX_KEY, typeof value === "string" ? value : JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLog(id: string, overrides: Partial<ApplicationLog> = {}): ApplicationLog {
  return {
    id,
    createdAt: "2026-09-26T12:00:00.000Z",
    sampleData: false,
    jobberJobNumber: "J-1",
    jobberAddress: "2 Oak Ave, Austin TX",
    customerBillingName: "Jane Doe",
    customerBillingAddress: "1 Main St",
    serviceAddress: `${id} Oak Ave`,
    poleLocation: "",
    products: [
      {
        lineId: `${id}-line`,
        catalogId: "prod-1",
        name: "Real Pesticide",
        epaRegNo: "1234-56",
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
      },
    ],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-26",
    personnel: [
      { role: "applying", name: "Alice", licenseNumber: "A-1" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ],
    shopTpclNumber: "12345",
    shopTpclLetter: "B",
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

function shopDoc(logs: ApplicationLog[] = []): ShopDocument {
  return {
    version: "1",
    updatedAt: "2026-09-26T00:00:00.000Z",
    logs,
    catalog: [],
    people: [],
    settings: { shopName: "Acme", shopTpclNumber: "12345", shopTpclLetter: "B" },
    ownerUid: "owner-uid",
  };
}

type GetResult = ShopStoreResult<ShopDocument>;
type PutResult = ShopStoreResult<{ updatedAt: string }>;

/**
 * In-memory stand-in for RemoteShopStore. `gets`/`puts` are scripted results
 * (consumed in order; the last one repeats); hooks run inside the await to
 * simulate concurrent local saves.
 */
function fakeRemote(opts: {
  doc?: ShopDocument;
  gets?: GetResult[];
  puts?: PutResult[];
  onGet?: (n: number) => void;
  onPut?: (n: number, doc: ShopDocument) => void;
} = {}) {
  let doc = opts.doc ?? shopDoc();
  const putDocs: ShopDocument[] = [];
  let g = 0;
  let p = 0;
  const getShop = vi.fn(async (): Promise<GetResult> => {
    const n = g++;
    await opts.onGet?.(n);
    const scripted = opts.gets?.[Math.min(n, (opts.gets?.length ?? 1) - 1)];
    if (scripted) return scripted.ok ? { ok: true, value: structuredClone(scripted.value) } : scripted;
    return { ok: true, value: structuredClone(doc) };
  });
  const putShop = vi.fn(async (next: ShopDocument): Promise<PutResult> => {
    const n = p++;
    putDocs.push(structuredClone(next));
    await opts.onPut?.(n, next);
    const scripted = opts.puts?.[Math.min(n, (opts.puts?.length ?? 1) - 1)];
    if (scripted && !scripted.ok) return scripted;
    doc = structuredClone(next);
    return { ok: true, value: { updatedAt: NOW.toISOString() } };
  });
  const remote = { mode: "shared", getShop, putShop } as unknown as RemoteShopStore;
  return { remote, getShop, putShop, putDocs, current: () => doc };
}

const conflict: PutResult = { ok: false, error: "Shop changed on another device", conflict: true };

// ---------------------------------------------------------------------------
// loadLogOutbox (deserialization / validation)
// ---------------------------------------------------------------------------

describe("loadLogOutbox", () => {
  it("returns [] when nothing is stored", () => {
    expect(loadLogOutbox()).toEqual([]);
  });

  it("returns [] for corrupt JSON, non-arrays, or a throwing storage", () => {
    writeRaw("{not json");
    expect(loadLogOutbox()).toEqual([]);
    writeRaw({ shopId: SHOP });
    expect(loadLogOutbox()).toEqual([]);
    writeRaw("null");
    expect(loadLogOutbox()).toEqual([]);
    storage.failGet = true;
    expect(loadLogOutbox()).toEqual([]);
  });

  it("drops invalid rows but keeps valid ones", () => {
    const good = { shopId: SHOP, queuedAt: NOW.toISOString(), entryId: "e1", log: makeLog("a") };
    writeRaw([
      null,
      42,
      "row",
      [good],
      { ...good, shopId: undefined },
      { ...good, shopId: "   " },
      { ...good, queuedAt: 5 },
      { ...good, queuedAt: " " },
      { ...good, log: { id: "x" } },
      { ...good, log: { ...makeLog("b"), products: [{ lineId: "bad" }] } },
      good,
    ]);
    const out = loadLogOutbox();
    expect(out).toHaveLength(1);
    expect(out[0].entryId).toBe("e1");
  });

  it("trims shopId, queuedAt, entryId and lastError, and drops a blank lastError", () => {
    writeRaw([
      { shopId: `  ${SHOP} `, queuedAt: ` ${NOW.toISOString()} `, entryId: " e1 ", lastError: "  offline ", log: makeLog("a") },
      { shopId: SHOP, queuedAt: NOW.toISOString(), entryId: "e2", lastError: "   ", log: makeLog("b") },
      { shopId: SHOP, queuedAt: NOW.toISOString(), entryId: "e3", lastError: 7, log: makeLog("c") },
    ]);
    const [a, b, c] = loadLogOutbox();
    expect(a).toMatchObject({ shopId: SHOP, queuedAt: NOW.toISOString(), entryId: "e1", lastError: "offline" });
    expect(b).not.toHaveProperty("lastError");
    expect(c).not.toHaveProperty("lastError");
  });

  it("derives a legacy entryId from queuedAt when entryId is missing or blank", () => {
    writeRaw([
      { shopId: SHOP, queuedAt: "2026-01-01T00:00:00.000Z", log: makeLog("a") },
      { shopId: SHOP, queuedAt: "2026-01-02T00:00:00.000Z", entryId: "  ", log: makeLog("b") },
      { shopId: SHOP, queuedAt: "2026-01-03T00:00:00.000Z", entryId: 99, log: makeLog("c") },
    ]);
    expect(loadLogOutbox().map((e) => e.entryId)).toEqual([
      "legacy:2026-01-01T00:00:00.000Z",
      "legacy:2026-01-02T00:00:00.000Z",
      "legacy:2026-01-03T00:00:00.000Z",
    ]);
  });

  it("keeps the full application log payload (all § 7.144 fields)", () => {
    const log = makeLog("a", {
      isTermite: true,
      termite: { ...makeLog("a").termite, areaTreatedSqFt: "1500", isCommercialPretreat: true, tankCount: "2" },
      poleLocation: "Pole 7",
    });
    writeRaw([{ shopId: SHOP, queuedAt: NOW.toISOString(), entryId: "e1", log }]);
    expect(loadLogOutbox()[0].log).toEqual(log);
  });

  it("normalizes the log like the rest of the app (example products never keep an EPA #)", () => {
    const log = makeLog("a");
    log.products[0] = { ...log.products[0], catalogId: "example-rtu-insecticide", isExample: false };
    writeRaw([{ shopId: SHOP, queuedAt: NOW.toISOString(), entryId: "e1", log }]);
    const loaded = loadLogOutbox()[0].log;
    expect(loaded.products[0].isExample).toBe(true);
    expect(loaded.products[0].epaRegNo).toBeNull();
    expect(loaded.sampleData).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enqueueLogOutbox (queue / dedupe / ordering / serialization)
// ---------------------------------------------------------------------------

describe("enqueueLogOutbox", async () => {
  it("rejects a blank shop id or a log without id, writing nothing", async () => {
    expect(await enqueueLogOutbox("", makeLog("a"))).toBe(false);
    expect(await enqueueLogOutbox("   ", makeLog("a"))).toBe(false);
    expect(await enqueueLogOutbox(SHOP, makeLog(""))).toBe(false);
    expect(storage.getItem(LOG_OUTBOX_KEY)).toBeNull();
  });

  it("stores a trimmed shop id, the current time, a unique entry id, and the full log", async () => {
    const log = makeLog("a");
    expect(await enqueueLogOutbox(`  ${SHOP}  `, log)).toBe(true);
    const [entry] = loadLogOutbox();
    expect(entry.shopId).toBe(SHOP);
    expect(entry.queuedAt).toBe(NOW.toISOString());
    expect(entry.entryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.log).toEqual(log);
    expect(entry).not.toHaveProperty("lastError");
  });

  it("serializes to JSON under LOG_OUTBOX_KEY and round-trips losslessly", async () => {
    const log = makeLog("a");
    await enqueueLogOutbox(SHOP, log, "offline");
    const raw = rawOutbox() as LogOutboxEntry[];
    expect(raw).toHaveLength(1);
    expect(raw[0].log).toEqual(log);
    expect(raw[0].lastError).toBe("offline");
    expect(loadLogOutbox()).toEqual(raw);
  });

  it("puts the newest entry first", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    expect(loadLogOutbox().map((e) => e.log.id)).toEqual(["b", "a"]);
  });

  it("upserts by shop + log id: latest payload wins, gets a new entry id and moves to the front", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v1" }));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    const firstId = outboxEntriesForShop(SHOP).find((e) => e.log.id === "a")!.entryId;
    vi.setSystemTime(new Date(NOW.getTime() + 5000));
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" }));
    const entries = loadLogOutbox();
    expect(entries.map((e) => e.log.id)).toEqual(["a", "b"]);
    expect(entries[0].log.targetPestOrPurpose).toBe("v2");
    expect(entries[0].entryId).not.toBe(firstId);
    expect(entries[0].queuedAt).toBe(new Date(NOW.getTime() + 5000).toISOString());
  });

  it("keeps the same log id queued separately per shop", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(OTHER, makeLog("a"));
    expect(loadLogOutbox().map((e) => e.shopId)).toEqual([OTHER, SHOP]);
  });

  it("dedupes against a stored entry whose shop id had whitespace", async () => {
    writeRaw([{ shopId: ` ${SHOP} `, queuedAt: NOW.toISOString(), entryId: "old", log: makeLog("a") }]);
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const entries = loadLogOutbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].entryId).not.toBe("old");
  });

  it("records a trimmed lastError, ignores a blank one, and a re-queue without error clears it", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"), "  offline  ");
    expect(loadLogOutbox()[0].lastError).toBe("offline");
    await enqueueLogOutbox(SHOP, makeLog("a"), "   ");
    expect(loadLogOutbox()[0]).not.toHaveProperty("lastError");
  });

  it("returns false and leaves the previous queue when storage is full", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    storage.failSet = true;
    expect(await enqueueLogOutbox(SHOP, makeLog("b"))).toBe(false);
    expect(loadLogOutbox().map((e) => e.log.id)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// outboxEntriesForShop / removeOutboxVersions / removeOutboxLogIds
// ---------------------------------------------------------------------------

describe("outboxEntriesForShop", () => {
  it("returns only the given shop's entries (trimmed id), newest first", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(OTHER, makeLog("x"));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    expect(outboxEntriesForShop(` ${SHOP} `).map((e) => e.log.id)).toEqual(["b", "a"]);
    expect(outboxEntriesForShop(OTHER).map((e) => e.log.id)).toEqual(["x"]);
    expect(outboxEntriesForShop("NOPE")).toEqual([]);
  });
});

describe("removeOutboxVersions", () => {
  it("removes only the exact entry ids for that shop", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    await enqueueLogOutbox(OTHER, makeLog("a"));
    const aId = outboxEntriesForShop(SHOP).find((e) => e.log.id === "a")!.entryId;
    const otherId = outboxEntriesForShop(OTHER)[0].entryId;
    expect(await removeOutboxVersions(` ${SHOP} `, [aId, otherId])).toBe(true);
    expect(outboxEntriesForShop(SHOP).map((e) => e.log.id)).toEqual(["b"]);
    // Other shop's entry is untouched even though its id was passed.
    expect(outboxEntriesForShop(OTHER)).toHaveLength(1);
  });

  it("preserves a newer re-queue of the same log", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v1" }));
    const oldId = outboxEntriesForShop(SHOP)[0].entryId;
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" }));
    await removeOutboxVersions(SHOP, [oldId]);
    const entries = outboxEntriesForShop(SHOP);
    expect(entries).toHaveLength(1);
    expect(entries[0].log.targetPestOrPurpose).toBe("v2");
  });

  it("ignores empty ids and unknown ids", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    expect(await removeOutboxVersions(SHOP, ["", "nope"])).toBe(true);
    expect(outboxEntriesForShop(SHOP)).toHaveLength(1);
  });

  it("returns false when the write fails", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const id = outboxEntriesForShop(SHOP)[0].entryId;
    storage.failSet = true;
    expect(await removeOutboxVersions(SHOP, [id])).toBe(false);
    expect(outboxEntriesForShop(SHOP)).toHaveLength(1);
  });
});

describe("removeOutboxLogIds (deprecated)", async () => {
  it("removes every version of the given log ids for that shop only", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    await enqueueLogOutbox(OTHER, makeLog("a"));
    expect(await removeOutboxLogIds(` ${SHOP} `, ["a"])).toBe(true);
    expect(outboxEntriesForShop(SHOP).map((e) => e.log.id)).toEqual(["b"]);
    expect(outboxEntriesForShop(OTHER).map((e) => e.log.id)).toEqual(["a"]);
  });

  it("returns false when the write fails", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    storage.failSet = true;
    expect(await removeOutboxLogIds(SHOP, ["a"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// flushLogOutbox (merge / retry / state transitions) — fake remote only
// ---------------------------------------------------------------------------

describe("flushLogOutbox", async () => {
  it("is a no-op when nothing is queued for the shop", async () => {
    await enqueueLogOutbox(OTHER, makeLog("x"));
    const { remote, getShop, putShop } = fakeRemote();
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 0, remaining: 0 });
    expect(getShop).not.toHaveBeenCalled();
    expect(putShop).not.toHaveBeenCalled();
    expect(outboxEntriesForShop(OTHER)).toHaveLength(1);
  });

  it("merges by id: replaces existing remote logs, adds new ones, keeps other remote logs and doc fields", async () => {
    const remoteOld = makeLog("a", { targetPestOrPurpose: "old" });
    const untouched = makeLog("z");
    const { remote, putShop, putDocs } = fakeRemote({ doc: shopDoc([remoteOld, untouched]) });
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "new" }));
    await enqueueLogOutbox(SHOP, makeLog("n"));

    const res = await flushLogOutbox(remote, SHOP);
    expect(res).toEqual({ ok: true, flushed: 2, remaining: 0 });
    expect(putShop).toHaveBeenCalledOnce();
    const put = putDocs[0];
    expect(put.logs.map((l) => l.id).sort()).toEqual(["a", "n", "z"]);
    expect(put.logs.find((l) => l.id === "a")!.targetPestOrPurpose).toBe("new");
    expect(put.logs.find((l) => l.id === "z")).toEqual(untouched);
    // Replaced log keeps its position; the untouched one stays after it.
    expect(put.logs.indexOf(put.logs.find((l) => l.id === "a")!)).toBeLessThan(
      put.logs.indexOf(put.logs.find((l) => l.id === "z")!),
    );
    expect({ ...put, logs: [] }).toEqual({ ...shopDoc(), logs: [] });
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });

  it("only flushes the requested shop's entries", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(OTHER, makeLog("x"));
    const { remote, putDocs } = fakeRemote();
    await flushLogOutbox(remote, ` ${SHOP} `);
    expect(putDocs[0].logs.map((l) => l.id)).toEqual(["a"]);
    expect(outboxEntriesForShop(OTHER)).toHaveLength(1);
  });

  it("is idempotent: flushing again after success does nothing", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote, putShop, current } = fakeRemote();
    await flushLogOutbox(remote, SHOP);
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 0, remaining: 0 });
    expect(putShop).toHaveBeenCalledOnce();
    expect(current().logs.map((l) => l.id)).toEqual(["a"]);
  });

  it("re-flushing a log already on the remote replaces it rather than duplicating it", async () => {
    const { remote, current } = fakeRemote({ doc: shopDoc([makeLog("a")]) });
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "edited" }));
    await flushLogOutbox(remote, SHOP);
    expect(current().logs).toHaveLength(1);
    expect(current().logs[0].targetPestOrPurpose).toBe("edited");
  });

  it("on getShop failure: keeps the queue, annotates lastError, leaves queuedAt and payload alone", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(OTHER, makeLog("a"));
    const before = outboxEntriesForShop(SHOP)[0];
    const { remote, putShop } = fakeRemote({ gets: [{ ok: false, error: "offline" }] });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: false, flushed: 0, remaining: 1, error: "offline" });
    expect(putShop).not.toHaveBeenCalled();
    const after = outboxEntriesForShop(SHOP)[0];
    expect(after).toEqual({ ...before, lastError: "offline" });
    expect(outboxEntriesForShop(OTHER)[0]).not.toHaveProperty("lastError");
  });

  it("does not annotate when the remote error is blank", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote } = fakeRemote({ gets: [{ ok: false, error: "  " }] });
    const res = await flushLogOutbox(remote, SHOP);
    expect(res.ok).toBe(false);
    expect(outboxEntriesForShop(SHOP)[0]).not.toHaveProperty("lastError");
  });

  it("does not put or clear when the session expired or switched shops during getShop", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote, putShop } = fakeRemote({ onGet: () => signIn(OTHER) });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({
      ok: false,
      flushed: 0,
      remaining: 1,
      error: "Session expired or shop changed — unlock to sync queued logs.",
    });
    expect(putShop).not.toHaveBeenCalled();
    expect(outboxEntriesForShop(SHOP)).toHaveLength(1);
  });

  it("does not put when there is no authenticated session at all", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    storage.removeItem(SHOP_SESSION_KEY);
    const { remote, putShop } = fakeRemote();
    const res = await flushLogOutbox(remote, SHOP);
    expect(res.ok).toBe(false);
    expect(putShop).not.toHaveBeenCalled();
  });

  it("does not put when the session is past its idle timeout", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    vi.setSystemTime(new Date(NOW.getTime() + 9 * 60 * 60 * 1000)); // > 8h idle
    const { remote, putShop } = fakeRemote();
    expect((await flushLogOutbox(remote, SHOP)).ok).toBe(false);
    expect(putShop).not.toHaveBeenCalled();
  });

  it("on a non-conflict put failure: annotates, keeps the queue, does not retry", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote, getShop, putShop } = fakeRemote({ puts: [{ ok: false, error: "permission denied" }] });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({
      ok: false,
      flushed: 0,
      remaining: 1,
      error: "permission denied",
      conflict: undefined,
    });
    expect(getShop).toHaveBeenCalledOnce();
    expect(putShop).toHaveBeenCalledOnce();
    expect(outboxEntriesForShop(SHOP)[0].lastError).toBe("permission denied");
  });

  it("retries exactly once on a CAS conflict, with a fresh read", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const fresh = shopDoc([makeLog("other-device")]);
    const { remote, getShop, putShop, putDocs } = fakeRemote({
      gets: [{ ok: true, value: shopDoc() }, { ok: true, value: fresh }],
      puts: [conflict, { ok: true, value: { updatedAt: "x" } }],
    });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    expect(getShop).toHaveBeenCalledTimes(2);
    expect(putShop).toHaveBeenCalledTimes(2);
    expect(putDocs[1].logs.map((l) => l.id).sort()).toEqual(["a", "other-device"]);
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });

  it("gives up after the second conflict and reports it", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote, getShop, putShop } = fakeRemote({ puts: [conflict] });
    const res = await flushLogOutbox(remote, SHOP);
    expect(res).toMatchObject({ ok: false, flushed: 0, remaining: 1, conflict: true });
    expect(getShop).toHaveBeenCalledTimes(2);
    expect(putShop).toHaveBeenCalledTimes(2);
    expect(outboxEntriesForShop(SHOP)[0].lastError).toBe(conflict.ok ? "" : conflict.error);
  });

  it("includes a payload queued during the first (conflicting) attempt in the retry", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote, putDocs } = fakeRemote({
      puts: [conflict, { ok: true, value: { updatedAt: "x" } }],
      onPut: async (n) => {
        if (n === 0) await enqueueLogOutbox(SHOP, makeLog("b"));
      },
    });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 2, remaining: 0 });
    expect(putDocs[1].logs.map((l) => l.id).sort()).toEqual(["a", "b"]);
  });

  it("skips entries superseded while getShop was awaiting", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v1" }));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    const { remote, putDocs } = fakeRemote({
      onGet: async () => await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" })),
    });
    const res = await flushLogOutbox(remote, SHOP);
    // Only "b" was still live; the superseding "a" v2 stays queued for the next flush.
    expect(res).toEqual({ ok: true, flushed: 1, remaining: 1 });
    expect(putDocs[0].logs.map((l) => l.id)).toEqual(["b"]);
    const left = outboxEntriesForShop(SHOP);
    expect(left).toHaveLength(1);
    expect(left[0].log.targetPestOrPurpose).toBe("v2");
  });

  it("returns ok with nothing flushed when every entry was superseded during getShop", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v1" }));
    const { remote, putShop } = fakeRemote({
      onGet: async () => await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" })),
    });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 0, remaining: 0 });
    expect(putShop).not.toHaveBeenCalled();
    expect(outboxEntriesForShop(SHOP)[0].log.targetPestOrPurpose).toBe("v2");
  });

  it("keeps a newer version queued during putShop and reports it as remaining", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v1" }));
    const { remote } = fakeRemote({
      onPut: async () => await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" })),
    });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 1 });
    expect(outboxEntriesForShop(SHOP)[0].log.targetPestOrPurpose).toBe("v2");
  });

  it("reports when the remote put succeeded but the local outbox could not be cleared", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote, current } = fakeRemote({ onPut: () => (storage.failSet = true) });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({
      ok: false,
      flushed: 1,
      remaining: 1,
      error: "Synced to shop but could not update the local outbox.",
    });
    expect(current().logs.map((l) => l.id)).toEqual(["a"]);
  });

  it("adds several new logs to the remote newest-first, matching local upsert order", async () => {
    const { remote, current } = fakeRemote({ doc: shopDoc([makeLog("z")]) });
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    await enqueueLogOutbox(SHOP, makeLog("c"));
    await flushLogOutbox(remote, SHOP);
    expect(current().logs.map((l) => l.id)).toEqual(["c", "b", "a", "z"]);
  });

  it("with a mix of new and existing logs: new ones go on top newest-first, existing ones are replaced in place", async () => {
    const { remote, current } = fakeRemote({
      doc: shopDoc([makeLog("x", { targetPestOrPurpose: "old" }), makeLog("z")]),
    });
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(SHOP, makeLog("x", { targetPestOrPurpose: "new" }));
    await enqueueLogOutbox(SHOP, makeLog("c"));
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 3, remaining: 0 });
    expect(current().logs.map((l) => l.id)).toEqual(["c", "a", "x", "z"]);
    expect(current().logs.find((l) => l.id === "x")!.targetPestOrPurpose).toBe("new");
  });

  it("with duplicate legacy rows for one log, the newest payload wins", async () => {
    writeRaw([
      { shopId: SHOP, queuedAt: "2026-09-26T02:00:00.000Z", entryId: "new", log: makeLog("a", { targetPestOrPurpose: "v2" }) },
      { shopId: SHOP, queuedAt: "2026-09-26T01:00:00.000Z", entryId: "old", log: makeLog("a", { targetPestOrPurpose: "v1" }) },
    ]);
    const { remote, current } = fakeRemote();
    await flushLogOutbox(remote, SHOP);
    expect(current().logs).toHaveLength(1);
    expect(current().logs[0].targetPestOrPurpose).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// syncLogToRemote (queue-first push, conflict retry, supersede) — fake remote only
// ---------------------------------------------------------------------------

describe("syncLogToRemote", async () => {
  it("queues first, pushes, then clears its own outbox version", async () => {
    let queuedDuringGet = 0;
    const { remote, putDocs } = fakeRemote({
      doc: shopDoc([makeLog("z")]),
      onGet: () => (queuedDuringGet = outboxEntriesForShop(SHOP).length),
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({ ok: true });
    expect(queuedDuringGet).toBe(1); // durable before the network round-trip
    expect(putDocs[0].logs.map((l) => l.id)).toEqual(["a", "z"]); // new log goes to the front
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });

  it("replaces an existing remote log in place", async () => {
    const { remote, putDocs } = fakeRemote({ doc: shopDoc([makeLog("y"), makeLog("a"), makeLog("z")]) });
    await syncLogToRemote(remote, SHOP, makeLog("a", { targetPestOrPurpose: "edited" }));
    expect(putDocs[0].logs.map((l) => l.id)).toEqual(["y", "a", "z"]);
    expect(putDocs[0].logs[1].targetPestOrPurpose).toBe("edited");
  });

  it("leaves other queued logs alone", async () => {
    await enqueueLogOutbox(SHOP, makeLog("other"));
    const { remote } = fakeRemote();
    await syncLogToRemote(remote, SHOP, makeLog("a"));
    expect(outboxEntriesForShop(SHOP).map((e) => e.log.id)).toEqual(["other"]);
  });

  it("on getShop failure: stays queued with lastError", async () => {
    const { remote, putShop } = fakeRemote({ gets: [{ ok: false, error: "offline" }] });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({ ok: false, error: "offline", queued: true });
    expect(putShop).not.toHaveBeenCalled();
    expect(outboxEntriesForShop(SHOP)[0]).toMatchObject({ lastError: "offline" });
  });

  it("on a non-conflict put failure: stays queued with lastError, no retry", async () => {
    const { remote, getShop, putShop } = fakeRemote({ puts: [{ ok: false, error: "denied" }] });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({ ok: false, error: "denied", queued: true });
    expect(getShop).toHaveBeenCalledOnce();
    expect(putShop).toHaveBeenCalledOnce();
    expect(outboxEntriesForShop(SHOP)[0].lastError).toBe("denied");
  });

  it("retries once on conflict against a fresh read and clears on success", async () => {
    const fresh = shopDoc([makeLog("from-other-device")]);
    const { remote, getShop, putShop, putDocs } = fakeRemote({
      gets: [{ ok: true, value: shopDoc() }, { ok: true, value: fresh }],
      puts: [conflict, { ok: true, value: { updatedAt: "x" } }],
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({ ok: true });
    expect(getShop).toHaveBeenCalledTimes(2);
    expect(putShop).toHaveBeenCalledTimes(2);
    expect(putDocs[1].logs.map((l) => l.id)).toEqual(["a", "from-other-device"]);
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });

  it("reports the retry's error when the conflict retry put also fails", async () => {
    const { remote, putShop } = fakeRemote({ puts: [conflict, { ok: false, error: "still conflicting", conflict: true }] });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({
      ok: false,
      error: "still conflicting",
      queued: true,
    });
    expect(putShop).toHaveBeenCalledTimes(2);
    expect(outboxEntriesForShop(SHOP)[0].lastError).toBe("still conflicting");
  });

  it("reports the original conflict when the re-read for the retry fails", async () => {
    const { remote, putShop } = fakeRemote({
      gets: [{ ok: true, value: shopDoc() }, { ok: false, error: "offline" }],
      puts: [conflict],
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({
      ok: false,
      error: conflict.ok ? "" : conflict.error,
      queued: true,
    });
    expect(putShop).toHaveBeenCalledOnce();
  });

  it("skips the put (ok) when a newer save superseded it during getShop; the newer version stays queued", async () => {
    const { remote, putShop } = fakeRemote({
      onGet: async (n) => {
        if (n === 0) await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" }));
      },
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a", { targetPestOrPurpose: "v1" }))).toEqual({ ok: true });
    expect(putShop).not.toHaveBeenCalled();
    expect(outboxEntriesForShop(SHOP)[0].log.targetPestOrPurpose).toBe("v2");
  });

  it("skips the conflict retry (ok) when superseded before the retry", async () => {
    const { remote, putShop } = fakeRemote({
      puts: [conflict],
      onPut: async () => await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" })),
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a", { targetPestOrPurpose: "v1" }))).toEqual({ ok: true });
    expect(putShop).toHaveBeenCalledOnce();
    expect(outboxEntriesForShop(SHOP)[0].log.targetPestOrPurpose).toBe("v2");
  });

  it("does not remove a newer version queued during a successful put", async () => {
    const { remote } = fakeRemote({
      onPut: async () => await enqueueLogOutbox(SHOP, makeLog("a", { targetPestOrPurpose: "v2" })),
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a", { targetPestOrPurpose: "v1" }))).toEqual({ ok: true });
    const left = outboxEntriesForShop(SHOP);
    expect(left).toHaveLength(1);
    expect(left[0].log.targetPestOrPurpose).toBe("v2");
  });

  it("still pushes when the outbox cannot be written, and reports queued: false on failure", async () => {
    storage.failSet = true;
    const ok = fakeRemote();
    expect(await syncLogToRemote(ok.remote, SHOP, makeLog("a"))).toEqual({ ok: true });
    expect(ok.putShop).toHaveBeenCalledOnce();

    const bad = fakeRemote({ gets: [{ ok: false, error: "offline" }] });
    expect(await syncLogToRemote(bad.remote, SHOP, makeLog("b"))).toEqual({
      ok: false,
      error: "offline",
      queued: false,
    });
    expect(loadLogOutbox()).toEqual([]);
  });

  it("does not queue for a blank shop id", async () => {
    const { remote } = fakeRemote({ gets: [{ ok: false, error: "offline" }] });
    expect(await syncLogToRemote(remote, "  ", makeLog("a"))).toEqual({ ok: false, error: "offline", queued: false });
    expect(loadLogOutbox()).toEqual([]);
  });

  it("reports when the push succeeded but the outbox could not be cleared", async () => {
    const { remote, current } = fakeRemote({ onPut: () => (storage.failSet = true) });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({
      ok: false,
      error: "Synced to shop but could not update the local outbox.",
      queued: true,
    });
    expect(current().logs.map((l) => l.id)).toEqual(["a"]);
    expect(outboxEntriesForShop(SHOP)).toHaveLength(1);
  });

  it("reports the same when the clear fails after a successful conflict retry", async () => {
    const { remote } = fakeRemote({
      puts: [conflict, { ok: true, value: { updatedAt: "x" } }],
      onPut: (n) => {
        if (n === 1) storage.failSet = true;
      },
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({
      ok: false,
      error: "Synced to shop but could not update the local outbox.",
      queued: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Branch-coverage follow-ups (target (a)): remaining uncovered paths
// ---------------------------------------------------------------------------

describe("logOutbox: remaining edge paths", async () => {
  it("falls back to a time-based entry id when crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    expect(await enqueueLogOutbox(SHOP, makeLog("a"))).toBe(true);
    const [entry] = outboxEntriesForShop(SHOP);
    expect(entry.entryId).toMatch(new RegExp(`^e-${NOW.getTime()}-[a-z0-9]+$`));
  });

  it("flush: the conflict retry finds an empty outbox (cleared elsewhere) and reports ok", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    const { remote, getShop, putShop } = fakeRemote({
      puts: [conflict],
      onPut: (n) => {
        // Another tab flushed and cleared the outbox while our first put was in flight.
        if (n === 0) storage.removeItem(LOG_OUTBOX_KEY);
      },
    });
    expect(await flushLogOutbox(remote, SHOP)).toEqual({ ok: true, flushed: 0, remaining: 0 });
    expect(getShop).toHaveBeenCalledOnce();
    expect(putShop).toHaveBeenCalledOnce();
  });

  it("sync without a queued copy still runs the conflict retry and succeeds", async () => {
    storage.failSet = true; // enqueue fails → queued: false, no entryId
    const fresh = shopDoc([makeLog("from-other-device")]);
    const { remote, putShop, putDocs } = fakeRemote({
      gets: [{ ok: true, value: shopDoc() }, { ok: true, value: fresh }],
      puts: [conflict, { ok: true, value: { updatedAt: "x" } }],
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({ ok: true });
    expect(putShop).toHaveBeenCalledTimes(2);
    expect(putDocs[1].logs.map((l) => l.id)).toEqual(["a", "from-other-device"]);
    expect(loadLogOutbox()).toEqual([]);
  });

  it("sync without a queued copy reports queued:false when the conflict retry put fails", async () => {
    storage.failSet = true;
    const { remote } = fakeRemote({ puts: [conflict, { ok: false, error: "denied" }] });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({
      ok: false,
      error: "denied",
      queued: false,
    });
    expect(loadLogOutbox()).toEqual([]);
  });

  it("sync conflict retry replaces the log in place when the fresh read already has it", async () => {
    const fresh = shopDoc([makeLog("y"), makeLog("a", { targetPestOrPurpose: "other device" }), makeLog("z")]);
    const { remote, putDocs } = fakeRemote({
      gets: [{ ok: true, value: shopDoc() }, { ok: true, value: fresh }],
      puts: [conflict, { ok: true, value: { updatedAt: "x" } }],
    });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a", { targetPestOrPurpose: "mine" }))).toEqual({ ok: true });
    expect(putDocs[1].logs.map((l) => [l.id, l.targetPestOrPurpose])).toEqual([
      ["y", "Ants"],
      ["a", "mine"],
      ["z", "Ants"],
    ]);
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });

  it("sync without a queued copy reports queued:false on a non-conflict put failure", async () => {
    storage.failSet = true;
    const { remote, putShop } = fakeRemote({ puts: [{ ok: false, error: "denied" }] });
    expect(await syncLogToRemote(remote, SHOP, makeLog("a"))).toEqual({
      ok: false,
      error: "denied",
      queued: false,
    });
    expect(putShop).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Cross-tab exclusion: Web Lock around RMW, CAS only for a bypass writer
// ---------------------------------------------------------------------------

describe("outbox cross-tab CAS", async () => {
  /** Other tab commits during the confirming read (between snapshot and setItem). */
  function interleaveOnConfirm(mutate: (currentRaw: string | null) => void) {
    const originalGet = storage.getItem.bind(storage);
    const originalSet = storage.setItem.bind(storage);
    let reads = 0;
    storage.getItem = (k: string) => {
      if (k === LOG_OUTBOX_KEY) {
        reads += 1;
        if (reads % 2 === 0) mutate(originalGet(k));
      }
      return originalGet(k);
    };
    return {
      reads: () => reads,
      restore() {
        storage.getItem = originalGet;
        storage.setItem = originalSet;
      },
      originalSet,
    };
  }

  function otherEntry(logId: string, entryId: string) {
    return {
      shopId: SHOP,
      queuedAt: NOW.toISOString(),
      entryId,
      log: makeLog(logId),
    };
  }

  it("retries an enqueue so another tab's row is kept instead of last-write-wins", async () => {
    await enqueueLogOutbox(SHOP, makeLog("existing"));
    let commits = 0;
    const hook = interleaveOnConfirm((currentRaw) => {
      if (commits > 0) return;
      commits += 1;
      const current = JSON.parse(currentRaw ?? "[]") as unknown[];
      hook.originalSet(
        LOG_OUTBOX_KEY,
        JSON.stringify([otherEntry("other", "other-tab"), ...current]),
      );
    });
    const originalSet = storage.setItem.bind(storage);
    let ourWrites = 0;
    storage.setItem = (k: string, v: string) => {
      if (k === LOG_OUTBOX_KEY) ourWrites += 1;
      originalSet(k, v);
    };
    expect(await enqueueLogOutbox(SHOP, makeLog("mine"))).toBe(true);
    expect(ourWrites).toBe(1);
    hook.restore();
    expect(loadLogOutbox().map((e) => e.log.id)).toEqual(["mine", "other", "existing"]);
    expect(loadLogOutbox().find((e) => e.log.id === "other")?.entryId).toBe("other-tab");
  });

  it("retries a versioned remove so a concurrent enqueue is not dropped", async () => {
    await enqueueLogOutbox(SHOP, makeLog("a"));
    await enqueueLogOutbox(SHOP, makeLog("b"));
    const dropId = outboxEntriesForShop(SHOP).find((e) => e.log.id === "a")!.entryId;
    let injected = false;
    const hook = interleaveOnConfirm((currentRaw) => {
      if (injected) return;
      injected = true;
      const current = JSON.parse(currentRaw ?? "[]") as unknown[];
      hook.originalSet(
        LOG_OUTBOX_KEY,
        JSON.stringify([otherEntry("other", "other-tab"), ...current]),
      );
    });
    expect(await removeOutboxVersions(SHOP, [dropId])).toBe(true);
    hook.restore();
    expect(loadLogOutbox().map((e) => e.log.id)).toEqual(["other", "b"]);
  });

  it("gives up after 8 conflicts and leaves the other tab's write in place", async () => {
    await enqueueLogOutbox(SHOP, makeLog("keep"));
    let confirms = 0;
    const hook = interleaveOnConfirm(() => {
      confirms += 1;
      hook.originalSet(LOG_OUTBOX_KEY, JSON.stringify([otherEntry("other", `tab-${confirms}`)]));
    });
    expect(await enqueueLogOutbox(SHOP, makeLog("mine"))).toBe(false);
    expect(confirms).toBe(8);
    hook.restore();
    expect(loadLogOutbox().map((e) => e.entryId)).toEqual(["tab-8"]);
  });
});

describe("outbox cross-tab lock", () => {
  function installExclusiveLocks() {
    let tail: Promise<void> = Promise.resolve();
    const calls: { name: string; mode?: string; hasSignal: boolean }[] = [];
    let held = false;
    const request = vi.fn(
      async (name: string, options: { mode?: string; signal?: AbortSignal }, callback: () => unknown) => {
        calls.push({ name, mode: options?.mode, hasSignal: !!options?.signal });
        const run = tail.then(async () => {
          if (options?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          held = true;
          try {
            return await callback();
          } finally {
            held = false;
          }
        });
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    );
    vi.stubGlobal("navigator", { locks: { request } });
    return {
      request,
      calls,
      isHeld: () => held,
    };
  }

  it("requests an exclusive Web Lock around confirm-read and setItem", async () => {
    const locks = installExclusiveLocks();
    const originalSet = storage.setItem.bind(storage);
    let setWhileHeld = 0;
    let setOutside = 0;
    storage.setItem = (k: string, v: string) => {
      if (k === LOG_OUTBOX_KEY) {
        if (locks.isHeld()) setWhileHeld += 1;
        else setOutside += 1;
      }
      originalSet(k, v);
    };
    expect(await enqueueLogOutbox(SHOP, makeLog("a"))).toBe(true);
    expect(setWhileHeld).toBe(1);
    expect(setOutside).toBe(0);
    expect(locks.calls).toEqual([{ name: OUTBOX_LOCK_NAME, mode: "exclusive", hasSignal: true }]);
    expect(loadLogOutbox().map((e) => e.log.id)).toEqual(["a"]);
  });

  it("serializes contending writers so neither clobbers the other's commit", async () => {
    installExclusiveLocks();
    const [first, second] = await Promise.all([
      enqueueLogOutbox(SHOP, makeLog("a")),
      enqueueLogOutbox(SHOP, makeLog("b")),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(loadLogOutbox().map((e) => e.log.id).sort()).toEqual(["a", "b"]);
  });

  it("returns false and does not write when the lock is not granted in time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storage.setItem(
      LOG_OUTBOX_KEY,
      JSON.stringify([
        { shopId: SHOP, queuedAt: NOW.toISOString(), entryId: "keep", log: makeLog("keep") },
      ]),
    );
    const request = vi.fn(
      (_name: string, options: { signal?: AbortSignal }, _callback: () => unknown) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (options?.signal?.aborted) {
            abort();
            return;
          }
          options?.signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const pending = enqueueLogOutbox(SHOP, makeLog("mine"));
    await vi.advanceTimersByTimeAsync(OUTBOX_LOCK_WAIT_MS);
    expect(await pending).toBe(false);
    expect(loadLogOutbox().map((e) => e.log.id)).toEqual(["keep"]);
  });

  it("fails closed when lock acquisition rejects for a reason other than timeout", async () => {
    const request = vi.fn(async () => {
      throw new Error("locks unavailable");
    });
    vi.stubGlobal("navigator", { locks: { request } });
    expect(await enqueueLogOutbox(SHOP, makeLog("a"))).toBe(false);
    expect(storage.getItem(LOG_OUTBOX_KEY)).toBeNull();
  });

  it("still serializes two writers in this agent when Web Locks is missing", async () => {
    vi.stubGlobal("navigator", {});
    const [first, second] = await Promise.all([
      enqueueLogOutbox(SHOP, makeLog("a")),
      removeOutboxVersions(SHOP, ["nope"]),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(loadLogOutbox().map((e) => e.log.id)).toEqual(["a"]);
  });
});
