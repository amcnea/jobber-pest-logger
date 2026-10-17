import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCorrection, loadLogs, markLogReviewed, saveLogs, shouldKeepDeviceLog, shouldKeepExistingLog } from "../storage";
import { makeLog, makeShopProduct } from "../test/fixtures";
import { MemoryStorage } from "../test/memoryStorage";
import type { ApplicationLog, Person } from "../types";
import {
  flushLogOutbox,
  outboxEntriesForShop,
  REMOTE_COPY_KEPT_ERROR,
  syncLogToRemote,
} from "./logOutbox";
import type { RemoteShopStore } from "./RemoteShopStore";
import { SHOP_SESSION_KEY } from "./session";
import type { ShopDocument, ShopStoreResult } from "./types";

// Scope: shared-sync guard (#164 Major on #161). syncLogToRemote (first write + conflict
// retry) and flushLogOutbox keep a remote log that is ahead, has a split change history,
// or is reviewed while the incoming copy is not — same rule as restore (shouldKeepDeviceLog,
// remote in the device's place). The local copy is never touched and stays queued + flagged.

const SHOP = "SHOP1";
const NOW = new Date(2026, 9, 17, 18, 0);
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
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

function shopDoc(logs: ApplicationLog[]): ShopDocument {
  return {
    version: "1",
    updatedAt: "2026-10-01T00:00:00.000Z",
    logs: clone(logs),
    catalog: [],
    people: [],
    settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
    ownerUid: "owner",
  };
}

type PutResult = ShopStoreResult<{ updatedAt: string }>;

/** gets: docs returned in order (last repeats). puts: scripted results (default ok). */
function fakeRemote(gets: ShopDocument[], puts: PutResult[] = []) {
  let g = 0;
  let p = 0;
  const putDocs: ShopDocument[] = [];
  const getShop = vi.fn(async () => ({ ok: true as const, value: clone(gets[Math.min(g++, gets.length - 1)]) }));
  const putShop = vi.fn(async (doc: ShopDocument): Promise<PutResult> => {
    putDocs.push(clone(doc));
    const scripted = puts[p++];
    return scripted ?? { ok: true, value: { updatedAt: "2026-10-17T23:00:00.000Z" } };
  });
  return { remote: { mode: "shared", getShop, putShop } as unknown as RemoteShopStore, getShop, putShop, putDocs };
}
const conflict: PutResult = { ok: false, error: "Shop changed on another device", conflict: true };

/** Build rev0 / rev1 / rev2 / split-rev1 / reviewed copies of one log through the real storage API. */
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

describe("shared helper", () => {
  it("sync uses the restore rule with the remote in the device's place", () => {
    const v = versions();
    for (const [existing, incoming] of [
      [v.rev2, v.rev1],
      [v.rev1, v.split1],
      [v.rev0Reviewed, v.rev0],
      [v.rev1, v.rev2],
      [v.rev1, v.rev1],
    ] as const) {
      expect(shouldKeepExistingLog(existing, incoming)).toBe(shouldKeepDeviceLog(existing, incoming));
    }
  });
});

describe("shorter history at the same revision", () => {
  it("is refused (existing copy ahead), for restore and sync alike", async () => {
    const v = versions();
    const shorter = { ...v.rev1, history: [] }; // same revision number, history dropped
    expect(shouldKeepDeviceLog(v.rev1, shorter)).toBe(true);
    const { remote, putShop } = fakeRemote([shopDoc([v.rev1])]);
    expect(await syncLogToRemote(remote, SHOP, shorter)).toMatchObject({ ok: false, error: REMOTE_COPY_KEPT_ERROR });
    expect(putShop).not.toHaveBeenCalled();
  });
});

describe("syncLogToRemote — first write", () => {
  it("refuses a stale lower revision: remote kept, nothing put, local copy stays queued + flagged", async () => {
    const v = versions();
    saveLogs([v.rev1]); // this device's (stale) copy
    const { remote, putShop } = fakeRemote([shopDoc([v.rev2])]);
    const res = await syncLogToRemote(remote, SHOP, v.rev1);
    expect(res).toEqual({ ok: false, error: REMOTE_COPY_KEPT_ERROR, queued: true });
    expect(putShop).not.toHaveBeenCalled();
    // Local copy survives untouched and is shown as a conflict on the outbox entry.
    expect(loadLogs()).toEqual([v.rev1]);
    const [entry] = outboxEntriesForShop(SHOP);
    expect(entry.log).toEqual(v.rev1);
    expect(entry.lastError).toBe(REMOTE_COPY_KEPT_ERROR);
  });

  it("refuses a split history", async () => {
    const v = versions();
    const { remote, putShop } = fakeRemote([shopDoc([v.rev1])]);
    expect(await syncLogToRemote(remote, SHOP, v.split1)).toMatchObject({ ok: false, error: REMOTE_COPY_KEPT_ERROR });
    expect(putShop).not.toHaveBeenCalled();
    expect(outboxEntriesForShop(SHOP)[0].log).toEqual(v.split1);
  });

  it("refuses an unreviewed copy that would unlock a reviewed remote log", async () => {
    const v = versions();
    const edited = { ...v.rev0, targetPestOrPurpose: "Fleas" };
    const { remote, putShop } = fakeRemote([shopDoc([v.rev0Reviewed])]);
    expect(await syncLogToRemote(remote, SHOP, edited)).toMatchObject({ ok: false, error: REMOTE_COPY_KEPT_ERROR });
    expect(putShop).not.toHaveBeenCalled();
  });

  it("lets an extension and an equal-history write through", async () => {
    const v = versions();
    const ext = fakeRemote([shopDoc([v.rev1])]);
    expect(await syncLogToRemote(ext.remote, SHOP, v.rev2)).toEqual({ ok: true });
    expect(ext.putDocs[0].logs[0]).toEqual(v.rev2);

    const edited = { ...v.rev1, jobberJobNumber: "J-9" };
    const eq = fakeRemote([shopDoc([v.rev1])]);
    expect(await syncLogToRemote(eq.remote, SHOP, edited)).toEqual({ ok: true });
    expect(eq.putDocs[0].logs[0].jobberJobNumber).toBe("J-9");
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });
});

