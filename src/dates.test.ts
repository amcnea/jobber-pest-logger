import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ceDueStatus,
  daysUntilLocal,
  filterLogsByDateUsed,
  formatCeDueLabel,
  formatLicenseDueLabel,
  licenseDueStatus,
  localDateYmd,
  monthRangeLocal,
  parseLocalYmd,
} from "./dates";

// vitest.config.ts pins TZ=America/Chicago (CDT -05:00 / CST -06:00).
// DST 2026: starts Sun 2026-03-08 02:00, ends Sun 2026-11-01 02:00.

/** Local wall-clock Date in the pinned TZ. month is 1-based. */
function local(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

/** Run fn with process.env.TZ temporarily switched (Node honors runtime TZ changes). */
function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

describe("test environment", () => {
  it("runs in America/Chicago", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Chicago");
    expect(new Date("2026-07-01T12:00:00Z").getTimezoneOffset()).toBe(300);
    expect(new Date("2026-01-01T12:00:00Z").getTimezoneOffset()).toBe(360);
  });
});

// ---------------------------------------------------------------------------
// localDateYmd
// ---------------------------------------------------------------------------

describe("localDateYmd", () => {
  it("formats a local date as zero-padded YYYY-MM-DD", () => {
    expect(localDateYmd(local(2026, 1, 5))).toBe("2026-01-05");
    expect(localDateYmd(local(2026, 12, 31))).toBe("2026-12-31");
  });

  it("uses the device-local calendar day, not the UTC day", () => {
    // 03:00Z on Sep 27 is 22:00 CDT on Sep 26.
    const d = new Date("2026-09-27T03:00:00Z");
    expect(d.toISOString().slice(0, 10)).toBe("2026-09-27");
    expect(localDateYmd(d)).toBe("2026-09-26");
  });

  it("follows the device timezone when it changes", () => {
    const d = new Date("2026-09-27T03:00:00Z");
    expect(withTz("Asia/Tokyo", () => localDateYmd(d))).toBe("2026-09-27");
    expect(withTz("Pacific/Honolulu", () => localDateYmd(d))).toBe("2026-09-26");
    expect(withTz("UTC", () => localDateYmd(d))).toBe("2026-09-27");
  });

  it("handles local midnight boundaries", () => {
    expect(localDateYmd(local(2026, 9, 26, 0, 0))).toBe("2026-09-26");
    expect(localDateYmd(new Date(2026, 8, 26, 23, 59, 59, 999))).toBe("2026-09-26");
    expect(localDateYmd(local(2026, 12, 31, 23, 59))).toBe("2026-12-31");
    expect(localDateYmd(local(2027, 1, 1, 0, 0))).toBe("2027-01-01");
  });

  it("pads 4-digit years and handles leap day", () => {
    expect(localDateYmd(local(2024, 2, 29))).toBe("2024-02-29");
  });

  describe("default argument (now)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("defaults to the current local date", () => {
      vi.setSystemTime(new Date("2026-09-27T04:59:00Z")); // 23:59 CDT Sep 26
      expect(localDateYmd()).toBe("2026-09-26");
      vi.setSystemTime(new Date("2026-09-27T05:00:00Z")); // 00:00 CDT Sep 27
      expect(localDateYmd()).toBe("2026-09-27");
    });
  });
});

// ---------------------------------------------------------------------------
// parseLocalYmd
// ---------------------------------------------------------------------------

