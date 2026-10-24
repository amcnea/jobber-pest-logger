/**
 * Added at Charles's direction (Catalog slice 8): proves the shared shop reg #
 * lookup gives exactly the same results as the old per-call catalog scans.
 * The "old" implementations below are verbatim copies of the pre-slice-8 logic.
 */
import { describe, expect, it } from "vitest";
import type { ShopProduct } from "../types";
import {
  filterStartersByShopStatus,
  findShopMatchForStarter,
  sortStarters,
  starterShopState,
  TEXAS_COMMON_STARTER,
  type StarterShopStatusFilter,
  type StarterSortOrder,
} from "./index";
import {
  buildCsvImportPreview,
  csvCandidateToShopProduct,
  effectiveImportEpa,
  findShopDuplicate,
  normalizeImportName,
} from "./csvImportPreview";
import type { CsvCandidate, CsvImportResult, CsvParsedRow } from "./csvImport";
import {
  appendShopRegLookup,
  buildShopRegLookup,
  cloneShopRegLookup,
  normalizeImportEpa,
  shopRowsWithRegNo,
  type ShopRegLookup,
} from "./shopRegLookup";
import type { StarterProduct } from "./types";

// ---- old (pre-lookup) implementations, copied verbatim ----
function oldFindShopMatchForStarter(catalog: ShopProduct[], starter: StarterProduct): ShopProduct | undefined {
  const normalizeEpa = normalizeImportEpa;
  const normalizeName = (name: string) => name.trim().toLowerCase();
  const starterEpa = normalizeEpa(starter.epaRegNo);
  const name = normalizeName(starter.name);
  const matches = catalog.filter((p) =>
    starterEpa
      ? normalizeEpa(p.epaRegNo) === starterEpa
      : p.kind === starter.kind && normalizeName(p.name) === name && !normalizeEpa(p.epaRegNo),
  );
  return matches.find((p) => !p.archived) ?? matches[0];
}

function oldShopMatch(catalog: ShopProduct[], epa: string, name: string) {
  if (epa) {
    const byEpa = catalog.find((p) => normalizeImportEpa(p.epaRegNo) === epa);
    if (byEpa) return { product: byEpa, by: "epa" as const };
  }
  if (name) {
    const byName = catalog.find((p) => normalizeImportName(p.name) === name);
    if (byName) return { product: byName, by: "name" as const };
  }
  return null;
}

function oldInRunFindShopDuplicate(
  candidate: CsvCandidate,
  catalog: ShopProduct[],
  addedInRun: ShopProduct[],
): string | null {
  const combined = [...catalog, ...addedInRun];
  const old = oldShopMatch(
    combined,
    normalizeImportEpa(effectiveImportEpa(candidate)),
    normalizeImportName(candidate.name),
  );
  if (!old) return null;
  return old.by === "epa"
    ? `Needs a look: same EPA reg # as "${old.product.name}" on your shop list.`
    : "Needs a look: same name as a product on your shop list.";
}

// ---- fixtures ----
let nextId = 0;
function shop(epaRegNo: string | null, extra: Partial<ShopProduct> = {}): ShopProduct {
  nextId += 1;
  return {
    id: `shop-${nextId}`,
    name: `Shop product ${nextId}`,
    epaRegNo,
    is25b: false,
    kind: "pesticide",
    isExample: false,
    archived: false,
    ...extra,
  };
}

const starter = (id: string, epaRegNo: string | null, extra: Partial<StarterProduct> = {}): StarterProduct => ({
  id,
  name: `Starter ${id}`,
  epaRegNo,
  is25b: false,
  kind: "pesticide",
  ...extra,
});

