import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countWithinRetention,
  deletableFromYmd,
  computeRetainUntil,
  deleteBlockedReason,
  effectiveRetainUntil,
  isExampleOnlyLog,
  isWithinRetention,
  retentionEndYmd,
  wipeRetentionWarning,
} from "./retention";
import {
  applyBackup,
  BACKUP_VERSION,
  clearExampleDemoData,
  deleteLog,
  loadLogs,
  applyCorrection,
  parseBackup,
  buildBackup,
  mergeLogIntoSet,
  mergeRestoredLogs,
  normalizeLog,
  restoreBannerText,
  restoredKeptReport,
  upsertLog,
  restoreRecentSentence,
  saveLogs,
  wipeAllDeviceData,
} from "./storage";
import { MemoryStorage } from "./test/memoryStorage";
import { makeApplied, makeLog } from "./test/fixtures";
import type { Person } from "./types";

const BANNED = /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified/i;
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const EXAMPLE = makeApplied({ lineId: "ex", catalogId: "example-rtu-insecticide", name: "Example RTU", epaRegNo: null, isExample: true });

/** Local wall-clock time (device time zone). */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe("retentionEndYmd", () => {
  it("adds 2 calendar years", () => {
    expect(retentionEndYmd("2026-09-20")).toBe("2028-09-20");
    expect(retentionEndYmd("2024-12-31")).toBe("2026-12-31");
  });

  it("leap day: Feb 29 + 2 years = Mar 1", () => {
    expect(retentionEndYmd("2024-02-29")).toBe("2026-03-01");
    expect(retentionEndYmd("2028-02-28")).toBe("2030-02-28");
    // Feb 28 of a year before a leap year stays Feb 28.
    expect(retentionEndYmd("2026-02-28")).toBe("2028-02-28");
  });

  it("unreadable dates give null", () => {
    expect(retentionEndYmd("")).toBeNull();
    expect(retentionEndYmd("2026-02-30")).toBeNull();
    expect(retentionEndYmd("09/20/2026")).toBeNull();
  });
});

