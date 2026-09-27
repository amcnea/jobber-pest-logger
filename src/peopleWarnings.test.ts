import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectPeopleWarnings,
  personHasWarning,
  personWarningTone,
  warningsForPerson,
} from "./peopleWarnings";
import type { Person } from "./types";

// vitest.config.ts pins TZ=America/Chicago. "Now" is faked per test.

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: "p1",
    name: "Alice Tech",
    licenseNumber: "L-1",
    roleTags: ["applying"],
    licenseExpiry: "2027-06-30",
    ceDueDate: "",
    ...overrides,
  };
}

/** Local wall-clock Date in the pinned TZ. month is 1-based. */
function local(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

function setNow(d: Date) {
  vi.setSystemTime(d);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow(local(2026, 9, 26, 10)); // Sat Sep 26 2026, 10:00 CDT
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// warningsForPerson
// ---------------------------------------------------------------------------

describe("warningsForPerson", () => {
  it("returns no messages when the license is far out and no CE date is set", () => {
    expect(warningsForPerson(person())).toEqual([]);
  });

  it("warns for an overdue license (singular and plural days)", () => {
    expect(warningsForPerson(person({ licenseExpiry: "2026-09-25" }))).toEqual([
      "License overdue by 1 day (2026-09-25)",
    ]);
    expect(warningsForPerson(person({ licenseExpiry: "2026-09-01" }))).toEqual([
      "License overdue by 25 days (2026-09-01)",
    ]);
  });

  it("warns when the license is due within 30 days (inclusive)", () => {
    expect(warningsForPerson(person({ licenseExpiry: "2026-09-26" }))).toEqual([
      "License due in 0 days (2026-09-26)",
    ]);
    expect(warningsForPerson(person({ licenseExpiry: "2026-09-27" }))).toEqual([
      "License due in 1 day (2026-09-27)",
    ]);
    expect(warningsForPerson(person({ licenseExpiry: "2026-10-26" }))).toEqual([
      "License due in 30 days (2026-10-26)",
    ]);
  });

  it("does not warn when the license is 31+ days out", () => {
    expect(warningsForPerson(person({ licenseExpiry: "2026-10-27" }))).toEqual([]);
  });

  it("does not warn for a missing or invalid license expiry", () => {
    expect(warningsForPerson(person({ licenseExpiry: "" }))).toEqual([]);
    expect(warningsForPerson(person({ licenseExpiry: "   " }))).toEqual([]);
    expect(warningsForPerson(person({ licenseExpiry: "2026-02-30" }))).toEqual([]);
    expect(warningsForPerson(person({ licenseExpiry: "not a date" }))).toEqual([]);
  });

  it("warns for an overdue CE date", () => {
    expect(warningsForPerson(person({ ceDueDate: "2026-09-20" }))).toEqual(["CE overdue by 6 days (2026-09-20)"]);
    expect(warningsForPerson(person({ ceDueDate: "2026-09-25" }))).toEqual(["CE overdue by 1 day (2026-09-25)"]);
  });

  it("does not give a CE year-end reminder before November", () => {
    expect(warningsForPerson(person({ ceDueDate: "2026-12-31" }))).toEqual([]);
  });

  it("gives a CE year-end reminder in Nov/Dec for a CE due this local year", () => {
    setNow(local(2026, 11, 2));
    expect(warningsForPerson(person({ ceDueDate: "2026-12-31" }))).toEqual([
      "CE due this calendar year (2026-12-31) — year-end reminder",
    ]);
  });

  it("does not give a year-end reminder for a CE due next year", () => {
    setNow(local(2026, 12, 15));
    expect(warningsForPerson(person({ ceDueDate: "2027-12-31" }))).toEqual([]);
  });

  it("ignores blank / whitespace / invalid CE dates", () => {
    expect(warningsForPerson(person({ ceDueDate: "" }))).toEqual([]);
    expect(warningsForPerson(person({ ceDueDate: "  \t" }))).toEqual([]);
    expect(warningsForPerson(person({ ceDueDate: "2026-13-01" }))).toEqual([]);
  });

  it("lists the license message before the CE message when both apply", () => {
    expect(warningsForPerson(person({ licenseExpiry: "2026-10-01", ceDueDate: "2026-09-01" }))).toEqual([
      "License due in 5 days (2026-10-01)",
      "CE overdue by 25 days (2026-09-01)",
    ]);
  });

  it("flips at local midnight, not UTC midnight", () => {
    // 23:30 CDT Sep 26 == 04:30Z Sep 27: a license expiring Sep 26 is still "due in 0 days".
    setNow(new Date("2026-09-27T04:30:00Z"));
    expect(warningsForPerson(person({ licenseExpiry: "2026-09-26" }))).toEqual([
      "License due in 0 days (2026-09-26)",
    ]);
    // 00:30 CDT Sep 27: overdue by 1 day.
    setNow(new Date("2026-09-27T05:30:00Z"));
    expect(warningsForPerson(person({ licenseExpiry: "2026-09-26" }))).toEqual([
      "License overdue by 1 day (2026-09-26)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// collectPeopleWarnings
// ---------------------------------------------------------------------------

describe("collectPeopleWarnings", () => {
  it("returns an empty list for no people", () => {
    expect(collectPeopleWarnings([])).toEqual([]);
  });

  it("returns an empty list when nobody has a warning", () => {
    expect(collectPeopleWarnings([person({ id: "a" }), person({ id: "b", ceDueDate: "2027-03-01" })])).toEqual([]);
  });

  it("includes only people with warnings, preserving roster order", () => {
    const out = collectPeopleWarnings([
      person({ id: "a", name: "Ann", licenseExpiry: "2026-09-20" }),
      person({ id: "b", name: "Ben" }),
      person({ id: "c", name: "Cy", licenseExpiry: "2026-10-01", ceDueDate: "2026-09-01" }),
    ]);
    expect(out).toEqual([
      { personId: "a", personName: "Ann", messages: ["License overdue by 6 days (2026-09-20)"] },
      {
        personId: "c",
        personName: "Cy",
        messages: ["License due in 5 days (2026-10-01)", "CE overdue by 25 days (2026-09-01)"],
      },
    ]);
  });

  it("trims names and labels blank names as (unnamed)", () => {
    const out = collectPeopleWarnings([
      person({ id: "a", name: "  Ann  ", licenseExpiry: "2026-09-20" }),
      person({ id: "b", name: "", licenseExpiry: "2026-09-20" }),
      person({ id: "c", name: "   ", licenseExpiry: "2026-09-20" }),
    ]);
    expect(out.map((w) => w.personName)).toEqual(["Ann", "(unnamed)", "(unnamed)"]);
    expect(out.map((w) => w.personId)).toEqual(["a", "b", "c"]);
  });

  it("messages match warningsForPerson for each person", () => {
    const people = [
      person({ id: "a", licenseExpiry: "2026-09-20", ceDueDate: "2026-09-01" }),
      person({ id: "b", licenseExpiry: "2026-10-10" }),
    ];
    const out = collectPeopleWarnings(people);
    expect(out.map((w) => w.messages)).toEqual(people.map(warningsForPerson));
  });

  it("does not mutate the input array", () => {
    const people = [person({ id: "a" }), person({ id: "b", licenseExpiry: "2026-09-20" })];
    const copy = structuredClone(people);
    collectPeopleWarnings(people);
    expect(people).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// personHasWarning
// ---------------------------------------------------------------------------

describe("personHasWarning", () => {
  it("is false with no warnings", () => {
    expect(personHasWarning(person())).toBe(false);
    expect(personHasWarning(person({ licenseExpiry: "", ceDueDate: "" }))).toBe(false);
  });

  it("is true for license-only, CE-only, and both", () => {
    expect(personHasWarning(person({ licenseExpiry: "2026-10-01" }))).toBe(true);
    expect(personHasWarning(person({ ceDueDate: "2026-01-01" }))).toBe(true);
    expect(personHasWarning(person({ licenseExpiry: "2026-09-01", ceDueDate: "2026-01-01" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// personWarningTone
// ---------------------------------------------------------------------------

describe("personWarningTone", () => {
  it("is null when there is nothing to warn about", () => {
    expect(personWarningTone(person())).toBeNull();
    expect(personWarningTone(person({ licenseExpiry: "", ceDueDate: "" }))).toBeNull();
    expect(personWarningTone(person({ licenseExpiry: "garbage", ceDueDate: "  " }))).toBeNull();
  });

  it("is overdue when the license is overdue", () => {
    expect(personWarningTone(person({ licenseExpiry: "2026-09-25" }))).toBe("overdue");
  });

  it("is overdue when the CE is overdue", () => {
    expect(personWarningTone(person({ ceDueDate: "2026-09-25" }))).toBe("overdue");
  });

  it("is soon when only a soon warning applies", () => {
    expect(personWarningTone(person({ licenseExpiry: "2026-10-26" }))).toBe("soon");
    setNow(local(2026, 11, 15));
    expect(personWarningTone(person({ licenseExpiry: "2027-06-30", ceDueDate: "2026-12-31" }))).toBe("soon");
  });

  it("prefers overdue over soon regardless of which item is which", () => {
    expect(personWarningTone(person({ licenseExpiry: "2026-10-01", ceDueDate: "2026-09-01" }))).toBe("overdue");
    setNow(local(2026, 11, 15));
    expect(personWarningTone(person({ licenseExpiry: "2026-11-01", ceDueDate: "2026-12-31" }))).toBe("overdue");
  });

  it("agrees with personHasWarning across a range of dates", () => {
    const licenses = ["", "bad", "2026-09-01", "2026-09-26", "2026-10-26", "2026-10-27", "2030-01-01"];
    const ces = ["", "  ", "bad", "2026-09-01", "2026-12-31", "2027-01-01"];
    for (const now of [local(2026, 9, 26), local(2026, 11, 15), local(2026, 12, 31, 23, 59)]) {
      setNow(now);
      for (const licenseExpiry of licenses) {
        for (const ceDueDate of ces) {
          const p = person({ licenseExpiry, ceDueDate });
          expect(personWarningTone(p) !== null, `${now.toISOString()} ${licenseExpiry} / ${ceDueDate}`).toBe(
            personHasWarning(p),
          );
        }
      }
    }
  });

  it("uses the device-local date for the tone boundary", () => {
    setNow(new Date("2026-09-27T04:30:00Z")); // 23:30 CDT Sep 26
    expect(personWarningTone(person({ licenseExpiry: "2026-09-26" }))).toBe("soon");
    setNow(new Date("2026-09-27T05:30:00Z")); // 00:30 CDT Sep 27
    expect(personWarningTone(person({ licenseExpiry: "2026-09-26" }))).toBe("overdue");
  });
});
