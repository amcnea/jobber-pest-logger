// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportPullResult } from "../shop/exportPull";
import type { ShopSections } from "../storage";
import { makeApplied, makeLog, makeShopProduct } from "../test/fixtures";
import type { ApplicationLog, ShopProduct, ShopSettings } from "../types";

// Scope: Export.tsx (office CSV / PDF trigger UI): backup label + nag, date range
// (This month / Clear / inverted range), example-seed and § 7.144 completeness gates,
// preview / provenance, and the prepare → download flow for local and shared shops
// (pull failure fallback, cancel, post-pull gates, PDF loader failure).
// Import-boundary mocks, same approach as NewLogForm.test.tsx:
// - ../storage → only `formatLastBackupLabel` / `backupNagMessage` (real impl).
// - ../shop    → `resolveExportSections` / `resolveShopStore` / `sharedExportPullHint`
//                as controllable fakes (Binder's shared-shop code is tested separately).
// - ../csv, ../pdf → download spies (no Blob / jsPDF work in jsdom).
// catalog / dates / formDefaults / exportProvenance / disclaimer run for real.

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { formatLastBackupLabel: actual.formatLastBackupLabel, backupNagMessage: actual.backupNagMessage };
});

const shop = vi.hoisted(() => ({
  hint: null as string | null,
  shopId: "SHOP-1" as string | null,
  pull: null as null | ((s: ShopSections) => Promise<ExportPullResult>),
}));
const resolveExportSections = vi.fn(async (s: ShopSections): Promise<ExportPullResult> =>
  shop.pull ? shop.pull(s) : { kind: "local", sections: s },
);
vi.mock("../shop", () => ({
  resolveExportSections: (s: ShopSections) => resolveExportSections(s),
  resolveShopStore: () => ({ shopId: shop.shopId }),
  sharedExportPullHint: () => shop.hint,
}));

const downloadCsv = vi.fn();
const downloadPdf = vi.fn();
vi.mock("../csv", () => ({ downloadCsv: (...a: unknown[]) => downloadCsv(...a) }));
vi.mock("../pdf", () => ({ downloadPdf: (...a: unknown[]) => downloadPdf(...a) }));

const { Export } = await import("./Export");
const { LAWGICAL_DISCLAIMER } = await import("../disclaimer");

vi.setConfig({ testTimeout: 15_000 });

const NOW = new Date("2026-09-26T15:00:00.000Z"); // Sat Sep 26 2026, 10:00 AM CDT
const SHARED_HINT = "Shared shop: CSV/PDF and backup JSON pull a fresh cloud snapshot before download.";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SETTINGS: ShopSettings = { shopName: "  Acme Pest  ", shopTpclNumber: "12345", shopTpclLetter: "B" };
const TALSTAR = makeShopProduct();
const EXAMPLE_PRODUCT = makeShopProduct({ id: "example-rtu", name: "Example RTU", epaRegNo: null, isExample: true });

const AUG = makeLog({ id: "aug", dateUsed: "2026-08-15", serviceAddress: "9 Aug Ln" });
const SEP1 = makeLog({ id: "sep1", dateUsed: "2026-09-01" });
const SEP20 = makeLog({
  id: "sep20",
  dateUsed: "2026-09-20",
  serviceAddress: "7 Oak Ave",
  jobberJobNumber: "J-9",
  isTermite: true,
  products: [makeApplied(), makeApplied({ lineId: "d", name: "Glue board", epaRegNo: null, method: "device", deviceCount: "3" })],
  termite: { ...makeLog().termite, areaTreatedSqFt: "1200", physicalBarrierMeasurement: "40 ft", diagramNote: "north wall" },
});
const LOGS = [AUG, SEP1, SEP20];
const RECENT_BACKUP = "2026-09-25T15:00:00.000Z";

type Opts = {
  logs?: ApplicationLog[];
  catalog?: ShopProduct[];
  settings?: ShopSettings;
  lastBackupAt?: string | null;
  removeOk?: boolean;
};

