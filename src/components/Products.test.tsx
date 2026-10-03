// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXAS_COMMON_STARTER, TEXAS_STARTER_CATALOG_VERSION } from "../starterCatalog";
import { STARTER_LABEL_CONFIRM_KEY } from "../starterCatalog/labelConfirmStore";
import type { ShopProduct } from "../types";

// Scope: Products.tsx (Catalog's file; tests only):
// (1) Texas starter search UI — query filtering, <mark> highlighting, no-results,
//     filters/sort/reset/25(b), keyboard, add-starter → label-confirm → activate,
//     fail-closed label-confirm storage.
// (2) Shop catalog UI — add/edit form validation, list filters, archive/delete,
//     remove-examples.
// Import-boundary mocks, same approach as NewLogForm.test.tsx:
// - ../storage → only `emptyShopProduct` (the one import Products uses, real impl).
// - ../ids     → deterministic "id-N" ids (the mount-time empty draft consumes id-1).
// starterCatalog/* runs for real; its label-confirm store persists to an in-memory
// localStorage stub with fail switches. The catalog lives in a small stateful harness so
// onUpsert round-trips like App does.

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { emptyShopProduct: actual.emptyShopProduct };
});

let idCounter = 0;
vi.mock("../ids", () => ({ newId: () => `id-${++idCounter}` }));

const { Products } = await import("./Products");

vi.setConfig({ testTimeout: 15_000 });

class MemoryStorage {
  map = new Map<string, string>();
  failSet = false;
  failGet = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    if (this.failGet) throw new Error("getItem failed");
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.failSet) throw new Error("QuotaExceededError");
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let storage: MemoryStorage;
let upsertOk: boolean;
let removeOk: boolean;
const onUpsertSpy = vi.fn<(p: ShopProduct) => void>();
const onDeleteSpy = vi.fn<(id: string) => void>();
const onRemoveExamplesSpy = vi.fn<() => boolean>();

function Harness({ initial }: { initial: ShopProduct[] }) {
  const [catalog, setCatalog] = useState(initial);
  return (
    <Products
      catalog={catalog}
      onUpsert={(p) => {
        onUpsertSpy(structuredClone(p));
        if (!upsertOk) return false;
        setCatalog((c) => (c.some((x) => x.id === p.id) ? c.map((x) => (x.id === p.id ? p : x)) : [p, ...c]));
        return true;
      }}
      onDelete={(id) => {
        onDeleteSpy(id);
        setCatalog((c) => c.filter((x) => x.id !== id));
      }}
      onRemoveExamples={() => {
        const ok = removeOk;
        onRemoveExamplesSpy.mockReturnValue(ok);
        onRemoveExamplesSpy();
        if (!ok) return false;
        setCatalog((c) => c.filter((p) => !p.isExample));
        return true;
      }}
    />
  );
}

function setup(initial: ShopProduct[] = []) {
  const user = userEvent.setup();
  const utils = render(<Harness initial={initial} />);
  return { user, ...utils };
}

beforeEach(() => {
  idCounter = 0;
  upsertOk = true;
  removeOk = true;
  onUpsertSpy.mockReset();
  onDeleteSpy.mockReset();
  onRemoveExamplesSpy.mockReset();
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.spyOn(window, "alert").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOTAL = TEXAS_COMMON_STARTER.length; // 20 in pack 2026.09.2

const search = () =>
  screen.getByRole("searchbox", { name: "Search starter list by name or EPA reg. no." }) as HTMLInputElement;
const starterPanel = () => screen.getByRole("heading", { name: "Texas starter catalog" }).closest(".card") as HTMLElement;
const resultsLine = () => within(starterPanel()).getByRole("status");

function rows(): HTMLElement[] {
  return Array.from(starterPanel().querySelectorAll<HTMLElement>(".starter-results > .card-head"));
}
function rowNames(): string[] {
  return rows().map((r) => r.querySelector("strong")!.textContent ?? "");
}
function row(name: string): HTMLElement {
  const found = rows().find((r) => r.querySelector("strong")!.textContent === name);
  if (!found) throw new Error(`starter row not found: ${name} (have: ${rowNames().join(", ")})`);
  return found;
}
function marks(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll("mark")).map((m) => m.textContent ?? "");
}
function pendingIds(): unknown {
  const raw = storage.getItem(STARTER_LABEL_CONFIRM_KEY);
  return raw === null ? null : JSON.parse(raw);
}
function confirmCard(): HTMLElement {
  return screen.getByRole("heading", { name: "Confirm label before activate" }).closest("article") as HTMLElement;
}
function shopCard(name: string): HTMLElement {
  const strong = screen
    .getAllByText(name, { selector: "article strong" })
    .find((el) => !el.closest(".starter-results"));
  return strong!.closest("article") as HTMLElement;
}

const TALSTAR_SHOP: ShopProduct = {
  id: "shop-talstar",
  name: "Talstar P (my label)",
  epaRegNo: "279-3206",
  is25b: false,
  kind: "pesticide",
  isExample: false,
  archived: false,
};

// ---------------------------------------------------------------------------
// Rendering, filtering, highlighting
// ---------------------------------------------------------------------------

describe("Products starter search: initial render", () => {
  it("shows the disclaimer + version note, an empty search and every starter row", () => {
    setup();
    const note = within(starterPanel()).getByRole("note");
    expect(note).toHaveTextContent("This Texas starter list is not official EPA or TDA data.");
    expect(note).toHaveTextContent(`Version ${TEXAS_STARTER_CATALOG_VERSION}.`);
    expect(search()).toHaveValue("");
    expect(search()).toHaveAttribute("placeholder", "Name or EPA reg. no. (dashes optional)");
    expect(rowNames()).toEqual(TEXAS_COMMON_STARTER.map((s) => s.name));
    expect(resultsLine()).toHaveTextContent(`Showing ${TOTAL} of ${TOTAL} starters.`);
    expect(within(starterPanel()).getByRole("button", { name: `Not on shop list yet: ${TOTAL}` })).toBeInTheDocument();
    expect(within(starterPanel()).getByRole("button", { name: "Pending label confirm: 0" })).toBeInTheDocument();
    expect(within(starterPanel()).getByRole("button", { name: "Archived on shop list: 0" })).toBeInTheDocument();
    expect(within(starterPanel()).getByRole("button", { name: "Already on shop list: 0" })).toBeInTheDocument();
  });

  it("the results line is a polite live region", () => {
    setup();
    expect(resultsLine()).toHaveAttribute("aria-live", "polite");
  });

  it("shows kind and EPA / 25(b) / device captions per starter, with no marks when the query is empty", () => {
    setup();
    expect(within(row("Termidor SC")).getByText("EPA 7969-210")).toBeInTheDocument();
    expect(within(row("Termidor SC")).getByText("pesticide")).toBeInTheDocument();
    expect(within(row("Essentria IC3")).getByText("25(b) · no EPA #")).toBeInTheDocument();
    expect(within(row("Catchmaster Insect Glue Board")).getAllByText("device")).toHaveLength(2); // kind + caption
    expect(starterPanel().querySelectorAll("mark")).toHaveLength(0);
    expect(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" })).toBeEnabled();
  });

  it("does not show a clear (×) or reset button until something is filtered", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Clear starter search" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset search & filters" })).toBeNull();
  });
});

