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

const { compareDuplicateCopies, dedupeLogsById, planDedupedWrite, setAsideDuplicateCopies, DUPLICATE_ID_SET_ASIDE_REASON, MAX_DEDUPE_CLEANUP_BATCH } =
  await import("./dedupeLogs");
const { RemoteShopStore } = await import("./RemoteShopStore");
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

  it("#228: batches >9 (20) held differing duplicate removals into <=8-copy cleanup writes before saving", async () => {
    const winners = Array.from({ length: 20 }, (_, i) => makeLog({ id: `L${i}`, revision: 1, serviceAddress: `${i} Winner St` }));
    const differingLosers = winners.map((w, i) => ({ ...w, revision: 0, serviceAddress: `${i} Stray St` }));
    fake.data = shopDoc([...differingLosers, ...winners]);
    const store = new RemoteShopStore(CONFIG, SHOP);
    const newLog = makeLog({ id: "N" });
    await enqueueLogOutbox(SHOP, newLog);
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    // 3 cleanup batches (8, 8, 4) + 1 final write = 4 writes.
    expect(fake.writes).toHaveLength(4);
    expect((fake.writes[0].logs as ApplicationLog[]).length).toBe(32);
    expect((fake.writes[1].logs as ApplicationLog[]).length).toBe(24);
    expect((fake.writes[2].logs as ApplicationLog[]).length).toBe(20);
    for (let b = 0; b < 3; b++) {
      const batchLogs = fake.writes[b].logs as ApplicationLog[];
      const kept = fake.writes[b].keptCopyAt as Record<string, number>;
      expect(Object.keys(kept).length).toBe(b < 2 ? 8 : 4);
      for (const [id, idx] of Object.entries(kept)) {
        expect(batchLogs[idx].id).toBe(id);
      }
    }
    // Final write carries the caller's new log and drops keptCopyAt.
    expect(fake.writes[3].keptCopyAt).toBeUndefined();
    expect(fake.writes[3].logs).toEqual([newLog, ...winners]);
    // Set-aside recorded each of the 20 differing losers once (no duplicates across batches).
    expect(setAsideRows().map((r) => r.deviceCopy)).toEqual(differingLosers);
  });

  it("#228 (Lawgical): when a cleanup write is refused, every copy is kept and the blocked save stays queued with lastError", async () => {
    const v = versions();
    const initialLogs = [v.rev2, v.reviewedRev0];
    fake.data = shopDoc(initialLogs);
    fake.failWrite = new Error("Missing or insufficient permissions.");
    const store = new RemoteShopStore(CONFIG, SHOP);
    const saved = makeLog({ id: "N", serviceAddress: "99 Pending St" });

    // 1) Direct save path (syncLogToRemote): queues first, cleanup is refused, entry stays queued with lastError.
    const sync = await syncLogToRemote(store, SHOP, saved);
    expect(sync).toEqual({
      ok: false,
      error: "Missing or insufficient permissions.",
      queued: true,
    });
    expect(fake.writes).toEqual([]);
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
    expect((fake.data as unknown as ShopDocument).logs).toEqual(initialLogs);
    expect(outboxEntriesForShop(SHOP)).toMatchObject([
      { shopId: SHOP, log: saved, lastError: "Missing or insufficient permissions." },
    ]);

    // 3) Once the refusal clears, the queued save flushes cleanly and no records are lost.
    fake.failWrite = null;
    expect(await flushLogOutbox(store, SHOP)).toEqual({ ok: true, flushed: 1, remaining: 0 });
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes[1].logs).toEqual([saved, v.reviewedRev0]);
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

    // A write keeps the reviewed loser in the doc (#208): still flagged.
    const store = new RemoteShopStore(CONFIG, SHOP);
    await enqueueLogOutbox(SHOP, makeLog({ id: "N" }));
    expect(await flushLogOutbox(store, SHOP)).toMatchObject({ ok: true });
    expect(loadReviewedCopyConflicts(SHOP)).toEqual({ L1: "revision" });

    // The doc no longer holds the duplicate (e.g. fixed on the server): next read clears it.
    fake.data = shopDoc([v.reviewedRev1, makeLog({ id: "N" })], { updatedAt: "2026-10-03T00:00:00.000Z" });
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