function setup(opts: Opts = {}) {
  const user = userEvent.setup();
  const onRemoveExamples = vi.fn(() => opts.removeOk ?? true);
  const onGo = vi.fn();
  const props = {
    logs: opts.logs ?? LOGS,
    catalog: opts.catalog ?? [TALSTAR],
    settings: opts.settings ?? SETTINGS,
    lastBackupAt: opts.lastBackupAt === undefined ? RECENT_BACKUP : opts.lastBackupAt,
    onRemoveExamples,
    onGo,
  };
  const utils = render(<Export {...props} />);
  return { user, onRemoveExamples, onGo, props, ...utils };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  shop.hint = null;
  shop.shopId = "SHOP-1";
  shop.pull = null;
  resolveExportSections.mockClear();
  downloadCsv.mockReset();
  downloadPdf.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const csvBtn = () => screen.getByRole("button", { name: /Download Texas TDA CSV|Preparing…/ });
const pdfBtn = () => screen.getAllByRole("button", { name: /Download PDF|Preparing…/ }).at(-1)!;
const fromInput = () => screen.getByLabelText("From") as HTMLInputElement;
const toInput = () => screen.getByLabelText("To") as HTMLInputElement;
const setDate = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });
const preview = () => screen.getByLabelText("Export preview");
const previewItems = () => Array.from(preview().querySelectorAll("li")).map((l) => l.textContent);
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);
const countLine = () => screen.getByText((_, el) => el?.tagName === "P" && /^\d+ logs? (in range|on this device)/.test(el.textContent ?? ""));
const printedCards = () => Array.from(document.querySelectorAll<HTMLElement>(".print-logs article"));

function sharedPullOf(sections: Partial<ShopSections>, kind: "shared" | "shared-fallback-local" = "shared") {
  shop.pull = async (local) => {
    const merged = { ...local, ...sections };
    return kind === "shared"
      ? { kind, sections: merged, shopId: "SHOP-1" }
      : { kind, sections: merged, shopId: "SHOP-1", error: "network down." };
  };
}

// ---------------------------------------------------------------------------
// Chrome: disclaimer, backup label / nag
// ---------------------------------------------------------------------------

describe("Export: chrome", () => {
  it("shows the heading, disclaimer, retention note and last backup label", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Office export" })).toBeInTheDocument();
    expect(screen.getByText(LAWGICAL_DISCLAIMER)).toBeInTheDocument();
    expect(screen.getByText("Records are kept 2 years. This app does not enforce retention.")).toBeInTheDocument();
    expect(screen.getByText(/^Last backup: (?!never|unknown)/)).toHaveAttribute("role", "status");
    expect(screen.queryByText(/Use Settings → Download backup JSON/)).toBeNull();
  });

  it("never-backed-up shows 'never' and the soft nag", () => {
    setup({ lastBackupAt: null });
    expect(screen.getByText("Last backup: never")).toBeInTheDocument();
    expect(screen.getByText(/No backup on this device yet.*Use Settings → Download backup JSON\./)).toHaveClass("nag");
  });

  it("a stale (>7 days) backup nags; an invalid stamp says 'unknown'", () => {
    const { unmount } = setup({ lastBackupAt: "2026-09-01T12:00:00.000Z" });
    expect(screen.getByText(/more than 7 days ago/)).toBeInTheDocument();
    unmount();
    setup({ lastBackupAt: "not-a-date" });
    expect(screen.getByText("Last backup: unknown")).toBeInTheDocument();
    expect(screen.getByText(/Backup stamp looks invalid/)).toBeInTheDocument();
  });

  it("local-only mode shows no shared-pull note", () => {
    setup();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the trimmed shop name and the log count", () => {
    setup();
    expect(screen.getAllByText("Acme Pest").length).toBeGreaterThan(0);
    expect(countLine()).toHaveTextContent("3 logs on this device.");
  });
});

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