const FIXED_CATALOG: ShopProduct[] = [
  shop("7969-210"), // plain hyphen
  shop("7969\u2013210", { archived: true }), // en dash, archived duplicate
  shop("7969\u2014210"), // em dash duplicate (second non-archived)
  shop("100\u22121484", { archived: true }), // minus sign, archived only
  shop(" 100 - 1498 "), // whitespace
  shop("ABC-12"), // case
  shop("8033-109"), // must not match 8033-109-279
  shop("8033-109-279", { archived: true }), // distributor suffix, archived
  shop("8033-109-279"), // suffix, non-archived after archived
  shop(null), // blank reg #
  shop("", { name: "Blank string reg" }),
  shop("   "),
  shop(null, { name: "essentria ic3", is25b: true }), // name branch (no reg #)
  shop(null, { name: "Trap Monitor", kind: "device" }),
  shop("53883-118", { archived: true }),
  shop("53883-118", { archived: true }), // multiple archived only
];

const FIXED_STARTERS: StarterProduct[] = [
  ...TEXAS_COMMON_STARTER,
  starter("plain", "7969-210"),
  starter("en", "7969\u2013210"),
  starter("minus", "100\u2212" + "1484"),
  starter("ws", "  100-1498  "),
  starter("case", "abc-12"),
  starter("short", "8033-109"),
  starter("suffix", "8033\u2013109\u2013279"),
  starter("prefix-only", "8033"),
  starter("blank", null, { name: "Essentria IC3", is25b: true }),
  starter("blank-device", null, { name: " trap monitor ", kind: "device" }),
  starter("none", "99999-1"),
  starter("multi-archived", "53883\u2010118"),
];

function expectSameStarterResults(catalog: ShopProduct[], starters: StarterProduct[], pending: string[]) {
  const lookup = buildShopRegLookup(catalog);
  for (const s of starters) {
    const old = oldFindShopMatchForStarter(catalog, s);
    expect(findShopMatchForStarter(catalog, s, lookup)).toBe(old);
    expect(findShopMatchForStarter(catalog, s)).toBe(old);
    expect(starterShopState(catalog, s, pending, lookup)).toBe(starterShopState(catalog, s, pending));
  }
  const statuses: StarterShopStatusFilter[] = ["all", "hide-active", "active", "not-added", "pending", "archived"];
  for (const st of statuses) {
    expect(filterStartersByShopStatus(starters, catalog, st, pending, lookup)).toEqual(
      filterStartersByShopStatus(starters, catalog, st, pending),
    );
  }
  const orders: StarterSortOrder[] = ["list", "name", "needs-action"];
  for (const o of orders) {
    expect(sortStarters(starters, catalog, pending, o, lookup)).toEqual(sortStarters(starters, catalog, pending, o));
  }
}

function csvResult(rows: { name: string; epaRegNo: string | null }[]): CsvImportResult {
  const parsed: CsvParsedRow[] = rows.map((r, i) => ({
    line: i + 2,
    candidate: { name: r.name, epaRegNo: r.epaRegNo, is25b: false, kind: "pesticide", isExample: false, archived: true },
    problems: [],
  }));
  return { rows: parsed, fileProblems: [], ignoredColumns: [], columns: [], columnMap: {} };
}

function expectSameCsvResults(catalog: ShopProduct[], rows: { name: string; epaRegNo: string | null }[]) {
  const lookup = buildShopRegLookup(catalog);
  for (const r of rows) {
    const candidate = { name: r.name, epaRegNo: r.epaRegNo, is25b: false, kind: "pesticide" as const, isExample: false, archived: true };
    expect(findShopDuplicate(candidate, catalog, lookup)).toBe(findShopDuplicate(candidate, catalog));
    const old = oldShopMatch(catalog, normalizeImportEpa(r.epaRegNo), normalizeImportName(r.name));
    const expected = old
      ? old.by === "epa"
        ? `Needs a look: same EPA reg # as "${old.product.name}" on your shop list.`
        : "Needs a look: same name as a product on your shop list."
      : null;
    expect(findShopDuplicate(candidate, catalog, lookup)).toBe(expected);
  }
  const result = csvResult(rows);
  expect(buildCsvImportPreview(result, catalog, lookup)).toEqual(buildCsvImportPreview(result, catalog));
}

