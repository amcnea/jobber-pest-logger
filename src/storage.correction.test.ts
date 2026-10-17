import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localIsoWithOffset } from "./dates";
import {
  applyBackup,
  applyCorrection,
  BACKUP_VERSION,
  buildBackup,
  diffLogs,
  loadLogs,
  loadLogsQuarantine,
  markLogReviewed,
  normalizeLog,
  parseBackup,
  parseShopSections,
  restoredKeptReport,
  restoreHistoryMessage,
  saveLogs,
  upsertLog,
} from "./storage";
import { enqueueLogOutbox, loadLogOutbox, syncLogToRemote } from "./shop/logOutbox";
import type { RemoteShopStore } from "./shop/RemoteShopStore";
import { SHOP_SESSION_KEY } from "./shop/session";
import type { ShopDocument } from "./shop/types";
import { MemoryStorage } from "./test/memoryStorage";
import { makeApplied, makeLog, makeShopProduct } from "./test/fixtures";
import type { ApplicationLog, Person } from "./types";

// Scope: correction history 2/4 — lock on review + revision/history model in storage.ts.
// TZ is America/Chicago (vitest config); offset tests switch process.env.TZ at runtime.

const NOW = new Date(2026, 9, 17, 17, 5, 0); // Sat Oct 17 2026, 5:05 PM CDT (-05:00)
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
  { id: "p-ben", name: "Ben Tech", licenseNumber: "TX-8", roleTags: ["applying"], licenseExpiry: "", ceDueDate: "" },
];
const CATALOG = [makeShopProduct()];

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seed(...logs: ApplicationLog[]) {
  expect(saveLogs(logs)).toBe(true);
}

function legacyRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  // A pre-2/4 stored row: no revision / history / review fields at all.
  const { revision: _r, history: _h, ...rest } = makeLog({ id: "legacy" });
  return { ...rest, ...over };
}

function corrected(id = "L1"): ApplicationLog {
  return seedAndCorrect(id).log;
}

function seedAndCorrect(id = "L1") {
  seed(makeLog({ id }));
  const next = { ...makeLog({ id }), serviceAddress: "101 Main St" };
  const res = applyCorrection(id, next, {
    changedBy: "p-ana",
    reason: "Typo in house number",
    people: PEOPLE,
    now: NOW,
  });
  if (!res.ok) throw new Error(res.error);
  return res;
}

describe("localIsoWithOffset (non-UTC zones, never Z)", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it("Chicago CDT and CST", () => {
    expect(localIsoWithOffset(new Date(2026, 9, 17, 17, 5, 0))).toBe("2026-10-17T17:05:00-05:00");
    expect(localIsoWithOffset(new Date(2026, 0, 5, 8, 0, 9))).toBe("2026-01-05T08:00:09-06:00");
  });

  it("half-hour positive offset and UTC", () => {
    const instant = new Date("2026-10-17T22:05:00.000Z");
    process.env.TZ = "Asia/Kolkata";
    expect(localIsoWithOffset(instant)).toBe("2026-10-18T03:35:00+05:30");
    process.env.TZ = "UTC";
    expect(localIsoWithOffset(instant)).toBe("2026-10-17T22:05:00+00:00");
    process.env.TZ = "America/Los_Angeles";
    expect(localIsoWithOffset(instant)).toBe("2026-10-17T15:05:00-07:00");
  });

  it("round-trips to the same instant", () => {
    const iso = localIsoWithOffset(NOW);
    expect(new Date(iso).getTime()).toBe(NOW.getTime());
    expect(iso.endsWith("Z")).toBe(false);
  });
});

