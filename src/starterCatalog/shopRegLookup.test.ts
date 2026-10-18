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
import { buildCsvImportPreview, findShopDuplicate, normalizeImportName } from "./csvImportPreview";
import type { CsvImportResult, CsvParsedRow } from "./csvImport";
import { buildShopRegLookup, normalizeImportEpa, shopRowsWithRegNo } from "./shopRegLookup";
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
});
