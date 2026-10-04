import { describe, expect, it } from "vitest";
import { makeShopProduct } from "../test/fixtures";
import {
  TEXAS_COMMON_STARTER,
  filterStarters25bOnly,
  filterStartersByShopStatus,
  findShopMatchForStarter,
  formatStarterResultCount,
  searchTexasStarterCatalog,
  sortStarters,
  starterEpaCaption,
  starterMatchesQuery,
  starterShopState,
  starterToPendingShopProduct,
} from "./index";
import type { StarterProduct } from "./types";

const REG = TEXAS_COMMON_STARTER.find((s) => s.name === "Termidor SC")!;
const B25 = TEXAS_COMMON_STARTER.find((s) => s.name === "Essentria IC3")!;
const DEV = TEXAS_COMMON_STARTER.find((s) => s.name === "Catchmaster Insect Glue Board")!;

function starter(over: Partial<StarterProduct> & Pick<StarterProduct, "id" | "name">): StarterProduct {
  return {
    epaRegNo: "1-1",
    is25b: false,
    kind: "pesticide",
    
    ...over,
  };
}

describe("findShopMatchForStarter", () => {
  it("matches by EPA # ignoring case and interior spaces", () => {
    const shop = makeShopProduct({ id: "a", epaRegNo: "7969- 210", name: "My Termidor" });
    expect(findShopMatchForStarter([shop], REG)?.id).toBe("a");
  });

  it("matches 25(b)/device by kind + name when both lack an EPA #", () => {
    const shop = makeShopProduct({ id: "e", name: "Essentria IC3", epaRegNo: null, is25b: true });
    expect(findShopMatchForStarter([shop], B25)?.id).toBe("e");
    const glue = makeShopProduct({ id: "g", name: "Catchmaster Insect Glue Board", epaRegNo: null, kind: "device" });
    expect(findShopMatchForStarter([glue], DEV)?.id).toBe("g");
  });

  it("does not match a same-name pesticide that still has an EPA # against a 25(b) starter", () => {
    const shop = makeShopProduct({ id: "x", name: "Essentria IC3", epaRegNo: "999-1", is25b: false });
    expect(findShopMatchForStarter([shop], B25)).toBeUndefined();
  });

  it("prefers an active match over an archived one with the same EPA #", () => {
    const archived = makeShopProduct({ id: "old", epaRegNo: REG.epaRegNo, archived: true });
    const active = makeShopProduct({ id: "new", epaRegNo: REG.epaRegNo, archived: false });
    expect(findShopMatchForStarter([archived, active], REG)?.id).toBe("new");
    expect(findShopMatchForStarter([archived], REG)?.id).toBe("old");
  });
});

describe("starterShopState / filterStartersByShopStatus", () => {
  const active = makeShopProduct({ id: "a", epaRegNo: REG.epaRegNo });
  const pending = makeShopProduct({ id: "p", name: B25.name, epaRegNo: null, is25b: true, archived: true });
  const archived = makeShopProduct({ id: "z", name: DEV.name, epaRegNo: null, kind: "device", archived: true });
  const catalog = [active, pending, archived];
  const pendingIds = ["p"];
  const rows = [REG, B25, DEV];

  it("classifies not-added / active / pending / archived", () => {
    expect(starterShopState([], REG, [])).toBe("not-added");
    expect(starterShopState(catalog, REG, pendingIds)).toBe("active");
    expect(starterShopState(catalog, B25, pendingIds)).toBe("pending");
    expect(starterShopState(catalog, DEV, pendingIds)).toBe("archived");
    expect(starterShopState(catalog, B25, new Set(["p"]))).toBe("pending");
  });

  it("filters by each shop-status option", () => {
    expect(filterStartersByShopStatus(rows, catalog, "all", pendingIds)).toEqual(rows);
    expect(filterStartersByShopStatus(rows, catalog, "hide-active", pendingIds).map((s) => s.name)).toEqual([
      B25.name,
      DEV.name,
    ]);
    // #108: "Already on shop list" keeps only active (non-archived) matches.
    expect(filterStartersByShopStatus(rows, catalog, "active", pendingIds).map((s) => s.id)).toEqual([REG.id]);
    expect(filterStartersByShopStatus(rows, catalog, "not-added", pendingIds)).toEqual([]);
    expect(filterStartersByShopStatus(rows, catalog, "pending", pendingIds).map((s) => s.id)).toEqual([B25.id]);
    expect(filterStartersByShopStatus(rows, catalog, "archived", pendingIds).map((s) => s.id)).toEqual([DEV.id]);
  });

  it("active filter excludes pending and archived matches (only non-archived shop rows)", () => {
    // Same catalog as above: REG active, B25 pending, DEV archived, plus a not-added starter.
    const onlyActive = filterStartersByShopStatus(rows, catalog, "active", pendingIds);
    expect(onlyActive).toHaveLength(1);
    expect(starterShopState(catalog, onlyActive[0]!, pendingIds)).toBe("active");
    expect(onlyActive.map((s) => s.id)).not.toContain(B25.id);
    expect(onlyActive.map((s) => s.id)).not.toContain(DEV.id);
  });
});