describe("normalizeLog — legacy and model fields", () => {
  it("legacy log without the model gets revision 0 and history []", () => {
    const log = normalizeLog(legacyRaw());
    expect(log).not.toBeNull();
    expect(log!.revision).toBe(0);
    expect(log!.history).toEqual([]);
    expect(log!.reviewedAt).toBeUndefined();
    expect(log!.reviewedBy).toBeUndefined();
  });

  it("legacy rows load from storage without quarantine", () => {
    storage.setItem("jobber-pest-logger:logs:v1", JSON.stringify([legacyRaw()]));
    expect(loadLogs().map((l) => [l.id, l.revision, l.history])).toEqual([["legacy", 0, []]]);
    expect(loadLogsQuarantine()).toEqual([]);
  });

  it("keeps review fields when both are present", () => {
    const log = normalizeLog(
      legacyRaw({ reviewedAt: "2026-10-17T17:05:00-05:00", reviewedBy: " Ana Office " }),
    );
    expect(log).toMatchObject({ reviewedAt: "2026-10-17T17:05:00-05:00", reviewedBy: "Ana Office" });
  });

  it("rejects a half-set review pair, bad revision, or malformed history (fail closed)", () => {
    expect(normalizeLog(legacyRaw({ reviewedAt: "2026-10-17T17:05:00-05:00" }))).toBeNull();
    expect(normalizeLog(legacyRaw({ reviewedBy: "Ana" }))).toBeNull();
    expect(normalizeLog(legacyRaw({ reviewedAt: "not a date", reviewedBy: "Ana" }))).toBeNull();
    expect(normalizeLog(legacyRaw({ revision: -1 }))).toBeNull();
    expect(normalizeLog(legacyRaw({ revision: 1.5 }))).toBeNull();
    expect(normalizeLog(legacyRaw({ history: "nope" }))).toBeNull();
    expect(normalizeLog(legacyRaw({ history: [{ revision: 1 }] }))).toBeNull();
  });

  it("missing revision with history present defaults to history length", () => {
    const log = corrected();
    const { revision: _r, ...raw } = JSON.parse(JSON.stringify(log)) as Record<string, unknown>;
    expect(normalizeLog(raw)!.revision).toBe(1);
  });
});

describe("markLogReviewed (lock on review)", () => {
  it("locks a log with zero flags, stamping offset time and roster name", () => {
    seed(makeLog({ id: "L1" }));
    const res = markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
    expect(res.ok).toBe(true);
    const stored = loadLogs()[0];
    expect(stored.reviewedAt).toBe("2026-10-17T17:05:00-05:00");
    expect(stored.reviewedBy).toBe("Ana Office");
  });

  it("refuses while the log has review-queue flags", () => {
    seed(makeLog({ id: "L1", serviceAddress: " " }));
    const res = markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
    expect(res).toMatchObject({ ok: false, error: "Clear the Review queue items on this log first." });
    expect(loadLogs()[0].reviewedAt).toBeUndefined();
  });

  it("refuses when the product was removed from the shop list (a flag)", () => {
    seed(makeLog({ id: "L1" }));
    const res = markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: [], now: NOW });
    expect(res.ok).toBe(false);
  });

  it("requires a roster person and a known log; no double review", () => {
    seed(makeLog({ id: "L1" }));
    const base = { people: PEOPLE, catalog: CATALOG, now: NOW };
    expect(markLogReviewed("L1", { ...base, reviewedBy: "" }).ok).toBe(false);
    expect(markLogReviewed("L1", { ...base, reviewedBy: "Ana Office" }).ok).toBe(false); // name ≠ id
    expect(markLogReviewed("nope", { ...base, reviewedBy: "p-ana" }).ok).toBe(false);
    expect(markLogReviewed("L1", { ...base, reviewedBy: "p-ana" }).ok).toBe(true);
    expect(markLogReviewed("L1", { ...base, reviewedBy: "p-ben" })).toMatchObject({
      ok: false,
      error: "This log is already reviewed.",
    });
    expect(loadLogs()[0].reviewedBy).toBe("Ana Office");
  });

  it("a reviewed log cannot be edited in place through upsertLog", () => {
    seed(makeLog({ id: "L1" }));
    markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
    const res = upsertLog({ ...loadLogs()[0], serviceAddress: "999 Elsewhere" });
    expect(res).toMatchObject({ saved: false, locked: true });
    expect(loadLogs()[0].serviceAddress).toBe("100 Main St");
    // New logs still save.
    expect(upsertLog(makeLog({ id: "L2" })).saved).toBe(true);
  });
});

