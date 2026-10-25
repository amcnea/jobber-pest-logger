import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logsToCsv } from "../csv";
import {
  applyCorrection,
  buildBackup,
  loadLogs,
  markLogReviewed,
  SET_ASIDE_KEY,
  saveLogs,
  wipeAllDeviceData,
} from "../storage";
import { makeLog, makeShopProduct } from "../test/fixtures";
import { MemoryStorage } from "../test/memoryStorage";
import type { ApplicationLog, Person } from "../types";
import type { ShopDocument } from "./types";

// #209 / #215. Firebase is replaced by an in-memory shop doc + per-log subcollection at
// the module boundary so the real RemoteShopStore (read path + write plan + legacy drain)
// runs; storage, outbox, conflicts and export code are real.

const fake = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  subLogs: new Map<string, Record<string, unknown>>(),
  writes: [] as Record<string, unknown>[],
  logWrites: [] as { id: string; data: Record<string, unknown> | null }[],
  failWrite: null as Error | null,
  stamp: 0,
}));

vi.mock("./firebaseAuth", () => ({ ensureAnonymousAuth: vi.fn(async () => ({ uid: "uid-office" })) }));
vi.mock("./resolveShopStore", () => ({ resolveShopStore: vi.fn() }));
vi.mock("./firebaseApp", () => ({ getFirebaseApp: vi.fn(async () => ({})) }));
vi.mock("firebase/firestore", () => {
  const snap = () => ({ exists: () => fake.data !== null, data: () => JSON.parse(JSON.stringify(fake.data)) });
  return {
    getFirestore: () => ({}),
    collection: (_db: unknown, ...segments: string[]) => ({ path: segments.join("/") }),
    doc: (_db: unknown, ...segments: string[]) => ({
      path: segments.join("/"),
      id: segments[segments.length - 1] ?? "",
    }),
    getDoc: async () => snap(),
    getDocs: async () => ({
      docs: [...fake.subLogs.entries()].map(([id, d]) => ({
        id,
        data: () => JSON.parse(JSON.stringify(d)),
      })),
    }),
    setDoc: async (ref: { path?: string; id?: string }, value: Record<string, unknown>) => {
      if (fake.failWrite) throw fake.failWrite;
      const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
      if (ref.path?.includes("/logs/") && ref.id) {
        fake.subLogs.set(ref.id, cloned);
        fake.logWrites.push({ id: ref.id, data: cloned });
      } else {
        fake.data = cloned;
      }
    },
    deleteDoc: async (ref: { path?: string; id?: string }) => {
      if (fake.failWrite) throw fake.failWrite;
      if (ref.id) {
        fake.subLogs.delete(ref.id);
        fake.logWrites.push({ id: ref.id, data: null });
      }
    },
    runTransaction: async (_db: unknown, fn: (t: unknown) => Promise<void>) => {
      let stagedShop: Record<string, unknown> | null = null;
      const stagedLogs: { id: string; data: Record<string, unknown> | null }[] = [];
      await fn({
        get: async () => snap(),
        set: (ref: { path?: string; id?: string }, value: Record<string, unknown>) => {
          const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
          if (ref?.path?.includes("/logs/") && ref.id) {
            stagedLogs.push({ id: ref.id, data: cloned });
          } else {
            stagedShop = cloned;
          }
        },
        delete: (ref: { path?: string; id?: string }) => {
          if (ref?.id) {
            stagedLogs.push({ id: ref.id, data: null });
          }
        },
        update: () => {},
      });
      if (fake.failWrite) throw fake.failWrite;
      for (const op of stagedLogs) {
        if (op.data === null) {
          fake.subLogs.delete(op.id);
        } else {
          fake.subLogs.set(op.id, op.data);
        }
        fake.logWrites.push(op);
      }
      if (stagedShop) {
        fake.data = stagedShop;
        fake.writes.push(stagedShop);
      }
    },
  };
});

const {
  compareDuplicateCopies,
  dedupeLogsById,
  planDedupedWrite,
  planLegacyDrain,
  setAsideDuplicateCopies,
  DUPLICATE_ID_SET_ASIDE_REASON,
  MAX_DEDUPE_CLEANUP_BATCH,
} = await import("./dedupeLogs");
const { RemoteShopStore, MAX_LOG_WRITES_PER_TX } = await import("./RemoteShopStore");
const { enqueueLogOutbox, flushLogOutbox, outboxEntriesForShop, syncLogToRemote } = await import("./logOutbox");
const { REMOTE_COPY_KEPT_ERROR } = await import("./logOutbox");
const { takeShopCopy } = await import("./conflicts");
const { SHOP_SESSION_KEY } = await import("./session");
const { resolveShopStore } = await import("./resolveShopStore");
const { resolveExportSections } = await import("./exportPull");

