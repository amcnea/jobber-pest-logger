import { describe, expect, it } from "vitest";
import {
  buildReviewQueue,
  needsALookText,
  parsesAsNumber,
  parseTimeOfDay,
  reviewFlagsForLog,
} from "./reviewQueue";
import { makeApplied, makeLog, makeShopProduct } from "./test/fixtures";
import type { ApplicationLog } from "./types";

// TZ is America/Chicago (vitest config). `now` is always built from local parts
// so expectations hold in any device timezone.
const NOW = new Date(2026, 9, 17, 10, 30, 0, 0); // Sat Oct 17 2026, 10:30 local
const CATALOG = [makeShopProduct()];

function texts(log: ApplicationLog, catalog = CATALOG, now = NOW): string[] {
  return reviewFlagsForLog(log, catalog, now).map((f) => f.text);
}

const BANNED = /noncompliant|violation|invalid|compliant|audit/i;

describe("reviewFlagsForLog — negative cases", () => {
  it("complete past log with a unit and a shop product → no flags", () => {
    expect(texts(makeLog())).toEqual([]);
  });

  it("today's date is fine", () => {
    expect(texts(makeLog({ dateUsed: "2026-10-17" }))).toEqual([]);
  });

  it("mixed line with rate text, % AI and a unit → no flags", () => {
    const log = makeLog({
      products: [
        makeApplied({
          method: "mixed",
          rtuAmount: "",
          mixingRate: "1 oz / gal",
          percentAi: "0.06",
          mixedTotal: "2",
          mixedUnit: "gal",
        }),
      ],
    });
    expect(texts(log)).toEqual([]);
  });

  it("archived shop product still on the list → no flag", () => {
    expect(texts(makeLog(), [makeShopProduct({ archived: true })])).toEqual([]);
  });

  it("device line with numeric count → no flag", () => {
    const log = makeLog({
      products: [makeApplied({ catalogId: "trap", method: "device", rtuAmount: "", deviceCount: "3" })],
    });
    expect(texts(log, [makeShopProduct({ id: "trap", kind: "device", epaRegNo: null })])).toEqual([]);
  });
});

describe("a. blank required field", () => {
  it("whitespace-only service address and applicator license", () => {
    const log = makeLog({
      serviceAddress: "   ",
      personnel: [
        { role: "applying", name: "Alice", licenseNumber: " " },
        { role: "supervising", name: "", licenseNumber: "" },
        { role: "receiving_training", name: "", licenseNumber: "" },
      ],
    });
    expect(texts(log)).toEqual([
      "Needs a look: Service address",
      "Needs a look: Person applying — license number",
    ]);
  });

  it("blank RTU amount uses the export gate label", () => {
    const log = makeLog({ products: [makeApplied({ rtuAmount: "" })] });
    expect(texts(log)).toEqual(["Needs a look: Product line 1: RTU amount"]);
  });

  it("blank date is flagged once (not also as unparseable)", () => {
    expect(texts(makeLog({ dateUsed: "" }))).toEqual(["Needs a look: Date used"]);
  });
});

describe("b. value does not parse", () => {
  it("date used that is not a real calendar day", () => {
    const flags = reviewFlagsForLog(makeLog({ dateUsed: "2026-02-30" }), CATALOG, NOW);
    expect(flags.map((f) => [f.rule, f.text])).toEqual([["unparseable", "Needs a look: Date used"]]);
  });

  it("non-numeric RTU amount, total, % AI, device count", () => {
    const log = makeLog({
      products: [
        makeApplied({ rtuAmount: "about a gallon" }),
        makeApplied({
          lineId: "l2",
          method: "mixed",
          rtuAmount: "",
          mixingRate: "1 oz / gal",
          percentAi: "lots",
          mixedTotal: "2 gal",
          mixedUnit: "gal",
        }),
        makeApplied({ lineId: "l3", method: "device", rtuAmount: "", deviceCount: "a few" }),
      ],
    });
    expect(texts(log)).toEqual([
      "Needs a look: Product line 1: RTU amount",
      "Needs a look: Product line 2: total material applied",
      "Needs a look: Product line 2: % AI",
      "Needs a look: Product line 3: device count",
    ]);
  });

  it("pretreat tank fields and times that don't parse", () => {
    const log = makeLog({
      isTermite: true,
      termite: {
        areaTreatedSqFt: "big",
        isBait: false,
        physicalBarrierMeasurement: "",
        diagramNote: "",
        isCommercialPretreat: true,
        tankCount: "two",
        tankGallons: "100",
        startTime: "9am",
        stopTime: "25:00",
      },
    });
    expect(texts(log)).toEqual([
      "Needs a look: Termite area treated (sq ft)",
      "Needs a look: Pretreat tank count",
      "Needs a look: Pretreat start time",
      "Needs a look: Pretreat stop time",
    ]);
  });

  it("free-text fields are not parse-checked", () => {
    const log = makeLog({ targetPestOrPurpose: "!!!", products: [makeApplied({ name: "???" })] });
    expect(texts(log)).toEqual([]);
  });

  it("number helpers", () => {
    expect(parsesAsNumber("1")).toBe(true);
    expect(parsesAsNumber(" 1,250.5 ")).toBe(true);
    expect(parsesAsNumber(".5")).toBe(true);
    expect(parsesAsNumber("1e3")).toBe(false);
    expect(parsesAsNumber("0x10")).toBe(false);
    expect(parsesAsNumber(".")).toBe(false);
    expect(parseTimeOfDay("08:05")).toBe(485);
    expect(parseTimeOfDay("8:05")).toBeNull();
  });
});