describe("applyCorrection — validation", () => {
  beforeEach(() => seed(makeLog({ id: "L1" })));
  const next = () => ({ ...makeLog({ id: "L1" }), targetPestOrPurpose: "Roaches" });

  it("rejects a blank / whitespace reason", () => {
    for (const reason of ["", "   ", "\n\t"]) {
      expect(applyCorrection("L1", next(), { changedBy: "p-ana", reason, people: PEOPLE })).toMatchObject({
        ok: false,
        error: "Enter a reason for the change.",
      });
    }
  });

  it("rejects a missing or unknown changedBy", () => {
    for (const changedBy of ["", "  ", "p-ghost"]) {
      expect(applyCorrection("L1", next(), { changedBy, reason: "r", people: PEOPLE }).ok).toBe(false);
    }
  });

  it("rejects no actual change (bookkeeping-only differences don't count)", () => {
    const same = { ...makeLog({ id: "L1" }), createdAt: "1999-01-01T00:00:00Z", revision: 7, history: [] };
    expect(applyCorrection("L1", same, { changedBy: "p-ana", reason: "r", people: PEOPLE })).toMatchObject({
      ok: false,
      error: "No fields changed.",
    });
  });

  it("rejects an unknown log, id mismatch, or unreadable log", () => {
    const opts = { changedBy: "p-ana", reason: "r", people: PEOPLE };
    expect(applyCorrection("nope", next(), opts).ok).toBe(false);
    expect(applyCorrection("L1", { ...next(), id: "L2" }, opts).ok).toBe(false);
    expect(applyCorrection("L1", { ...next(), products: [{} as never] }, opts).ok).toBe(false);
    expect(loadLogs()[0].revision).toBe(0);
    expect(loadLogs()[0].history).toEqual([]);
  });

  it("works on a reviewed (locked) log and keeps the review stamp", () => {
    markLogReviewed("L1", { reviewedBy: "p-ben", people: PEOPLE, catalog: CATALOG, now: NOW });
    const res = applyCorrection("L1", next(), { changedBy: "p-ana", reason: "Wrong pest", people: PEOPLE, now: NOW });
    expect(res.ok).toBe(true);
    const stored = loadLogs()[0];
    expect(stored.targetPestOrPurpose).toBe("Roaches");
    expect(stored.reviewedBy).toBe("Ben Tech");
    expect(stored.history![0].priorSnapshot.reviewedBy).toBe("Ben Tech");
  });
});

describe("applyCorrection — diff, history, revision", () => {
  it("appends an entry with offset time, roster name, trimmed reason and the field diff", () => {
    const { log } = seedAndCorrect();
    expect(log.revision).toBe(1);
    expect(log.history).toHaveLength(1);
    const entry = log.history![0];
    expect(entry).toMatchObject({
      revision: 1,
      changedAt: "2026-10-17T17:05:00-05:00",
      changedBy: "Ana Office",
      reason: "Typo in house number",
      changes: [{ field: "serviceAddress", old: "100 Main St", new: "101 Main St" }],
    });
    expect(entry.priorSnapshot.serviceAddress).toBe("100 Main St");
    expect(entry.priorSnapshot.revision).toBe(0);
    expect("history" in entry.priorSnapshot).toBe(false);
    // Persisted, and survives a reload.
    expect(loadLogs()[0]).toEqual(log);
  });

  it("bumps revision per correction and keeps earlier entries", () => {
    seedAndCorrect();
    const second = applyCorrection(
      "L1",
      { ...loadLogs()[0], dateUsed: "2026-08-31" },
      { changedBy: "p-ben", reason: "Wrong day", people: PEOPLE, now: NOW },
    );
    expect(second.ok).toBe(true);
    const stored = loadLogs()[0];
    expect(stored.revision).toBe(2);
    expect(stored.history!.map((h) => [h.revision, h.changedBy, h.priorSnapshot.revision])).toEqual([
      [1, "Ana Office", 0],
      [2, "Ben Tech", 1],
    ]);
    expect(stored.history![1].priorSnapshot.serviceAddress).toBe("101 Main St");
    expect(stored.history![1].changes).toEqual([{ field: "dateUsed", old: "2026-09-01", new: "2026-08-31" }]);
    expect(stored.id).toBe("L1");
    expect(stored.createdAt).toBe(makeLog().createdAt);
  });

  it("diffs nested product / personnel / termite fields and added or removed lines", () => {
    const prev = makeLog({ products: [makeApplied({ lineId: "a" })] });
    const next = makeLog({
      products: [makeApplied({ lineId: "a", rtuAmount: "2" }), makeApplied({ lineId: "b", name: "Bait" })],
      personnel: [
        { role: "applying", name: "Alice Applicator", licenseNumber: "TX-112" },
        { role: "supervising", name: "", licenseNumber: "" },
        { role: "receiving_training", name: "", licenseNumber: "" },
      ],
      termite: { ...makeLog().termite, diagramNote: "north wall" },
      isTermite: true,
    });
    const changes = diffLogs(prev, next);
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: "isTermite", old: false, new: true },
        { field: "products[a].rtuAmount", old: "1", new: "2" },
        { field: "products[b].name", old: null, new: "Bait" },
        { field: "personnel[applying].licenseNumber", old: "TX-111", new: "TX-112" },
        { field: "termite.diagramNote", old: "", new: "north wall" },
      ]),
    );
    // Removing a line: every field of it goes to null.
    const removed = diffLogs(next, prev).filter((c) => c.field.startsWith("products[b]"));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((c) => c.new === null)).toBe(true);
    // Reordering lines is not a change.
    expect(diffLogs(next, { ...next, products: [...next.products].reverse() })).toEqual([]);
  });
});