const SHOP = "SHOP1";
const NOW = new Date(2026, 9, 17, 18, 0);
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const CATALOG = [makeShopProduct()];
const CONFIG = { apiKey: "k", authDomain: "d", projectId: "p", appId: "a" } as never;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  storage.setItem(
    SHOP_SESSION_KEY,
    JSON.stringify({ shopId: SHOP, role: "office", verifiedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
  );
  fake.data = null;
  fake.subLogs.clear();
  fake.writes = [];
  fake.logWrites = [];
  fake.failWrite = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Copies of one log "L1" built through the real storage API. */
function versions() {
  saveLogs([makeLog({ id: "L1", serviceAddress: "1 Original St" })]);
  const rev0 = loadLogs()[0];
  const fix = (patch: Partial<ApplicationLog>, reason: string, now = NOW) => {
    const res = applyCorrection("L1", { ...loadLogs()[0], ...patch }, { changedBy: "p-ana", reason, people: PEOPLE, now });
    if (!res.ok) throw new Error(res.error);
    return res.log;
  };
  const review = (now: Date) => {
    const res = markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now });
    if (!res.ok) throw new Error(res.error);
    return loadLogs()[0];
  };
  const rev1 = fix({ serviceAddress: "2 Stray St" }, "first");
  const rev2 = fix({ serviceAddress: "3 Stray St" }, "second");
  saveLogs([rev0]);
  const rev1Early = fix({ serviceAddress: "4 Early St" }, "early", new Date(2026, 9, 17, 9, 0));
  saveLogs([rev0]);
  const rev1Late = fix({ serviceAddress: "5 Late St" }, "late", new Date(2026, 9, 17, 10, 0));
  saveLogs([rev0]);
  const reviewedEarly = review(new Date(2026, 9, 17, 9, 0));
  saveLogs([rev0]);
  const reviewedLate = review(new Date(2026, 9, 17, 10, 0));
  saveLogs([rev1]);
  const reviewedRev1 = review(NOW);
  saveLogs([rev0]);
  const reviewedRev0 = review(NOW);
  storage.removeItem("jobber-pest-logger:logs:v1");
  return { rev0, rev1, rev2, rev1Early, rev1Late, reviewedEarly, reviewedLate, reviewedRev0, reviewedRev1 };
}

function shopDoc(logs: unknown[], extra: Partial<ShopDocument> = {}): Record<string, unknown> {
  return {
    version: "1",
    updatedAt: "2026-10-01T00:00:00.000Z",
    logs: clone(logs),
    catalog: [],
    people: [],
    settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
    ownerUid: "uid-office",
    members: { "uid-office": "office" },
    ...extra,
  };
}

function setAsideRows(): Record<string, unknown>[] {
  return JSON.parse(storage.getItem(SET_ASIDE_KEY) ?? "[]") as Record<string, unknown>[];
}

const winner = (...logs: ApplicationLog[]) => dedupeLogsById(logs).logs;

describe("winner rule (Lawgical) and tie-break", () => {
  it("reviewed copy wins even when it is behind an unreviewed copy", () => {
    const v = versions();
    expect(winner(v.rev2, v.reviewedRev0)).toEqual([v.reviewedRev0]);
    expect(winner(v.reviewedRev0, v.rev2)).toEqual([v.reviewedRev0]);
  });

  it("reviewed copy wins when it is ahead", () => {
    const v = versions();
    expect(winner(v.rev0, v.reviewedRev1)).toEqual([v.reviewedRev1]);
  });

  it("neither reviewed: higher revision wins, wherever it sits", () => {
    const v = versions();
    expect(winner(v.rev1, v.rev2, v.rev0)).toEqual([v.rev2]);
    expect(winner(v.rev0, v.rev1)).toEqual([v.rev1]);
  });

  it("both reviewed: higher revision, then later reviewedAt", () => {
    const v = versions();
    expect(winner(v.reviewedRev0, v.reviewedRev1)).toEqual([v.reviewedRev1]);
    expect(winner(v.reviewedLate, v.reviewedEarly)).toEqual([v.reviewedLate]);
    expect(winner(v.reviewedEarly, v.reviewedLate)).toEqual([v.reviewedLate]);
  });

  it("same review state and revision: later changedAt of the newest correction", () => {
    const v = versions();
    expect(winner(v.rev1Early, v.rev1Late)).toEqual([v.rev1Late]);
    expect(winner(v.rev1Late, v.rev1Early)).toEqual([v.rev1Late]);
    expect(compareDuplicateCopies(v.rev1Early, v.rev1Late)).toBeLessThan(0);
  });

  it("all equal: first in the array; exact copies collapse without a set-aside", () => {
    const a = makeLog({ id: "L1", serviceAddress: "A" });
    const b = makeLog({ id: "L1", serviceAddress: "B" });
    const r = dedupeLogsById([a, makeLog({ id: "x" }), b, clone(a)]);
    expect(r.logs).toEqual([a, makeLog({ id: "x" })]);
    expect(r.losers.map((l) => [l.index, l.identical])).toEqual([
      [2, false],
      [3, true],
    ]);
  });

  it("no duplicates: logs unchanged, nothing lost", () => {
    const logs = [makeLog({ id: "a" }), makeLog({ id: "b" })];
    expect(dedupeLogsById(logs)).toEqual({ logs, losers: [] });
  });
});

