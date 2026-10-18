import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBackup,
  applyCorrection,
  BACKUP_VERSION,
  buildBackup,
  buildCorrection,
  buildReupload,
  countSetAsideRows,
  addSetAsideCopy,
  loadLogs,
  loadLogsQuarantine,
  mergeLogIntoSet,
  normalizeLog,
  parseBackup,
  saveLogs,
  SET_ASIDE_KEY,
  shouldKeepDeviceLog,
  STALE_EDIT_MSG,
  upsertLog,
  wipeAllDeviceData,
} from "./storage";
import { MemoryStorage } from "./test/memoryStorage";
import { makeLog } from "./test/fixtures";
import type { ApplicationLog, Person } from "./types";

const NOW = new Date(2026, 9, 17, 20, 40);
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const RECORD = { reuploadedAt: "2026-10-17T20:40:00-05:00", reuploadedBy: "Ana Office", reason: "Shop lost it" };

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => vi.unstubAllGlobals());

function reuploaded(over: Partial<ApplicationLog> = {}): ApplicationLog {
  const res = buildReupload(makeLog({ id: "L1", ...over }), { reuploadedBy: "p-ana", reason: "Shop lost it", people: PEOPLE, now: NOW });
  if (!res.ok) throw new Error(res.error);
  return res.log;
}