describe("applyCorrection — snapshot isolation", () => {
  it("mutating the returned log or the input never alters priorSnapshot", () => {
    seed(makeLog({ id: "L1" }));
    const input = { ...makeLog({ id: "L1" }), serviceAddress: "101 Main St" };
    const res = applyCorrection("L1", input, { changedBy: "p-ana", reason: "fix", people: PEOPLE, now: NOW });
    if (!res.ok) throw new Error(res.error);
    const snap = res.log.history![0].priorSnapshot;

    res.log.serviceAddress = "mutated";
    res.log.products[0].name = "mutated";
    res.log.personnel[0].name = "mutated";
    input.products[0].rtuAmount = "999";
    input.termite.diagramNote = "mutated";

    expect(snap.serviceAddress).toBe("100 Main St");
    expect(snap.products[0].name).toBe("Talstar P");
    expect(snap.products[0].rtuAmount).toBe("1");
    expect(snap.personnel[0].name).toBe("Alice Applicator");
    expect(snap.termite.diagramNote).toBe("");
    expect(res.log.history![0].changes).toEqual([
      { field: "serviceAddress", old: "100 Main St", new: "101 Main St" },
    ]);
  });

  it("history entries are frozen (writes throw in strict mode)", () => {
    const log = corrected();
    const entry = log.history![0];
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.priorSnapshot)).toBe(true);
    expect(Object.isFrozen(entry.priorSnapshot.products[0])).toBe(true);
    expect(Object.isFrozen(entry.changes[0])).toBe(true);
    expect(() => {
      (entry.priorSnapshot as ApplicationLog).serviceAddress = "x";
    }).toThrow(TypeError);
    // Reloaded entries are frozen too.
    expect(Object.isFrozen(loadLogs()[0].history![0].priorSnapshot)).toBe(true);
  });
});

