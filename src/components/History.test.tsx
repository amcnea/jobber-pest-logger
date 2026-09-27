// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppliedProduct, ApplicationLog } from "../types";

// Scope: History.tsx (property-level log list) as tech and office see it:
// empty state, grouping by service address, per-log summary lines, the date-used
// filter (From / To / This month / Clear), and the role-gated Edit / Delete actions.
// Import-boundary mocks, same approach as NewLogForm.test.tsx:
// - ../storage → only `groupLogsByServiceAddress` (the one import History uses, real impl).
// dates / catalog run for real (pure). Date is faked; TZ is America/Chicago (vitest config).

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { groupLogsByServiceAddress: actual.groupLogsByServiceAddress };
});

const { History } = await import("./History");

vi.setConfig({ testTimeout: 15_000 });

const NOW = new Date("2026-09-26T15:00:00.000Z"); // Sat Sep 26 2026, 10:00 AM CDT

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function product(over: Partial<AppliedProduct> = {}): AppliedProduct {
  return {
    lineId: "l1",
    catalogId: "talstar",
    name: "Talstar P",
    epaRegNo: "279-3206",
    is25b: false,
    isExample: false,
    method: "rtu",
    rtuAmount: "1",
    rtuUnit: "gal",
    mixingRate: "",
    percentAi: "",
    mixedTotal: "",
    mixedUnit: "",
    deviceCount: "",
    ...over,
  };
}

const TALSTAR = product();
const ESSENTRIA = product({ lineId: "l2", catalogId: "ess", name: "Essentria IC3", epaRegNo: null, is25b: true });
const GLUE = product({ lineId: "l3", catalogId: "glue", name: "Glue board", epaRegNo: null, method: "device", deviceCount: "4" });
const EXAMPLE = product({ lineId: "l4", catalogId: "ex", name: "Example RTU", epaRegNo: null, isExample: true });

function log(over: Partial<ApplicationLog> = {}): ApplicationLog {
  return {
    id: "log",
    createdAt: "2026-09-01T15:00:00.000Z",
    sampleData: false,
    jobberJobNumber: "",
    jobberAddress: "",
    customerBillingName: "Pat Customer",
    customerBillingAddress: "1 Billing Rd",
    serviceAddress: "100 Main St",
    poleLocation: "",
    products: [TALSTAR],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-01",
    personnel: [],
    shopTpclNumber: "12345",
    shopTpclLetter: "B",
    isTermite: false,
    termite: {
      areaTreatedSqFt: "",
      isBait: false,
      physicalBarrierMeasurement: "",
      diagramNote: "",
      isCommercialPretreat: false,
      tankCount: "",
      tankGallons: "",
      startTime: "",
      stopTime: "",
    },
    ...over,
  };
}

// Two properties; Main St has three visits (one in August), Oak Ave one.
const MAIN_AUG = log({ id: "main-aug", dateUsed: "2026-08-15", customerBillingName: "Old Owner" });
const MAIN_SEP1 = log({ id: "main-sep1", dateUsed: "2026-09-01" });
const MAIN_SEP20 = log({
  id: "main-sep20",
  dateUsed: "2026-09-20",
  serviceAddress: "  100   MAIN st ", // same property after trim / whitespace / case-fold
  customerBillingName: "New Owner",
  poleLocation: "P-17",
  products: [TALSTAR, ESSENTRIA, GLUE],
  jobberJobNumber: "J-555",
});
const OAK = log({
  id: "oak",
  dateUsed: "2026-09-10",
  serviceAddress: "7 Oak Ave",
  customerBillingName: "Oak HOA",
  isTermite: true,
  sampleData: true,
  products: [EXAMPLE],
});
const LOGS = [MAIN_AUG, MAIN_SEP1, OAK, MAIN_SEP20];

type Opts = { logs?: ApplicationLog[]; canEditDelete?: boolean };

function setup(opts: Opts = {}) {
  const user = userEvent.setup();
  const cb = {
    onDelete: vi.fn<(id: string) => void>(),
    onEdit: vi.fn<(l: ApplicationLog) => void>(),
    onLogAgainHere: vi.fn(),
    onDuplicateLastStop: vi.fn(),
  };
  const utils = render(<History logs={opts.logs ?? LOGS} canEditDelete={opts.canEditDelete ?? true} {...cb} />);
  return { user, ...cb, ...utils };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const groupHeadings = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".history-group > .history-group-head > h3")).map(
    (h) => h.textContent,
  );