describe("Products starter search: query filtering", () => {
  it("filters by name, case-insensitively, as you type (no debounce)", async () => {
    const { user } = setup();
    await user.type(search(), "ADV");
    expect(rowNames()).toEqual(["Advion Cockroach Gel Bait", "Advion Ant Gel", "Advanced Insect Monitor"]);
    await user.type(search(), "ion");
    expect(rowNames()).toEqual(["Advion Cockroach Gel Bait", "Advion Ant Gel"]);
    expect(resultsLine()).toHaveTextContent(`Showing 2 of ${TOTAL} starters.`);
  });

  it("matches an EPA reg. no. with or without dashes/spaces", async () => {
    const { user } = setup();
    await user.type(search(), "100-1484");
    expect(rowNames()).toEqual(["Advion Cockroach Gel Bait"]);
    await user.clear(search());
    await user.type(search(), "1001484");
    expect(rowNames()).toEqual(["Advion Cockroach Gel Bait"]);
    await user.clear(search());
    await user.type(search(), "100 1484");
    expect(rowNames()).toEqual(["Advion Cockroach Gel Bait"]);
  });

  it("matches kind and 25(b) keywords", async () => {
    const { user } = setup();
    await user.type(search(), "device");
    expect(rowNames()).toEqual(["Catchmaster Insect Glue Board", "Advanced Insect Monitor"]);
    await user.clear(search());
    await user.type(search(), "25(b)");
    expect(rowNames()).toEqual(["Essentria IC3", "EcoVia EC"]);
  });

  it("ignores surrounding whitespace in the query", async () => {
    const { user } = setup();
    await user.type(search(), "   termidor   ");
    expect(rowNames()).toEqual(["Termidor SC"]);
  });

  it("shows the empty state and zero counts when nothing matches", async () => {
    const { user } = setup();
    await user.type(search(), "zzz-no-such-product");
    expect(rows()).toHaveLength(0);
    expect(within(starterPanel()).getByText("No starter rows match this search/filter.")).toBeInTheDocument();
    expect(resultsLine()).toHaveTextContent(`Showing 0 of ${TOTAL} starters.`);
    expect(within(starterPanel()).getByRole("button", { name: "Not on shop list yet: 0" })).toBeInTheDocument();
  });

  it("has no result cap: a broad query lists every match", async () => {
    const { user } = setup();
    await user.type(search(), "e");
    const expected = TEXAS_COMMON_STARTER.filter((s) =>
      `${s.name} ${s.epaRegNo ?? ""} ${s.kind} ${s.is25b ? "25b 25(b)" : ""}`.toLowerCase().includes("e"),
    ).map((s) => s.name);
    expect(rowNames()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(15);
  });
});

describe("Products starter search: highlighting", () => {
  it("wraps name matches in <mark>, keeping original casing", async () => {
    const { user } = setup();
    await user.type(search(), "gel");
    expect(marks(row("Advion Cockroach Gel Bait"))).toEqual(["Gel"]);
    expect(marks(row("Maxforce FC Magnum Roach Killer Bait Gel"))).toEqual(["Gel"]);
    expect(row("Advion Cockroach Gel Bait").querySelector("strong")!.textContent).toBe("Advion Cockroach Gel Bait");
  });

  it("marks every occurrence in the name", async () => {
    const { user } = setup();
    await user.type(search(), "in");
    expect(marks(row("Phantom Termiticide-Insecticide"))).toEqual(["In"]);
    expect(marks(row("Temprid FX Insecticide"))).toEqual(["In"]);
    expect(marks(row("Catchmaster Insect Glue Board"))).toEqual(["In"]);
    expect(marks(row("Advanced Insect Monitor"))).toEqual(["In"]);
  });

  it("highlights a dashed EPA query in the EPA caption", async () => {
    const { user } = setup();
    await user.type(search(), "7969-210");
    const r = row("Termidor SC");
    expect(marks(r)).toEqual(["7969-210"]);
    expect(within(r).getByText("7969-210", { selector: "mark" }).closest(".chip")).toHaveTextContent("EPA 7969-210");
  });

  it("does not highlight an EPA match that only works without dashes (documented limitation)", async () => {
    const { user } = setup();
    await user.type(search(), "7969210");
    expect(rowNames()).toEqual(["Termidor SC"]);
    expect(marks(row("Termidor SC"))).toEqual([]);
  });

  it("renders highlights as elements, not raw HTML (query text is escaped)", async () => {
    const { user } = setup();
    await user.type(search(), "<b>");
    expect(rows()).toHaveLength(0);
    expect(starterPanel().querySelector("b")).toBeNull();
  });
});

describe("Products starter search: keyboard, clear and reset", () => {
  it("Escape clears a non-empty query and keeps focus", async () => {
    const { user } = setup();
    await user.type(search(), "bifen");
    expect(rowNames()).toEqual(["Bifen IT"]);
    await user.keyboard("{Escape}");
    expect(search()).toHaveValue("");
    expect(search()).toHaveFocus();
    expect(rows()).toHaveLength(TOTAL);
  });

  it("Escape on an empty query is left to the browser (not prevented)", () => {
    setup();
    expect(fireEvent.keyDown(search(), { key: "Escape" })).toBe(true); // default not prevented
    expect(fireEvent.change(search(), { target: { value: "x" } })).toBe(true);
    expect(fireEvent.keyDown(search(), { key: "Escape" })).toBe(false); // prevented when clearing
  });

  it("the × button clears the query and returns focus to the search box", async () => {
    const { user } = setup();
    await user.type(search(), "taurus");
    const clear = screen.getByRole("button", { name: "Clear starter search" });
    await user.click(clear);
    expect(search()).toHaveValue("");
    expect(search()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear starter search" })).toBeNull();
  });

  it("kind filter narrows results and combines with the query", async () => {
    const { user } = setup();
    const kind = within(starterPanel()).getByLabelText(/^Kind/);
    await user.selectOptions(kind, "device");
    expect(rowNames()).toEqual(["Catchmaster Insect Glue Board", "Advanced Insect Monitor"]);
    await user.type(search(), "advan");
    expect(rowNames()).toEqual(["Advanced Insect Monitor"]);
    await user.selectOptions(kind, "pesticide");
    expect(rows()).toHaveLength(0);
  });

  it("sort by name orders A–Z", async () => {
    const { user } = setup();
    await user.selectOptions(within(starterPanel()).getByLabelText(/^Sort/), "name");
    const names = rowNames();
    expect(names).toEqual(
      [...TEXAS_COMMON_STARTER.map((s) => s.name)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    );
  });

  it("Reset search & filters restores the defaults", async () => {
    const { user } = setup();
    await user.type(search(), "gel");
    await user.selectOptions(within(starterPanel()).getByLabelText(/^Kind/), "pesticide");
    await user.selectOptions(within(starterPanel()).getByLabelText(/^Sort/), "name");
    await user.selectOptions(within(starterPanel()).getByLabelText(/^Shop status/), "not-added");
    await user.click(screen.getByRole("button", { name: "Reset search & filters" }));
    expect(search()).toHaveValue("");
    expect(within(starterPanel()).getByLabelText(/^Kind/)).toHaveValue("all");
    expect(within(starterPanel()).getByLabelText(/^Sort/)).toHaveValue("list");
    expect(within(starterPanel()).getByLabelText(/^Shop status/)).toHaveValue("all");
    expect(rowNames()).toEqual(TEXAS_COMMON_STARTER.map((s) => s.name));
    expect(screen.queryByRole("button", { name: "Reset search & filters" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shop status
// ---------------------------------------------------------------------------

describe("Products starter search: shop status", () => {
  const archivedTermidor: ShopProduct = {
    id: "shop-termidor",
    name: "Termidor SC",
    epaRegNo: "7969-210",
    is25b: false,
    kind: "pesticide",
    isExample: false,
    archived: true,
  };

  it("marks starters already on the shop list (matched by EPA #) and hides their Add button", () => {
    setup([TALSTAR_SHOP]);
    const r = row("Talstar Professional Insecticide");
    expect(within(r).getByText("on shop list")).toBeInTheDocument();
    expect(within(r).getByText("Already in catalog")).toBeInTheDocument();
    expect(within(r).queryByRole("button")).toBeNull();
    expect(within(starterPanel()).getByRole("button", { name: "Already on shop list: 1" })).toBeInTheDocument();
  });

  it("matches 25(b) / device starters by kind + name (no EPA #)", () => {
    setup([
      { ...TALSTAR_SHOP, id: "shop-ess", name: " essentria ic3 ", epaRegNo: null, is25b: true },
    ]);
    expect(within(row("Essentria IC3")).getByText("on shop list")).toBeInTheDocument();
  });

  it("an archived (not pending) match shows 'archived on shop list' and a Confirm label… button", () => {
    setup([archivedTermidor]);
    const r = row("Termidor SC");
    expect(within(r).getByText("archived on shop list")).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: "Confirm label…" })).toBeInTheDocument();
    expect(within(starterPanel()).getByRole("button", { name: "Archived on shop list: 1" })).toBeInTheDocument();
  });

  it("an archived match that is pending label confirm shows 'pending label confirm'", () => {
    storage.setItem(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(["shop-termidor"]));
    setup([archivedTermidor]);
    const r = row("Termidor SC");
    expect(within(r).getByText("pending label confirm")).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: "Confirm label…" })).toBeInTheDocument();
    expect(within(starterPanel()).getByRole("button", { name: "Pending label confirm: 1" })).toBeInTheDocument();
  });

  it("status filter options narrow the list", async () => {
    storage.setItem(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(["shop-termidor"]));
    const { user } = setup([archivedTermidor, TALSTAR_SHOP]);
    const status = within(starterPanel()).getByLabelText(/^Shop status/);
    await user.selectOptions(status, "pending");
    expect(rowNames()).toEqual(["Termidor SC"]);
    await user.selectOptions(status, "hide-active");
    expect(rowNames()).not.toContain("Talstar Professional Insecticide");
    expect(rowNames()).toContain("Termidor SC");
    await user.selectOptions(status, "not-added");
    expect(rowNames()).toHaveLength(TOTAL - 2);
    await user.selectOptions(status, "archived");
    expect(rowNames()).toEqual([]);
  });

  it("needs-action sort puts pending, then archived, then not-added, then active", async () => {
    storage.setItem(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(["shop-termidor"]));
    const archivedBifen: ShopProduct = { ...archivedTermidor, id: "shop-bifen", name: "Bifen", epaRegNo: "53883-118" };
    const { user } = setup([TALSTAR_SHOP, archivedTermidor, archivedBifen]);
    await user.selectOptions(within(starterPanel()).getByLabelText(/^Sort/), "needs-action");
    const names = rowNames();
    expect(names[0]).toBe("Termidor SC");
    expect(names[1]).toBe("Bifen IT");
    expect(names[names.length - 1]).toBe("Talstar Professional Insecticide");
  });
});

// ---------------------------------------------------------------------------
// Add starter → label confirm → activate
// ---------------------------------------------------------------------------

describe("Products starter search: add and label-confirm flow", () => {
  it("Add to my catalog copies the starter as an archived, pending row and opens label confirm", async () => {
    const { user } = setup();
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    expect(onUpsertSpy).toHaveBeenCalledTimes(1);
    const added = onUpsertSpy.mock.calls[0][0];
    expect(added).toEqual({
      id: expect.stringMatching(/^id-\d+$/),
      name: "Termidor SC",
      epaRegNo: "7969-210",
      is25b: false,
      kind: "pesticide",
      isExample: false,
      archived: true,
    });
    expect(pendingIds()).toEqual([added.id]); // durable guard written before the row
    const card = confirmCard();
    expect(within(card).getByText("Termidor SC")).toBeInTheDocument();
    expect(within(card).getByText("EPA 7969-210")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Confirm label & activate" })).toBeDisabled();
    expect(within(row("Termidor SC")).getByText("pending label confirm")).toBeInTheDocument();
  });

  it("locks the starter search and its controls while a label confirm is open", async () => {
    const { user } = setup();
    await user.type(search(), "termidor");
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    expect(search()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear starter search" })).toBeDisabled();
    expect(within(starterPanel()).getByLabelText(/^Kind/)).toBeDisabled();
    expect(within(starterPanel()).getByLabelText(/^Shop status/)).toBeDisabled();
    expect(within(starterPanel()).getByLabelText(/^Sort/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset search & filters" })).toBeDisabled();
    expect(within(row("Termidor SC")).getByRole("button", { name: "Confirm label…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add product" })).toBeDisabled();
  });

  it("checking the label box enables activate; activating un-archives and clears the pending id", async () => {
    const { user } = setup();
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    const card = confirmCard();
    await user.click(within(card).getByLabelText(/I confirmed the product name and EPA #/));
    const activate = within(card).getByRole("button", { name: "Confirm label & activate" });
    expect(activate).toBeEnabled();
    const addedId = onUpsertSpy.mock.calls[0][0].id;
    await user.click(activate);
    expect(onUpsertSpy).toHaveBeenLastCalledWith(expect.objectContaining({ id: addedId, archived: false }));
    expect(pendingIds()).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Confirm label before activate" })).toBeNull();
    expect(search()).toBeEnabled();
    const r = row("Termidor SC");
    expect(within(r).getByText("on shop list")).toBeInTheDocument();
    expect(within(r).getByText("Already in catalog")).toBeInTheDocument();
  });

  it("Leave archived closes the confirm but keeps the row pending (Confirm label… reopens it)", async () => {
    const { user } = setup();
    await user.click(within(row("Bifen IT")).getByRole("button", { name: "Add to my catalog" }));
    await user.click(within(confirmCard()).getByRole("button", { name: "Leave archived" }));
    expect(screen.queryByRole("heading", { name: "Confirm label before activate" })).toBeNull();
    expect(pendingIds()).toEqual([onUpsertSpy.mock.calls[0][0].id]);
    const shop = shopCard("Bifen IT");
    expect(within(shop).getByText("needs label confirm")).toBeInTheDocument();
    expect(within(shop).getByText("archived")).toBeInTheDocument();
    await user.click(within(row("Bifen IT")).getByRole("button", { name: "Confirm label…" }));
    expect(within(confirmCard()).getByText("Bifen IT")).toBeInTheDocument();
    expect(onUpsertSpy).toHaveBeenCalledTimes(1); // reopening does not add a second copy
  });

  it("adds 25(b) and device starters without an EPA #", async () => {
    const { user } = setup();
    await user.click(within(row("Essentria IC3")).getByRole("button", { name: "Add to my catalog" }));
    await user.click(within(confirmCard()).getByRole("button", { name: "Leave archived" }));
    await user.click(within(row("Catchmaster Insect Glue Board")).getByRole("button", { name: "Add to my catalog" }));
    expect(onUpsertSpy.mock.calls.map((c) => [c[0].name, c[0].epaRegNo, c[0].is25b, c[0].kind])).toEqual([
      ["Essentria IC3", null, true, "pesticide"],
      ["Catchmaster Insect Glue Board", null, false, "device"],
    ]);
    expect(within(confirmCard()).getByText("device", { selector: ".chip:last-child" })).toBeInTheDocument();
  });

  it("an archived shop match routes through label confirm instead of adding a duplicate", async () => {
    const archived: ShopProduct = { ...TALSTAR_SHOP, archived: true };
    const { user } = setup([archived]);
    await user.click(within(row("Talstar Professional Insecticide")).getByRole("button", { name: "Confirm label…" }));
    expect(onUpsertSpy).not.toHaveBeenCalled();
    expect(pendingIds()).toEqual(["shop-talstar"]);
    const card = confirmCard();
    expect(within(card).getByText("Talstar P (my label)")).toBeInTheDocument();
    await user.click(within(card).getByLabelText(/I confirmed/));
    await user.click(within(card).getByRole("button", { name: "Confirm label & activate" }));
    expect(onUpsertSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "shop-talstar", archived: false }));
    expect(pendingIds()).toEqual([]);
  });

  it("if onUpsert fails, nothing is added and the pending guard is rolled back", async () => {
    upsertOk = false;
    const { user } = setup();
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    expect(onUpsertSpy).toHaveBeenCalledTimes(1);
    expect(pendingIds()).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Confirm label before activate" })).toBeNull();
    expect(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" })).toBeEnabled();
  });

  it("if activation's onUpsert fails, the confirm stays open and the row stays pending", async () => {
    const { user } = setup();
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    upsertOk = false;
    await user.click(within(confirmCard()).getByLabelText(/I confirmed/));
    await user.click(within(confirmCard()).getByRole("button", { name: "Confirm label & activate" }));
    expect(confirmCard()).toBeInTheDocument();
    expect(pendingIds()).toEqual([onUpsertSpy.mock.calls[0][0].id]);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed label-confirm storage
// ---------------------------------------------------------------------------

describe("Products starter search: label-confirm storage failures", () => {
  it("a malformed pending store shows the fail-closed alert and is not overwritten", () => {
    storage.setItem(STARTER_LABEL_CONFIRM_KEY, "{broken");
    setup();
    expect(screen.getByRole("alert")).toHaveTextContent("Label-confirm storage is unavailable on this device.");
    expect(storage.getItem(STARTER_LABEL_CONFIRM_KEY)).toBe("{broken");
  });

  it("when the pending guard cannot be written, the starter is not added", async () => {
    const { user } = setup();
    storage.failSet = true;
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    expect(onUpsertSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Confirm label before activate" })).toBeNull();
  });

  it("with storage unavailable, activation stays blocked even after the label box is checked", async () => {
    const archived: ShopProduct = { ...TALSTAR_SHOP, archived: true };
    const { user } = setup([archived]);
    storage.failGet = true;
    await user.click(within(row("Talstar Professional Insecticide")).getByRole("button", { name: "Confirm label…" }));
    const card = confirmCard();
    await user.click(within(card).getByLabelText(/I confirmed/));
    expect(within(card).getByRole("button", { name: "Confirm label & activate" })).toBeDisabled();
    expect(onUpsertSpy).not.toHaveBeenCalled();
  });

  it("re-reads the durable store on mount (pending ids from a previous session)", () => {
    storage.setItem(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(["shop-talstar"]));
    setup([{ ...TALSTAR_SHOP, archived: true }]);
    expect(within(row("Talstar Professional Insecticide")).getByText("pending label confirm")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 25(b)-only toggle (#81)
// ---------------------------------------------------------------------------

describe("Products starter search: 25(b)-only toggle", () => {
  const only25b = () =>
    within(starterPanel()).getByRole("checkbox", { name: "25(b) products only" }) as HTMLInputElement;
  const EXPECTED_25B = TEXAS_COMMON_STARTER.filter((s) => s.kind === "pesticide" && s.is25b).map((s) => s.name);

  it("starts unchecked and narrows the rows to 25(b) pesticide starters only", async () => {
    const { user } = setup();
    expect(EXPECTED_25B.length).toBeGreaterThan(0);
    expect(EXPECTED_25B.length).toBeLessThan(TOTAL);
    expect(only25b().checked).toBe(false);
    await user.click(only25b());
    expect(only25b().checked).toBe(true);
    expect(rowNames()).toEqual(EXPECTED_25B);
    expect(rowNames()).toContain("Essentria IC3");
    expect(rowNames()).not.toContain("Termidor SC");
    expect(rowNames()).not.toContain("Catchmaster Insect Glue Board"); // devices excluded
  });

  it("updates the results count and combines with the query", async () => {
    const { user } = setup();
    await user.click(only25b());
    expect(resultsLine()).toHaveTextContent(`Showing ${EXPECTED_25B.length} of ${TOTAL} starters.`);
    await user.type(search(), "essentria");
    expect(rowNames()).toEqual(["Essentria IC3"]);
    expect(resultsLine()).toHaveTextContent(`Showing 1 of ${TOTAL} starters.`);
    await user.clear(search());
    await user.type(search(), "termidor"); // registered → filtered out by the toggle
    expect(rowNames()).toEqual([]);
    expect(screen.getByText("No starter rows match this search/filter.")).toBeInTheDocument();
  });

  it("shows 'Reset search & filters' on its own, and Reset clears it", async () => {
    const { user } = setup();
    expect(screen.queryByRole("button", { name: "Reset search & filters" })).toBeNull();
    await user.click(only25b());
    await user.click(screen.getByRole("button", { name: "Reset search & filters" }));
    expect(only25b().checked).toBe(false);
    expect(rowNames()).toEqual(TEXAS_COMMON_STARTER.map((s) => s.name));
    expect(resultsLine()).toHaveTextContent(`Showing ${TOTAL} of ${TOTAL} starters.`);
    expect(screen.queryByRole("button", { name: "Reset search & filters" })).toBeNull();
  });

  it("is disabled while the label-confirm card is open, and re-enabled after", async () => {
    const { user } = setup();
    await user.click(only25b());
    await user.click(within(row("Essentria IC3")).getByRole("button", { name: "Add to my catalog" }));
    expect(confirmCard()).toBeInTheDocument();
    expect(only25b()).toBeDisabled();
    expect(only25b().checked).toBe(true); // state kept, just locked
    await user.click(within(confirmCard()).getByRole("button", { name: "Leave archived" }));
    expect(only25b()).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Shop catalog: add / edit form, list filters, archive / delete, remove-examples
// ---------------------------------------------------------------------------

const EXAMPLE: ShopProduct = {
  id: "example-rtu-insecticide",
  name: "Example RTU insecticide",
  epaRegNo: null,
  is25b: false,
  kind: "pesticide",
  isExample: true,
  archived: false,
};
const GLUE_SHOP: ShopProduct = {
  id: "shop-glue",
  name: "Glue board",
  epaRegNo: null,
  is25b: false,
  kind: "device",
  isExample: false,
  archived: false,
};
const ARCHIVED_SHOP: ShopProduct = {
  id: "shop-old",
  name: "Old Concentrate",
  epaRegNo: "111-2",
  is25b: false,
  kind: "pesticide",
  isExample: false,
  archived: true,
};

// Shop-catalog filters (distinct from the starter panel, which also uses .catalog-filters).
const catalogFilters = () =>
  (document.querySelector('.catalog-filters input[placeholder="Name or EPA #"]') as HTMLElement).closest(
    ".catalog-filters",
  ) as HTMLElement;
const catalogSearch = () => within(catalogFilters()).getByPlaceholderText("Name or EPA #") as HTMLInputElement;
const catalogShow = () => within(catalogFilters()).getByLabelText(/^Show/) as HTMLSelectElement;
const catalogKind = () => within(catalogFilters()).getByLabelText(/^Kind/) as HTMLSelectElement;
const catalogStatus = () => within(catalogFilters()).getByRole("status");
const productForm = () =>
  screen.getByRole("heading", { name: /^(Add|Edit) product$/ }).closest("form") as HTMLFormElement;
const formName = () => within(productForm()).getByLabelText(/^Name/) as HTMLInputElement;
const formKind = () => within(productForm()).getByLabelText(/^Kind/) as HTMLSelectElement;
const formEpa = () => within(productForm()).getByLabelText(/^EPA registration number/) as HTMLInputElement;
const form25b = () => within(productForm()).getByRole("checkbox", { name: /25\(b\) product/ }) as HTMLInputElement;
const formExample = () =>
  within(productForm()).getByRole("checkbox", { name: /Example seed/ }) as HTMLInputElement;
const formErrors = () => Array.from(productForm().querySelectorAll(".error")).map((e) => e.textContent);
function listedShopNames(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("article.card"))
    .filter((a) => !a.closest(".starter-results") && a.querySelector(".card-head strong"))
    .map((a) => a.querySelector(".card-head strong")!.textContent ?? "");
}

describe("Products catalog: empty and remove-examples", () => {
  it("shows the empty hint when the shop catalog is empty", () => {
    setup([]);
    expect(screen.getByText("No products yet. Add the pesticides and devices this shop actually uses.")).toBeInTheDocument();
    expect(document.querySelector('.catalog-filters input[placeholder="Name or EPA #"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove example products from catalog" })).toBeNull();
  });

  it("offers remove-examples when seeds remain, confirms, then removes them", async () => {
    const { user } = setup([TALSTAR_SHOP, EXAMPLE]);
    const btn = screen.getByRole("button", { name: "Remove example products from catalog" });
    expect(screen.getByText(/1 example product on this list/)).toBeInTheDocument();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(btn);
    expect(confirm).toHaveBeenCalledWith(
      "Remove 1 example product from the shop catalog? Saved logs are not changed.",
    );
    expect(onRemoveExamplesSpy).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(btn);
    expect(onRemoveExamplesSpy).toHaveBeenCalledTimes(1);
    expect(listedShopNames()).toEqual(["Talstar P (my label)"]);
    expect(screen.queryByRole("button", { name: "Remove example products from catalog" })).toBeNull();
  });

  it("uses plural copy for multiple example products", async () => {
    const ex2 = { ...EXAMPLE, id: "example-25b-concentrate", name: "Example 25(b) concentrate", is25b: true };
    const { user } = setup([EXAMPLE, ex2]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Remove example products from catalog" }));
    expect(confirm).toHaveBeenCalledWith(
      "Remove 2 example products from the shop catalog? Saved logs are not changed.",
    );
  });

  it("when onRemoveExamples fails, examples stay and the remove nag remains (#103)", async () => {
    // Products.tsx ignores the boolean return today — it does not show a dedicated error
    // string like Export does. The failure is still visible: examples stay on the list and
    // the remove affordance stays up (removal was not treated as done).
    removeOk = false;
    const { user } = setup([TALSTAR_SHOP, EXAMPLE]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Remove example products from catalog" }));
    expect(onRemoveExamplesSpy).toHaveBeenCalledTimes(1);
    expect(listedShopNames()).toEqual(["Talstar P (my label)", "Example RTU insecticide"]);
    expect(screen.getByText(/1 example product on this list/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove example products from catalog" })).toBeInTheDocument();
  });
});

describe("Products catalog: list filters", () => {
  const CATALOG = [TALSTAR_SHOP, GLUE_SHOP, ARCHIVED_SHOP, EXAMPLE];

  it("defaults to active and hides archived; status line reflects the filter", () => {
    setup(CATALOG);
    expect(catalogShow().value).toBe("active");
    expect(listedShopNames()).toEqual(["Talstar P (my label)", "Glue board", "Example RTU insecticide"]);
    expect(catalogStatus()).toHaveTextContent("Showing 3 of 4 (active).");
    expect(within(catalogShow()).getByRole("option", { name: "Archived (1)" })).toBeInTheDocument();
  });

  it("Show=archived / all and Kind narrow the list; search matches name, EPA, kind, 25b, example", async () => {
    const { user } = setup(CATALOG);
    await user.selectOptions(catalogShow(), "archived");
    expect(listedShopNames()).toEqual(["Old Concentrate"]);
    expect(catalogStatus()).toHaveTextContent("Showing 1 of 4 (archived).");
    await user.selectOptions(catalogShow(), "all");
    expect(listedShopNames()).toHaveLength(4);
    expect(catalogStatus()).toHaveTextContent("Showing 4 of 4.");
    await user.selectOptions(catalogKind(), "device");
    expect(listedShopNames()).toEqual(["Glue board"]);
    await user.selectOptions(catalogKind(), "all");
    await user.type(catalogSearch(), "279-3206");
    expect(listedShopNames()).toEqual(["Talstar P (my label)"]);
    await user.clear(catalogSearch());
    await user.type(catalogSearch(), "example");
    expect(listedShopNames()).toEqual(["Example RTU insecticide"]);
    await user.clear(catalogSearch());
    await user.type(catalogSearch(), "zzzz");
    expect(listedShopNames()).toEqual([]);
    expect(screen.getByText("No products match this search/filter.")).toBeInTheDocument();
  });
});

describe("Products catalog: add form", () => {
  it("Add product opens a blank form and hides the Add button", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add product" }));
    expect(screen.getByRole("heading", { name: "Add product" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add product" })).toBeNull();
    expect(formName().value).toBe("");
    expect(formKind().value).toBe("pesticide");
    expect(form25b().checked).toBe(false);
    expect(formExample().checked).toBe(false);
  });

  it("requires a name and an EPA # for registered pesticides", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(formErrors()).toEqual(["Name required", "EPA # required for registered pesticides (leave blank for 25(b) or examples)"]);
    expect(onUpsertSpy).not.toHaveBeenCalled();
  });

  it("rejects SAMPLE-* EPA numbers unless marked as an example seed", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(formName(), "Placeholder");
    await user.type(formEpa(), "SAMPLE-1");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(formErrors()).toEqual([
      "SAMPLE-* looks like a placeholder; mark as Example seed or enter a real EPA #",
    ]);
  });

  it("saves a registered pesticide with a trimmed name and EPA #", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(formName(), "  New Bifen  ");
    await user.type(formEpa(), "  53883-118  ");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(onUpsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^id-\d+$/),
        name: "New Bifen",
        epaRegNo: "53883-118",
        is25b: false,
        kind: "pesticide",
        isExample: false,
        archived: false,
      }),
    );
    expect(screen.queryByRole("heading", { name: "Add product" })).toBeNull();
    expect(listedShopNames()).toContain("New Bifen");
  });

  it("25(b) and device saves null the EPA #; example seed does too", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(formName(), "Ess Clone");
    await user.click(form25b());
    await user.type(formEpa(), "should-clear");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(onUpsertSpy.mock.calls.at(-1)![0]).toMatchObject({
      name: "Ess Clone",
      epaRegNo: null,
      is25b: true,
    });

    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(formName(), "Trap");
    await user.selectOptions(formKind(), "device");
    expect(within(productForm()).queryByLabelText(/^EPA registration number/)).toBeNull();
    expect(within(productForm()).queryByRole("checkbox", { name: /25\(b\) product/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(onUpsertSpy.mock.calls.at(-1)![0]).toMatchObject({
      name: "Trap",
      kind: "device",
      epaRegNo: null,
      is25b: false,
    });

    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(formName(), "Demo");
    await user.click(formExample());
    expect(formEpa()).toBeDisabled();
    expect(formEpa().value).toBe("");
    expect(screen.getByText(/Example items never print a registration number/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(onUpsertSpy.mock.calls.at(-1)![0]).toMatchObject({
      name: "Demo",
      isExample: true,
      epaRegNo: null,
    });
  });

  it("keeps the form open when onUpsert fails; Cancel discards", async () => {
    upsertOk = false;
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(formName(), "Nope");
    await user.type(formEpa(), "1-1");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(onUpsertSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Add product" })).toBeInTheDocument();
    upsertOk = true;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Add product" })).toBeNull();
    expect(listedShopNames()).toEqual([]);
  });
});

describe("Products catalog: edit, archive, delete", () => {
  it("Edit prefills the form; Save updates under the same id", async () => {
    const { user } = setup([TALSTAR_SHOP]);
    await user.click(within(shopCard("Talstar P (my label)")).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("heading", { name: "Edit product" })).toBeInTheDocument();
    expect(formName().value).toBe("Talstar P (my label)");
    expect(formEpa().value).toBe("279-3206");
    expect(catalogSearch()).toBeDisabled();
    expect(catalogShow()).toBeDisabled();
    await user.clear(formName());
    await user.type(formName(), "Talstar Pro");
    await user.click(screen.getByRole("button", { name: "Save product" }));
    expect(onUpsertSpy).toHaveBeenLastCalledWith(expect.objectContaining({ id: "shop-talstar", name: "Talstar Pro" }));
    expect(listedShopNames()).toEqual(["Talstar Pro"]);
  });

  it("Archive / Unarchive toggles the archived flag", async () => {
    const { user } = setup([TALSTAR_SHOP]);
    await user.click(within(shopCard("Talstar P (my label)")).getByRole("button", { name: "Archive" }));
    expect(onUpsertSpy).toHaveBeenLastCalledWith(expect.objectContaining({ id: "shop-talstar", archived: true }));
    await user.selectOptions(catalogShow(), "archived");
    await user.click(within(shopCard("Talstar P (my label)")).getByRole("button", { name: "Unarchive" }));
    expect(onUpsertSpy).toHaveBeenLastCalledWith(expect.objectContaining({ id: "shop-talstar", archived: false }));
  });

  it("Delete confirms by name then removes the row", async () => {
    const { user } = setup([TALSTAR_SHOP, GLUE_SHOP]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(within(shopCard("Glue board")).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete Glue board from the shop list?");
    expect(onDeleteSpy).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(within(shopCard("Glue board")).getByRole("button", { name: "Delete" }));
    expect(onDeleteSpy).toHaveBeenCalledWith("shop-glue");
    expect(listedShopNames()).toEqual(["Talstar P (my label)"]);
  });

  it("example products have no Archive button", () => {
    setup([EXAMPLE]);
    const card = shopCard("Example RTU insecticide");
    expect(within(card).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(within(card).getByText("example")).toHaveClass("chip", "sample");
  });
});

describe("Products catalog: edit visibility and unarchive edges", () => {
  it("keeps the product being edited visible even when filters would hide it", async () => {
    const { user } = setup([TALSTAR_SHOP, GLUE_SHOP]);
    await user.click(within(shopCard("Glue board")).getByRole("button", { name: "Edit" }));
    await user.selectOptions(catalogKind(), "pesticide"); // would hide the device
    // The edit form (not the card-head) is still mounted for Glue board.
    expect(screen.getByRole("heading", { name: "Edit product" })).toBeInTheDocument();
    expect(formName().value).toBe("Glue board");
    expect(listedShopNames()).not.toContain("Glue board"); // card-head gone, form remains
  });

  it("Unarchive on a pending label-confirm row opens Confirm label instead of activating", async () => {
    // Seed a pending archived shop match via starter add, then leave archived and try Unarchive /
    // Confirm label… from the shop card.
    const { user } = setup();
    await user.type(search(), "essentria");
    await user.click(within(row("Essentria IC3")).getByRole("button", { name: "Add to my catalog" }));
    await user.click(within(confirmCard()).getByRole("button", { name: "Leave archived" }));
    const card = shopCard("Essentria IC3");
    expect(within(card).getByText("needs label confirm")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Confirm label…" }));
    expect(confirmCard()).toBeInTheDocument();
    // Still archived — activate only goes through the confirm checkbox path.
    expect(onUpsertSpy.mock.calls.some((c) => c[0].name === "Essentria IC3" && c[0].archived === false)).toBe(
      false,
    );
  });
});

describe("Products catalog: fail-closed unarchive / clear-pending", () => {
  const CUSTOM_ARCHIVED: ShopProduct = {
    id: "custom-mix",
    name: "Custom Mix",
    epaRegNo: "999-999",
    is25b: false,
    kind: "pesticide",
    isExample: false,
    archived: true,
  };

  it("shows Unarchive blocked (disabled) for a non-pending archived row when storage is unreadable", async () => {
    // Heuristic pending only covers archived starter matches. A custom archived row
    // with no starter match must not be activatable while storage is down.
    storage.failGet = true;
    const { user } = setup([CUSTOM_ARCHIVED]);
    expect(screen.getByRole("alert")).toHaveTextContent("Label-confirm storage is unavailable");
    await user.selectOptions(catalogShow(), "archived");
    const card = shopCard("Custom Mix");
    const btn = within(card).getByRole("button", { name: "Unarchive blocked" });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onUpsertSpy).not.toHaveBeenCalled();
  });

  it("if clearPending fails after activate, re-archives and keeps the confirm open", async () => {
    const { user } = setup();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    await user.type(search(), "termidor");
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    const card = confirmCard();
    await user.click(within(card).getByLabelText(/I confirmed/));
    storage.failSet = true; // clearPending write fails; activate upsert still ok
    const before = onUpsertSpy.mock.calls.length;
    await user.click(within(card).getByRole("button", { name: "Confirm label & activate" }));
    const after = onUpsertSpy.mock.calls.slice(before).map((c) => c[0]);
    expect(after.map((p) => p.archived)).toEqual([false, true]); // activate then re-archive
    expect(confirmCard()).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Label-confirm storage is unavailable");
    expect(alertSpy).not.toHaveBeenCalled();
    expect(pendingIds()).toEqual([after[0].id]);
  });

  it("alerts if re-archive also fails after a clearPending failure", async () => {
    const { user } = setup();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    await user.type(search(), "termidor");
    await user.click(within(row("Termidor SC")).getByRole("button", { name: "Add to my catalog" }));
    const card = confirmCard();
    await user.click(within(card).getByLabelText(/I confirmed/));
    storage.failSet = true;
    // Harness: onUpsertSpy(clone) then if (!upsertOk) return false.
    // Fail only the re-archive call (the one after a successful activate).
    let seenActivate = false;
    onUpsertSpy.mockImplementation((p: ShopProduct) => {
      if (seenActivate) upsertOk = false;
      if (p.archived === false) seenActivate = true;
    });
    await user.click(within(card).getByRole("button", { name: "Confirm label & activate" }));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Termidor SC is active but label confirmation could not be saved/),
    );
    expect(confirmCard()).toBeInTheDocument();
  });
});