describe("backup / restore carry", () => {
  it("backup JSON round-trips review fields, revision and history", () => {
    seedAndCorrect("L1");
    seed(...loadLogs(), makeLog({ id: "L2" }));
    markLogReviewed("L2", { reviewedBy: "p-ben", people: PEOPLE, catalog: CATALOG, now: NOW });
    const before = loadLogs();
    const json = JSON.stringify(buildBackup());
    const parsed = parseBackup(JSON.parse(json));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    storage.clear();
    expect(applyBackup(parsed.backup).ok).toBe(true);
    const after = loadLogs();
    expect(after).toEqual(before);
    const l1 = after.find((l) => l.id === "L1")!;
    const l2 = after.find((l) => l.id === "L2")!;
    expect(l1.revision).toBe(1);
    expect(l1.history![0].reason).toBe("Typo in house number");
    expect(l2.reviewedAt).toBe("2026-10-17T17:05:00-05:00");
    expect(l2.reviewedBy).toBe("Ben Tech");
  });

  it("an older backup without the new fields still restores", () => {
    const legacy = {
      version: BACKUP_VERSION,
      exportedAt: "2026-09-01T12:00:00.000Z",
      logs: [legacyRaw()],
      catalog: [],
      people: [],
      settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
    };
    const parsed = parseBackup(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(applyBackup(parsed.backup).ok).toBe(true);
    expect(loadLogs().map((l) => [l.id, l.revision, l.history])).toEqual([["legacy", 0, []]]);
  });
});

describe("shared sync carry", () => {
  const SHOP = "shop-1";

  function shopDoc(logs: ApplicationLog[] = []): ShopDocument {
    return {
      version: "1",
      updatedAt: "2026-10-01T00:00:00.000Z",
      logs,
      catalog: [],
      people: [],
      settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
      ownerUid: "owner",
    };
  }

  it("outbox queue keeps reviewedAt/By, revision and history", async () => {
    const log = { ...corrected(), reviewedAt: "2026-10-17T17:05:00-05:00", reviewedBy: "Ana Office" };
    expect(await enqueueLogOutbox(SHOP, log)).not.toBeNull();
    expect(loadLogOutbox()[0].log).toEqual(log);
  });

  it("syncLogToRemote puts the full model, and the remote read path parses it back", async () => {
    storage.setItem(
      SHOP_SESSION_KEY,
      JSON.stringify({ shopId: SHOP, role: "office", verifiedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }),
    );
    const log = corrected();
    let doc = shopDoc();
    const remote = {
      mode: "shared",
      getShop: async () => ({ ok: true, value: JSON.parse(JSON.stringify(doc)) as ShopDocument }),
      putShop: async (next: ShopDocument) => {
        doc = JSON.parse(JSON.stringify(next)) as ShopDocument;
        return { ok: true, value: { updatedAt: "2026-10-17T22:05:00.000Z" } };
      },
    } as unknown as RemoteShopStore;
    expect(await syncLogToRemote(remote, SHOP, log)).toEqual({ ok: true });
    const parsed = parseShopSections(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sections.logs[0]).toEqual(log);
  });
});

describe("wording", () => {
  it("error messages that can reach the UI avoid loaded terms", () => {
    const banned =
      /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;
    seed(makeLog({ id: "L1", serviceAddress: "" }), makeLog({ id: "L2" }));
    const errors: string[] = [];
    const push = (r: { ok: boolean; error?: string }) => {
      if (!r.ok && r.error) errors.push(r.error);
    };
    const base = { people: PEOPLE, catalog: CATALOG, now: NOW };
    push(markLogReviewed("L1", { ...base, reviewedBy: "p-ana" }));
    push(markLogReviewed("nope", { ...base, reviewedBy: "p-ana" }));
    push(markLogReviewed("L2", { ...base, reviewedBy: "" }));
    markLogReviewed("L2", { ...base, reviewedBy: "p-ana" });
    push(markLogReviewed("L2", { ...base, reviewedBy: "p-ana" }));
    const opts = { changedBy: "p-ana", reason: "r", people: PEOPLE };
    push(applyCorrection("L2", loadLogs()[1], opts));
    push(applyCorrection("L2", loadLogs()[1], { ...opts, reason: " " }));
    push(applyCorrection("L2", loadLogs()[1], { ...opts, changedBy: "" }));
    push(applyCorrection("L2", { ...loadLogs()[1], id: "x" }, opts));
    push(applyCorrection("L2", { ...loadLogs()[1], products: [{} as never] }, opts));
    expect(errors.length).toBeGreaterThanOrEqual(9);
    for (const e of errors) expect(e).not.toMatch(banned);
  });
});

// ---------------------------------------------------------------------------
// Restore never drops correction history (Lawgical records rule)
// ---------------------------------------------------------------------------

const LOGS_KEY = "jobber-pest-logger:logs:v1";
const SETTINGS = { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" };

function backupWith(logs: unknown[]) {
  const parsed = parseBackup({
    version: BACKUP_VERSION,
    exportedAt: "2026-09-01T12:00:00.000Z",
    logs: JSON.parse(JSON.stringify(logs)),
    catalog: [],
    people: [],
    settings: SETTINGS,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.backup;
}

function correct(id: string, patch: Partial<ApplicationLog>, reason: string, by = "p-ana") {
  const current = loadLogs().find((l) => l.id === id)!;
  const res = applyCorrection(id, { ...current, ...patch }, { changedBy: by, reason, people: PEOPLE, now: NOW });
  if (!res.ok) throw new Error(res.error);
  return res.log;
}

function restore(logs: unknown[]) {
  const res = applyBackup(backupWith(logs));
  if (!res.ok) throw new Error(res.message);
  return res;
}

describe("restore — keep device copy vs take backup copy", () => {
  it("older backup (no history) over a corrected log: device copy and its history survive", () => {
    seed(makeLog({ id: "L1" }));
    const olderBackupCopy = loadLogs()[0]; // revision 0, history []
    correct("L1", { serviceAddress: "101 Main St" }, "Typo in house number");
    const rawBefore = JSON.stringify(loadLogs()[0]);

    const res = restore([olderBackupCopy]);
    const after = loadLogs()[0];
    expect(JSON.stringify(after)).toBe(rawBefore);
    expect(after.serviceAddress).toBe("101 Main St");
    expect(after.revision).toBe(1);
    expect(after.history![0].reason).toBe("Typo in house number");
    expect(res.history).toEqual({ keptDevice: ["L1"], diverged: [], keptAbsent: [] });
  });

  it("legacy-shaped backup row (fields missing entirely) is treated as revision 0 / no history", () => {
    seed(makeLog({ id: "legacy" }));
    correct("legacy", { targetPestOrPurpose: "Roaches" }, "Wrong pest");
    restore([legacyRaw()]);
    expect(loadLogs()[0].targetPestOrPurpose).toBe("Roaches");
    expect(loadLogs()[0].history).toHaveLength(1);
  });

  it("backup with a shorter (prefix) history: device copy kept (higher revision)", () => {
    seed(makeLog({ id: "L1" }));
    const rev1 = correct("L1", { serviceAddress: "101 Main St" }, "first");
    correct("L1", { dateUsed: "2026-08-31" }, "second");
    restore([rev1]);
    const after = loadLogs()[0];
    expect(after.revision).toBe(2);
    expect(after.history!.map((h) => h.reason)).toEqual(["first", "second"]);
    expect(after.dateUsed).toBe("2026-08-31");
  });

  it("backup that extends the device history (higher revision): backup copy taken", () => {
    seed(makeLog({ id: "L1" }));
    const rev1 = correct("L1", { serviceAddress: "101 Main St" }, "first");
    const rev2 = correct("L1", { dateUsed: "2026-08-31" }, "second");
    // Device goes back to revision 1 (e.g. another device's file is newer).
    seed(rev1);
    const res = restore([rev2]);
    const after = loadLogs()[0];
    expect(after).toEqual(rev2);
    expect(after.revision).toBe(2);
    expect(after.history!.map((h) => h.reason)).toEqual(["first", "second"]);
    expect(after.serviceAddress).toBe("101 Main St");
    expect(after.dateUsed).toBe("2026-08-31");
    expect(res.history).toEqual({ keptDevice: [], diverged: [], keptAbsent: [] });
    // Banner does not count a taken extension.
    expect(restoredKeptReport(backupWith([rev2]).logs, loadLogs()).keptDevice).toEqual([]);
    expect(restoreHistoryMessage(res.history)).toBeNull();
  });

  it("extending backup that would unlock a reviewed device log: device copy kept", () => {
    seed(makeLog({ id: "L1" }));
    const rev1 = correct("L1", { serviceAddress: "101 Main St" }, "first");
    const rev2 = correct("L1", { dateUsed: "2026-08-31" }, "second"); // unreviewed
    seed(rev1);
    markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
    const res = restore([rev2]);
    const after = loadLogs()[0];
    expect(after.reviewedBy).toBe("Ana Office");
    expect(after.revision).toBe(1);
    expect(after.dateUsed).toBe("2026-09-01");
    expect(res.history!.keptDevice).toEqual(["L1"]);
  });

  it("extending backup that is itself reviewed replaces a reviewed device log", () => {
    seed(makeLog({ id: "L1" }));
    const rev1 = correct("L1", { serviceAddress: "101 Main St" }, "first");
    markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
    const reviewedRev1 = loadLogs()[0];
    const rev2 = correct("L1", { dateUsed: "2026-08-31" }, "second"); // keeps review stamp
    seed(reviewedRev1);
    restore([rev2]);
    expect(loadLogs()[0]).toEqual(rev2);
    expect(rev1.revision).toBe(1);
  });

  it("diverged histories (same revision, different entries): device kept, counted as diverged", () => {
    seed(makeLog({ id: "L1" }));
    const base = loadLogs()[0];
    const deviceRev1 = correct("L1", { serviceAddress: "101 Main St" }, "device fix");
    seed(base);
    const otherRev1 = correct("L1", { serviceAddress: "102 Main St" }, "other fix", "p-ben");
    seed(deviceRev1);
    const res = restore([otherRev1]);
    const after = loadLogs()[0];
    expect(after.serviceAddress).toBe("101 Main St");
    expect(after.history!.map((h) => h.reason)).toEqual(["device fix"]);
    expect(res.history).toEqual({ keptDevice: ["L1"], diverged: ["L1"], keptAbsent: [] });
  });

  it("same history and revision: backup copy taken (normal restore)", () => {
    seed(makeLog({ id: "L1" }));
    const rev1 = correct("L1", { serviceAddress: "101 Main St" }, "fix");
    seed({ ...rev1, jobberJobNumber: "LOCAL-EDIT" });
    const res = restore([{ ...rev1, jobberJobNumber: "FROM-BACKUP" }]);
    expect(loadLogs()[0].jobberJobNumber).toBe("FROM-BACKUP");
    expect(res.history!.keptDevice).toEqual([]);
  });

  it("logs with no history on either side restore from the backup as before", () => {
    seed(makeLog({ id: "L1", targetPestOrPurpose: "Ants" }));
    restore([makeLog({ id: "L1", targetPestOrPurpose: "Fleas" })]);
    expect(loadLogs()[0].targetPestOrPurpose).toBe("Fleas");
  });

  it("reviewed device log vs unreviewed backup copy: device kept, stays locked", () => {
    seed(makeLog({ id: "L1" }));
    const unreviewed = loadLogs()[0];
    markLogReviewed("L1", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
    const res = restore([{ ...unreviewed, targetPestOrPurpose: "Fleas" }]);
    const after = loadLogs()[0];
    expect(after.reviewedAt).toBe("2026-10-17T17:05:00-05:00");
    expect(after.reviewedBy).toBe("Ana Office");
    expect(after.targetPestOrPurpose).toBe("Ants");
    expect(res.history!.keptDevice).toEqual(["L1"]);
  });
});

describe("restore — whole-set replace keeps history-bearing device logs", () => {
  it("device logs absent from the backup are kept when corrected or reviewed; plain ones are replaced", () => {
    seed(makeLog({ id: "corrected" }), makeLog({ id: "reviewed" }), makeLog({ id: "plain" }));
    correct("corrected", { serviceAddress: "101 Main St" }, "fix");
    markLogReviewed("reviewed", { reviewedBy: "p-ana", people: PEOPLE, catalog: CATALOG, now: NOW });
    const res = restore([makeLog({ id: "fromBackup" })]);
    expect(loadLogs().map((l) => l.id)).toEqual(["fromBackup", "corrected", "reviewed"]);
    expect(loadLogs()[1].history).toHaveLength(1);
    expect(loadLogs()[2].reviewedBy).toBe("Ana Office");
    expect(res.history!.keptAbsent).toEqual(["corrected", "reviewed"]);
  });

  it("legacy backup into an empty store still works, with nothing kept", () => {
    const res = restore([legacyRaw()]);
    expect(loadLogs().map((l) => [l.id, l.revision, l.history])).toEqual([["legacy", 0, []]]);
    expect(res.history).toEqual({ keptDevice: [], diverged: [], keptAbsent: [] });
    expect(restoreHistoryMessage(res.history)).toBeNull();
  });
});

describe("restore — rollback puts history back exactly", () => {
  class FailSettingsStorage extends MemoryStorage {
    failSettings = false;
    setItem(k: string, v: string) {
      if (this.failSettings && k === "jobber-pest-logger:settings:v1") throw new Error("QuotaExceededError");
      super.setItem(k, v);
    }
  }

  it("a mid-restore failure restores the logs key byte-for-byte (revision, history, review stamp)", () => {
    const failing = new FailSettingsStorage();
    vi.stubGlobal("localStorage", failing);
    seed(makeLog({ id: "L1" }), makeLog({ id: "L2" }));
    correct("L1", { serviceAddress: "101 Main St" }, "fix");
    markLogReviewed("L2", { reviewedBy: "p-ben", people: PEOPLE, catalog: CATALOG, now: NOW });
    const rawBefore = failing.getItem(LOGS_KEY);
    const logsBefore = loadLogs();

    failing.failSettings = true;
    // The logs write succeeds (new id changes the bytes), then settings fails.
    const res = applyBackup(backupWith([makeLog({ id: "L9" })]));
    expect(res.ok).toBe(false);

    expect(failing.getItem(LOGS_KEY)).toBe(rawBefore);
    const after = loadLogs();
    expect(after).toEqual(logsBefore);
    expect(after[0].revision).toBe(1);
    expect(JSON.stringify(after[0].history)).toBe(JSON.stringify(logsBefore[0].history));
    expect(after[1]).toMatchObject({ reviewedAt: "2026-10-17T17:05:00-05:00", reviewedBy: "Ben Tech" });
  });
});

describe("restore — summary wording", () => {
  const banned =
    /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;

  it("neutral one-liner, singular and plural", () => {
    const one = restoreHistoryMessage({ keptDevice: ["a"], diverged: ["a"], keptAbsent: [] });
    const many = restoreHistoryMessage({ keptDevice: ["a"], diverged: [], keptAbsent: ["b", "c"] });
    expect(one).toBe("1 log kept its change history from this device.");
    expect(many).toBe("3 logs kept their change history from this device.");
    for (const m of [one, many]) expect(m).not.toMatch(banned);
    expect(restoreHistoryMessage({ keptDevice: [], diverged: [], keptAbsent: [] })).toBeNull();
  });

  it("restoredKeptReport derives the same counts from the backup and stored result", () => {
    seed(makeLog({ id: "L1" }), makeLog({ id: "L2" }));
    const backupCopy = loadLogs()[0];
    correct("L1", { serviceAddress: "101 Main St" }, "fix");
    correct("L2", { serviceAddress: "9 Elm" }, "fix");
    const backup = backupWith([backupCopy]);
    expect(applyBackup(backup).ok).toBe(true);
    expect(restoredKeptReport(backup.logs, loadLogs())).toEqual({
      keptDevice: ["L1"],
      diverged: [],
      keptAbsent: ["L2"],
    });
  });
});

describe("priorSnapshot carries the review stamp", () => {
  it("correcting a reviewed log snapshots reviewedAt and reviewedBy", () => {
    seed(makeLog({ id: "L1" }));
    markLogReviewed("L1", { reviewedBy: "p-ben", people: PEOPLE, catalog: CATALOG, now: NOW });
    const log = correct("L1", { targetPestOrPurpose: "Roaches" }, "Wrong pest");
    const snap = log.history![0].priorSnapshot;
    expect(snap.reviewedAt).toBe("2026-10-17T17:05:00-05:00");
    expect(snap.reviewedBy).toBe("Ben Tech");
    // Survives a reload.
    const reloaded = loadLogs()[0].history![0].priorSnapshot;
    expect(reloaded).toMatchObject({ reviewedAt: "2026-10-17T17:05:00-05:00", reviewedBy: "Ben Tech" });
  });
});