function group(address: string): HTMLElement {
  return screen.getByRole("heading", { level: 3, name: address }).closest("section") as HTMLElement;
}
function cards(scope: HTMLElement = document.body): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>("article.history-log-card"));
}
const cardDates = (scope?: HTMLElement) => cards(scope).map((c) => c.querySelector("strong")!.textContent);
function card(date: string): HTMLElement {
  const found = cards().find((c) => c.querySelector("strong")!.textContent === date);
  if (!found) throw new Error(`no card for ${date}`);
  return found;
}
const status = () => screen.getByRole("status");
const fromInput = () => screen.getByLabelText("From") as HTMLInputElement;
const toInput = () => screen.getByLabelText("To") as HTMLInputElement;
const setDate = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("History: empty state", () => {
  it("shows the empty message and no filters when there are no logs", () => {
    setup({ logs: [] });
    expect(screen.getByText("No logs on this device yet.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Property-level history" })).toBeNull();
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("History: grouping and log cards", () => {
  it("groups by normalized service address, sorted A–Z", () => {
    setup();
    // "  100   MAIN st " (most recent) supplies the display address for the Main St group.
    expect(groupHeadings()).toEqual(["100 MAIN st", "7 Oak Ave"]);
  });

  it("orders logs newest-first within a group", () => {
    setup();
    expect(cardDates(group("100 MAIN st"))).toEqual(["2026-09-20", "2026-09-01", "2026-08-15"]);
    expect(cardDates(group("7 Oak Ave"))).toEqual(["2026-09-10"]);
  });

  it("shows billing name and pole from the most recent visit in the group header", () => {
    setup();
    const head = group("100 MAIN st").querySelector(".history-group-head") as HTMLElement;
    expect(head).toHaveTextContent("New Owner");
    expect(head).toHaveTextContent("· Pole: P-17");
    expect(head).not.toHaveTextContent("Old Owner");
  });

  it("omits the meta line when the latest visit has no billing name or pole", () => {
    setup({ logs: [log({ customerBillingName: "", poleLocation: "" })] });
    expect(document.querySelector(".property-meta")).toBeNull();
  });

  it("summarizes products (device count), EPA captions (no device caption) and the Jobber #", () => {
    setup();
    const c = card("2026-09-20");
    const lines = Array.from(c.querySelectorAll(".history-log-line")).map((l) => l.textContent);
    expect(lines).toEqual([
      "Talstar P, Essentria IC3, Glue board × 4",
      "EPA 279-3206 · 25(b) · no EPA #",
      "Jobber #J-555 (not TDA)",
    ]);
  });

  it("shows example / termite chips and the example EPA label, no Jobber line when blank", () => {
    setup();
    const c = card("2026-09-10");
    expect(within(c).getByText("example")).toHaveClass("chip", "sample");
    expect(within(c).getByText("termite")).toHaveClass("chip");
    expect(c).toHaveTextContent("example / not a real EPA number");
    expect(c).not.toHaveTextContent("Jobber #");
    // a plain log has neither chip
    expect(within(card("2026-09-01")).queryByText("termite")).toBeNull();
  });

  it("says 'No products' and skips the EPA line for a log without products", () => {
    setup({ logs: [log({ products: [] })] });
    const lines = Array.from(card("2026-09-01").querySelectorAll(".history-log-line")).map((l) => l.textContent);
    expect(lines).toEqual(["No products"]);
  });

  it("groups logs with a blank service address under '(no service address)'", () => {
    setup({ logs: [log({ serviceAddress: "   " })] });
    expect(groupHeadings()).toEqual(["(no service address)"]);
  });
});

describe("History: date-used filter", () => {
  it("starts unfiltered with Clear dates disabled", () => {
    setup();
    expect(status()).toHaveTextContent("Showing 4 of 4 logs.");
    expect(screen.getByRole("button", { name: "Clear dates" })).toBeDisabled();
    expect(cards()).toHaveLength(4);
  });

  it("uses singular 'log' for a one-log device", () => {
    setup({ logs: [MAIN_SEP1] });
    expect(status()).toHaveTextContent("Showing 1 of 1 log.");
  });

  it("From only is an inclusive lower bound", () => {
    setup();
    setDate(fromInput(), "2026-09-10");
    expect(status()).toHaveTextContent("Showing 2 of 4 logs in range.");
    expect(cardDates()).toEqual(["2026-09-20", "2026-09-10"]);
  });

  it("To only is an inclusive upper bound", () => {
    setup();
    setDate(toInput(), "2026-09-01");
    expect(status()).toHaveTextContent("Showing 2 of 4 logs in range.");
    expect(cardDates()).toEqual(["2026-09-01", "2026-08-15"]);
  });

  it("drops groups with no logs in range", () => {
    setup();
    setDate(fromInput(), "2026-08-01");
    setDate(toInput(), "2026-08-31");
    expect(groupHeadings()).toEqual(["100 Main St"]); // display address now comes from the in-range visit
    expect(cardDates()).toEqual(["2026-08-15"]);
  });

  it("an empty range shows the no-results hint and no groups", () => {
    setup();
    setDate(fromInput(), "2026-10-01");
    expect(status()).toHaveTextContent("Showing 0 of 4 logs in range.");
    expect(screen.getByText("No logs in this date range. Clear dates or widen the range.")).toBeInTheDocument();
    expect(groupHeadings()).toEqual([]);
  });

  it("an inverted range (From after To) matches nothing", () => {
    setup();
    setDate(fromInput(), "2026-09-20");
    setDate(toInput(), "2026-09-01");
    expect(status()).toHaveTextContent("Showing 0 of 4 logs in range.");
  });

  it("This month fills the current device-local month and filters to it", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "This month" }));
    expect(fromInput().value).toBe("2026-09-01");
    expect(toInput().value).toBe("2026-09-30");
    expect(status()).toHaveTextContent("Showing 3 of 4 logs in range.");
    expect(cardDates()).not.toContain("2026-08-15");
  });

  it("This month uses the local calendar at a UTC month boundary", async () => {
    // 2026-10-01T03:00Z is still Sep 30, 10 PM in Chicago.
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "This month" }));
    expect(fromInput().value).toBe("2026-09-01");
    expect(toInput().value).toBe("2026-09-30");
  });

  it("Clear dates resets both inputs and is disabled again", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "This month" }));
    const clear = screen.getByRole("button", { name: "Clear dates" });
    expect(clear).toBeEnabled();
    await user.click(clear);
    expect(fromInput().value).toBe("");
    expect(toInput().value).toBe("");
    expect(clear).toBeDisabled();
    expect(status()).toHaveTextContent("Showing 4 of 4 logs.");
  });

  it("excludes logs with a malformed dateUsed once a bound is set, keeps them unfiltered", () => {
    setup({ logs: [MAIN_SEP1, log({ id: "bad", dateUsed: "9/5/2026", serviceAddress: "9 Bad Ln" })] });
    expect(status()).toHaveTextContent("Showing 2 of 2 logs.");
    setDate(fromInput(), "2026-01-01");
    expect(status()).toHaveTextContent("Showing 1 of 2 logs in range.");
    expect(groupHeadings()).toEqual(["100 Main St"]);
  });
});