describe("syncLogToRemote — conflict retry", () => {
  it("refuses on retry when the re-read remote is now ahead", async () => {
    const v = versions();
    const { remote, putShop } = fakeRemote([shopDoc([v.rev1]), shopDoc([v.rev2])], [conflict]);
    expect(await syncLogToRemote(remote, SHOP, { ...v.rev1, jobberJobNumber: "J-9" })).toMatchObject({
      ok: false,
      error: REMOTE_COPY_KEPT_ERROR,
      queued: true,
    });
    expect(putShop).toHaveBeenCalledTimes(1); // only the first (conflicted) put
    expect(outboxEntriesForShop(SHOP)[0].lastError).toBe(REMOTE_COPY_KEPT_ERROR);
  });

  it("refuses on retry when the re-read remote has a split history", async () => {
    const v = versions();
    const { remote, putShop } = fakeRemote([shopDoc([v.rev0]), shopDoc([v.split1])], [conflict]);
    expect(await syncLogToRemote(remote, SHOP, v.rev1)).toMatchObject({ ok: false, error: REMOTE_COPY_KEPT_ERROR });
    expect(putShop).toHaveBeenCalledTimes(1);
  });

  it("refuses on retry when the re-read remote was reviewed meanwhile", async () => {
    const v = versions();
    const { remote, putShop } = fakeRemote([shopDoc([v.rev0]), shopDoc([v.rev0Reviewed])], [conflict]);
    expect(await syncLogToRemote(remote, SHOP, { ...v.rev0, targetPestOrPurpose: "Fleas" })).toMatchObject({
      ok: false,
      error: REMOTE_COPY_KEPT_ERROR,
    });
    expect(putShop).toHaveBeenCalledTimes(1);
  });

  it("an extension still goes through on retry", async () => {
    const v = versions();
    const { remote, putDocs } = fakeRemote([shopDoc([v.rev0]), shopDoc([v.rev1])], [conflict]);
    expect(await syncLogToRemote(remote, SHOP, v.rev2)).toEqual({ ok: true });
    expect(putDocs[1].logs[0]).toEqual(v.rev2);
    expect(outboxEntriesForShop(SHOP)).toEqual([]);
  });
});

describe("flushLogOutbox — queued entries", () => {
  it("keeps a remote that is ahead, flushes the others, and leaves the refused entry flagged", async () => {
    const v = versions();
    const { remote: offline } = { remote: { getShop: async () => ({ ok: false, error: "offline" }) } as unknown as RemoteShopStore };
    await syncLogToRemote(offline, SHOP, v.rev1); // queued (stale vs remote below)
    await syncLogToRemote(offline, SHOP, makeLog({ id: "NEW" }));
    const { remote, putDocs } = fakeRemote([shopDoc([v.rev2])]);
    const res = await flushLogOutbox(remote, SHOP);
    expect(res).toMatchObject({ ok: false, flushed: 1, remaining: 1, error: REMOTE_COPY_KEPT_ERROR });
    expect(putDocs[0].logs.map((l) => l.id)).toEqual(["NEW", "L1"]);
    expect(putDocs[0].logs[1]).toEqual(v.rev2);
    const [left] = outboxEntriesForShop(SHOP);
    expect(left.log).toEqual(v.rev1);
    expect(left.lastError).toBe(REMOTE_COPY_KEPT_ERROR);
  });

  it("only refused entries: nothing is put", async () => {
    const v = versions();
    const offline = { getShop: async () => ({ ok: false, error: "offline" }) } as unknown as RemoteShopStore;
    await syncLogToRemote(offline, SHOP, { ...v.rev0, targetPestOrPurpose: "Fleas" });
    const { remote, putShop } = fakeRemote([shopDoc([v.rev0Reviewed])]);
    expect(await flushLogOutbox(remote, SHOP)).toMatchObject({ ok: false, flushed: 0, remaining: 1 });
    expect(putShop).not.toHaveBeenCalled();
  });
});

describe("wording", () => {
  it("conflict text is plain and avoids loaded terms", () => {
    expect(REMOTE_COPY_KEPT_ERROR).toBe(
      "Sync conflict: the shop has a newer or reviewed copy of this log, so this device's copy was not uploaded. It stays saved here.",
    );
    expect(REMOTE_COPY_KEPT_ERROR).not.toMatch(BANNED);
  });
});