describe("parseLocalYmd", () => {
  it("parses YYYY-MM-DD as noon local time on that day", () => {
    const d = parseLocalYmd("2026-09-26");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(8);
    expect(d!.getDate()).toBe(26);
    expect(d!.getHours()).toBe(12);
    expect(d!.getMinutes()).toBe(0);
    expect(d!.getTime()).toBe(local(2026, 9, 26, 12).getTime());
  });

  it("round-trips with localDateYmd", () => {
    for (const ymd of ["2026-01-01", "2026-03-08", "2026-11-01", "2024-02-29", "2026-12-31"]) {
      expect(localDateYmd(parseLocalYmd(ymd)!)).toBe(ymd);
    }
  });

  it("stays on the right day on DST transition days", () => {
    // Noon exists on both transition days, so the date must not shift.
    expect(parseLocalYmd("2026-03-08")!.getHours()).toBe(12);
    expect(parseLocalYmd("2026-11-01")!.getHours()).toBe(12);
  });

  it("trims surrounding whitespace", () => {
    expect(localDateYmd(parseLocalYmd("  2026-09-26\n")!)).toBe("2026-09-26");
  });

  it("accepts Feb 29 only in leap years", () => {
    expect(parseLocalYmd("2024-02-29")).not.toBeNull();
    expect(parseLocalYmd("2000-02-29")).not.toBeNull();
    expect(parseLocalYmd("2026-02-29")).toBeNull();
    expect(parseLocalYmd("1900-02-29")).toBeNull();
  });

  it("rejects impossible days that would otherwise roll over", () => {
    expect(parseLocalYmd("2026-02-30")).toBeNull();
    expect(parseLocalYmd("2026-04-31")).toBeNull();
    expect(parseLocalYmd("2026-06-31")).toBeNull();
    expect(parseLocalYmd("2026-01-31")).not.toBeNull();
  });

  it.each(["2026-00-10", "2026-13-01", "2026-01-00", "2026-01-32", "2026-99-99"])(
    "rejects out-of-range %s",
    (ymd) => {
      expect(parseLocalYmd(ymd)).toBeNull();
    },
  );

  it.each([
    "",
    "   ",
    "2026-9-26",
    "2026-09-6",
    "26-09-26",
    "2026/09/26",
    "09-26-2026",
    "2026-09-26T00:00",
    "2026-09-26Z",
    "20260926",
    "abcd-ef-gh",
    "2026-09-26 extra",
  ])("rejects malformed input %j", (ymd) => {
    expect(parseLocalYmd(ymd)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// daysUntilLocal
// ---------------------------------------------------------------------------

describe("daysUntilLocal", () => {
  const today = local(2026, 9, 26, 12);

  it("is 0 for today, positive for future, negative for past", () => {
    expect(daysUntilLocal("2026-09-26", today)).toBe(0);
    expect(daysUntilLocal("2026-09-27", today)).toBe(1);
    expect(daysUntilLocal("2026-09-25", today)).toBe(-1);
    expect(daysUntilLocal("2026-10-26", today)).toBe(30);
    expect(daysUntilLocal("2025-09-26", today)).toBe(-365);
  });

  it("ignores the time of day of `today`", () => {
    for (const [h, m] of [
      [0, 0],
      [0, 1],
      [11, 59],
      [23, 59],
    ]) {
      expect(daysUntilLocal("2026-09-27", local(2026, 9, 26, h, m))).toBe(1);
    }
  });

  it("counts whole calendar days across DST start and end", () => {
    expect(daysUntilLocal("2026-03-09", local(2026, 3, 7, 23, 30))).toBe(2);
    expect(daysUntilLocal("2026-03-08", local(2026, 3, 7, 0, 5))).toBe(1);
    expect(daysUntilLocal("2026-04-01", local(2026, 3, 1))).toBe(31);
    expect(daysUntilLocal("2026-11-02", local(2026, 10, 31, 23, 59))).toBe(2);
    expect(daysUntilLocal("2026-12-01", local(2026, 11, 1))).toBe(30);
    expect(daysUntilLocal("2026-01-01", local(2026, 12, 31))).toBe(-364);
  });

  it("crosses year and leap-year boundaries", () => {
    expect(daysUntilLocal("2027-01-01", local(2026, 12, 31, 23, 59))).toBe(1);
    expect(daysUntilLocal("2024-03-01", local(2024, 2, 28))).toBe(2);
    expect(daysUntilLocal("2025-01-01", local(2024, 1, 1))).toBe(366);
  });

  it("uses the device-local day of `today`, not the UTC day", () => {
    // 2026-09-27T03:00Z is still Sep 26 locally.
    expect(daysUntilLocal("2026-09-26", new Date("2026-09-27T03:00:00Z"))).toBe(0);
  });

  it("returns null for invalid dates", () => {
    expect(daysUntilLocal("", today)).toBeNull();
    expect(daysUntilLocal("2026-02-30", today)).toBeNull();
    expect(daysUntilLocal("not a date", today)).toBeNull();
  });

  describe("default today", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(local(2026, 9, 26, 8));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("defaults to now", () => {
      expect(daysUntilLocal("2026-09-26")).toBe(0);
      expect(daysUntilLocal("2026-10-01")).toBe(5);
    });
  });
});

// ---------------------------------------------------------------------------
// licenseDueStatus / formatLicenseDueLabel (use the current time)
// ---------------------------------------------------------------------------

describe("licenseDueStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 26, 9, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is missing for empty, whitespace, null, undefined and invalid dates", () => {
    expect(licenseDueStatus("")).toBe("missing");
    expect(licenseDueStatus("   ")).toBe("missing");
    expect(licenseDueStatus(null)).toBe("missing");
    expect(licenseDueStatus(undefined)).toBe("missing");
    expect(licenseDueStatus("2026-02-30")).toBe("missing");
    expect(licenseDueStatus("garbage")).toBe("missing");
  });

  it("is overdue for any past date", () => {
    expect(licenseDueStatus("2026-09-25")).toBe("overdue");
    expect(licenseDueStatus("2020-01-01")).toBe("overdue");
  });

  it("is soon from today through 30 days out (inclusive)", () => {
    expect(licenseDueStatus("2026-09-26")).toBe("soon");
    expect(licenseDueStatus("2026-10-10")).toBe("soon");
    expect(licenseDueStatus("2026-10-26")).toBe("soon"); // day 30
  });

  it("is ok beyond 30 days", () => {
    expect(licenseDueStatus("2026-10-27")).toBe("ok"); // day 31
    expect(licenseDueStatus("2030-01-01")).toBe("ok");
  });

  it("respects a custom window", () => {
    expect(licenseDueStatus("2026-10-03", 7)).toBe("soon"); // day 7
    expect(licenseDueStatus("2026-10-04", 7)).toBe("ok"); // day 8
    expect(licenseDueStatus("2026-09-26", 0)).toBe("soon");
    expect(licenseDueStatus("2026-09-27", 0)).toBe("ok");
  });

  it("tolerates surrounding whitespace", () => {
    expect(licenseDueStatus(" 2026-10-01 ")).toBe("soon");
  });

  it("flips at local midnight, not UTC midnight", () => {
    // 23:30 CDT Sep 26 (= 04:30Z Sep 27): a license expiring Sep 26 is still due today.
    vi.setSystemTime(new Date("2026-09-27T04:30:00Z"));
    expect(licenseDueStatus("2026-09-26")).toBe("soon");
    // 00:30 CDT Sep 27: now overdue.
    vi.setSystemTime(new Date("2026-09-27T05:30:00Z"));
    expect(licenseDueStatus("2026-09-26")).toBe("overdue");
  });
});

describe("formatLicenseDueLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 26, 9, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when ok, missing or invalid", () => {
    expect(formatLicenseDueLabel("2027-01-01")).toBeNull();
    expect(formatLicenseDueLabel("")).toBeNull();
    expect(formatLicenseDueLabel("2026-13-01")).toBeNull();
  });

  it("describes overdue licenses with singular/plural days", () => {
    expect(formatLicenseDueLabel("2026-09-25")).toBe("License overdue by 1 day (2026-09-25)");
    expect(formatLicenseDueLabel("2026-09-16")).toBe("License overdue by 10 days (2026-09-16)");
  });

  it("describes upcoming licenses with singular/plural days", () => {
    expect(formatLicenseDueLabel("2026-09-27")).toBe("License due in 1 day (2026-09-27)");
    expect(formatLicenseDueLabel("2026-10-26")).toBe("License due in 30 days (2026-10-26)");
    expect(formatLicenseDueLabel("2026-09-26")).toBe("License due in 0 days (2026-09-26)");
  });
});