describe("History: property actions", () => {
  it("Log again here / Duplicate last stop pass the property entry with its latest visit", async () => {
    const { user, onLogAgainHere, onDuplicateLastStop } = setup();
    const g = group("100 MAIN st");
    await user.click(within(g).getByRole("button", { name: "Log again here" }));
    await user.click(within(g).getByRole("button", { name: "Duplicate last stop" }));
    for (const fn of [onLogAgainHere, onDuplicateLastStop]) {
      expect(fn).toHaveBeenCalledTimes(1);
      const entry = fn.mock.calls[0][0];
      expect(entry).toMatchObject({ key: "100 main st", customerBillingName: "New Owner", poleLocation: "P-17" });
      expect(entry.lastLog.id).toBe("main-sep20");
      expect(entry.logs.map((l: ApplicationLog) => l.id)).toEqual(["main-sep20", "main-sep1", "main-aug"]);
    }
  });

  it("with a date filter active, the property entry is built from in-range logs only", async () => {
    // Documents current behavior (see BUGS-batch2.md "observation"): the group handed to
    // Duplicate last stop is the filtered one, so its lastLog is the latest *in range*.
    const { user, onDuplicateLastStop } = setup();
    setDate(toInput(), "2026-08-31");
    await user.click(within(group("100 Main St")).getByRole("button", { name: "Duplicate last stop" }));
    expect(onDuplicateLastStop.mock.calls[0][0].lastLog.id).toBe("main-aug");
    expect(onDuplicateLastStop.mock.calls[0][0].customerBillingName).toBe("Old Owner");
  });
});

describe("History: role-gated Edit / Delete", () => {
  it("tech (canEditDelete=false) sees no Edit/Delete and the ask-office hint", () => {
    setup({ canEditDelete: false });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText(/tech cannot edit or delete saved logs/)).toBeInTheDocument();
    // tech still gets the property actions
    expect(screen.getAllByRole("button", { name: "Log again here" })).toHaveLength(2);
  });

  it("office sees Edit/Delete on every log card", () => {
    setup();
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(4);
    expect(screen.queryByText(/tech cannot edit or delete/)).toBeNull();
  });

  it("Edit passes the exact log", async () => {
    const { user, onEdit } = setup();
    await user.click(within(card("2026-09-01")).getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(MAIN_SEP1);
  });

  it("Delete asks for confirmation naming the date and address, then deletes by id", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onDelete } = setup();
    await user.click(within(card("2026-09-20")).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(
      "Delete 2026-09-20 at 100   MAIN st from this device? This cannot be undone.",
    );
    expect(onDelete).toHaveBeenCalledWith("main-sep20");
  });

  it("cancelling the confirm does not delete", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user, onDelete } = setup();
    await user.click(within(card("2026-09-01")).getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("confirm text falls back for a blank date / address", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = setup({ logs: [log({ dateUsed: "", serviceAddress: " " })] });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(
      "Delete this log at unknown address from this device? This cannot be undone.",
    );
  });
});