describe("sortStarters", () => {
  const a = starter({ id: "a", name: "Zebra" });
  const b = starter({ id: "b", name: "apple" });
  const c = starter({ id: "c", name: "Apple", epaRegNo: "2-2" });
  const rows = [a, b, c];

  it("list returns a shallow copy in input order", () => {
    const out = sortStarters(rows, [], [], "list");
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("name sorts A–Z (base sensitivity), ties by id", () => {
    expect(sortStarters(rows, [], [], "name").map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("needs-action groups pending → archived → not-added → active, stable within group (#102)", () => {
    // Distinct EPA #s so findShopMatchForStarter cannot share a shop row across starters.
    // Input order is intentionally interleaved (active, not-added, archived, pending) so a
    // correct sort must actually regroup — not lean on the original order.
    const pending = starter({ id: "p", name: "Pending One", epaRegNo: "10-1" });
    const archived = starter({ id: "z", name: "Archived One", epaRegNo: "10-2" });
    const notAdded = starter({ id: "n", name: "Not Added", epaRegNo: "10-3" });
    const active = starter({ id: "a", name: "Active One", epaRegNo: "10-4" });
    const interleaved = [active, notAdded, archived, pending];
    const catalog = [
      makeShopProduct({ id: "shop-p", epaRegNo: "10-1", archived: true }),
      makeShopProduct({ id: "shop-z", epaRegNo: "10-2", archived: true }),
      makeShopProduct({ id: "shop-a", epaRegNo: "10-4", archived: false }),
    ];
    expect(sortStarters(interleaved, catalog, ["shop-p"], "needs-action").map((s) => s.id)).toEqual([
      "p",
      "z",
      "n",
      "a",
    ]);
  });
});

describe("starterMatchesQuery / searchTexasStarterCatalog", () => {
  it("empty / whitespace query matches all", () => {
    expect(starterMatchesQuery(REG, "")).toBe(true);
    expect(starterMatchesQuery(REG, "   ")).toBe(true);
  });

  it("matches name, kind, 25(b) keywords and dashless EPA #", () => {
    expect(starterMatchesQuery(REG, "termidor")).toBe(true);
    expect(starterMatchesQuery(REG, "PESTICIDE")).toBe(true);
    expect(starterMatchesQuery(B25, "25(b)")).toBe(true);
    expect(starterMatchesQuery(B25, "25b")).toBe(true);
    expect(starterMatchesQuery(REG, "7969210")).toBe(true);
    expect(starterMatchesQuery(REG, "7969-210")).toBe(true);
    expect(starterMatchesQuery(REG, "nope")).toBe(false);
  });

  it("searchTexasStarterCatalog applies kind filter then query", () => {
    expect(searchTexasStarterCatalog("", "device").every((s) => s.kind === "device")).toBe(true);
    expect(searchTexasStarterCatalog("essentria", "pesticide").map((s) => s.name)).toEqual(["Essentria IC3"]);
    expect(searchTexasStarterCatalog("essentria", "device")).toEqual([]);
    expect(searchTexasStarterCatalog("").length).toBe(TEXAS_COMMON_STARTER.length);
  });
});

describe("filterStarters25bOnly", () => {
  it("when false returns the same array reference; when true keeps only 25(b) pesticides", () => {
    const rows = [REG, B25, DEV];
    expect(filterStarters25bOnly(rows, false)).toBe(rows);
    expect(filterStarters25bOnly(rows, true).map((s) => s.name)).toEqual(
      rows.filter((s) => s.kind === "pesticide" && s.is25b).map((s) => s.name),
    );
    expect(filterStarters25bOnly(rows, true)).not.toContainEqual(DEV);
  });
});

describe("starterToPendingShopProduct / starterEpaCaption / formatStarterResultCount", () => {
  it("copies a registered starter as archived with its EPA #", () => {
    expect(starterToPendingShopProduct(REG, "x")).toEqual({
      id: "x",
      name: REG.name,
      epaRegNo: REG.epaRegNo,
      is25b: false,
      kind: "pesticide",
      isExample: false,
      archived: true,
    });
  });

  it("nulls EPA and clears is25b for devices; nulls EPA for 25(b)", () => {
    expect(starterToPendingShopProduct(DEV, "d")).toMatchObject({
      epaRegNo: null,
      is25b: false,
      kind: "device",
      archived: true,
    });
    expect(starterToPendingShopProduct(B25, "b")).toMatchObject({ epaRegNo: null, is25b: true, archived: true });
  });

  it("trims the starter name", () => {
    expect(starterToPendingShopProduct(starter({ id: "s", name: "  Spaced  " }), "n").name).toBe("Spaced");
  });

  it("captions and count lines", () => {
    expect(starterEpaCaption(DEV)).toBe("device");
    expect(starterEpaCaption(B25)).toBe("25(b) · no EPA #");
    expect(starterEpaCaption(REG)).toBe(`EPA ${REG.epaRegNo}`);
    expect(formatStarterResultCount(4, 20)).toBe("Showing 4 of 20 starters");
    expect(formatStarterResultCount(1, 1)).toBe("Showing 1 of 1 starter");
  });
});
