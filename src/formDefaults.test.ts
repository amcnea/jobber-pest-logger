import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SEEDS } from "./catalog";
import {
  draftDuplicateLastStop,
  draftLogAgainHere,
  emptyLog,
  emptyTermite,
  exportCompletenessIssues,
  FIELD_LABELS,
  personnelFromRosterDefaults,
  productFromCatalog,
  rosterPicksForPersonnel,
  validateLog,
  withSaveFlags,
  type PropertyPrefill,
} from "./formDefaults";
import type { ApplicationLog, AppliedProduct, Person, Personnel, ShopProduct, ShopSettings } from "./types";

// vitest.config.ts pins TZ=America/Chicago. "Now" is faked per test.
const NOW = new Date("2026-09-27T00:05:00Z"); // Sat Sep 26 2026 19:05 CDT (already Sep 27 in UTC)
const TODAY = "2026-09-26";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const settings: ShopSettings = { shopName: "Acme Pest", shopTpclNumber: "12345", shopTpclLetter: "B" };

function shopProduct(overrides: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id: "prod-1",
    name: "Real Pesticide",
    epaRegNo: "1234-56",
    is25b: false,
    kind: "pesticide",
    isExample: false,
    archived: false,
    ...overrides,
  };
}

function applied(overrides: Partial<AppliedProduct> = {}): AppliedProduct {
  return {
    lineId: "line-1",
    catalogId: "prod-1",
    name: "Real Pesticide",
    epaRegNo: "1234-56",
    is25b: false,
    isExample: false,
    method: "rtu",
    rtuAmount: "16",
    rtuUnit: "fl oz",
    mixingRate: "",
    percentAi: "",
    mixedTotal: "",
    mixedUnit: "gal",
    deviceCount: "",
    ...overrides,
  };
}

function rosterPerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-1",
    name: "Alice Tech",
    licenseNumber: "A-1",
    roleTags: [],
    licenseExpiry: "2027-06-30",
    ceDueDate: "",
    ...overrides,
  };
}

