import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBackup,
  applyCorrection,
  buildBackup,
  loadLogs,
  loadSetAsideCopies,
  markLogReviewed,
  parseBackup,
  saveLogs,
  upsertLog,
  SET_ASIDE_KEY,
} from "../storage";
import { makeLog, makeShopProduct } from "../test/fixtures";
import { MemoryStorage } from "../test/memoryStorage";
import type { ApplicationLog, Person } from "../types";
import { keepDeviceCopy, listSyncConflicts, SET_ASIDE_CONFIRM, takeShopCopy } from "./conflicts";
import { LOG_OUTBOX_KEY, outboxEntriesForShop, REMOTE_COPY_KEPT_ERROR, syncLogToRemote } from "./logOutbox";
import type { RemoteShopStore } from "./RemoteShopStore";
import { SHOP_SESSION_KEY } from "./session";
import type { ShopDocument, ShopStoreResult } from "./types";

// Scope: conflict screen record-keeping rules (Lawgical). TZ America/Chicago.

const SHOP = "SHOP1";
const NOW = new Date(2026, 9, 17, 19, 30);
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
  { id: "p-ben", name: "Ben Tech", licenseNumber: "TX-8", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const CATALOG = [makeShopProduct()];
const BANNED =
  /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  storage.setItem(
    SHOP_SESSION_KEY,
    JSON.stringify({ shopId: SHOP, role: "office", verifiedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function fakeRemote(initial: ApplicationLog[]) {
  let doc: ShopDocument = {
    version: "1",
    updatedAt: "2026-10-01T00:00:00.000Z",
    logs: clone(initial),
    catalog: [],
    people: [],
    settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
    ownerUid: "owner",
  };
  const putShop = vi.fn(async (next: ShopDocument): Promise<ShopStoreResult<{ updatedAt: string }>> => {
    doc = clone(next);
    return { ok: true, value: { updatedAt: "2026-10-18T00:30:00.000Z" } };
  });
  const getShop = vi.fn(async () => ({ ok: true as const, value: clone(doc) }));
  return { remote: { mode: "shared", getShop, putShop } as unknown as RemoteShopStore, putShop, doc: () => doc };
}

function versions() {
  saveLogs([makeLog({ id: "L1" })]);
  const rev0 = loadLogs()[0];
  const fix = (patch: Partial<ApplicationLog>, reason: string) => {
    const res = applyCorrection("L1", { ...loadLogs()[0], ...patch }, { changedBy: "p-ana", reason, people: PEOPLE, now: NOW });
    if (!res.ok) throw new Error(res.error);
    return res.log;
  };
  const rev1 = fix({ serviceAddress: "101 Main St" }, "first");
  const rev2 = fix({ dateUsed: "2026-08-31" }, "second");
  saveLogs([rev0]);
  const split1 = fix({ serviceAddress: "102 Main St" }, "other");
  saveLogs([rev0]);
  markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
  const rev0Reviewed = loadLogs()[0];
  storage.removeItem("jobber-pest-logger:logs:v1");
  return { rev0, rev1, rev2, split1, rev0Reviewed };
}

/** Device saves `local`, sync is refused by a remote holding `shopCopy`. */
async function conflictSetup(local: ApplicationLog, shopCopy: ApplicationLog) {
  saveLogs([local]);
  const fake = fakeRemote([shopCopy]);
  const res = await syncLogToRemote(fake.remote, SHOP, local);
  expect(res).toMatchObject({ ok: false, error: REMOTE_COPY_KEPT_ERROR });
  const [entry] = listSyncConflicts(SHOP);
  expect(entry.log).toEqual(local);
  fake.putShop.mockClear();
  return { ...fake, entry };
}

describe("Take shop copy", () => {
  it("sets aside this device's copy, adopts the shop copy, drops the rejected upload", async () => {
    const v = versions();
    const { remote, entry, putShop } = await conflictSetup(v.rev1, v.rev2);
    const res = await takeShopCopy(remote, SHOP, entry, { setAsideBy: "p-ben", people: PEOPLE, now: NOW });
    expect(res.ok).toBe(true);

    expect(loadLogs()).toEqual([v.rev2]); // device now has the shop copy
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
    expect(putShop).not.toHaveBeenCalled(); // shop copy untouched
    const [aside] = loadSetAsideCopies();
    expect(aside).toMatchObject({
      logId: "L1",
      setAsideAt: "2026-10-17T19:30:00-05:00",
      setAsideBy: "Ben Tech",
      shopId: SHOP,
    });
    expect(aside.deviceCopy).toEqual(v.rev1); // full device copy, incl. its history
  });

  it("the set-aside copy is in the backup JSON export", async () => {
    const v = versions();
    const { remote, entry } = await conflictSetup(v.rev1, v.rev2);
    await takeShopCopy(remote, SHOP, entry, { setAsideBy: "p-ben", people: PEOPLE, now: NOW });
    const json = JSON.parse(JSON.stringify(buildBackup())) as { setAside: Array<{ deviceCopy: ApplicationLog; setAsideBy: string }> };
    expect(json.setAside).toHaveLength(1);
    expect(json.setAside[0].deviceCopy).toEqual(v.rev1);
    expect(json.setAside[0].setAsideBy).toBe("Ben Tech");
  });

  it("also sets aside the saved local copy when it differs from the rejected upload", async () => {
    const v = versions();
    const { remote, entry } = await conflictSetup(v.rev1, v.rev2);
    saveLogs([{ ...v.rev1, jobberJobNumber: "LATER-EDIT" }]);
    await takeShopCopy(remote, SHOP, entry, { setAsideBy: "p-ben", people: PEOPLE, now: NOW });
    expect(loadSetAsideCopies().map((c) => c.deviceCopy.jobberJobNumber)).toEqual(["", "LATER-EDIT"]);
  });

  it("requires who did it; on failure nothing changes", async () => {
    const v = versions();
    const { remote, entry } = await conflictSetup(v.rev1, v.rev2);
    const res = await takeShopCopy(remote, SHOP, entry, { setAsideBy: "", people: PEOPLE, now: NOW });
    expect(res).toEqual({ ok: false, error: "Choose who is setting this copy aside from People." });
    expect(loadLogs()).toEqual([v.rev1]);
    expect(listSyncConflicts(SHOP)).toHaveLength(1);
    expect(loadSetAsideCopies()).toEqual([]);
  });
});

describe("Set-aside copies survive restore", () => {
  async function withOneSetAside() {
    const v = versions();
    const { remote, entry } = await conflictSetup(v.rev1, v.rev2);
    await takeShopCopy(remote, SHOP, entry, { setAsideBy: "p-ben", people: PEOPLE, now: NOW });
    return v;
  }

  it("restore round-trip into a fresh device keeps set-aside copies", async () => {
    await withOneSetAside();
    const before = loadSetAsideCopies();
    const json = JSON.stringify(buildBackup());
    storage.clear();
    const parsed = parseBackup(JSON.parse(json));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(applyBackup(parsed.backup).ok).toBe(true);
    expect(loadSetAsideCopies()).toEqual(before);
  });

  it("restore merges with this device's own set-aside copies (drops neither)", async () => {
    await withOneSetAside();
    const json = JSON.stringify(buildBackup());
    const fromBackup = loadSetAsideCopies()[0];
    storage.removeItem(SET_ASIDE_KEY);
    // Device has a different set-aside entry of its own.
    const v = versions();
    const { remote, entry } = await conflictSetup(v.split1, v.rev1);
    await takeShopCopy(remote, SHOP, entry, { setAsideBy: "p-ana", people: PEOPLE, now: NOW });
    const own = loadSetAsideCopies()[0];
    const parsed = parseBackup(JSON.parse(json));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(applyBackup(parsed.backup).ok).toBe(true);
    expect(loadSetAsideCopies()).toEqual([own, fromBackup]);
    // Restoring the same backup again does not duplicate.
    expect(applyBackup(parsed.backup).ok).toBe(true);
    expect(loadSetAsideCopies()).toHaveLength(2);
  });

  it("an older backup without setAside leaves the device's set-aside copies alone", async () => {
    await withOneSetAside();
    const before = storage.getItem(SET_ASIDE_KEY);
    const parsed = parseBackup({
      version: "1.2",
      exportedAt: "2026-09-01T12:00:00.000Z",
      logs: [],
      catalog: [],
      people: [],
      settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(applyBackup(parsed.backup).ok).toBe(true);
    expect(storage.getItem(SET_ASIDE_KEY)).toBe(before);
  });

  it("a failed restore rolls the set-aside store back byte-for-byte", async () => {
    await withOneSetAside();
    const json = JSON.stringify(buildBackup());
    const before = storage.getItem(SET_ASIDE_KEY);
    const parsed = parseBackup({ ...JSON.parse(json), setAside: [{ extra: "row" }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const realSet = storage.setItem.bind(storage);
    vi.spyOn(storage, "setItem").mockImplementation((k: string, val: string) => {
      if (k === SET_ASIDE_KEY && val.includes("extra")) throw new Error("QuotaExceededError");
      realSet(k, val);
    });
    expect(applyBackup(parsed.backup).ok).toBe(false);
    expect(storage.getItem(SET_ASIDE_KEY)).toBe(before);
  });

  it("rejects a backup whose setAside is not an array", () => {
    const res = parseBackup({
      version: "1.2",
      exportedAt: "2026-09-01T12:00:00.000Z",
      logs: [],
      catalog: [],
      people: [],
      settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
      setAside: {},
    });
    expect(res).toEqual({ ok: false, error: "Backup set-aside copies must be an array." });
  });
});

describe("Keep this device's copy", () => {
  it("is a correction on top of a reviewed shop copy: revision shop+1, reason, changedBy, per-field diff; review stamp kept", async () => {
    const v = versions();
    const local = { ...v.rev0, targetPestOrPurpose: "Fleas" };
    const { remote, entry, doc } = await conflictSetup(local, v.rev0Reviewed);
    const res = await keepDeviceCopy(remote, SHOP, entry, {
      changedBy: "p-ben",
      reason: "Tech logged fleas on site",
      people: PEOPLE,
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const log = res.log;
    expect(log.revision).toBe(1);
    expect(log.reviewedAt).toBe(v.rev0Reviewed.reviewedAt);
    expect(log.reviewedBy).toBe("Ana Office");
    expect(log.history).toHaveLength(1);
    expect(log.history![0]).toMatchObject({
      revision: 1,
      changedAt: "2026-10-17T19:30:00-05:00",
      changedBy: "Ben Tech",
      reason: "Tech logged fleas on site",
      changes: [{ field: "targetPestOrPurpose", old: "Ants", new: "Fleas" }],
    });
    expect(log.history![0].priorSnapshot).toMatchObject({ reviewedBy: "Ana Office", targetPestOrPurpose: "Ants" });
    expect(doc().logs[0]).toEqual(log); // uploaded
    expect(loadLogs()).toEqual([log]);
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
    expect(loadSetAsideCopies()).toEqual([]); // device had no history the shop lacked
  });

  it("requires a reason and changedBy; nothing is uploaded or changed without them", async () => {
    const v = versions();
    const local = { ...v.rev0, targetPestOrPurpose: "Fleas" };
    const { remote, entry, putShop } = await conflictSetup(local, v.rev0Reviewed);
    for (const [changedBy, reason, error] of [
      ["p-ben", "   ", "Enter a reason for the change."],
      ["", "why", "Choose who made the change from People."],
      ["p-ghost", "why", "Choose who made the change from People."],
    ] as const) {
      expect(await keepDeviceCopy(remote, SHOP, entry, { changedBy, reason, people: PEOPLE, now: NOW })).toEqual({
        ok: false,
        error,
      });
    }
    expect(putShop).not.toHaveBeenCalled();
    expect(loadLogs()).toEqual([local]);
    expect(listSyncConflicts(SHOP)).toHaveLength(1);
  });

  it("no field difference from the shop copy is refused (use Take shop copy)", async () => {
    const v = versions();
    const { remote, entry } = await conflictSetup(v.rev0, v.rev0Reviewed);
    expect(await keepDeviceCopy(remote, SHOP, entry, { changedBy: "p-ben", reason: "x", people: PEOPLE })).toEqual({
      ok: false,
      error: "No fields changed.",
    });
  });

  it("split history: correction on top of the shop's revision, and the device copy is set aside", async () => {
    const v = versions();
    const { remote, entry, doc } = await conflictSetup(v.split1, v.rev2);
    const res = await keepDeviceCopy(remote, SHOP, entry, { changedBy: "p-ana", reason: "Keep 102", people: PEOPLE, now: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.log.revision).toBe(3);
    expect(res.log.history!.map((h) => h.reason)).toEqual(["first", "second", "Keep 102"]);
    expect(res.log.history![2].changes).toEqual(
      expect.arrayContaining([
        { field: "serviceAddress", old: "101 Main St", new: "102 Main St" },
        { field: "dateUsed", old: "2026-08-31", new: "2026-09-01" },
      ]),
    );
    expect(doc().logs[0]).toEqual(res.log);
    const [aside] = loadSetAsideCopies();
    expect(aside.deviceCopy).toEqual(v.split1);
    expect(aside.setAsideBy).toBe("Ana Office");
  });
});

describe("wording", () => {
  it("confirm text is exact and plain", () => {
    expect(SET_ASIDE_CONFIRM).toBe("This device's version will be set aside, not uploaded. It stays in the backup.");
    expect(SET_ASIDE_CONFIRM).not.toMatch(BANNED);
  });
});

describe("Keep this device's copy — shop no longer has the log (re-upload record)", () => {
  async function shopMissingSetup() {
    const v = versions();
    const fake = await conflictSetup(v.rev1, v.rev2);
    fake.doc().logs = []; // shop deleted the log after refusing the upload
    return { v, ...fake };
  }

  it("requires a People pick and a reason; nothing is saved or uploaded without them", async () => {
    const { remote, entry, putShop } = await shopMissingSetup();
    const before = loadLogs();
    expect(await keepDeviceCopy(remote, SHOP, entry, { changedBy: "", reason: "Shop lost it", people: PEOPLE, now: NOW }))
      .toEqual({ ok: false, error: "Choose who made the change from People." });
    expect(await keepDeviceCopy(remote, SHOP, entry, { changedBy: "p-ghost", reason: "Shop lost it", people: PEOPLE, now: NOW }))
      .toEqual({ ok: false, error: "Choose who made the change from People." });
    expect(await keepDeviceCopy(remote, SHOP, entry, { changedBy: "p-ana", reason: "   ", people: PEOPLE, now: NOW }))
      .toEqual({ ok: false, error: "Enter a reason for the change." });
    expect(loadLogs()).toEqual(before);
    expect(putShop).not.toHaveBeenCalled();
  });

  it("uploads this device's copy with who / when / why; no revision bump, not a correction", async () => {
    const { v, remote, entry, doc } = await shopMissingSetup();
    const res = await keepDeviceCopy(remote, SHOP, entry, {
      changedBy: "p-ana",
      reason: " Shop copy was deleted by mistake ",
      people: PEOPLE,
      now: NOW,
    });
    expect(res.ok).toBe(true);
    const [saved] = loadLogs();
    expect(saved.revision).toBe(v.rev1.revision);
    expect(saved.history).toEqual(v.rev1.history);
    expect(saved.reuploads).toEqual([
      { reuploadedAt: "2026-10-17T19:30:00-05:00", reuploadedBy: "Ana Office", reason: "Shop copy was deleted by mistake" },
    ]);
    expect({ ...saved, reuploads: undefined }).toEqual({ ...v.rev1, reuploads: undefined });
    expect(doc().logs.find((l) => l.id === "L1")?.reuploads).toEqual(saved.reuploads);
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });
});

describe("#170 partial failures return the saved logs", () => {
  it("Keep this device's copy: sync fails after the local save → error plus saved logs", async () => {
    const v = versions();
    const { remote, entry, putShop } = await conflictSetup(v.rev1, v.rev2);
    putShop.mockImplementation(async () => ({ ok: false as const, error: "offline" }));
    const res = await keepDeviceCopy(remote, SHOP, entry, {
      changedBy: "p-ana",
      reason: "Keep the tech's address",
      people: PEOPLE,
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.logs).toEqual(loadLogs());
    expect(res.log?.revision).toBe(3);
    expect(loadLogs()[0].revision).toBe(3);

    // A later History edit from the pre-correction copy cannot overwrite the correction.
    const stale = upsertLog({ ...v.rev1, jobberJobNumber: "EDIT" });
    expect(stale).toMatchObject({ saved: false, stale: true });
    expect(loadLogs()[0]).toEqual(res.log);
    // Editing the copy App now holds (res.logs) is fine.
    const fresh = upsertLog({ ...res.logs![0], jobberJobNumber: "EDIT" });
    expect(fresh.saved).toBe(true);
    expect(loadLogs()[0].history).toHaveLength(3);
  });

  it("Take shop copy: upload queue update fails after the local save → error plus saved logs", async () => {
    const v = versions();
    const { remote, entry } = await conflictSetup(v.rev1, v.rev2);
    const realSet = storage.setItem.bind(storage);
    storage.setItem = (k: string, val: string) => {
      if (k === LOG_OUTBOX_KEY) throw new Error("QuotaExceededError");
      realSet(k, val);
    };
    const res = await takeShopCopy(remote, SHOP, entry, { setAsideBy: "p-ben", people: PEOPLE, now: NOW });
    expect(res).toMatchObject({
      ok: false,
      error: "Saved the shop copy, but could not update the upload queue.",
      log: v.rev2,
    });
    if (res.ok) return;
    expect(res.logs).toEqual([v.rev2]);
    expect(loadLogs()).toEqual([v.rev2]);
  });
});