describe("set-aside store", () => {
  it("adds each losing copy once (repeat calls add nothing)", () => {
    const v = versions();
    const { losers } = dedupeLogsById([v.reviewedRev0, v.rev2, v.rev1]);
    expect(setAsideDuplicateCopies(SHOP, losers, NOW)).toBe(true);
    expect(setAsideDuplicateCopies(SHOP, losers, NOW)).toBe(true);
    const rows = setAsideRows();
    expect(rows.map((r) => r.deviceCopy)).toEqual([v.rev2, v.rev1]);
    expect(rows.every((r) => r.reason === DUPLICATE_ID_SET_ASIDE_REASON && r.shopId === SHOP && r.logId === "L1")).toBe(true);
  });

  it("keeps existing rows and refuses to overwrite a store it can't read", () => {
    const v = versions();
    const { losers } = dedupeLogsById([v.reviewedRev0, v.rev2]);
    storage.setItem(SET_ASIDE_KEY, JSON.stringify([{ id: "older", other: true }]));
    expect(setAsideDuplicateCopies(SHOP, losers)).toBe(true);
    expect(setAsideRows()[0]).toEqual({ id: "older", other: true });
    storage.setItem(SET_ASIDE_KEY, "{corrupt");
    expect(setAsideDuplicateCopies(SHOP, losers)).toBe(false);
    expect(storage.getItem(SET_ASIDE_KEY)).toBe("{corrupt");
  });
});