describe("isWithinRetention: age boundary (device-local dates)", () => {
  const log = makeLog({ dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" });

  it("just under 2 years: kept", () => {
    expect(isWithinRetention(log, at(2028, 9, 19, 23, 59))).toBe(true);
  });

  it("exactly 2 years (the anniversary date, from local midnight): deletable", () => {
    expect(isWithinRetention(log, at(2028, 9, 20, 0, 0))).toBe(false);
  });

  it("just over 2 years: deletable", () => {
    expect(isWithinRetention(log, at(2028, 9, 21, 0, 1))).toBe(false);
  });

  it("leap-day application is kept through Feb 28 and deletable on Mar 1", () => {
    const leap = makeLog({ dateUsed: "2024-02-29", createdAt: "2024-02-29T12:00:00" });
    expect(isWithinRetention(leap, at(2026, 2, 28, 23, 59))).toBe(true);
    expect(isWithinRetention(leap, at(2026, 3, 1, 0, 0))).toBe(false);
  });

  it("uses the device time zone, not UTC", () => {
    // 2028-09-19 23:30 in Chicago is already 2028-09-20 in UTC: still kept.
    expect(isWithinRetention(log, new Date("2028-09-20T04:30:00Z"))).toBe(true);
    expect(isWithinRetention(log, new Date("2028-09-20T05:30:00Z"))).toBe(false);
  });

  it("works in other time zones (local calendar date of `now`)", () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      // 2028-09-19 11:30 UTC = 2028-09-19 23:30 NZST: kept.
      expect(isWithinRetention(log, new Date("2028-09-19T11:30:00Z"))).toBe(true);
      // 2028-09-19 12:30 UTC = 2028-09-20 00:30 NZST: deletable.
      expect(isWithinRetention(log, new Date("2028-09-19T12:30:00Z"))).toBe(false);
    } finally {
      // Assigning undefined to process.env stores the string "undefined" (#184).
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it("no readable dateUsed: falls back to the local date of createdAt; neither → kept", () => {
    const noDate = makeLog({ dateUsed: "", createdAt: "2026-09-01T15:00:00.000Z" });
    expect(deletableFromYmd(noDate)).toBe("2028-09-01");
    const none = makeLog({ dateUsed: "", createdAt: "garbage" });
    expect(isWithinRetention(none, at(2040, 1, 1))).toBe(true);
    expect(deleteBlockedReason(none, at(2040, 1, 1))).toBe(
      "Can't delete. This log has no readable application date, and Texas requires keeping records for 2 years from that date.",
    );
  });

  it("example-only demo logs are not held; mixed logs are", () => {
    const demo = makeLog({ sampleData: true, products: [EXAMPLE] });
    const mixed = makeLog({ products: [EXAMPLE, makeApplied({ lineId: "r" })] });
    expect(isExampleOnlyLog(demo)).toBe(true);
    expect(isWithinRetention(demo, at(2026, 10, 1))).toBe(false);
    expect(isWithinRetention(mixed, at(2026, 10, 1))).toBe(true);
  });
});

describe("strings", () => {
  it("delete reason names the first deletable date", () => {
    expect(deleteBlockedReason(makeLog({ dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" }), at(2026, 10, 17))).toBe(
      "Can't delete yet. Texas requires keeping this record for 2 years from the application date. You can delete it on or after 2028-09-20.",
    );
    expect(deleteBlockedReason(makeLog({ dateUsed: "2020-09-20", createdAt: "2020-09-20T12:00:00" }), at(2026, 10, 17))).toBeNull();
  });

  it("wipe warning: singular, plural, none", () => {
    expect(wipeRetentionWarning(0)).toBe("");
    expect(wipeRetentionWarning(1)).toBe(
      "1 log is less than 2 years old. Texas requires the shop to keep this record for 2 years. Download the backup JSON or export first.",
    );
    expect(wipeRetentionWarning(4)).toBe(
      "4 logs are less than 2 years old. Texas requires the shop to keep these records for 2 years. Download the backup JSON or export first.",
    );
  });

  it("count skips old and example-only logs", () => {
    const logs = [
      makeLog({ id: "a", dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" }),
      makeLog({ id: "b", dateUsed: "2020-01-01", createdAt: "2020-01-01T12:00:00" }),
      makeLog({ id: "c", sampleData: true, products: [EXAMPLE] }),
      makeLog({ id: "d", dateUsed: "2025-10-18", createdAt: "2025-10-18T12:00:00" }),
    ];
    expect(countWithinRetention(logs, at(2026, 10, 17))).toBe(2);
  });

  it("no banned words", () => {
    for (const s of [
      deleteBlockedReason(makeLog({ dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" }), at(2026, 10, 17))!,
      deleteBlockedReason(makeLog({ dateUsed: "", createdAt: "x" }), at(2026, 10, 17))!,
      wipeRetentionWarning(1),
      wipeRetentionWarning(2),
      restoreRecentSentence(1),
      restoreRecentSentence(2),
    ]) {
      expect(s).not.toMatch(BANNED);
      expect(s).not.toMatch(/audit/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Storage-level guard
// ---------------------------------------------------------------------------

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(2026, 10, 17, 22, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("storage: no path deletes a log under 2 years", () => {
  it("deleteLog refuses with the reason and writes nothing", () => {
    const recent = makeLog({ id: "R", dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" });
    const old = makeLog({ id: "O", dateUsed: "2020-01-01", createdAt: "2020-01-01T12:00:00" });
    expect(saveLogs([recent, old])).toBe(true);
    const res = deleteLog("R");
    expect(res.saved).toBe(false);
    expect(res.blocked).toMatch(/^Can't delete yet\. .* on or after 2028-09-20\.$/);
    expect(loadLogs().map((l) => l.id)).toEqual(["R", "O"]);
    expect(deleteLog("O")).toMatchObject({ saved: true });
    expect(loadLogs().map((l) => l.id)).toEqual(["R"]);
  });

  it("deleteLog allows a log exactly 2 years old", () => {
    expect(saveLogs([makeLog({ id: "E", dateUsed: "2024-10-17", createdAt: "2024-10-17T12:00:00" })])).toBe(true);
    expect(deleteLog("E").saved).toBe(true);
  });

  it("saveLogs refuses any write that drops a log under 2 years", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(saveLogs([makeLog({ id: "R", dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" })])).toBe(true);
    expect(saveLogs([])).toBe(false);
    expect(saveLogs([makeLog({ id: "OTHER" })])).toBe(false);
    expect(loadLogs().map((l) => l.id)).toEqual(["R"]);
    // Replacing it in place (same id) is fine.
    expect(saveLogs([makeLog({ id: "R", dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00", jobberJobNumber: "J" })])).toBe(true);
  });

  it("wipe (device reset) is the one path allowed to remove them", () => {
    expect(saveLogs([makeLog({ id: "R", dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" })])).toBe(true);
    expect(wipeAllDeviceData().saved).toBe(true);
    expect(loadLogs()).toEqual([]);
  });

  it("restore keeps device logs under 2 years that the backup lacks, and says so", () => {
    expect(saveLogs([makeLog({ id: "R", dateUsed: "2026-09-20", createdAt: "2026-09-20T12:00:00" }), makeLog({ id: "O", dateUsed: "2020-01-01", createdAt: "2020-01-01T12:00:00" })])).toBe(true);
    const parsed = parseBackup({
      version: BACKUP_VERSION,
      exportedAt: "2026-09-01T12:00:00.000Z",
      logs: [makeLog({ id: "B" })],
      catalog: [],
      people: [],
      settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const res = applyBackup(parsed.backup);
    if (!res.ok) throw new Error(res.message);
    expect(loadLogs().map((l) => l.id)).toEqual(["B", "R"]);
    expect(res.history?.keptRecent).toEqual(["R"]);
    expect(restoreBannerText(parsed.backup, res.history)).toBe(
      "Restored backup (v1.2) from 2026-09-01T12:00:00.000Z. Device data replaced. 1 log that the backup doesn't have is less than 2 years old, so it stayed on this device.",
    );
    expect(restoreRecentSentence(3)).toBe(
      "3 logs that the backup doesn't have are less than 2 years old, so they stayed on this device.",
    );
  });
});

describe("clearExampleDemoData removes example seeds only", () => {
  it("removes unreviewed example-only logs; keeps real, mixed-stripped, reviewed and corrected logs", () => {
    const demo = makeLog({ id: "demo", sampleData: true, products: [EXAMPLE] });
    const real = makeLog({ id: "real" });
    const mixed = makeLog({ id: "mixed", products: [EXAMPLE, makeApplied({ lineId: "r" })] });
    const reviewedDemo = makeLog({ id: "revDemo", sampleData: true, products: [EXAMPLE] });
    const correctedDemo = makeLog({ id: "corDemo", sampleData: true, products: [EXAMPLE] });
    expect(saveLogs([demo, real, mixed, reviewedDemo, correctedDemo])).toBe(true);
    // Reviewed with a forced stamp (example logs carry review flags, so not via markLogReviewed).
    const stamped = loadLogs().map((l) =>
      l.id === "revDemo" ? { ...l, reviewedAt: "2026-10-16T09:00:00-05:00", reviewedBy: "Ana Office" } : l,
    );
    expect(saveLogs(stamped)).toBe(true);
    const fixed = applyCorrection("corDemo", { ...loadLogs().find((l) => l.id === "corDemo")!, serviceAddress: "9 Elm" }, {
      changedBy: "p-ana",
      reason: "Fix",
      people: PEOPLE,
    });
    expect(fixed.ok).toBe(true);

    const res = clearExampleDemoData();
    expect(res.saved).toBe(true);
    expect(res.removedLogs).toBe(1);
    const after = loadLogs();
    expect(after.map((l) => l.id)).toEqual(["real", "mixed", "revDemo", "corDemo"]);
    expect(after.find((l) => l.id === "mixed")!.products.map((p) => p.lineId)).toEqual(["r"]);
    // Reviewed / corrected logs are untouched (not stripped either).
    expect(after.find((l) => l.id === "revDemo")!.products).toEqual(reviewedDemo.products);
    expect(after.find((l) => l.id === "corDemo")!.products).toEqual(correctedDemo.products);
  });
});

describe("retainUntil — the hold never gets shorter (#182)", () => {
  // Now is 2026-10-17 22:00 local. Applied and created 2026-10-01 → held until 2028-10-01.
  const fresh = () => makeLog({ id: "H", dateUsed: "2026-10-01", createdAt: "2026-10-01T12:00:00" });
  const stored = () => loadLogs().find((l) => l.id === "H")!;

  it("a log with no retainUntil uses the computed date", () => {
    const log = fresh();
    expect(log.retainUntil).toBeUndefined();
    expect(computeRetainUntil(log)).toBe("2028-10-01");
    expect(effectiveRetainUntil(log)).toBe("2028-10-01");
    expect(saveLogs([log])).toBe(true);
    // Not stored when it equals the computed date (saved shape unchanged).
    expect(stored().retainUntil).toBeUndefined();
    expect(deleteLog("H").blocked).toContain("2028-10-01");
  });

  it("an edit moving the date back 3 years saves, and the log is still held", () => {
    expect(saveLogs([fresh()])).toBe(true);
    // Even with createdAt moved back too (e.g. a copy from another device), nothing lowers the hold.
    const edited = { ...stored(), dateUsed: "2023-10-01", createdAt: "2023-10-01T12:00:00" };
    const res = upsertLog(edited);
    expect(res.saved).toBe(true);
    expect(stored().dateUsed).toBe("2023-10-01");
    expect(stored().retainUntil).toBe("2028-10-01");
    expect(isWithinRetention(stored(), at(2027, 1, 1))).toBe(true);
    const del = deleteLog("H");
    expect(del.saved).toBe(false);
    // The message date is the stored hold.
    expect(del.blocked).toContain("2028-10-01");
    expect(del.blocked ?? "").not.toMatch(BANNED);
    expect(loadLogs().map((l) => l.id)).toEqual(["H"]);
  });

  it("a correction moving the date back 3 years is still held", () => {
    expect(saveLogs([fresh()])).toBe(true);
    const res = applyCorrection("H", { ...stored(), dateUsed: "2023-10-01", createdAt: "2023-10-01T12:00:00" }, {
      changedBy: "p-ana",
      reason: "Wrong year",
      people: PEOPLE,
    });
    expect(res.ok).toBe(true);
    expect(stored().dateUsed).toBe("2023-10-01");
    expect(effectiveRetainUntil(stored())).toBe("2028-10-01");
    expect(deleteLog("H").blocked).toContain("2028-10-01");
  });

  it("a correction never lowers a stored retainUntil", () => {
    expect(saveLogs([{ ...fresh(), retainUntil: "2029-03-01" }])).toBe(true);
    const res = applyCorrection("H", { ...stored(), dateUsed: "2023-10-01", retainUntil: "2024-01-01" }, {
      changedBy: "p-ana",
      reason: "Wrong year",
      people: PEOPLE,
    });
    expect(res.ok).toBe(true);
    expect(stored().retainUntil).toBe("2029-03-01");
    // The prior snapshot never carries the hold.
    expect(stored().history?.[0].priorSnapshot).not.toHaveProperty("retainUntil");
    expect(deleteLog("H").blocked).toContain("2029-03-01");
  });

  it("the saveLogs drop guard reads retainUntil", () => {
    const log = { ...makeLog({ id: "H", dateUsed: "2020-01-01", createdAt: "2020-01-01T12:00:00" }), retainUntil: "2028-10-01" };
    expect(saveLogs([log])).toBe(true);
    expect(saveLogs([])).toBe(false);
    expect(loadLogs().map((l) => l.id)).toEqual(["H"]);
    vi.setSystemTime(at(2028, 10, 1, 0, 0));
    expect(saveLogs([])).toBe(true);
  });

  it("sync merge keeps the later retainUntil", () => {
    const local = { ...fresh(), retainUntil: "2029-01-01" };
    const incoming = { ...fresh(), dateUsed: "2023-10-01", createdAt: "2023-10-01T12:00:00", revision: 5 };
    const { logs } = mergeLogIntoSet([local], incoming);
    expect(logs[0].retainUntil).toBe("2029-01-01");
    // A later incoming hold wins too.
    const later = mergeLogIntoSet([fresh()], { ...fresh(), retainUntil: "2030-05-05", revision: 5 });
    expect(later.logs[0].retainUntil).toBe("2030-05-05");
  });

  it("restore keeps the later retainUntil whichever copy wins", () => {
    const device = { ...fresh(), retainUntil: "2029-01-01" };
    const backup = { ...fresh(), dateUsed: "2023-10-01", createdAt: "2023-10-01T12:00:00" };
    expect(mergeRestoredLogs([device], [backup]).logs[0].retainUntil).toBe("2029-01-01");
    expect(mergeRestoredLogs([backup], [device]).logs[0].retainUntil).toBe("2029-01-01");
  });

  it("backup JSON carries retainUntil; restore keeps it; a bad value is quarantined", () => {
    const log = { ...makeLog({ id: "H", dateUsed: "2020-01-01", createdAt: "2020-01-01T12:00:00" }), retainUntil: "2028-10-01" };
    expect(saveLogs([log])).toBe(true);
    const backup = buildBackup();
    expect(JSON.parse(JSON.stringify(backup)).logs[0].retainUntil).toBe("2028-10-01");
    expect(normalizeLog({ ...log, retainUntil: "soon" })).toBeNull();
  });
});

describe("restore summary ignores retainUntil", () => {
  it("logs that differ only in retainUntil aren't counted; the later hold is kept", () => {
    const base = makeLog({ id: "H", dateUsed: "2026-10-01", createdAt: "2026-10-01T12:00:00" });
    const backupOf = (logs: unknown[]) => {
      const parsed = parseBackup({
        version: BACKUP_VERSION,
        exportedAt: "2026-09-01T12:00:00.000Z",
        logs: JSON.parse(JSON.stringify(logs)),
        catalog: [],
        people: [],
        settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
      });
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.backup;
    };
    // Device later hold, backup none / an earlier one; and the reverse.
    const cases: [string | undefined, string | undefined][] = [
      ["2029-03-01", undefined],
      ["2029-03-01", "2028-12-01"],
      [undefined, "2029-03-01"],
    ];
    for (const [deviceHold, backupHold] of cases) {
      localStorage.clear();
      expect(saveLogs([{ ...base, ...(deviceHold ? { retainUntil: deviceHold } : {}) }], { allowRetainedRemoval: true })).toBe(true);
      const backup = backupOf([{ ...base, ...(backupHold ? { retainUntil: backupHold } : {}) }]);
      const res = applyBackup(backup);
      if (!res.ok) throw new Error(res.message);
      const stored = loadLogs();
      expect(stored.map((l) => l.id)).toEqual(["H"]);
      expect(stored[0].retainUntil).toBe("2029-03-01");
      const fromStored = restoredKeptReport(backup.logs, stored);
      for (const report of [res.history, fromStored]) {
        expect(report?.keptDevice ?? []).toEqual([]);
        expect(report?.keptAbsent ?? []).toEqual([]);
        expect(report?.keptRecent ?? []).toEqual([]);
        expect(restoreBannerText(backup, report)).toBe(
          "Restored backup (v" + BACKUP_VERSION + ") from 2026-09-01T12:00:00.000Z. Device data replaced.",
        );
      }
    }
  });
});
