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

// #209. Firebase is replaced by an in-memory doc at the module boundary so the real
// RemoteShopStore (read path + write plan) runs; storage, outbox, conflicts and export
// code are real.

const fake = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  writes: [] as Record<string, unknown>[],
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
    doc: () => ({}),
    getDoc: async () => snap(),
    setDoc: async () => {},
    runTransaction: async (_db: unknown, fn: (t: unknown) => Promise<void>) => {
      let staged: Record<string, unknown> | null = null;
      await fn({
        get: async () => snap(),
        set: (_ref: unknown, value: Record<string, unknown>) => {
          staged = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
        },
        update: () => {},
      });
      if (fake.failWrite) throw fake.failWrite;
      if (staged) {
        fake.data = staged;
        fake.writes.push(staged);
      }
    },
  };
});

const { compareDuplicateCopies, dedupeLogsById, planDedupedWrite, setAsideDuplicateCopies, DUPLICATE_ID_SET_ASIDE_REASON } =
  await import("./dedupeLogs");
const { RemoteShopStore } = await import("./RemoteShopStore");
const { enqueueLogOutbox, flushLogOutbox, outboxEntriesForShop } = await import("./logOutbox");
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
  fake.writes = [];
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

function shopDoc(logs: ApplicationLog[], extra: Partial<ShopDocument> = {}): Record<string, unknown> {
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
  });

  it("keeps every loser when its set-aside copy wasn't saved", () => {
    const v = versions();
    const stored = [v.rev2, v.reviewedRev0];
    expect(planDedupedWrite(stored, [v.reviewedRev0], false)).toEqual({ cleanup: null, logs: [v.reviewedRev0, v.rev2] });
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
    wipeAllDeviceData();
    expect(storage.getItem(SET_ASIDE_KEY)).toBeNull();
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
  it("outbox flush merges over the winner; cleanup write first, then the change; reviewed loser untouched", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, v.reviewedLate, v.reviewedEarly]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    await enqueueLogOutbox(SHOP, makeLog({ id: "N" }));
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes[0].logs).toEqual([v.reviewedLate, v.reviewedEarly]); // only the removal
    expect(fake.writes[1].logs).toEqual([makeLog({ id: "N" }), v.reviewedLate, v.reviewedEarly]);
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual([v.rev2, v.reviewedEarly]);
    // The next write reuses the written doc: no cleanup again, no extra set-aside rows.
    await enqueueLogOutbox(SHOP, makeLog({ id: "M" }));
    expect(await flushLogOutbox(store, SHOP)).toMatchObject({ ok: true, flushed: 1 });
    expect(fake.writes).toHaveLength(3);
    expect(fake.writes[2].logs).toEqual([makeLog({ id: "M" }), makeLog({ id: "N" }), v.reviewedLate, v.reviewedEarly]);
    expect(setAsideRows()).toHaveLength(2);
  });

  it("an unreviewed device copy is refused against the reviewed winner (conflict screen), not merged over the stray", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    await enqueueLogOutbox(SHOP, v.rev2);
    expect(await flushLogOutbox(store, SHOP)).toMatchObject({ ok: false, error: REMOTE_COPY_KEPT_ERROR });
    expect(outboxEntriesForShop(SHOP)[0].lastError).toBe(REMOTE_COPY_KEPT_ERROR);
    expect(fake.writes).toEqual([]);
  });

  it("if the set-aside can't be saved, putShop leaves every copy in the shop doc", async () => {
    const v = versions();
    storage.setItem(SET_ASIDE_KEY, "{corrupt");
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const got = await store.getShop();
    if (!got.ok) throw new Error(got.error);
    expect(got.value.logs).toEqual([v.reviewedRev0]);
    const put = await store.putShop({ ...got.value, logs: [makeLog({ id: "N" }), ...got.value.logs] });
    expect(put.ok).toBe(true);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].logs).toEqual([makeLog({ id: "N" }), v.reviewedRev0, v.rev2]);
  });

  it("putShop without a prior read re-reads the stored doc so nothing is dropped", async () => {
    const v = versions();
    fake.data = shopDoc([v.rev2, v.reviewedRev0]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const doc = shopDoc([v.reviewedRev0]) as unknown as ShopDocument;
    expect((await store.putShop(doc)).ok).toBe(true);
    expect(fake.writes.map((w) => w.logs)).toEqual([[v.reviewedRev0], [v.reviewedRev0]]);
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual([v.rev2]);
  });

  it("a stale caller doc is a conflict (no write)", async () => {
    fake.data = shopDoc([makeLog({ id: "a" })], { updatedAt: "2026-10-02T00:00:00.000Z" });
    const store = new RemoteShopStore(CONFIG, SHOP);
    const res = await store.putShop(shopDoc([]) as unknown as ShopDocument);
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect(fake.writes).toEqual([]);
  });
});