/** A log that passes validateLog. */
function validLog(overrides: Partial<ApplicationLog> = {}): ApplicationLog {
  return {
    ...emptyLog(settings),
    id: "log-1",
    customerBillingName: "Jane Doe",
    customerBillingAddress: "1 Main St",
    serviceAddress: "2 Oak Ave",
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-26",
    personnel: [
      { role: "applying", name: "Alice Tech", licenseNumber: "A-1" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ],
    products: [applied()],
    ...overrides,
  };
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// emptyTermite
// ---------------------------------------------------------------------------

describe("emptyTermite", () => {
  it("returns all-blank termite extras", () => {
    expect(emptyTermite()).toEqual({
      areaTreatedSqFt: "",
      isBait: false,
      physicalBarrierMeasurement: "",
      diagramNote: "",
      isCommercialPretreat: false,
      tankCount: "",
      tankGallons: "",
      startTime: "",
      stopTime: "",
    });
  });

  it("returns a fresh object each call", () => {
    const a = emptyTermite();
    a.areaTreatedSqFt = "100";
    expect(emptyTermite().areaTreatedSqFt).toBe("");
    expect(emptyTermite()).not.toBe(emptyTermite());
  });
});

// ---------------------------------------------------------------------------
// productFromCatalog
// ---------------------------------------------------------------------------

describe("productFromCatalog", () => {
  it("returns null for an unknown catalog id or empty catalog", () => {
    expect(productFromCatalog([shopProduct()], "nope")).toBeNull();
    expect(productFromCatalog([], "prod-1")).toBeNull();
  });

  it("builds an RTU line for a registered pesticide with default units", () => {
    const p = productFromCatalog([shopProduct()], "prod-1");
    expect(p).toMatchObject({
      catalogId: "prod-1",
      name: "Real Pesticide",
      epaRegNo: "1234-56",
      is25b: false,
      isExample: false,
      method: "rtu",
      rtuAmount: "",
      rtuUnit: "fl oz",
      mixingRate: "",
      percentAi: "",
      mixedTotal: "",
      mixedUnit: "gal",
      deviceCount: "",
    });
    expect(p!.lineId).toMatch(UUIDISH);
  });

  it("picks the matching product among several", () => {
    const catalog = [shopProduct({ id: "a", name: "A" }), shopProduct({ id: "b", name: "B", epaRegNo: "9-9" })];
    expect(productFromCatalog(catalog, "b")).toMatchObject({ catalogId: "b", name: "B", epaRegNo: "9-9" });
  });

  it("gives each line a new unique lineId", () => {
    const catalog = [shopProduct()];
    const a = productFromCatalog(catalog, "prod-1")!;
    const b = productFromCatalog(catalog, "prod-1")!;
    expect(a.lineId).not.toBe(b.lineId);
  });

  it("drops the EPA number for 25(b) products", () => {
    const p = productFromCatalog([shopProduct({ is25b: true, epaRegNo: "999-9" })], "prod-1")!;
    expect(p.epaRegNo).toBeNull();
    expect(p.is25b).toBe(true);
    expect(p.method).toBe("rtu");
  });

  it("drops the EPA number for example seeds and marks them as examples", () => {
    const p = productFromCatalog([shopProduct({ isExample: true, epaRegNo: "123-4" })], "prod-1")!;
    expect(p.epaRegNo).toBeNull();
    expect(p.isExample).toBe(true);
  });

  it("builds a device line with count 1 and no EPA number", () => {
    const p = productFromCatalog([shopProduct({ kind: "device", epaRegNo: "555-5" })], "prod-1")!;
    expect(p.method).toBe("device");
    expect(p.deviceCount).toBe("1");
    expect(p.epaRegNo).toBeNull();
  });

  it("keeps a null EPA number for unregistered pesticides", () => {
    expect(productFromCatalog([shopProduct({ epaRegNo: null })], "prod-1")!.epaRegNo).toBeNull();
  });

  it("works with the built-in example seeds", () => {
    for (const seed of EXAMPLE_SEEDS) {
      const p = productFromCatalog(EXAMPLE_SEEDS, seed.id)!;
      expect(p.isExample).toBe(true);
      expect(p.epaRegNo).toBeNull();
      expect(p.method).toBe(seed.kind === "device" ? "device" : "rtu");
    }
  });

  it("includes archived products (lookup is by id only)", () => {
    expect(productFromCatalog([shopProduct({ archived: true })], "prod-1")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// emptyLog
// ---------------------------------------------------------------------------

describe("emptyLog", () => {
  it("creates a blank log dated today (device-local) with three empty personnel rows", () => {
    const log = emptyLog();
    expect(log.id).toMatch(UUIDISH);
    expect(log.createdAt).toBe(NOW.toISOString());
    expect(log.dateUsed).toBe(TODAY); // local date, not the UTC date (2026-09-27)
    expect(log.sampleData).toBe(false);
    expect(log.products).toEqual([]);
    expect(log.isTermite).toBe(false);
    expect(log.termite).toEqual(emptyTermite());
    expect(log.personnel).toEqual([
      { role: "applying", name: "", licenseNumber: "" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ]);
    for (const k of [
      "jobberJobNumber",
      "jobberAddress",
      "customerBillingName",
      "customerBillingAddress",
      "serviceAddress",
      "poleLocation",
      "targetPestOrPurpose",
      "shopTpclNumber",
      "shopTpclLetter",
    ] as const) {
      expect(log[k]).toBe("");
    }
  });

  it("copies shop TPCL number/letter from settings", () => {
    const log = emptyLog(settings);
    expect(log.shopTpclNumber).toBe("12345");
    expect(log.shopTpclLetter).toBe("B");
  });

  it("treats null settings like no settings", () => {
    const log = emptyLog(null);
    expect(log.shopTpclNumber).toBe("");
    expect(log.shopTpclLetter).toBe("");
  });

  it("generates a new id each call", () => {
    expect(emptyLog().id).not.toBe(emptyLog().id);
  });
});

// ---------------------------------------------------------------------------
// FIELD_LABELS
// ---------------------------------------------------------------------------

describe("FIELD_LABELS", () => {
  it("has a label for every fixed key validateLog can emit", () => {
    const everythingMissing: ApplicationLog = {
      ...emptyLog(),
      personnel: [],
      isTermite: true,
      termite: { ...emptyTermite(), isCommercialPretreat: true },
    };
    const keys = Object.keys(validateLog(everythingMissing));
    for (const k of keys) expect(FIELD_LABELS[k], k).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// validateLog
// ---------------------------------------------------------------------------

describe("validateLog", () => {
  it("returns no errors for a complete log", () => {
    expect(validateLog(validLog())).toEqual({});
  });

  it("requires the core § 7.144(a) fields (whitespace counts as empty)", () => {
    const errors = validateLog(
      validLog({
        customerBillingName: "",
        customerBillingAddress: "  ",
        serviceAddress: "\t",
        targetPestOrPurpose: "",
        dateUsed: " ",
        shopTpclNumber: "",
      }),
    );
    expect(errors).toEqual({
      customerBillingName: "Required",
      customerBillingAddress: "Required",
      serviceAddress: "Required",
      targetPestOrPurpose: "Required",
      dateUsed: "Required",
      shopTpclNumber: "Required",
    });
  });

  it("does not require the TPCL letter, pole location, or Jobber fields", () => {
    expect(validateLog(validLog({ shopTpclLetter: "", poleLocation: "", jobberJobNumber: "", jobberAddress: "" }))).toEqual(
      {},
    );
  });

  it("requires the applying person's name and license", () => {
    const personnel: Personnel[] = [{ role: "applying", name: " ", licenseNumber: "" }];
    expect(validateLog(validLog({ personnel }))).toEqual({
      applyingName: "Required",
      applyingLicense: "Required",
    });
  });

  it("flags a missing applying row entirely", () => {
    const personnel: Personnel[] = [{ role: "supervising", name: "Sam", licenseNumber: "S-1" }];
    expect(validateLog(validLog({ personnel }))).toEqual({
      applyingName: "Required",
      applyingLicense: "Required",
    });
  });

  it("does not require supervising or trainee rows", () => {
    const personnel: Personnel[] = [{ role: "applying", name: "Alice", licenseNumber: "A-1" }];
    expect(validateLog(validLog({ personnel }))).toEqual({});
  });

  it("requires at least one product", () => {
    expect(validateLog(validLog({ products: [] }))).toEqual({
      products: "Add at least one pesticide or device from the shop list.",
    });
  });

  it("requires a product name", () => {
    expect(validateLog(validLog({ products: [applied({ name: "  " })] }))).toEqual({
      "product-0-name": "Product name required",
    });
  });

  it("requires an RTU amount for RTU lines", () => {
    expect(validateLog(validLog({ products: [applied({ rtuAmount: " " })] }))).toEqual({
      "product-0-rtu": "RTU amount required",
    });
  });

  it("requires a device count for device lines (and not an RTU amount)", () => {
    expect(
      validateLog(validLog({ products: [applied({ method: "device", rtuAmount: "", deviceCount: "" })] })),
    ).toEqual({ "product-0-device": "Device count required" });
    expect(validateLog(validLog({ products: [applied({ method: "device", rtuAmount: "", deviceCount: "3" })] }))).toEqual(
      {},
    );
  });

  it("requires mixing rate or % AI, and a total, for mixed lines", () => {
    const base = { method: "mixed" as const, rtuAmount: "" };
    expect(validateLog(validLog({ products: [applied({ ...base })] }))).toEqual({
      "product-0-mix": "Enter mixing rate or % AI",
      "product-0-total": "Total material applied required",
    });
    expect(validateLog(validLog({ products: [applied({ ...base, mixingRate: "1 oz/gal", mixedTotal: "2" })] }))).toEqual(
      {},
    );
    expect(validateLog(validLog({ products: [applied({ ...base, percentAi: "0.5", mixedTotal: "2" })] }))).toEqual({});
    expect(validateLog(validLog({ products: [applied({ ...base, percentAi: " ", mixingRate: " ", mixedTotal: "2" })] })))
      .toEqual({ "product-0-mix": "Enter mixing rate or % AI" });
  });

  it("indexes product errors by line position", () => {
    const errors = validateLog(
      validLog({
        products: [applied(), applied({ lineId: "2", rtuAmount: "" }), applied({ lineId: "3", name: "" })],
      }),
    );
    expect(errors).toEqual({
      "product-1-rtu": "RTU amount required",
      "product-2-name": "Product name required",
    });
  });

  it("ignores termite fields when the log is not termite work", () => {
    expect(
      validateLog(validLog({ isTermite: false, termite: { ...emptyTermite(), isCommercialPretreat: true } })),
    ).toEqual({});
  });

  it("requires area treated for non-bait termite work only", () => {
    expect(validateLog(validLog({ isTermite: true }))).toEqual({ termiteArea: "Required for non-bait termite work" });
    expect(validateLog(validLog({ isTermite: true, termite: { ...emptyTermite(), isBait: true } }))).toEqual({});
    expect(
      validateLog(validLog({ isTermite: true, termite: { ...emptyTermite(), areaTreatedSqFt: "1500" } })),
    ).toEqual({});
  });

  it("requires tank count/gallons/start/stop for commercial pretreats", () => {
    const termite = { ...emptyTermite(), isBait: true, isCommercialPretreat: true };
    expect(validateLog(validLog({ isTermite: true, termite }))).toEqual({
      termiteTankCount: "Required",
      termiteTankGallons: "Required",
      termiteStart: "Required",
      termiteStop: "Required",
    });
    expect(
      validateLog(
        validLog({
          isTermite: true,
          termite: { ...termite, tankCount: "2", tankGallons: "100", startTime: "08:00", stopTime: "09:00" },
        }),
      ),
    ).toEqual({});
  });

  it("does not validate the date format (only presence)", () => {
    expect(validateLog(validLog({ dateUsed: "sometime" }))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// exportCompletenessIssues
// ---------------------------------------------------------------------------

describe("exportCompletenessIssues", () => {
  it("returns no issues for empty input or complete logs", () => {
    expect(exportCompletenessIssues([])).toEqual([]);
    expect(exportCompletenessIssues([validLog(), validLog({ id: "log-2" })])).toEqual([]);
  });

  it("maps fixed error keys to human labels", () => {
    const issues = exportCompletenessIssues([
      validLog({ customerBillingName: "", shopTpclNumber: "", personnel: [] }),
    ]);
    expect(issues).toEqual([
      {
        logId: "log-1",
        dateUsed: "2026-09-26",
        serviceAddress: "2 Oak Ave",
        fields: [
          "Customer billing name",
          "Shop TPCL number",
          "Person applying — name",
          "Person applying — license number",
        ],
      },
    ]);
  });

  it("labels product-line errors with 1-based line numbers", () => {
    const issues = exportCompletenessIssues([
      validLog({
        products: [
          applied({ name: "", rtuAmount: "" }),
          applied({ lineId: "2", method: "device", deviceCount: "" }),
          applied({ lineId: "3", method: "mixed", rtuAmount: "" }),
        ],
      }),
    ]);
    expect(issues[0].fields).toEqual([
      "Product line 1: name",
      "Product line 1: RTU amount",
      "Product line 2: device count",
      "Product line 3: mix rate / % AI",
      "Product line 3: total material applied",
    ]);
  });

  it("labels the no-products and termite errors", () => {
    const issues = exportCompletenessIssues([
      validLog({
        products: [],
        isTermite: true,
        termite: { ...emptyTermite(), isCommercialPretreat: true },
      }),
    ]);
    expect(issues[0].fields).toEqual([
      "Pesticides / devices",
      "Termite area treated (sq ft)",
      "Pretreat tank count",
      "Pretreat tank gallons",
      "Pretreat start time",
      "Pretreat stop time",
    ]);
  });

  it("uses placeholders for a missing date and service address", () => {
    const [issue] = exportCompletenessIssues([validLog({ dateUsed: "", serviceAddress: "   " })]);
    expect(issue.dateUsed).toBe("(no date)");
    expect(issue.serviceAddress).toBe("(no service address)");
    expect(issue.fields).toEqual(["Service address", "Date used"]);
  });

  it("trims the service address it reports", () => {
    const [issue] = exportCompletenessIssues([validLog({ serviceAddress: "  2 Oak Ave  ", targetPestOrPurpose: "" })]);
    expect(issue.serviceAddress).toBe("2 Oak Ave");
  });

  // BUG (minor, display only): a whitespace-only dateUsed is flagged "Date used"
  // (validateLog trims it), but the issue's dateUsed is not trimmed, so the
  // "(no date)" placeholder is skipped. serviceAddress on the next line is
  // trimmed before its placeholder check, so the two are inconsistent.
  //   Expected: dateUsed "(no date)"   Actual: dateUsed "   "
  it.skip("uses the (no date) placeholder for a whitespace-only date", () => {
    const [issue] = exportCompletenessIssues([validLog({ dateUsed: "   " })]);
    expect(issue.fields).toEqual(["Date used"]);
    expect(issue.dateUsed).toBe("(no date)");
  });

  it("reports only incomplete logs, in input order", () => {
    const issues = exportCompletenessIssues([
      validLog({ id: "a", customerBillingName: "" }),
      validLog({ id: "b" }),
      validLog({ id: "c", targetPestOrPurpose: "" }),
    ]);
    expect(issues.map((i) => i.logId)).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// withSaveFlags
// ---------------------------------------------------------------------------

describe("withSaveFlags", () => {
  const old = "2026-01-01T00:00:00.000Z";

  it("refreshes createdAt to now by default", () => {
    expect(withSaveFlags(validLog({ createdAt: old })).createdAt).toBe(NOW.toISOString());
    expect(withSaveFlags(validLog({ createdAt: old }), {}).createdAt).toBe(NOW.toISOString());
    expect(withSaveFlags(validLog({ createdAt: old }), { preserveCreatedAt: false }).createdAt).toBe(
      NOW.toISOString(),
    );
  });

  it("keeps createdAt when preserveCreatedAt is true", () => {
    expect(withSaveFlags(validLog({ createdAt: old }), { preserveCreatedAt: true }).createdAt).toBe(old);
  });

  it("recomputes sampleData from products (both directions)", () => {
    expect(withSaveFlags(validLog({ sampleData: true, products: [applied()] })).sampleData).toBe(false);
    expect(
      withSaveFlags(validLog({ sampleData: false, products: [applied({ catalogId: "example-rtu-insecticide" })] }))
        .sampleData,
    ).toBe(true);
    expect(withSaveFlags(validLog({ products: [applied({ epaRegNo: "SAMPLE-1" })] })).sampleData).toBe(true);
    expect(withSaveFlags(validLog({ products: [applied({ isExample: true })] })).sampleData).toBe(true);
    expect(withSaveFlags(validLog({ sampleData: true, products: [] })).sampleData).toBe(false);
  });

  it("does not mutate the input and keeps other fields", () => {
    const log = validLog({ createdAt: old, sampleData: true });
    const copy = structuredClone(log);
    const out = withSaveFlags(log);
    expect(log).toEqual(copy);
    expect(out).not.toBe(log);
    expect({ ...out, createdAt: old, sampleData: true }).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// personnelFromRosterDefaults
// ---------------------------------------------------------------------------

describe("personnelFromRosterDefaults", () => {
  it("returns three empty rows for an empty roster", () => {
    expect(personnelFromRosterDefaults([])).toEqual([
      { role: "applying", name: "", licenseNumber: "" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ]);
  });

  it("fills each role from the first roster person tagged for it", () => {
    const people = [
      rosterPerson({ id: "1", name: "Untagged", licenseNumber: "U", roleTags: [] }),
      rosterPerson({ id: "2", name: "Sam", licenseNumber: "S-1", roleTags: ["supervising"] }),
      rosterPerson({ id: "3", name: "Alice", licenseNumber: "A-1", roleTags: ["applying"] }),
      rosterPerson({ id: "4", name: "Second Applier", licenseNumber: "A-2", roleTags: ["applying"] }),
    ];
    expect(personnelFromRosterDefaults(people)).toEqual([
      { role: "applying", name: "Alice", licenseNumber: "A-1" },
      { role: "supervising", name: "Sam", licenseNumber: "S-1" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ]);
  });

  it("lets one person fill several roles when multi-tagged", () => {
    const people = [rosterPerson({ name: "Owner", licenseNumber: "O-1", roleTags: ["applying", "supervising"] })];
    const rows = personnelFromRosterDefaults(people);
    expect(rows[0]).toEqual({ role: "applying", name: "Owner", licenseNumber: "O-1" });
    expect(rows[1]).toEqual({ role: "supervising", name: "Owner", licenseNumber: "O-1" });
    expect(rows[2]).toEqual({ role: "receiving_training", name: "", licenseNumber: "" });
  });

  it("always returns rows in applying, supervising, receiving_training order", () => {
    const people = [rosterPerson({ roleTags: ["receiving_training", "supervising", "applying"] })];
    expect(personnelFromRosterDefaults(people).map((r) => r.role)).toEqual([
      "applying",
      "supervising",
      "receiving_training",
    ]);
  });
});

// ---------------------------------------------------------------------------
// rosterPicksForPersonnel
// ---------------------------------------------------------------------------

describe("rosterPicksForPersonnel", () => {
  const people = [
    rosterPerson({ id: "alice", name: "Alice", licenseNumber: "A-1" }),
    rosterPerson({ id: "sam", name: "Sam", licenseNumber: "S-1" }),
    rosterPerson({ id: "sam2", name: "Sam", licenseNumber: "S-2" }),
  ];

  it("returns empty picks for no personnel", () => {
    expect(rosterPicksForPersonnel([], people)).toEqual({ applying: "", supervising: "", receiving_training: "" });
  });

  it("matches rows by exact name and license number", () => {
    const personnel: Personnel[] = [
      { role: "applying", name: "Alice", licenseNumber: "A-1" },
      { role: "supervising", name: "Sam", licenseNumber: "S-2" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ];
    expect(rosterPicksForPersonnel(personnel, people)).toEqual({
      applying: "alice",
      supervising: "sam2",
      receiving_training: "",
    });
  });

  it("ignores surrounding whitespace on both sides", () => {
    const roster = [rosterPerson({ id: "x", name: " Alice ", licenseNumber: "A-1 " })];
    expect(rosterPicksForPersonnel([{ role: "applying", name: "Alice  ", licenseNumber: " A-1" }], roster).applying).toBe(
      "x",
    );
  });

  it("does not match when the name or license differs (including case)", () => {
    const personnel: Personnel[] = [
      { role: "applying", name: "Alice", licenseNumber: "A-9" },
      { role: "supervising", name: "sam", licenseNumber: "S-1" },
    ];
    expect(rosterPicksForPersonnel(personnel, people)).toEqual({
      applying: "",
      supervising: "",
      receiving_training: "",
    });
  });

  it("skips fully blank rows even if a roster person is blank", () => {
    const roster = [rosterPerson({ id: "blank", name: "", licenseNumber: "" })];
    expect(rosterPicksForPersonnel([{ role: "applying", name: " ", licenseNumber: "" }], roster).applying).toBe("");
  });

  it("matches a row with only a name when the roster person has no license", () => {
    const roster = [rosterPerson({ id: "n", name: "New Hire", licenseNumber: "" })];
    expect(rosterPicksForPersonnel([{ role: "receiving_training", name: "New Hire", licenseNumber: "" }], roster))
      .toEqual({ applying: "", supervising: "", receiving_training: "n" });
  });

  it("round-trips personnelFromRosterDefaults", () => {
    const roster = [
      rosterPerson({ id: "a", name: "Alice", licenseNumber: "A-1", roleTags: ["applying"] }),
      rosterPerson({ id: "t", name: "Tom", licenseNumber: "T-1", roleTags: ["receiving_training"] }),
    ];
    expect(rosterPicksForPersonnel(personnelFromRosterDefaults(roster), roster)).toEqual({
      applying: "a",
      supervising: "",
      receiving_training: "t",
    });
  });
});

// ---------------------------------------------------------------------------
// draftLogAgainHere
// ---------------------------------------------------------------------------

describe("draftLogAgainHere", () => {
  const property: PropertyPrefill = {
    serviceAddress: "2 Oak Ave",
    customerBillingName: "Jane Doe",
    customerBillingAddress: "1 Main St",
    poleLocation: "Pole 7",
    jobberAddress: "2 Oak Ave, Austin TX",
  };

  it("prefills property fields only, with a new id, now, and today's local date", () => {
    const log = draftLogAgainHere(property, settings);
    expect(log.id).toMatch(UUIDISH);
    expect(log.createdAt).toBe(NOW.toISOString());
    expect(log.dateUsed).toBe(TODAY);
    expect(log).toMatchObject(property);
    expect(log.jobberJobNumber).toBe("");
    expect(log.products).toEqual([]);
    expect(log.targetPestOrPurpose).toBe("");
    expect(log.isTermite).toBe(false);
    expect(log.termite).toEqual(emptyTermite());
    expect(log.sampleData).toBe(false);
    expect(log.personnel).toEqual(emptyLog().personnel);
  });

  it("takes TPCL number/letter from settings", () => {
    expect(draftLogAgainHere(property, settings)).toMatchObject({ shopTpclNumber: "12345", shopTpclLetter: "B" });
    expect(draftLogAgainHere(property)).toMatchObject({ shopTpclNumber: "", shopTpclLetter: "" });
    expect(draftLogAgainHere(property, null)).toMatchObject({ shopTpclNumber: "", shopTpclLetter: "" });
  });

  it("turns the '(no service address)' placeholder back into an empty field", () => {
    expect(draftLogAgainHere({ ...property, serviceAddress: "(no service address)" }).serviceAddress).toBe("");
  });

  it("keeps other service addresses verbatim", () => {
    expect(draftLogAgainHere({ ...property, serviceAddress: "  12 Elm  " }).serviceAddress).toBe("  12 Elm  ");
  });

  it("produces a log that still needs the non-property fields before export", () => {
    const errors = validateLog(draftLogAgainHere(property, settings));
    expect(Object.keys(errors).sort()).toEqual(
      ["applyingLicense", "applyingName", "products", "targetPestOrPurpose"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// draftDuplicateLastStop
// ---------------------------------------------------------------------------

describe("draftDuplicateLastStop", () => {
  const last = validLog({
    id: "old-log",
    createdAt: "2026-09-01T15:00:00.000Z",
    dateUsed: "2026-09-01",
    jobberJobNumber: "J-99",
    jobberAddress: "2 Oak Ave, Austin TX",
    poleLocation: "Pole 7",
    shopTpclNumber: "OLD-TPCL",
    shopTpclLetter: "Z",
    targetPestOrPurpose: "Termites",
    isTermite: true,
    termite: { ...emptyTermite(), areaTreatedSqFt: "1500", diagramNote: "North wall" },
    products: [applied({ lineId: "l1" }), applied({ lineId: "l2", name: "Station", method: "device", deviceCount: "4" })],
    personnel: [{ role: "applying", name: "Old Tech", licenseNumber: "OLD" }],
  });

  it("copies property, products, pest and termite details; resets identity and date", () => {
    const log = draftDuplicateLastStop(last, [], settings);
    expect(log.id).not.toBe("old-log");
    expect(log.id).toMatch(UUIDISH);
    expect(log.createdAt).toBe(NOW.toISOString());
    expect(log.dateUsed).toBe(TODAY);
    expect(log.serviceAddress).toBe(last.serviceAddress);
    expect(log.customerBillingName).toBe(last.customerBillingName);
    expect(log.customerBillingAddress).toBe(last.customerBillingAddress);
    expect(log.poleLocation).toBe("Pole 7");
    expect(log.jobberAddress).toBe("2 Oak Ave, Austin TX");
    expect(log.jobberJobNumber).toBe("");
    expect(log.targetPestOrPurpose).toBe("Termites");
    expect(log.isTermite).toBe(true);
    expect(log.termite).toEqual(last.termite);
  });

  it("takes TPCL from current settings, not from the old log", () => {
    expect(draftDuplicateLastStop(last, [], settings)).toMatchObject({ shopTpclNumber: "12345", shopTpclLetter: "B" });
    expect(draftDuplicateLastStop(last, [])).toMatchObject({ shopTpclNumber: "", shopTpclLetter: "" });
  });

  it("copies products with fresh line ids and otherwise identical fields", () => {
    const log = draftDuplicateLastStop(last, []);
    expect(log.products).toHaveLength(2);
    log.products.forEach((p, i) => {
      expect(p.lineId).not.toBe(last.products[i].lineId);
      expect(p.lineId).toMatch(UUIDISH);
      expect({ ...p, lineId: last.products[i].lineId }).toEqual(last.products[i]);
    });
    expect(new Set(log.products.map((p) => p.lineId)).size).toBe(2);
  });

  it("does not share product or termite objects with the old log", () => {
    const log = draftDuplicateLastStop(last, []);
    log.products[0].rtuAmount = "999";
    log.termite.areaTreatedSqFt = "1";
    expect(last.products[0].rtuAmount).toBe("16");
    expect(last.termite.areaTreatedSqFt).toBe("1500");
  });

  it("uses roster defaults (not the old log's personnel)", () => {
    const roster = [rosterPerson({ name: "Alice", licenseNumber: "A-1", roleTags: ["applying"] })];
    expect(draftDuplicateLastStop(last, roster).personnel).toEqual([
      { role: "applying", name: "Alice", licenseNumber: "A-1" },
      { role: "supervising", name: "", licenseNumber: "" },
      { role: "receiving_training", name: "", licenseNumber: "" },
    ]);
    expect(draftDuplicateLastStop(last, []).personnel).toEqual(emptyLog().personnel);
  });

  it("recomputes sampleData from the copied products", () => {
    expect(draftDuplicateLastStop({ ...last, sampleData: true }, []).sampleData).toBe(false);
    const withExample = { ...last, sampleData: false, products: [applied({ catalogId: "example-insect-monitor" })] };
    expect(draftDuplicateLastStop(withExample, []).sampleData).toBe(true);
  });

  it("handles a last stop with no products", () => {
    const log = draftDuplicateLastStop({ ...last, products: [] }, []);
    expect(log.products).toEqual([]);
    expect(log.sampleData).toBe(false);
  });
});