describe("write plan (#208 compatible)", () => {
  it("removes unreviewed losers and exact copies in a separate cleanup; keeps reviewed losers", () => {
    const v = versions();
    const other = makeLog({ id: "o" });
    const stored = [v.rev2, other, v.reviewedLate, clone(other), v.reviewedEarly];
    const next = dedupeLogsById(stored).logs;
    expect(next).toEqual([v.reviewedLate, other]);
    const plan = planDedupedWrite(stored, next, true);
    expect(plan.cleanup).toEqual([other, v.reviewedLate, v.reviewedEarly]);
    expect(plan.logs).toEqual([v.reviewedLate, other, v.reviewedEarly]);
    // #221: the removed rev2 differs from its kept copy (index 1 in the cleanup); the exact
    // copy of "o" needs no hint.
    expect(plan.keptCopyAt).toEqual({ [v.rev2.id]: 1 });
  });

  it("keeps every loser when its set-aside copy wasn't saved", () => {
    const v = versions();
    const stored = [v.rev2, v.reviewedRev0];
    expect(planDedupedWrite(stored, [v.reviewedRev0], false)).toEqual({ cleanup: null, logs: [v.reviewedRev0, v.rev2] });
  });

  it("#228: splits >8 differing unreviewed losers into batches of MAX_DEDUPE_CLEANUP_BATCH with per-batch keptCopyAt indices", () => {
    const winners = Array.from({ length: 20 }, (_, i) => makeLog({ id: `L${i}`, revision: 1, serviceAddress: `${i} Winner St` }));
    const differingLosers = winners.map((w, i) => ({ ...w, revision: 0, serviceAddress: `${i} Loser St` }));
    const exactCopy = clone(winners[0]);
    // Put differing losers ahead of winners so winner indices shift as each batch removes 8 losers.
    const stored = [...differingLosers, exactCopy, ...winners];
    const next = dedupeLogsById(stored).logs;
    const plan = planDedupedWrite(stored, next, true);
    expect(MAX_DEDUPE_CLEANUP_BATCH).toBe(8);
    expect(plan.cleanups).toHaveLength(3);
    // Batch 1 drops the exact copy + first 8 differing losers (L0..L7); 12 differing losers + 20 winners = 32 logs remain.
    expect(plan.cleanups![0].logs).toHaveLength(32);
    expect(Object.keys(plan.cleanups![0].keptCopyAt!)).toEqual(["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
    // Batch 2 drops L8..L15; 4 differing losers + 20 winners = 24 logs remain.
    expect(plan.cleanups![1].logs).toHaveLength(24);
    expect(Object.keys(plan.cleanups![1].keptCopyAt!)).toEqual(["L8", "L9", "L10", "L11", "L12", "L13", "L14", "L15"]);
    // Batch 3 drops L16..L19; only the 20 winners remain.
    expect(plan.cleanups![2].logs).toEqual(winners);
    expect(Object.keys(plan.cleanups![2].keptCopyAt!)).toEqual(["L16", "L17", "L18", "L19"]);
    // In every batch, keptCopyAt[id] points to the winner with that id in THAT batch's logs array.
    for (const step of plan.cleanups!) {
      for (const [id, idx] of Object.entries(step.keptCopyAt!)) {
        expect(step.logs[idx]).toEqual(winners[Number(id.slice(1))]);
      }
    }
    expect(plan.cleanup).toEqual(winners);
  });

  it("#215: planLegacyDrain queues winners for subcollection creation and drains removable legacy entries in <=8 batches", () => {
    const v = versions();
    const other = makeLog({ id: "o" });
    const legacy = [v.rev2, other, v.reviewedLate, clone(other), v.reviewedEarly];
    const next = dedupeLogsById(legacy).logs;
    const plan = planLegacyDrain(new Map(), legacy, legacy, next, true);
    expect(plan.winnersToCreate.map((w) => w.log)).toEqual([v.reviewedLate, other]);
    expect(plan.remainingLegacy).toEqual([v.reviewedEarly]);
    expect(plan.drainBatches).toEqual([[v.reviewedEarly]]);
  });

  it("#215: planLegacyDrain preserves raw legacy entries without normalized defaults (e.g. history) in drainBatches and remainingLegacy", () => {
    const v = versions();
    const rawLate = clone(v.reviewedLate) as unknown as Record<string, unknown>;
    const rawEarly = clone(v.reviewedEarly) as unknown as Record<string, unknown>;
    delete rawLate.history;
    delete rawEarly.history;
    const legacy = [v.reviewedLate, v.reviewedEarly];
    const rawLegacy = [rawLate, rawEarly];
    const plan = planLegacyDrain(new Map(), legacy, rawLegacy, [v.reviewedLate], true);
    expect(plan.winnersToCreate[0].raw).toEqual(rawLate);
    expect("history" in (plan.winnersToCreate[0].raw as Record<string, unknown>)).toBe(false);
    expect(plan.drainBatches).toEqual([[rawEarly as unknown as ApplicationLog]]);
    expect(plan.remainingLegacy).toEqual([rawEarly as unknown as ApplicationLog]);
    expect("history" in (plan.remainingLegacy[0] as unknown as Record<string, unknown>)).toBe(false);

    // No-removals path (winner already in subLogs, only reviewed loser remains in legacyLogs):
    const noRemovals = planLegacyDrain(
      new Map([["L1", v.reviewedLate]]),
      [v.reviewedEarly],
      [rawEarly],
      [v.reviewedLate],
      true,
    );
    expect(noRemovals.drainBatches).toEqual([]);
    expect(noRemovals.remainingLegacy).toEqual([rawEarly as unknown as ApplicationLog]);
    expect("history" in (noRemovals.remainingLegacy[0] as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("RemoteShopStore read path", () => {
  it("getShop returns one copy per id, sets the losers aside once, backup carries them, wipe clears them", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, makeLog({ id: "o" }), v.reviewedRev0, v.rev1]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    for (let i = 0; i < 3; i++) {
      const got = await store.getShop();
      expect(got.ok && got.value.logs).toEqual([v.reviewedRev0, makeLog({ id: "o" })]);
    }
    await new RemoteShopStore(CONFIG, SHOP).getShop(); // another instance / tab
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual([v.rev2, v.rev1]);
    expect(buildBackup().setAside).toEqual(setAsideRows());
    expect(fake.writes).toEqual([]); // reading never writes
    expect(fake.logWrites).toEqual([]);
    wipeAllDeviceData();
    expect(storage.getItem(SET_ASIDE_KEY)).toBeNull();
  });

  it("#215: getShop reads per-log subcollection docs when shops/{shopId}.logs is empty or omitted", async () => {
    const v = versions();
    const other = makeLog({ id: "o" });
    const rawDoc = shopDoc([]);
    delete rawDoc.logs;
    fake.data = rawDoc;
    fake.subLogs.set("L1", clone(v.reviewedRev0) as unknown as Record<string, unknown>);
    fake.subLogs.set("o", clone(other) as unknown as Record<string, unknown>);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const got = await store.getShop();
    expect(got.ok && got.value.logs).toEqual([v.reviewedRev0, other]);
  });

  it("export (shared pull) and CSV use the reviewed winner, not the stray copy", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    vi.mocked(resolveShopStore).mockReturnValue({ store, mode: "shared", shopId: SHOP, role: "office", locked: false } as never);
    const local = { logs: [], catalog: [], people: [], settings: { shopName: "", shopTpclNumber: "", shopTpclLetter: "" } };
    const pulled = await resolveExportSections(local as never);
    if (pulled.kind !== "shared") throw new Error(`unexpected ${pulled.kind}`);
    expect(pulled.sections.logs).toEqual([v.reviewedRev0]);
    const csv = logsToCsv(pulled.sections.logs);
    expect(csv).toContain("1 Original St");
    expect(csv).not.toContain("3 Stray St");
  });

  it("take shop copy adopts the reviewed winner", async () => {
    const v = versions();
    saveLogs([v.rev1]);
    await enqueueLogOutbox(SHOP, v.rev1);
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const [entry] = outboxEntriesForShop(SHOP);
    const res = await takeShopCopy(store, SHOP, entry, { setAsideBy: "p-ana", people: PEOPLE, now: NOW });
    expect(res).toMatchObject({ ok: true, log: v.reviewedRev0 });
    expect(loadLogs()).toEqual([v.reviewedRev0]);
  });
});

describe("RemoteShopStore write path", () => {
  it("outbox flush migrates winner to per-log doc, drains legacy array first, then writes new log; reviewed loser stays in legacy array", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, v.reviewedLate, v.reviewedEarly]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const logN = makeLog({ id: "N" });
    await enqueueLogOutbox(SHOP, logN);
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    // Winner migrated to shops/SHOP1/logs/L1 and new log written to shops/SHOP1/logs/N.
    expect(fake.subLogs.get("L1")).toEqual(v.reviewedLate);
    expect(fake.subLogs.get("N")).toEqual(logN);
    // Shop doc writes: [0] drains rev2 + reviewedLate, leaving only reviewedEarly; [1] commits the flush.
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes[0].logs).toEqual([v.reviewedEarly]);
    expect(fake.writes[1].logs).toEqual([v.reviewedEarly]);
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual([v.rev2, v.reviewedEarly]);
    // The next write reuses the written state: only writes M to shops/SHOP1/logs/M + 1 shop doc CAS update.
    const logM = makeLog({ id: "M" });
    await enqueueLogOutbox(SHOP, logM);
    expect(await flushLogOutbox(store, SHOP)).toMatchObject({ ok: true, flushed: 1 });
    expect(fake.subLogs.get("M")).toEqual(logM);
    expect(fake.writes).toHaveLength(3);
    expect(fake.writes[2].logs).toEqual([v.reviewedEarly]);
    expect(setAsideRows()).toHaveLength(2);
  });

  it("#215: putShop preserves raw legacy entries without history across drain batches and subsequent writes", async () => {
    const v = versions();
    const rawLate = clone(v.reviewedLate) as unknown as Record<string, unknown>;
    const rawEarly = clone(v.reviewedEarly) as unknown as Record<string, unknown>;
    delete rawLate.history;
    delete rawEarly.history;
    fake.data = shopDoc([rawLate, rawEarly]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    await enqueueLogOutbox(SHOP, makeLog({ id: "N" }));
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    expect(fake.subLogs.get("L1")).toEqual(rawLate);
    expect("history" in (fake.subLogs.get("L1") as Record<string, unknown>)).toBe(false);
    expect(fake.writes[0].logs).toEqual([rawEarly]);
    expect("history" in ((fake.writes[0].logs as Record<string, unknown>[])[0])).toBe(false);
    expect(fake.writes[1].logs).toEqual([rawEarly]);
    expect("history" in ((fake.writes[1].logs as Record<string, unknown>[])[0])).toBe(false);

    // Subsequent write reusing cached state also keeps rawEarly without history:
    await enqueueLogOutbox(SHOP, makeLog({ id: "M" }));
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    expect(fake.writes[2].logs).toEqual([rawEarly]);
    expect("history" in ((fake.writes[2].logs as Record<string, unknown>[])[0])).toBe(false);
    expect(setAsideRows()).toHaveLength(1);
  });

  it("an unreviewed device copy is refused against the reviewed winner (conflict screen), not merged over the stray", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    await enqueueLogOutbox(SHOP, v.rev2);
    expect(await flushLogOutbox(store, SHOP)).toMatchObject({ ok: false, error: REMOTE_COPY_KEPT_ERROR });
    expect(outboxEntriesForShop(SHOP)[0].lastError).toBe(REMOTE_COPY_KEPT_ERROR);
    expect(fake.writes).toEqual([]);
    expect(fake.logWrites).toEqual([]);
  });

  it("if the set-aside can't be saved, putShop keeps the un-set-aside loser in the shop doc while migrating the winner", async () => {
    const v = versions();
    storage.setItem(SET_ASIDE_KEY, "{corrupt");
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const got = await store.getShop();
    if (!got.ok) throw new Error(got.error);
    expect(got.value.logs).toEqual([v.reviewedRev0]);
    const logN = makeLog({ id: "N" });
    const put = await store.putShop({ ...got.value, logs: [logN, ...got.value.logs] });
    expect(put.ok).toBe(true);
    expect(fake.subLogs.get("L1")).toEqual(v.reviewedRev0);
    expect(fake.subLogs.get("N")).toEqual(logN);
    expect((fake.data as unknown as ShopDocument).logs).toEqual([v.rev2]);
  });

  it("putShop without a prior read re-reads the stored doc so nothing is dropped", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const doc = shopDoc([v.reviewedRev0]) as unknown as ShopDocument;
    expect((await store.putShop(doc)).ok).toBe(true);
    expect(fake.subLogs.get("L1")).toEqual(v.reviewedRev0);
    expect(fake.writes.map((w) => w.logs)).toEqual([[], []]);
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual([v.rev2]);
  });

  it("a stale caller doc is a conflict (no write)", async () => {
    fake.data = shopDoc([makeLog({ id: "a" })], { updatedAt: "2026-10-02T00:00:00.000Z" });
    const store = new RemoteShopStore(CONFIG, SHOP);
    const res = await store.putShop(shopDoc([]) as unknown as ShopDocument);
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect(fake.writes).toEqual([]);
    expect(fake.logWrites).toEqual([]);
  });

  it("#215: when remote updatedAt changes after getShop (cached state is stale), putShop conflicts inside CAS without overwriting or deleting any per-log doc", async () => {
    const logA = makeLog({ id: "a", serviceAddress: "1 Original St" });
    const logB = makeLog({ id: "b", serviceAddress: "2 Keep St" });
    fake.data = shopDoc([]);
    fake.subLogs.set("a", clone(logA) as unknown as Record<string, unknown>);
    fake.subLogs.set("b", clone(logB) as unknown as Record<string, unknown>);

    // Device A reads the shop and caches updatedAt = "2026-10-01T00:00:00.000Z".
    const storeA = new RemoteShopStore(CONFIG, SHOP);
    const gotA = await storeA.getShop();
    if (!gotA.ok) throw new Error(gotA.error);

    // Device B edits log "a" and commits, advancing remote updatedAt.
    const logAByB = { ...logA, revision: 1, serviceAddress: "1 Edited By B St" };
    fake.subLogs.set("a", clone(logAByB) as unknown as Record<string, unknown>);
    fake.data = { ...fake.data, updatedAt: "2026-10-02T00:00:00.000Z" };

    // Device A now attempts to overwrite "a" with its stale edit and delete "b".
    const staleA = { ...logA, revision: 1, serviceAddress: "1 Stale Edit By A St" };
    const res = await storeA.putShop({ ...gotA.value, logs: [staleA] });
    expect(res).toMatchObject({ ok: false, conflict: true });
    // Neither "a" nor "b" was overwritten or deleted in shops/{shopId}/logs/{logId}.
    expect(fake.logWrites).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(fake.subLogs.get("a")).toEqual(logAByB);
    expect(fake.subLogs.get("b")).toEqual(logB);
  });

  it("#215: chunks >499 per-log writes across CAS transactions of <=499 log writes + 1 shop write", async () => {
    expect(MAX_LOG_WRITES_PER_TX).toBe(499);
    fake.data = shopDoc([]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const got = await store.getShop();
    if (!got.ok) throw new Error(got.error);

    const manyLogs = Array.from({ length: 505 }, (_, i) => makeLog({ id: `L${i}`, serviceAddress: `${i} Bulk St` }));
    const res = await store.putShop({ ...got.value, logs: manyLogs });
    expect(res.ok).toBe(true);
    expect(fake.subLogs.size).toBe(505);
    // 505 log writes split across 2 CAS transactions (499 + 6), each updating the shop doc once.
    expect(fake.writes).toHaveLength(2);
    expect(fake.logWrites).toHaveLength(505);
  });

  it("#215 / #228: drains >8 (40) legacy entries in <=8-entry batches after writing winners to shops/{shopId}/logs/{logId}", async () => {
    const winners = Array.from({ length: 20 }, (_, i) => makeLog({ id: `L${i}`, revision: 1, serviceAddress: `${i} Winner St` }));
    const differingLosers = winners.map((w, i) => ({ ...w, revision: 0, serviceAddress: `${i} Stray St` }));
    fake.data = shopDoc([...differingLosers, ...winners]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const newLog = makeLog({ id: "N" });
    await enqueueLogOutbox(SHOP, newLog);
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    // All 20 winners + newLog live in shops/SHOP1/logs/{logId}.
    expect(fake.subLogs.size).toBe(21);
    for (const w of winners) {
      expect(fake.subLogs.get(w.id)).toEqual(w);
    }
    expect(fake.subLogs.get("N")).toEqual(newLog);
    // 5 drain batches (removing 8 entries each from 40 -> 32 -> 24 -> 16 -> 8 -> 0) + 1 final write = 6 writes.
    expect(fake.writes).toHaveLength(6);
    expect((fake.writes[0].logs as ApplicationLog[]).length).toBe(32);
    expect((fake.writes[1].logs as ApplicationLog[]).length).toBe(24);
    expect((fake.writes[2].logs as ApplicationLog[]).length).toBe(16);
    expect((fake.writes[3].logs as ApplicationLog[]).length).toBe(8);
    expect((fake.writes[4].logs as ApplicationLog[]).length).toBe(0);
    expect(fake.writes[5].logs).toEqual([]);
    // Set-aside recorded each of the 20 differing losers once.
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual(differingLosers);
  });

  it("#215: per-log updates and deletions only write/delete changed docs in shops/{shopId}/logs/{logId}", async () => {
    const a = makeLog({ id: "a", serviceAddress: "1 A St" });
    const b = makeLog({ id: "b", serviceAddress: "2 B St" });
    fake.data = shopDoc([]);
    fake.subLogs.set("a", clone(a) as unknown as Record<string, unknown>);
    fake.subLogs.set("b", clone(b) as unknown as Record<string, unknown>);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const got = await store.getShop();
    if (!got.ok) throw new Error(got.error);
    expect(got.value.logs).toEqual([a, b]);

    // Update "a" and delete "b" in one putShop call.
    const aUpdated = { ...a, revision: 1, serviceAddress: "1 Updated St" };
    const put = await store.putShop({ ...got.value, logs: [aUpdated] });
    expect(put.ok).toBe(true);
    expect(fake.subLogs.get("a")).toEqual(aUpdated);
    expect(fake.subLogs.has("b")).toBe(false);
    expect(fake.logWrites).toEqual([
      { id: "a", data: aUpdated as unknown as Record<string, unknown> },
      { id: "b", data: null },
    ]);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].logs).toEqual([]);
  });

  it("#228 (Lawgical): when a cleanup write is refused, every copy is kept and the blocked save stays queued with lastError", async () => {
    const v = versions();
    const initialLogs = [v.rev2, v.reviewedRev0];
    fake.data = shopDoc(initialLogs);
    fake.failWrite = new Error("Missing or insufficient permissions.");
    const store = new RemoteShopStore(CONFIG, SHOP);
    const saved = makeLog({ id: "N", serviceAddress: "99 Pending St" });

    // 1) Direct save path (syncLogToRemote): queues first, migration/cleanup is refused, entry stays queued with lastError.
    const sync = await syncLogToRemote(store, SHOP, saved);
    expect(sync).toEqual({
      ok: false,
      error: "Missing or insufficient permissions.",
      queued: true,
    });
    expect(fake.writes).toEqual([]);
    expect(fake.subLogs.size).toBe(0);
    expect((fake.data as unknown as ShopDocument).logs).toEqual(initialLogs);
    expect(outboxEntriesForShop(SHOP)).toMatchObject([
      { shopId: SHOP, log: saved, lastError: "Missing or insufficient permissions." },
    ]);
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual([v.rev2]);

    // 2) Retry flush path (flushLogOutbox): still refused -> stays queued with lastError, remote copies untouched.
    const flushedRefused = await flushLogOutbox(store, SHOP);
    expect(flushedRefused).toEqual({
      ok: false,
      flushed: 0,
      remaining: 1,
      error: "Missing or insufficient permissions.",
    });
    expect(fake.writes).toEqual([]);
    expect(fake.subLogs.size).toBe(0);
    expect((fake.data as unknown as ShopDocument).logs).toEqual(initialLogs);
    expect(outboxEntriesForShop(SHOP)).toMatchObject([
      { shopId: SHOP, log: saved, lastError: "Missing or insufficient permissions." },
    ]);

    // 3) Once the refusal clears, the queued save flushes cleanly and no records are lost.
    fake.failWrite = null;
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
    expect(fake.subLogs.get("L1")).toEqual(v.reviewedRev0);
    expect(fake.subLogs.get("N")).toEqual(saved);
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes[1].logs).toEqual([]);
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual([v.rev2]);
  });
});