describe("Export: date range", () => {
  it("From/To narrow the count, preview and printed set; total shown when narrowed", () => {
    setup();
    setDate(fromInput(), "2026-09-01");
    expect(countLine()).toHaveTextContent("2 logs in range (3 total on device).");
    expect(previewItems()).toEqual(["Source: This device's local copy", "Date range (date used): From 2026-09-01", "Records: 2"]);
    expect(printedCards()).toHaveLength(2);
    setDate(toInput(), "2026-09-10");
    expect(countLine()).toHaveTextContent("1 log in range (3 total on device).");
    expect(previewItems()[1]).toBe("Date range (date used): 2026-09-01 to 2026-09-10");
  });

  it("links the inputs with min/max so the picker discourages an inverted range", () => {
    setup();
    setDate(fromInput(), "2026-09-01");
    setDate(toInput(), "2026-09-30");
    expect(toInput()).toHaveAttribute("min", "2026-09-01");
    expect(fromInput()).toHaveAttribute("max", "2026-09-30");
  });

  it("an inverted range shows the alert and disables both downloads", () => {
    setup();
    setDate(toInput(), "2026-09-01");
    setDate(fromInput(), "2026-09-20");
    expect(alerts()).toContain("“From” is after “To”, so no logs can match. Fix the date range to export.");
    expect(csvBtn()).toBeDisabled();
    expect(pdfBtn()).toBeDisabled();
  });

  it("an in-range count that equals the total omits the '(N total)' note", () => {
    setup();
    setDate(fromInput(), "2026-01-01");
    expect(countLine()).toHaveTextContent(/^3 logs in range\.$/);
  });

  it("This month fills Sep 1–30 (device-local) and Clear dates resets", async () => {
    const { user } = setup();
    const clear = screen.getByRole("button", { name: "Clear dates" });
    expect(clear).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "This month" }));
    expect([fromInput().value, toInput().value]).toEqual(["2026-09-01", "2026-09-30"]);
    expect(countLine()).toHaveTextContent("2 logs in range (3 total on device).");
    await user.click(clear);
    expect([fromInput().value, toInput().value]).toEqual(["", ""]);
    expect(clear).toBeDisabled();
  });

  it("an empty range disables downloads (local mode)", () => {
    setup();
    setDate(fromInput(), "2027-01-01");
    expect(countLine()).toHaveTextContent("0 logs in range (3 total on device).");
    expect(csvBtn()).toBeDisabled();
    expect(pdfBtn()).toBeDisabled();
  });

  it("no logs at all: downloads disabled, count 0", () => {
    setup({ logs: [] });
    expect(countLine()).toHaveTextContent("0 logs on this device.");
    expect(csvBtn()).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Gates (local mode)
// ---------------------------------------------------------------------------

describe("Export: example-seed gate (local)", () => {
  it("example products on the catalog block export and offer removal", async () => {
    const { user, onRemoveExamples } = setup({ catalog: [TALSTAR, EXAMPLE_PRODUCT] });
    const gate = screen.getByText("Example seeds still present — CSV/PDF export disabled").closest("div")!;
    expect(gate).toHaveTextContent("1 example product on the shop catalog");
    expect(csvBtn()).toBeDisabled();
    expect(pdfBtn()).toBeDisabled();
    await user.click(within(gate).getByRole("button", { name: "Remove example products from catalog" }));
    expect(onRemoveExamples).toHaveBeenCalledTimes(1);
    expect(within(gate).getByText(/^Example products removed from the catalog\./)).toBeInTheDocument();
  });

  it("a failed removal says so", async () => {
    const { user } = setup({ catalog: [EXAMPLE_PRODUCT], removeOk: false });
    await user.click(screen.getByRole("button", { name: "Remove example products from catalog" }));
    expect(screen.getByText("Could not remove example products from the catalog on this device.")).toBeInTheDocument();
  });

  it("the removal message survives the gate clearing (catalog prop updates)", async () => {
    const { user, rerender, props } = setup({ catalog: [TALSTAR, EXAMPLE_PRODUCT] });
    await user.click(screen.getByRole("button", { name: "Remove example products from catalog" }));
    rerender(<Export {...props} catalog={[TALSTAR]} />);
    expect(screen.queryByText(/Example seeds still present/)).toBeNull();
    expect(screen.getByText(/^Example products removed from the catalog\./)).toBeInTheDocument();
    expect(csvBtn()).toBeEnabled();
  });

  it("saved logs with example products link to History (plural copy) and hide the remove button", async () => {
    const exLog = (id: string) =>
      makeLog({ id, sampleData: true, products: [makeApplied({ name: "Example RTU", epaRegNo: null, isExample: true })] });
    const { user, onGo } = setup({ logs: [SEP1, exLog("e1"), exLog("e2")] });
    const gate = screen.getByText(/Example seeds still present/).closest("div")!;
    expect(gate).toHaveTextContent("2 saved logs still reference example products");
    expect(within(gate).queryByRole("button", { name: /Remove example products/ })).toBeNull();
    await user.click(within(gate).getByRole("button", { name: "History" }));
    expect(onGo).toHaveBeenCalledWith("history");
  });
});

describe("Export: § 7.144 completeness gate (local)", () => {
  it("lists incomplete logs in range with field labels and disables export", async () => {
    const bad = makeLog({ id: "bad", dateUsed: "2026-09-05", serviceAddress: "5 Elm", targetPestOrPurpose: "", shopTpclNumber: " " });
    const { user, onGo } = setup({ logs: [SEP1, bad] });
    const gate = screen.getByText("Incomplete records in range — CSV/PDF export disabled").closest("div")!;
    expect(within(gate).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      "2026-09-05 · 5 Elm: Target pest or purpose; Shop TPCL number",
    ]);
    expect(gate).not.toHaveTextContent("termite § 7.144(b)");
    expect(csvBtn()).toBeDisabled();
    await user.click(within(gate).getByRole("button", { name: "Open History" }));
    expect(onGo).toHaveBeenCalledWith("history");
  });

  it("mentions termite (b) extras when a termite field is missing", () => {
    const bad = makeLog({ id: "t", isTermite: true }); // non-bait, no area
    setup({ logs: [bad] });
    expect(screen.getByText(/plus termite § 7\.144\(b\) extras when that flag is on/)).toBeInTheDocument();
  });

  it("only checks logs in the selected range", () => {
    const bad = makeLog({ id: "bad", dateUsed: "2026-08-02", customerBillingName: "" });
    setup({ logs: [SEP1, bad] });
    expect(csvBtn()).toBeDisabled();
    setDate(fromInput(), "2026-09-01");
    expect(screen.queryByText(/Incomplete records in range/)).toBeNull();
    expect(csvBtn()).toBeEnabled();
  });

  it("caps the list at 8 with an '…and N more' line", () => {
    const bads = Array.from({ length: 10 }, (_, i) => makeLog({ id: `b${i}`, customerBillingName: "" }));
    setup({ logs: bads });
    const gate = screen.getByText(/Incomplete records in range/).closest("div")!;
    const items = within(gate).getAllByRole("listitem");
    expect(items).toHaveLength(9);
    expect(items.at(-1)).toHaveTextContent("…and 2 more incomplete log(s)");
  });
});

// ---------------------------------------------------------------------------
// Downloads (local)
// ---------------------------------------------------------------------------

describe("Export: CSV / PDF download (local)", () => {
  it("CSV downloads the filtered logs with the trimmed shop name and local provenance", async () => {
    const { user } = setup();
    setDate(fromInput(), "2026-09-01");
    await user.click(csvBtn());
    expect(resolveExportSections).toHaveBeenCalledWith({ logs: LOGS, catalog: [TALSTAR], people: [], settings: SETTINGS });
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [logs, name, prov] = downloadCsv.mock.calls[0];
    expect((logs as ApplicationLog[]).map((l) => l.id)).toEqual(["sep1", "sep20"]);
    expect(name).toBe("Acme Pest");
    expect(prov).toMatchObject({
      source: "local",
      shopId: null,
      dateFrom: "2026-09-01",
      dateTo: null,
      rangeLabel: "From 2026-09-01",
      recordCount: 2,
      generatedAt: "2026-09-26T10:00:00-05:00",
    });
    expect(screen.getByText(/^Last export — Source: this device's local copy · Range: From 2026-09-01 · 2 records/)).toBeInTheDocument();
  });

  it("a blank shop name is passed as undefined", async () => {
    const { user } = setup({ settings: { ...SETTINGS, shopName: "   " } });
    await user.click(csvBtn());
    expect(downloadCsv.mock.calls[0][1]).toBeUndefined();
  });

  it("PDF lazy-loads the exporter and downloads with the same payload", async () => {
    const { user } = setup();
    await user.click(pdfBtn());
    await vi.waitFor(() => expect(downloadPdf).toHaveBeenCalledTimes(1));
    const [logs, name, prov] = downloadPdf.mock.calls[0];
    expect((logs as ApplicationLog[]).map((l) => l.id)).toEqual(["aug", "sep1", "sep20"]);
    expect(name).toBe("Acme Pest");
    expect(prov).toMatchObject({ source: "local", rangeLabel: "All dates", recordCount: 3 });
    expect(downloadCsv).not.toHaveBeenCalled();
  });

  it("a PDF exporter failure shows the fallback alert and logs the error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    downloadPdf.mockImplementation(() => {
      throw new Error("jsPDF boom");
    });
    const { user } = setup();
    await user.click(pdfBtn());
    expect(await screen.findByText(/^Could not load the PDF exporter\./)).toHaveAttribute("role", "alert");
    expect(err).toHaveBeenCalled();
    expect(screen.queryByText(/^Last export —/)).toBeNull();
    // cleared on the next attempt
    downloadPdf.mockReset();
    await user.click(pdfBtn());
    await vi.waitFor(() => expect(screen.queryByText(/Could not load the PDF exporter/)).toBeNull());
  });

  it("buttons show 'Preparing…' and date controls lock while the pull is in flight", async () => {
    let release!: () => void;
    shop.pull = (s) => new Promise((res) => (release = () => res({ kind: "local", sections: s })));
    const { user } = setup();
    await user.click(csvBtn());
    expect(screen.getAllByRole("button", { name: "Preparing…" })).toHaveLength(2);
    expect(fromInput()).toBeDisabled();
    expect(toInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "This month" })).toBeDisabled();
    await act(async () => release());
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    expect(csvBtn()).toHaveTextContent("Download Texas TDA CSV");
    expect(fromInput()).toBeEnabled();
  });

  it("Print this page calls window.print", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Print this page" }));
    expect(print).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Shared shop
// ---------------------------------------------------------------------------

describe("Export: shared shop", () => {
  beforeEach(() => {
    shop.hint = SHARED_HINT;
  });

  it("shows the shared-pull note and a shared preview with the shop id", () => {
    setup();
    expect(screen.getByText(SHARED_HINT)).toHaveAttribute("role", "note");
    expect(previewItems()).toEqual([
      "Source: Shared shop snapshot",
      "Shop ID: SHOP-1",
      "Date range (date used): All dates",
      "Records: 3 on this device — final count from the shared snapshot",
    ]);
  });

  it("does not disable on local gates; notes they run on the snapshot instead", () => {
    setup({ catalog: [EXAMPLE_PRODUCT], logs: [makeLog({ customerBillingName: "" })] });
    expect(screen.queryByText(/Example seeds still present/)).toBeNull();
    expect(screen.queryByText(/Incomplete records in range/)).toBeNull();
    expect(screen.getByText(/checks run on the shared shop snapshot at download time/)).toBeInTheDocument();
    expect(csvBtn()).toBeEnabled();
  });

  it("stays enabled with zero local logs (the snapshot may have some)", async () => {
    sharedPullOf({ logs: [SEP1] });
    const { user } = setup({ logs: [] });
    expect(csvBtn()).toBeEnabled();
    await user.click(csvBtn());
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    expect(downloadCsv.mock.calls[0][0]).toEqual([SEP1]);
    expect(downloadCsv.mock.calls[0][2]).toMatchObject({ source: "shared", shopId: "SHOP-1", recordCount: 1 });
  });

  it("uses the pulled snapshot's shop name and range-filters the pulled logs", async () => {
    sharedPullOf({ logs: [AUG, SEP20], settings: { ...SETTINGS, shopName: " Cloud Pest " } });
    const { user } = setup();
    setDate(fromInput(), "2026-09-01");
    await user.click(csvBtn());
    const [logs, name] = downloadCsv.mock.calls[0];
    expect((logs as ApplicationLog[]).map((l) => l.id)).toEqual(["sep20"]);
    expect(name).toBe("Cloud Pest");
  });

  it("an empty pulled range says 'No logs in range to export.' and does not download", async () => {
    sharedPullOf({ logs: [] });
    const { user } = setup();
    await user.click(csvBtn());
    expect(alerts()).toContain("No logs in range to export.");
    expect(downloadCsv).not.toHaveBeenCalled();
  });

  it("re-checks gates on the pulled snapshot and blocks with a combined message", async () => {
    sharedPullOf({ catalog: [EXAMPLE_PRODUCT], logs: [makeLog({ customerBillingName: "" }), makeLog({ id: "x", targetPestOrPurpose: "" })] });
    const { user } = setup();
    await user.click(pdfBtn());
    expect(
      await screen.findByText(
        "Export blocked after shared shop pull: example seeds still present on the export set; 2 incomplete § 7.144 record(s) in range. Clear gates, then try again.",
      ),
    ).toHaveAttribute("role", "alert");
    expect(downloadPdf).not.toHaveBeenCalled();
  });

  it("a canceled pull shows its error and downloads nothing", async () => {
    shop.pull = async () => ({ kind: "canceled", error: "Shop session changed during the shared pull — export canceled." });
    const { user } = setup();
    await user.click(csvBtn());
    expect(alerts()).toContain("Shop session changed during the shared pull — export canceled.");
    expect(downloadCsv).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Last export —/)).toBeNull();
  });

  it("a failed pull falls back to local data with a warning and fallback provenance", async () => {
    sharedPullOf({}, "shared-fallback-local");
    const { user } = setup();
    await user.click(csvBtn());
    expect(alerts()).toContain(
      "Shared shop pull failed (SHOP-1): network down. Using this device's local data instead — it may not match the full shop.",
    );
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    expect(downloadCsv.mock.calls[0][2]).toMatchObject({ source: "shared-fallback-local", shopId: "SHOP-1", recordCount: 3 });
    expect(screen.getByText(/^Last export — Source: local copy \(shared pull failed\) · shop SHOP-1/)).toBeInTheDocument();
  });

  it("gate messages after a local-fallback pull say 'preparing export'", async () => {
    shop.pull = async (local) => ({
      kind: "shared-fallback-local",
      sections: { ...local, logs: [makeLog({ customerBillingName: "" })] },
      shopId: "SHOP-1",
      error: "offline.",
    });
    const { user } = setup();
    await user.click(csvBtn());
    expect(alerts()).toContain(
      "Export blocked after preparing export: 1 incomplete § 7.144 record(s) in range. Clear gates, then try again.",
    );
  });

  it("an inverted range still blocks in shared mode (no pull attempted)", () => {
    setup();
    setDate(toInput(), "2026-09-01");
    setDate(fromInput(), "2026-09-02");
    expect(csvBtn()).toBeDisabled();
    expect(resolveExportSections).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Printable list
// ---------------------------------------------------------------------------

describe("Export: printable log list", () => {
  it("prints shop + TPCL header and per-log details (products, termite, Jobber #)", () => {
    setup();
    expect(document.querySelector(".print-logs > p")).toHaveTextContent("Acme Pest · TPCL 12345B");
    const oak = printedCards().find((c) => c.textContent?.includes("7 Oak Ave"))!;
    expect(oak.querySelector("strong")).toHaveTextContent("2026-09-20 — 7 Oak Ave termite");
    expect(oak).toHaveTextContent("Billing: Pat Customer, 1 Billing Rd");
    expect(oak).toHaveTextContent("Target: Ants");
    expect(oak).toHaveTextContent("TPCL 12345B · applying Alice Applicator");
    expect(oak).toHaveTextContent("Jobber #J-9 (not TDA)");
    expect(within(oak).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      "Talstar P EPA 279-3206",
      "Glue board device × 3",
    ]);
    expect(oak).toHaveTextContent("Termite: area 1200 sq ft · barrier 40 ft · diagram note: north wall");
  });

  it("prints bait and commercial-pretreat termite details, and example captions on devices", () => {
    const bait = makeLog({
      id: "bait",
      isTermite: true,
      sampleData: true,
      products: [makeApplied({ name: "Example trap", epaRegNo: null, isExample: true, method: "device", deviceCount: "2" })],
      termite: { ...makeLog().termite, isBait: true, isCommercialPretreat: true, tankCount: "2", startTime: "08:00" },
    });
    setup({ logs: [bait] });
    const c = printedCards()[0];
    expect(c.querySelector("strong")).toHaveTextContent("example items");
    expect(c).toHaveTextContent("Example trap device × 2 · example / not a real EPA number");
    expect(c).toHaveTextContent("Termite: bait — area N/A · pretreat tanks 2 / — gal 08:00–—");
  });

  it("omits the TPCL suffix when no shop TPCL number is set", () => {
    setup({ settings: { shopName: "Acme Pest", shopTpclNumber: "", shopTpclLetter: "" } });
    expect(document.querySelector(".print-logs > p")).toHaveTextContent(/^Acme Pest$/);
  });
});