// ---------------------------------------------------------------------------
// ceDueStatus / formatCeDueLabel
// ---------------------------------------------------------------------------

describe("ceDueStatus", () => {
  it("is missing for empty/null/undefined/invalid", () => {
    const today = local(2026, 11, 15);
    expect(ceDueStatus("", today)).toBe("missing");
    expect(ceDueStatus("  ", today)).toBe("missing");
    expect(ceDueStatus(null, today)).toBe("missing");
    expect(ceDueStatus(undefined, today)).toBe("missing");
    expect(ceDueStatus("2026-11-31", today)).toBe("missing");
  });

  it("is overdue for past dates in any month", () => {
    expect(ceDueStatus("2026-03-01", local(2026, 6, 1))).toBe("overdue");
    expect(ceDueStatus("2026-11-14", local(2026, 11, 15))).toBe("overdue");
    expect(ceDueStatus("2025-12-31", local(2026, 1, 1))).toBe("overdue");
  });

  it("is ok before November even when due later this year", () => {
    expect(ceDueStatus("2026-12-31", local(2026, 10, 31, 23, 59))).toBe("ok");
    expect(ceDueStatus("2026-10-31", local(2026, 10, 1))).toBe("ok");
    expect(ceDueStatus("2026-06-01", local(2026, 1, 1))).toBe("ok");
  });

  it("is soon in Nov/Dec when due in the current local year", () => {
    expect(ceDueStatus("2026-12-31", local(2026, 11, 1, 0, 0))).toBe("soon");
    expect(ceDueStatus("2026-11-20", local(2026, 11, 15))).toBe("soon");
    expect(ceDueStatus("2026-12-31", local(2026, 12, 31, 23, 59))).toBe("soon");
  });

  it("is ok in Nov/Dec when due next year", () => {
    expect(ceDueStatus("2027-01-01", local(2026, 12, 15))).toBe("ok");
    expect(ceDueStatus("2027-12-31", local(2026, 11, 1))).toBe("ok");
  });

  it("uses the device-local month for the year-end window", () => {
    // 2026-11-01T03:00Z is still Oct 31 22:00 CDT locally -> not in window.
    expect(ceDueStatus("2026-12-31", new Date("2026-11-01T03:00:00Z"))).toBe("ok");
    // 2026-11-01T06:00Z is Nov 1 01:00 CDT locally -> in window.
    expect(ceDueStatus("2026-12-31", new Date("2026-11-01T06:00:00Z"))).toBe("soon");
  });

  it("uses the device-local year when crossing New Year's", () => {
    // 2027-01-01T03:00Z is Dec 31 2026 21:00 CST locally.
    expect(ceDueStatus("2026-12-31", new Date("2027-01-01T03:00:00Z"))).toBe("soon");
  });

  describe("default today", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("defaults to now", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(local(2026, 12, 1));
      expect(ceDueStatus("2026-12-15")).toBe("soon");
      vi.setSystemTime(local(2026, 9, 26));
      expect(ceDueStatus("2026-12-15")).toBe("ok");
    });
  });
});