function restore(logs: unknown[]) {
  const parsed = parseBackup({
    version: BACKUP_VERSION,
    exportedAt: "2026-09-01T12:00:00.000Z",
    logs: JSON.parse(JSON.stringify(logs)),
    catalog: [],
    people: [],
    settings: { shopName: "Acme", shopTpclNumber: "1", shopTpclLetter: "" },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const res = applyBackup(parsed.backup);
  if (!res.ok) throw new Error(res.message);
  return res;
}

describe("buildReupload", () => {
  it("adds who / when / why without touching revision, history or values", () => {
    const base = makeLog({ id: "L1" });
    const log = reuploaded();
    expect(log.reuploads).toEqual([RECORD]);
    expect({ ...log, reuploads: undefined }).toEqual({ ...base, reuploads: undefined });
    expect(Object.isFrozen(log.reuploads![0])).toBe(true);
  });

  it("requires a People pick and a non-blank reason", () => {
    const base = makeLog({ id: "L1" });
    expect(buildReupload(base, { reuploadedBy: "", reason: "x", people: PEOPLE })).toEqual({
      ok: false,
      error: "Choose who made the change from People.",
    });
    expect(buildReupload(base, { reuploadedBy: "p-ana", reason: " \n", people: PEOPLE })).toEqual({
      ok: false,
      error: "Enter a reason for the change.",
    });
  });

  it("appends: a second re-upload keeps the first", () => {
    const twice = buildReupload(reuploaded(), { reuploadedBy: "p-ana", reason: "Again", people: PEOPLE, now: NOW });
    expect(twice.ok && twice.log.reuploads?.map((r) => r.reason)).toEqual(["Shop lost it", "Again"]);
  });
});

describe("normalize / quarantine", () => {
  it("logs never re-uploaded stay without a reuploads key", () => {
    expect(saveLogs([makeLog({ id: "L1" })])).toBe(true);
    expect("reuploads" in loadLogs()[0]).toBe(false);
  });

  it("valid records load; malformed ones send the whole row to quarantine", () => {
    const bad = [
      { ...makeLog({ id: "B1" }), reuploads: "nope" },
      { ...makeLog({ id: "B2" }), reuploads: [{ ...RECORD, reuploadedBy: " " }] },
      { ...makeLog({ id: "B3" }), reuploads: [{ ...RECORD, reason: "" }] },
      { ...makeLog({ id: "B4" }), reuploads: [{ ...RECORD, reuploadedAt: "not a date" }] },
    ];
    storage.setItem("jobber-pest-logger:logs:v1", JSON.stringify([reuploaded(), ...bad]));
    expect(loadLogs().map((l) => l.id)).toEqual(["L1"]);
    expect(loadLogs()[0].reuploads).toEqual([RECORD]);
    expect((loadLogsQuarantine() as { id: string }[]).map((r) => r.id)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(normalizeLog({ ...makeLog(), reuploads: null })).not.toBeNull();
  });
});

describe("corrections keep re-upload records out of snapshots", () => {
  it("a correction carries reuploads on the log, not in priorSnapshot or the diff", () => {
    const log = reuploaded();
    const res = buildCorrection(log, { ...log, serviceAddress: "9 Elm", reuploads: [] }, {
      changedBy: "p-ana",
      reason: "Fix",
      people: PEOPLE,
      now: NOW,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.log.reuploads).toEqual([RECORD]);
    expect(res.log.revision).toBe(1);
    expect("reuploads" in res.log.history![0].priorSnapshot).toBe(false);
    expect(res.log.history![0].changes.map((c) => c.field)).toEqual(["serviceAddress"]);
  });
});

describe("backup / restore / sync never drop a re-upload record", () => {
  it("backup JSON carries reuploads and restores them on a fresh device", () => {
    expect(saveLogs([reuploaded()])).toBe(true);
    const json = JSON.parse(JSON.stringify(buildBackup())) as { logs: ApplicationLog[] };
    storage.clear();
    restore(json.logs);
    expect(loadLogs()[0].reuploads).toEqual([RECORD]);
  });

  it("restoring a backup that lacks the record keeps the device copy", () => {
    expect(saveLogs([reuploaded()])).toBe(true);
    const res = restore([makeLog({ id: "L1" })]);
    expect(loadLogs()[0].reuploads).toEqual([RECORD]);
    expect(res.history?.keptDevice).toEqual(["L1"]);
  });

  it("a device log absent from the backup is kept when it has a re-upload record", () => {
    expect(saveLogs([reuploaded()])).toBe(true);
    const res = restore([makeLog({ id: "OTHER" })]);
    expect(loadLogs().map((l) => l.id).sort()).toEqual(["L1", "OTHER"]);
    expect(res.history?.keptAbsent).toEqual(["L1"]);
  });

  it("a backup carrying the same record is taken as usual", () => {
    expect(shouldKeepDeviceLog(reuploaded(), reuploaded({ jobberJobNumber: "J" }))).toBe(false);
  });

  it("sync: an incoming copy without the shop's record is refused; with it, accepted", () => {
    const shop = [reuploaded()];
    expect(mergeLogIntoSet(shop, makeLog({ id: "L1", jobberJobNumber: "J" })).kept).toBe(true);
    expect(mergeLogIntoSet(shop, reuploaded({ jobberJobNumber: "J" })).kept).toBe(false);
  });
});

describe("upsertLog refuses a stale copy", () => {
  it("message is plain", () => {
    expect(STALE_EDIT_MSG).toBe("This log changed on this device after you opened it. Open it again from History.");
    expect(STALE_EDIT_MSG).not.toMatch(
      /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i,
    );
  });

  it("refuses an edit that would drop history or a re-upload record", () => {
    expect(saveLogs([makeLog({ id: "L1" })])).toBe(true);
    const opened = loadLogs()[0];
    const fixed = applyCorrection("L1", { ...opened, serviceAddress: "9 Elm" }, { changedBy: "p-ana", reason: "Fix", people: PEOPLE, now: NOW });
    expect(fixed.ok).toBe(true);
    expect(upsertLog({ ...opened, jobberJobNumber: "J" })).toMatchObject({ saved: false, stale: true });

    expect(saveLogs([reuploaded()])).toBe(true);
    expect(upsertLog(makeLog({ id: "L1", jobberJobNumber: "J" }))).toMatchObject({ saved: false, stale: true });
    expect(upsertLog(reuploaded({ jobberJobNumber: "J" })).saved).toBe(true);
  });
});

describe("#171 wipe clears set-aside copies", () => {
  it("removes the set-aside store with everything else", () => {
    expect(saveLogs([makeLog({ id: "L1" })])).toBe(true);
    expect(addSetAsideCopy(makeLog({ id: "L1" }), { setAsideBy: "p-ana", people: PEOPLE, now: NOW }).ok).toBe(true);
    expect(countSetAsideRows()).toBe(1);
    expect(wipeAllDeviceData().saved).toBe(true);
    expect(storage.getItem(SET_ASIDE_KEY)).toBeNull();
    expect(countSetAsideRows()).toBe(0);
    expect((buildBackup() as { setAside?: unknown[] }).setAside).toEqual([]);
  });

  it("a failed wipe leaves the set-aside store as it was", () => {
    expect(addSetAsideCopy(makeLog({ id: "L1" }), { setAsideBy: "p-ana", people: PEOPLE, now: NOW }).ok).toBe(true);
    const before = storage.getItem(SET_ASIDE_KEY);
    storage.failSet = true;
    expect(wipeAllDeviceData().saved).toBe(false);
    storage.failSet = false;
    expect(storage.getItem(SET_ASIDE_KEY)).toBe(before);
  });
});