describe("shared shop reg # lookup matches the old scans", () => {
  it("shopRowsWithRegNo returns the same rows, in catalog order, as a filter scan", () => {
    const lookup = buildShopRegLookup(FIXED_CATALOG);
    const keys = new Set(FIXED_CATALOG.map((p) => normalizeImportEpa(p.epaRegNo)));
    keys.add("8033");
    keys.add("nothing");
    for (const key of keys) {
      const scan = key ? FIXED_CATALOG.filter((p) => normalizeImportEpa(p.epaRegNo) === key) : [];
      expect([...shopRowsWithRegNo(FIXED_CATALOG, key, lookup)]).toEqual(scan);
    }
  });

  it("falls back to the scan when the lookup was built from another catalog array", () => {
    const lookup = buildShopRegLookup(FIXED_CATALOG.slice(0, 1));
    expect([...shopRowsWithRegNo(FIXED_CATALOG, "7969-210", lookup)]).toEqual(
      FIXED_CATALOG.filter((p) => normalizeImportEpa(p.epaRegNo) === "7969-210"),
    );
  });

  it("starter list: dashes, whitespace, case, suffix, archived/non-archived, blank and multiple matches", () => {
    const pending = [FIXED_CATALOG[1].id, FIXED_CATALOG[7].id, FIXED_CATALOG[14].id];
    expectSameStarterResults(FIXED_CATALOG, FIXED_STARTERS, pending);
    expectSameStarterResults(FIXED_CATALOG, FIXED_STARTERS, []);
    expectSameStarterResults([], FIXED_STARTERS, []);
  });

  it("spot checks: suffix never matches the shorter number, non-archived wins", () => {
    const lookup = buildShopRegLookup(FIXED_CATALOG);
    const short = findShopMatchForStarter(FIXED_CATALOG, starter("s", "8033-109"), lookup);
    expect(short?.epaRegNo).toBe("8033-109");
    const suffix = findShopMatchForStarter(FIXED_CATALOG, starter("x", "8033-109-279"), lookup);
    expect(suffix).toBe(FIXED_CATALOG[8]);
    expect(findShopMatchForStarter(FIXED_CATALOG, starter("p", "8033"), lookup)).toBeUndefined();
    expect(findShopMatchForStarter(FIXED_CATALOG, starter("t", "7969-210"), lookup)).toBe(FIXED_CATALOG[0]);
  });

  it("CSV import: shop reg # match (first in catalog order) and name fallback are unchanged", () => {
    expectSameCsvResults(FIXED_CATALOG, [
      { name: "A", epaRegNo: "7969\u2013210" },
      { name: "B", epaRegNo: " 100 \u2212 1484 " },
      { name: "C", epaRegNo: "8033-109" },
      { name: "D", epaRegNo: "8033-109-279" },
      { name: "E", epaRegNo: "ABC-12".toLowerCase() },
      { name: "Shop product 3", epaRegNo: "1-1" },
      { name: "essentria IC3", epaRegNo: null },
      { name: "Nothing", epaRegNo: "424242-1" },
      { name: "", epaRegNo: "" },
      { name: "Again", epaRegNo: "7969-210" },
    ]);
  });

  it("randomized: lookup and scans agree across many generated catalogs", () => {
    // Small seeded PRNG so failures are reproducible.
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const DASHES = ["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212"];
    const BASES = ["7969-210", "100-1484", "8033-109", "8033-109-279", "53883-118", "ab-12", "1-1", "12455-79"];
    const regNo = (): string | null => {
      const r = rand();
      if (r < 0.1) return null;
      if (r < 0.15) return pick(["", "  "]);
      const base = pick(BASES)
        .split("-")
        .map((part) => (rand() < 0.3 ? part.toUpperCase() : part))
        .join(pick(DASHES));
      return rand() < 0.3 ? ` ${base.replace(/(.)/, "$1 ")} ` : base;
    };
    const NAMES = ["Termidor SC", "termidor  sc", "Essentria IC3", "Trap Monitor", "Advion Ant Gel", "Other"];
    for (let round = 0; round < 300; round += 1) {
      const size = Math.floor(rand() * 12);
      const catalog: ShopProduct[] = Array.from({ length: size }, () =>
        shop(regNo(), {
          name: pick(NAMES),
          archived: rand() < 0.5,
          kind: rand() < 0.15 ? "device" : "pesticide",
          is25b: rand() < 0.15,
        }),
      );
      const starters = [
        ...TEXAS_COMMON_STARTER,
        ...Array.from({ length: 8 }, (_, i) =>
          starter(`r${round}-${i}`, regNo(), { name: pick(NAMES), kind: rand() < 0.2 ? "device" : "pesticide" }),
        ),
      ];
      const pending = catalog.filter(() => rand() < 0.4).map((p) => p.id);
      expectSameStarterResults(catalog, starters, pending);
      expectSameCsvResults(
        catalog,
        Array.from({ length: 6 }, () => ({ name: pick(NAMES), epaRegNo: regNo() })),
      );
    }
  });
  describe("in-run CSV duplicate recheck working lookup (Catalog slice 9)", () => {
    const cand = (
      name: string,
      epaRegNo: string | null,
      extra: Partial<CsvCandidate> = {},
    ): CsvCandidate => ({
      name,
      epaRegNo,
      is25b: false,
      kind: "pesticide",
      isExample: false,
      archived: true,
      ...extra,
    });

    function expectSameInRunStep(
      catalog: ShopProduct[],
      addedInRun: ShopProduct[],
      runLookup: ShopRegLookup,
      candidates: CsvCandidate[],
    ) {
      const combined = [...catalog, ...addedInRun];
      expect(runLookup.catalog).toEqual(combined);
      const keys = new Set<string>([
        "",
        "8033",
        "nothing",
        ...combined.map((p) => normalizeImportEpa(p.epaRegNo)),
        ...candidates.map((c) => normalizeImportEpa(effectiveImportEpa(c))),
      ]);
      for (const key of keys) {
        const expectedRows = key ? combined.filter((p) => normalizeImportEpa(p.epaRegNo) === key) : [];
        expect([...shopRowsWithRegNo(runLookup.catalog, key, runLookup)]).toEqual(expectedRows);
      }
      for (const c of candidates) {
        const expected = oldInRunFindShopDuplicate(c, catalog, addedInRun);
        expect(findShopDuplicate(c, runLookup.catalog, runLookup)).toBe(expected);
        expect(findShopDuplicate(c, combined)).toBe(expected);
      }
    }

    it("only clones when the lookup was built from the exact catalog array, and never mutates the shared lookup", () => {
      const baseLookup = buildShopRegLookup(FIXED_CATALOG);
      expect(cloneShopRegLookup(FIXED_CATALOG, undefined)).toBeUndefined();
      expect(cloneShopRegLookup(FIXED_CATALOG, buildShopRegLookup(FIXED_CATALOG.slice(0, 2)))).toBeUndefined();

      const snapshotBefore = new Map(
        Array.from(baseLookup.byRegNo.entries(), ([k, rows]) => [k, [...rows]]),
      );
      const runLookup = cloneShopRegLookup(FIXED_CATALOG, baseLookup)!;
      expect(runLookup).toBeDefined();
      appendShopRegLookup(runLookup, shop("7969-210", { name: "In-run Termidor" }));
      appendShopRegLookup(runLookup, shop("91919-1", { name: "Brand New" }));

      expect(baseLookup.catalog).toBe(FIXED_CATALOG);
      expect(baseLookup.byRegNo).toEqual(snapshotBefore);
    });

    it("covers existing vs in-run matches, tie-break order, dashes/whitespace/case, suffixes, archived rows, and blank reg #s", () => {
      const baseCatalog: ShopProduct[] = [
        shop("7969-210", { name: "Existing Plain Active", archived: false }),
        shop("100\u22121484", { name: "Existing Minus Archived", archived: true }),
        shop("8033-109", { name: "Existing Short Reg", archived: true }),
        shop(null, { name: "Existing Blank Reg", is25b: true }),
      ];
      const baseLookup = buildShopRegLookup(baseCatalog);
      const runLookup = cloneShopRegLookup(baseCatalog, baseLookup)!;
      const addedInRun: ShopProduct[] = [];

      const addRow = (row: ShopProduct) => {
        addedInRun.push(row);
        appendShopRegLookup(runLookup, row);
      };

      const probes: CsvCandidate[] = [
        // Matches existing row (with dash/whitespace/case variants)
        cand("Probe existing hyphen", "7969-210"),
        cand("Probe existing en-dash ws", "  7969 \u2013 210 "),
        cand("Probe existing minus archived", "100-1484"),
        // Matches earlier new row from the same run (including case/dash/whitespace variants)
        cand("Probe in-run new 1", "53883-118"),
        cand("Probe in-run new 1 em-dash", " 53883\u2014118 "),
        cand("Probe in-run alpha case", "ab\u201099"),
        // Suffixes: 8033-109 vs 8033-109-279 vs prefix 8033
        cand("Probe short", "8033-109"),
        cand("Probe distributor suffix", "8033\u2013109\u2014279"),
        cand("Probe prefix only", "8033"),
        // Blank reg #s (null, empty, whitespace, 25b, device) and name fallback
        cand("Probe blank null", null),
        cand("Probe blank spaces", "   "),
        cand("In-Run Blank pesticide", null),
        cand(" in-run  25b  cedar ", "53883-118", { is25b: true }),
        cand("In-Run Device Trap", "53883-118", { kind: "device" }),
      ];

      // Step 0: before any row is added in the run
      expectSameInRunStep(baseCatalog, addedInRun, runLookup, probes);

      // Step 1: add a new archived row with reg # 53883-118
      addRow(
        csvCandidateToShopProduct(
          cand("First In-Run 53883", " 53883 \u2013 118 ", { archived: true }),
          "inrun-1",
        ),
      );
      expectSameInRunStep(baseCatalog, addedInRun, runLookup, probes);
      expect(findShopDuplicate(cand("Check 53883", "53883-118"), runLookup.catalog, runLookup)).toBe(
        'Needs a look: same EPA reg # as "First In-Run 53883" on your shop list.',
      );

      // Step 2: add a second new row with the same reg # (non-archived) -> first in-run row still wins tie-break
      addRow(shop("53883\u2212118", { id: "inrun-2", name: "Second In-Run 53883", archived: false }));
      expectSameInRunStep(baseCatalog, addedInRun, runLookup, probes);
      expect(findShopDuplicate(cand("Check 53883 tie", "53883-118"), runLookup.catalog, runLookup)).toBe(
        'Needs a look: same EPA reg # as "First In-Run 53883" on your shop list.',
      );

      // Step 3: add an in-run row whose reg # duplicates an existing catalog row -> existing catalog row wins tie-break
      addRow(shop("7969\u2014210", { id: "inrun-3", name: "In-Run Duplicate Of Existing", archived: true }));
      expectSameInRunStep(baseCatalog, addedInRun, runLookup, probes);
      expect(findShopDuplicate(cand("Check existing tie", "7969-210"), runLookup.catalog, runLookup)).toBe(
        'Needs a look: same EPA reg # as "Existing Plain Active" on your shop list.',
      );

      // Step 4: add distributor-suffix row 8033-109-279 and uppercase/dash row AB-99
      addRow(shop("8033-109-279", { id: "inrun-4", name: "In-Run Suffix 279", archived: true }));
      addRow(shop(" AB \u2212 99 ", { id: "inrun-5", name: "In-Run Alpha Case", archived: true }));
      expectSameInRunStep(baseCatalog, addedInRun, runLookup, probes);
      expect(findShopDuplicate(cand("Short stays short", "8033-109"), runLookup.catalog, runLookup)).toBe(
        'Needs a look: same EPA reg # as "Existing Short Reg" on your shop list.',
      );
      expect(findShopDuplicate(cand("Suffix matches suffix", "8033\u2013109\u2014279"), runLookup.catalog, runLookup)).toBe(
        'Needs a look: same EPA reg # as "In-Run Suffix 279" on your shop list.',
      );

      // Step 5: add blank-reg-# rows (null, "", whitespace, 25b, device) -> skipped in byRegNo, matched by name only
      addRow(shop(null, { id: "inrun-6", name: "In-Run Blank Pesticide", archived: true }));
      addRow(shop("", { id: "inrun-7", name: "In-Run Empty String Reg", archived: true }));
      addRow(shop("   ", { id: "inrun-8", name: "In-Run Spaces Reg", archived: true }));
      addRow(
        csvCandidateToShopProduct(
          cand("In-Run 25b Cedar", "99999-9", { is25b: true }),
          "inrun-9",
        ),
      );
      addRow(
        csvCandidateToShopProduct(
          cand("In-Run Device Trap", "99999-9", { kind: "device" }),
          "inrun-10",
        ),
      );
      expect(runLookup.byRegNo.has("")).toBe(false);
      expect(runLookup.byRegNo.has("99999-9")).toBe(false);
      expectSameInRunStep(baseCatalog, addedInRun, runLookup, probes);
    });

    it("randomized multi-add loop: working lookup and combined-list scan agree across runs", () => {
      let seed = 0x9eedcafe;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
      const DASHES = ["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212"];
      const BASES = [
        "7969-210",
        "100-1484",
        "8033-109",
        "8033-109-279",
        "53883-118",
        "ab-12",
        "ab-12-99",
        "12455-79",
      ];
      const regNo = (): string | null => {
        const r = rand();
        if (r < 0.12) return null;
        if (r < 0.2) return pick(["", "   "]);
        const base = pick(BASES)
          .split("-")
          .map((part) => (rand() < 0.35 ? part.toUpperCase() : part))
          .join(pick(DASHES));
        return rand() < 0.35 ? ` ${base.replace(/(.)/, "$1 ")} ` : base;
      };
      const NAMES = [
        "Termidor SC",
        "termidor  sc",
        "Essentria IC3",
        "Trap Monitor",
        "Advion Ant Gel",
        "Demand CS",
        " Alpine WSG ",
        "Custom Mix",
      ];

      for (let run = 0; run < 200; run += 1) {
        const initialSize = Math.floor(rand() * 10);
        const catalog: ShopProduct[] = Array.from({ length: initialSize }, () =>
          shop(regNo(), {
            name: pick(NAMES),
            archived: rand() < 0.5,
            kind: rand() < 0.15 ? "device" : "pesticide",
            is25b: rand() < 0.15,
          }),
        );
        const baseLookup = buildShopRegLookup(catalog);
        const runLookup = cloneShopRegLookup(catalog, baseLookup)!;
        const addedInRun: ShopProduct[] = [];

        const steps = 1 + Math.floor(rand() * 10);
        for (let step = 0; step < steps; step += 1) {
          const candidates: CsvCandidate[] = Array.from({ length: 4 }, () =>
            cand(pick(NAMES), regNo(), {
              archived: rand() < 0.8,
              kind: rand() < 0.15 ? "device" : "pesticide",
              is25b: rand() < 0.15,
            }),
          );
          expectSameInRunStep(catalog, addedInRun, runLookup, candidates);

          const toAdd =
            rand() < 0.5
              ? csvCandidateToShopProduct(candidates[0], `run-${run}-step-${step}`)
              : shop(regNo(), {
                  id: `run-${run}-step-${step}`,
                  name: pick(NAMES),
                  archived: rand() < 0.7,
                  kind: rand() < 0.15 ? "device" : "pesticide",
                  is25b: rand() < 0.15,
                });
          addedInRun.push(toAdd);
          appendShopRegLookup(runLookup, toAdd);
        }
        expectSameInRunStep(catalog, addedInRun, runLookup, [
          cand(pick(NAMES), regNo()),
          cand(pick(NAMES), null),
        ]);
      }
    });
  });
});