describe("c. future date / time (device-local)", () => {
  it("tomorrow is flagged, today and yesterday are not", () => {
    expect(texts(makeLog({ dateUsed: "2026-10-18" }))).toEqual(["Needs a look: Date used"]);
    expect(texts(makeLog({ dateUsed: "2026-10-17" }))).toEqual([]);
    expect(texts(makeLog({ dateUsed: "2026-10-16" }))).toEqual([]);
  });

  it("uses the device-local calendar day, not UTC", () => {
    // 11:30 PM local on Oct 17 is already Oct 18 in UTC; Oct 18 is still the future here.
    const lateNight = new Date(2026, 9, 17, 23, 30);
    expect(lateNight.toISOString().slice(0, 10)).toBe("2026-10-18");
    expect(texts(makeLog({ dateUsed: "2026-10-18" }), CATALOG, lateNight)).toEqual([
      "Needs a look: Date used",
    ]);
    expect(texts(makeLog({ dateUsed: "2026-10-17" }), CATALOG, lateNight)).toEqual([]);
    // 12:30 AM local on Oct 18: Oct 18 is today, not future.
    const justAfterMidnight = new Date(2026, 9, 18, 0, 30);
    expect(texts(makeLog({ dateUsed: "2026-10-18" }), CATALOG, justAfterMidnight)).toEqual([]);
  });

  it("same-day pretreat time later than now is flagged; earlier is not", () => {
    const termite = {
      areaTreatedSqFt: "1200",
      isBait: false,
      physicalBarrierMeasurement: "",
      diagramNote: "",
      isCommercialPretreat: true,
      tankCount: "2",
      tankGallons: "100",
      startTime: "09:00",
      stopTime: "11:00",
    };
    const today = makeLog({ dateUsed: "2026-10-17", isTermite: true, termite });
    expect(texts(today)).toEqual(["Needs a look: Pretreat stop time"]);
    const past = makeLog({ dateUsed: "2026-10-16", isTermite: true, termite });
    expect(texts(past)).toEqual([]);
    // Future date: only Date used is flagged, not the times as well.
    const future = makeLog({ dateUsed: "2026-10-20", isTermite: true, termite });
    expect(texts(future)).toEqual(["Needs a look: Date used"]);
  });
});

describe("d. rate / amount with no unit", () => {
  it("RTU amount with blank unit", () => {
    const log = makeLog({ products: [makeApplied({ rtuUnit: "" })] });
    expect(texts(log)).toEqual(["Needs a look: Product line 1: unit"]);
  });

  it("mixed total with blank unit and bare-number mixing rate", () => {
    const log = makeLog({
      products: [
        makeApplied({
          method: "mixed",
          rtuAmount: "",
          mixingRate: "1",
          percentAi: "",
          mixedTotal: "2",
          mixedUnit: " ",
        }),
      ],
    });
    expect(texts(log)).toEqual([
      "Needs a look: Product line 1: unit",
      "Needs a look: Product line 1: mixing rate unit",
    ]);
  });

  it("rate with a unit is fine", () => {
    const log = makeLog({ products: [makeApplied({ rtuAmount: "16", rtuUnit: "fl oz" })] });
    expect(texts(log)).toEqual([]);
  });
});

describe("e. product not on the shop list, or example / SAMPLE", () => {
  it("product deleted from the shop list", () => {
    expect(texts(makeLog(), [])).toEqual(["Needs a look: Product line 1: product (Talstar P)"]);
  });

  it("example seed line (by flag, catalog id, or SAMPLE- EPA)", () => {
    const byFlag = makeLog({ products: [makeApplied({ isExample: true })] });
    const byId = makeLog({ products: [makeApplied({ catalogId: "example-rtu-insecticide" })] });
    const bySample = makeLog({ products: [makeApplied({ epaRegNo: "SAMPLE-1" })] });
    for (const log of [byFlag, byId, bySample]) {
      expect(texts(log)).toEqual(["Needs a look: Product line 1: EPA registration number"]);
    }
  });

  it("shop row that is itself an example seed", () => {
    expect(texts(makeLog(), [makeShopProduct({ isExample: true })])).toEqual([
      "Needs a look: Product line 1: EPA registration number",
    ]);
  });

  it("sampleData marker without an example line", () => {
    expect(texts(makeLog({ sampleData: true }))).toEqual(["Needs a look: Pesticides / devices"]);
  });
});

describe("buildReviewQueue", () => {
  it("keeps only flagged logs, newest date first", () => {
    const ok = makeLog({ id: "ok" });
    const a = makeLog({ id: "a", dateUsed: "2026-09-01", serviceAddress: "" });
    const b = makeLog({ id: "b", dateUsed: "2026-10-01", products: [makeApplied({ rtuUnit: "" })] });
    const queue = buildReviewQueue([ok, a, b], CATALOG, NOW);
    expect(queue.map((e) => e.log.id)).toEqual(["b", "a"]);
  });

  it("every flag is worded 'Needs a look: [field]' with no loaded wording", () => {
    const log = makeLog({
      dateUsed: "2099-01-01",
      serviceAddress: "",
      products: [makeApplied({ rtuUnit: "", rtuAmount: "x", isExample: true })],
    });
    const flags = reviewFlagsForLog(log, [], NOW);
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      expect(f.text).toBe(needsALookText(f.field));
      expect(f.text).toMatch(/^Needs a look: \S/);
      expect(f.text).not.toMatch(BANNED);
    }
  });
});