const {
  findReviewedCopyConflicts,
  loadReviewedCopyConflicts,
  reviewedCopiesNote,
  reviewedCopiesNoteFor,
  REVIEWED_COPIES_KEY,
} = await import("./reviewedCopies");

describe("#212: reviewed copies that don't match (office note)", () => {
  const REVISION_TEXT =
    "Needs a look: the shop data has two reviewed versions of this log that don't match. This app shows the higher revision. The other is set aside and kept in the backup JSON.";
  const OTHER_TEXT =
    "Needs a look: the shop data has two reviewed versions of this log that don't match. This app shows the one picked by revision and review date. The other is set aside and kept in the backup JSON.";

  it("texts are Lawgical's, word for word", () => {
    expect(reviewedCopiesNote("revision")).toBe(REVISION_TEXT);
    expect(reviewedCopiesNote("other")).toBe(OTHER_TEXT);
  });

  it("winner picked by revision → the 'higher revision' text", () => {
    const v = versions();
    expect(findReviewedCopyConflicts([v.reviewedRev0, v.reviewedRev1])).toEqual({ L1: "revision" });
  });

  it("winner picked by reviewedAt → the 'revision and review date' text", () => {
    const v = versions();
    expect(findReviewedCopyConflicts([v.reviewedEarly, v.reviewedLate])).toEqual({ L1: "other" });
  });

  it("winner picked by changedAt or array order → the 'revision and review date' text", () => {
    const v = versions();
    const stamp = (l: ApplicationLog) => ({ ...l, reviewedAt: v.reviewedRev0.reviewedAt, reviewedBy: v.reviewedRev0.reviewedBy });
    expect(compareDuplicateCopies(stamp(v.rev1Late), stamp(v.rev1Early))).toBeGreaterThan(0); // decided by changedAt
    expect(findReviewedCopyConflicts([stamp(v.rev1Early), stamp(v.rev1Late)])).toEqual({ L1: "other" });
    const a = v.reviewedRev0;
    const b = { ...v.reviewedRev0, serviceAddress: "Elsewhere" }; // same stamps: array order
    expect(compareDuplicateCopies(a, b)).toBe(0);
    expect(findReviewedCopyConflicts([a, b])).toEqual({ L1: "other" });
  });

  it("mixed: one copy lost on revision, another on review date → 'other'", () => {
    const v = versions();
    const lateRev1 = { ...v.reviewedRev1, reviewedAt: v.reviewedLate.reviewedAt };
    expect(findReviewedCopyConflicts([v.reviewedRev0, lateRev1, v.reviewedRev1])).toEqual({ L1: "other" });
  });

  it("no note for exact copies, or when only one copy is reviewed", () => {
    const v = versions();
    expect(findReviewedCopyConflicts([v.reviewedRev0, clone(v.reviewedRev0)])).toEqual({});
    expect(findReviewedCopyConflicts([v.reviewedRev0, v.rev2])).toEqual({});
    expect(findReviewedCopyConflicts([v.rev1, v.rev2])).toEqual({});
    expect(findReviewedCopyConflicts([v.reviewedRev0, makeLog({ id: "o" })])).toEqual({});
  });

  it("recorded on shared reads (per shop), survives a new store instance, clears once the duplicate is gone", async () => {
    const v = versions();
    fake.data = shopDoc([v.reviewedRev0, v.reviewedRev1, v.rev2]);
    await new RemoteShopStore(CONFIG, SHOP).getShop();
    expect(loadReviewedCopyConflicts(SHOP)).toEqual({ L1: "revision" });
    expect(loadReviewedCopyConflicts()).toEqual({ L1: "revision" }); // current session shop
    expect(reviewedCopiesNoteFor("L1")).toBe(REVISION_TEXT);
    expect(reviewedCopiesNoteFor("other")).toBeNull();
    expect(loadReviewedCopyConflicts("OTHERSHOP")).toEqual({});

    // A write migrates the winner to shops/SHOP1/logs/L1 and keeps the reviewed loser in shops/SHOP1.logs (#208): still flagged.
    const store = new RemoteShopStore(CONFIG, SHOP);
    await enqueueLogOutbox(SHOP, makeLog({ id: "N" }));
    expect(await flushLogOutbox(store, SHOP)).toMatchObject({ ok: true });
    expect(loadReviewedCopyConflicts(SHOP)).toEqual({ L1: "revision" });

    // The doc no longer holds the duplicate (e.g. fixed on the server): next read clears it.
    fake.data = shopDoc([], { updatedAt: "2026-10-03T00:00:00.000Z" });
    fake.subLogs.clear();
    fake.subLogs.set("L1", clone(v.reviewedRev1) as unknown as Record<string, unknown>);
    fake.subLogs.set("N", clone(makeLog({ id: "N" })) as unknown as Record<string, unknown>);
    await new RemoteShopStore(CONFIG, SHOP).getShop();
    expect(loadReviewedCopyConflicts(SHOP)).toEqual({});
    expect(storage.getItem(REVIEWED_COPIES_KEY)).toBeNull();
  });

  it("an identical or unreviewed duplicate in the shop doc records nothing", async () => {
    const v = versions();
    fake.data = shopDoc([v.reviewedRev0, clone(v.reviewedRev0), v.rev2]);
    await new RemoteShopStore(CONFIG, SHOP).getShop();
    expect(storage.getItem(REVIEWED_COPIES_KEY)).toBeNull();
  });
});