describe("formatCeDueLabel", () => {
  it("returns null when ok, missing or invalid", () => {
    const today = local(2026, 9, 26);
    expect(formatCeDueLabel("2026-12-31", today)).toBeNull();
    expect(formatCeDueLabel("", today)).toBeNull();
    expect(formatCeDueLabel("nope", today)).toBeNull();
  });

  it("describes overdue CE with singular/plural days", () => {
    expect(formatCeDueLabel("2026-09-25", local(2026, 9, 26))).toBe("CE overdue by 1 day (2026-09-25)");
    expect(formatCeDueLabel("2026-09-01", local(2026, 9, 26))).toBe("CE overdue by 25 days (2026-09-01)");
  });

  it("describes a year-end reminder in Nov/Dec", () => {
    expect(formatCeDueLabel("2026-12-31", local(2026, 11, 2))).toBe(
      "CE due this calendar year (2026-12-31) — year-end reminder",
    );
  });
});

// ---------------------------------------------------------------------------
// monthRangeLocal
// ---------------------------------------------------------------------------

describe("monthRangeLocal", () => {
  it("returns the first and last day of the month", () => {
    expect(monthRangeLocal(local(2026, 9, 26))).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(monthRangeLocal(local(2026, 1, 1))).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(monthRangeLocal(local(2026, 12, 31, 23, 59))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("handles February in leap and non-leap years", () => {
    expect(monthRangeLocal(local(2024, 2, 10))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(monthRangeLocal(local(2026, 2, 10))).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRangeLocal(local(2100, 2, 10))).toEqual({ from: "2100-02-01", to: "2100-02-28" });
  });

  it("handles DST-transition months", () => {
    expect(monthRangeLocal(local(2026, 3, 8))).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(monthRangeLocal(local(2026, 11, 1))).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });

  it("uses the device-local month, not the UTC month", () => {
    // 2026-10-01T02:00Z is Sep 30 21:00 CDT.
    expect(monthRangeLocal(new Date("2026-10-01T02:00:00Z"))).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(withTz("UTC", () => monthRangeLocal(new Date("2026-10-01T02:00:00Z")))).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  describe("default argument", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    it("defaults to the current month", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(local(2026, 4, 15));
      expect(monthRangeLocal()).toEqual({ from: "2026-04-01", to: "2026-04-30" });
    });
  });
});

// ---------------------------------------------------------------------------
// filterLogsByDateUsed
// ---------------------------------------------------------------------------

describe("filterLogsByDateUsed", () => {
  const logs = [
    { id: "a", dateUsed: "2026-08-31" },
    { id: "b", dateUsed: "2026-09-01" },
    { id: "c", dateUsed: "2026-09-15" },
    { id: "d", dateUsed: "2026-09-30" },
    { id: "e", dateUsed: "2026-10-01" },
    { id: "bad", dateUsed: "9/15/2026" },
    { id: "empty", dateUsed: "" },
    { id: "padded", dateUsed: " 2026-09-20 " },
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it("returns the same array when both bounds are empty", () => {
    expect(filterLogsByDateUsed(logs, "", "")).toBe(logs);
    expect(filterLogsByDateUsed(logs, "  ", "\t")).toBe(logs);
  });

  it("treats invalid bounds as unbounded (and returns the input when both are invalid)", () => {
    expect(filterLogsByDateUsed(logs, "Sept 1", "2026/09/30")).toBe(logs);
    expect(ids(filterLogsByDateUsed(logs, "bogus", "2026-09-01"))).toEqual(["a", "b"]);
    expect(ids(filterLogsByDateUsed(logs, "2026-09-30", "bogus"))).toEqual(["d", "e"]);
  });

  it("filters an inclusive from..to range, preserving order", () => {
    expect(ids(filterLogsByDateUsed(logs, "2026-09-01", "2026-09-30"))).toEqual(["b", "c", "d", "padded"]);
  });

  it("supports only a from bound or only a to bound", () => {
    expect(ids(filterLogsByDateUsed(logs, "2026-09-30", ""))).toEqual(["d", "e"]);
    expect(ids(filterLogsByDateUsed(logs, "", "2026-09-01"))).toEqual(["a", "b"]);
  });

  it("trims bounds and dateUsed values", () => {
    expect(ids(filterLogsByDateUsed(logs, " 2026-09-16 ", " 2026-09-25 "))).toEqual(["padded"]);
  });

  it("excludes invalid or empty dateUsed values when any bound is set", () => {
    const out = ids(filterLogsByDateUsed(logs, "2000-01-01", "2100-12-31"));
    expect(out).not.toContain("bad");
    expect(out).not.toContain("empty");
    expect(out).toHaveLength(6);
  });

  it("excludes logs with a missing dateUsed at runtime", () => {
    const loose = [{ id: "x" }, { id: "y", dateUsed: "2026-09-10" }] as unknown as { id: string; dateUsed: string }[];
    expect(ids(filterLogsByDateUsed(loose, "2026-09-01", ""))).toEqual(["y"]);
  });

  it("returns an empty list when from is after to", () => {
    expect(filterLogsByDateUsed(logs, "2026-10-01", "2026-09-01")).toEqual([]);
  });

  it("matches a single day when from === to", () => {
    expect(ids(filterLogsByDateUsed(logs, "2026-09-15", "2026-09-15"))).toEqual(["c"]);
  });

  it("returns an empty list for empty input", () => {
    expect(filterLogsByDateUsed([], "2026-01-01", "2026-12-31")).toEqual([]);
  });

  it("does not depend on the device timezone (pure string comparison)", () => {
    const out = withTz("Asia/Tokyo", () => ids(filterLogsByDateUsed(logs, "2026-09-01", "2026-09-30")));
    expect(out).toEqual(["b", "c", "d", "padded"]);
  });
});
