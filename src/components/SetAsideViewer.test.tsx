// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAsideDuplicateCopies } from "../shop/dedupeLogs";
import * as storage from "../storage";
import { makeApplied, makeLog, makeShopProduct } from "../test/fixtures";
import type { Person, ShopSettings } from "../types";
import {
  formatSetAsideApplicators,
  formatSetAsideProducts,
  formatSetAsideTimestamp,
  SET_ASIDE_EMPTY_TEXT,
  SET_ASIDE_VIEWER_HEADING,
  SET_ASIDE_VIEWER_HINT,
   setAsideCountText,
  setAsideReasonChip,
  setAsideReasonText,
  SetAsideViewer,
} from "./SetAsideViewer";
import { Settings } from "./Settings";

const BANNED =
  /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;

const NOW = new Date("2026-10-17T19:30:00.000Z"); // 2026-10-17T14:30:00-05:00 in America/Chicago
const SETTINGS: ShopSettings = {
  shopName: "Acme Pest",
  shopTpclNumber: "12345",
  shopTpclLetter: "B",
};
const BEN: Person = {
  id: "p-ben",
  name: "Ben Tech",
  licenseNumber: "TX-222",
  roleTags: ["applying"],
  licenseExpiry: "2027-06-30",
  ceDueDate: "",
};
const ANA: Person = {
  id: "p-ana",
  name: "Ana Office",
  licenseNumber: "TX-333",
  roleTags: ["supervising"],
  licenseExpiry: "2027-06-30",
  ceDueDate: "",
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("SetAsideViewer — Lawgical wording & quarantine distinction (#168)", () => {
  it("keeps all viewer copy free of banned terms and distinct from unreadable quarantine wording", () => {
    const samples = [
      SET_ASIDE_VIEWER_HEADING,
      SET_ASIDE_VIEWER_HINT,
      SET_ASIDE_EMPTY_TEXT,
      setAsideCountText(0),
      setAsideCountText(1),
      setAsideCountText(4),
      setAsideReasonChip({}),
      setAsideReasonChip({ reason: "duplicate-id" }),
      setAsideReasonText({ setAsideBy: "Ben Tech" }),
      setAsideReasonText({ setAsideBy: "", reason: "duplicate-id" }),
    ];
    for (const text of samples) {
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(/couldn't be read/i);
    }
    expect(SET_ASIDE_VIEWER_HINT).toContain("distinct from unreadable storage rows");
    expect(SET_ASIDE_VIEWER_HINT).toContain("not in CSV or PDF exports");
    expect(SET_ASIDE_VIEWER_HINT).toContain("included in the backup JSON");
    expect(SET_ASIDE_VIEWER_HINT).toContain(
      "kept across syncs, example-data resets, and backup restores",
    );
    expect(SET_ASIDE_VIEWER_HINT).toContain(
      "Wipe ALL data deletes them from this device — download the backup JSON first if you need them.",
    );
  });
});

describe("normalizeSetAsideCopy & loadSetAsideCopies (#168 / #211)", () => {
  it("loads both sync-conflict rows (with setAsideBy) and duplicate-id rows (with reason)", () => {
    const syncLog = makeLog({ id: "log-sync", dateUsed: "2026-10-15" });
    const dupLog = makeLog({ id: "log-dup", dateUsed: "2026-10-16" });

    const added = storage.addSetAsideCopy(syncLog, {
      setAsideBy: "p-ben",
      people: [BEN],
      shopId: "SHOP-1",
      now: NOW,
    });
    expect(added.ok).toBe(true);

    setAsideDuplicateCopies(
      "SHOP-1",
      [{ log: dupLog, index: 1, identical: false }],
      new Date("2026-10-17T20:00:00.000Z"),
    );

    const copies = storage.loadSetAsideCopies();
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({
      logId: "log-sync",
      setAsideBy: "Ben Tech",
      shopId: "SHOP-1",
    });
    expect("reason" in copies[0]!).toBe(false);
    expect(copies[1]).toMatchObject({
      logId: "log-dup",
      setAsideBy: "",
      shopId: "SHOP-1",
      reason: "duplicate-id",
    });
  });

  it("still rejects a set-aside row that has neither setAsideBy nor reason", () => {
    const log = makeLog({ id: "log-bad" });
    expect(
      storage.normalizeSetAsideCopy({
        id: "sa-1",
        logId: "log-bad",
        deviceCopy: log,
        setAsideAt: "2026-10-17T14:30:00-05:00",
        setAsideBy: "   ",
        shopId: "SHOP-1",
      }),
    ).toBeNull();
  });
});

describe("SetAsideViewer component (#168)", () => {
  it("renders the empty state when no set-aside copies exist", () => {
    render(<SetAsideViewer />);
    expect(screen.getByRole("heading", { name: SET_ASIDE_VIEWER_HEADING })).toBeInTheDocument();
    expect(screen.getByText(SET_ASIDE_VIEWER_HINT)).toBeInTheDocument();
    expect(screen.getByText(SET_ASIDE_EMPTY_TEXT)).toBeInTheDocument();
  });

  it("renders a sync-conflict set-aside copy with summary fields and expandable details + JSON snapshot", async () => {
    const user = userEvent.setup();
    const baseLog = makeLog({
      id: "log-conflict-1",
      createdAt: "2026-10-14T15:00:00.000Z",
      dateUsed: "2026-10-14",
      customerBillingName: "Hill Country HOA",
      customerBillingAddress: "500 Main St, Austin, TX",
      serviceAddress: "1200 Barton Springs Rd, Austin, TX",
      targetPestOrPurpose: "Fire ants",
      poleLocation: "Pole #42",
      jobberJobNumber: "JB-901",
      shopTpclNumber: "12345",
      shopTpclLetter: "B",
      products: [
        makeApplied({
          lineId: "line-1",
          name: "Talstar P",
          epaRegNo: "279-3206",
          method: "mixed",
          mixedTotal: "2",
          mixedUnit: "gal",
        }),
      ],
      personnel: [{ role: "applying", name: "Ben Tech", licenseNumber: "TX-222" }],
      reviewedAt: "2026-10-15T09:15:00-05:00",
      reviewedBy: "Ana Office",
      revision: 1,
      history: [
        {
          revision: 1,
          priorSnapshot: makeLog({ id: "log-conflict-1" }),
          changedAt: "2026-10-15T10:20:00-05:00",
          changedBy: "Ana Office",
          reason: "Updated gallons from paper sheet",
          changes: [{ field: "products[line-1].mixedTotal", old: "1", new: "2" }],
        },
      ],
      reuploads: [
        {
          reuploadedAt: "2026-10-16T11:00:00-05:00",
          reuploadedBy: "Ana Office",
          reason: "Shop doc was reset",
        },
      ],
    });

    const added = storage.addSetAsideCopy(baseLog, {
      setAsideBy: "p-ben",
      people: [BEN],
      shopId: "SHOP-77",
      now: NOW,
    });
    expect(added.ok).toBe(true);

    const { container } = render(<SetAsideViewer />);
    expect(screen.getByText("1 set-aside device copy on this device.")).toBeInTheDocument();

    const card = screen.getByRole("article", { name: "Set-aside copy log-conflict-1" });
    expect(within(card).getByText("Sync conflict")).toBeInTheDocument();
    expect(within(card).getByText("Rev 1")).toBeInTheDocument();
    expect(within(card).getByText("Reviewed")).toBeInTheDocument();
    expect(within(card).getByText("Corrected (rev 1); Re-uploaded")).toBeInTheDocument();
    expect(
      within(card).getByText("Sync conflict (shop copy kept) · Set aside by Ben Tech"),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Shop: SHOP-77 · Log ID: log-conflict-1/)).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Customer: Hill Country HOA · Service address: 1200 Barton Springs Rd, Austin, TX · Target: Fire ants",
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("Products: Talstar P (EPA 279-3206, 2 gal)"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Applicator: Ben Tech (TX-222)")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Review: Reviewed 2026-10-15 09:15 by Ana Office · Revision: 1 · Saved: 2026-10-14T15:00:00.000Z",
      ),
    ).toBeInTheDocument();

    // Collapsed by default
    expect(within(card).queryByText("Device copy JSON snapshot")).toBeNull();
    const toggleBtn = within(card).getByRole("button", { name: "Show full details" });
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");

    // Expand full details
    await user.click(toggleBtn);
    expect(
      within(card).getByRole("button", { name: "Hide full details" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(card).getByText(
        "Customer billing address: 500 Main St, Austin, TX · Shop TPCL: 12345 B · Pole: Pole #42 · Jobber #JB-901 (not TDA)",
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Change history (1): Rev 1 (2026-10-15 10:20 by Ana Office: Updated gallons from paper sheet)",
      ),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("Re-uploads (1): 2026-10-16 11:00 by Ana Office: Shop doc was reset"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Device copy JSON snapshot")).toBeInTheDocument();
    const pre = card.querySelector("pre.set-aside-json");
    expect(pre?.textContent).toContain(`"id": "log-conflict-1"`);
    expect(pre?.textContent).toContain(`"serviceAddress": "1200 Barton Springs Rd, Austin, TX"`);
    expect(container.textContent ?? "").not.toMatch(BANNED);

    // Collapse again
    await user.click(within(card).getByRole("button", { name: "Hide full details" }));
    expect(within(card).queryByText("Device copy JSON snapshot")).toBeNull();
  });

  it("renders a duplicate-id set-aside copy and orders multiple copies newest first", () => {
    const olderSync = makeLog({
      id: "log-older",
      dateUsed: "2026-10-10",
      serviceAddress: "10 First St",
    });
    const newerDup = makeLog({
      id: "log-dup-99",
      dateUsed: "2026-10-12",
      serviceAddress: "99 Second St",
    });

    storage.addSetAsideCopy(olderSync, {
      setAsideBy: "p-ana",
      people: [ANA],
      shopId: "SHOP-9",
      now: new Date("2026-10-17T18:00:00.000Z"),
    });
    setAsideDuplicateCopies(
      "SHOP-9",
      [{ log: newerDup, index: 1, identical: false }],
      new Date("2026-10-17T21:00:00.000Z"),
    );

    render(<SetAsideViewer />);
    expect(screen.getByText("2 set-aside device copies on this device.")).toBeInTheDocument();

    const articles = screen.getAllByRole("article");
    expect(articles).toHaveLength(2);
    // Newest (log-dup-99) first, older (log-older) second
    expect(articles[0]).toHaveAttribute("aria-label", "Set-aside copy log-dup-99");
    expect(articles[1]).toHaveAttribute("aria-label", "Set-aside copy log-older");

    expect(within(articles[0]!).getByText("Duplicate ID")).toBeInTheDocument();
    expect(within(articles[0]!).getByText("Unreviewed")).toBeInTheDocument();
    expect(
      within(articles[0]!).getByText(
        "Duplicate log ID in shared shop (another copy was kept) · Set aside automatically",
      ),
    ).toBeInTheDocument();
  });

  it("formats device products, 25(b) products, empty products, and blank applicators cleanly", () => {
    const emptyLog = makeLog({
      id: "log-empty-parts",
      products: [],
      personnel: [],
    });
    expect(formatSetAsideProducts(emptyLog)).toBe("No products");
    expect(formatSetAsideApplicators(emptyLog)).toBe("(none)");

    const deviceLog = makeLog({
      id: "log-device",
      products: [
        makeApplied({
          name: "Tin Cat Trap",
          method: "device",
          deviceCount: "6",
          epaRegNo: null,
        }),
        makeApplied({
          name: "EcoVia EC",
          method: "rtu",
          is25b: true,
          epaRegNo: null,
          rtuAmount: "16",
          rtuUnit: "fl oz",
        }),
      ],
      personnel: [{ role: "applying", name: "Solo Tech", licenseNumber: "" }],
    });
    expect(formatSetAsideProducts(deviceLog)).toBe(
      "Tin Cat Trap × 6; EcoVia EC (25(b) · no EPA #, 16 fl oz)",
    );
    expect(formatSetAsideApplicators(deviceLog)).toBe("Solo Tech");
    expect(formatSetAsideTimestamp("2026-10-17T14:30:00-05:00")).toBe(
      "2026-10-17 14:30 (2026-10-17T14:30:00-05:00)",
    );
  });
});

describe("Settings integration — set-aside viewer across restore, demo reset, and wipe (#168)", () => {
  it("updates live when a backup with setAside is restored, stays on demo reset, and clears on wipe", async () => {
    const user = userEvent.setup();
    storage.saveLogs([makeLog({ id: "active-1" })]);
    storage.saveCatalog([makeShopProduct()]);
    storage.savePeople([BEN]);
    storage.saveSettings(SETTINGS);

    // Prepare a backup JSON that contains one set-aside copy
    storage.addSetAsideCopy(
      makeLog({
        id: "aside-from-backup",
        dateUsed: "2026-10-11",
        serviceAddress: "404 Backup Ln",
      }),
      { setAsideBy: "p-ben", people: [BEN], shopId: "SHOP-BK", now: NOW },
    );
    const backupWithAside = storage.buildBackup();
    // Clear set-aside on the device before mounting Settings
    localStorage.removeItem(storage.SET_ASIDE_KEY);

    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <Settings
        settings={SETTINGS}
        lastBackupAt={null}
        onSave={() => true}
        onRestored={() => {}}
        onBackupStampChange={() => {}}
        onClearExamples={() => {
          storage.clearExampleDemoData();
          return { ok: true, summary: "Cleared." };
        }}
        onWipeAll={() => {
          storage.wipeAllDeviceData();
          return { ok: true, summary: "Wiped." };
        }}
      />,
    );

    // Initially empty
    expect(screen.getByText(SET_ASIDE_EMPTY_TEXT)).toBeInTheDocument();

    // Restore backup carrying aside-from-backup
    const input = screen.getByLabelText("Restore backup JSON file") as HTMLInputElement;
    const file = new File([JSON.stringify(backupWithAside)], "backup.json", {
      type: "application/json",
    });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: "Set-aside copy aside-from-backup" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("1 set-aside device copy on this device.")).toBeInTheDocument();

    // Demo reset keeps set-aside copies
    await user.click(screen.getByRole("button", { name: "Clear example / demo data" }));
    expect(
      screen.getByRole("article", { name: "Set-aside copy aside-from-backup" }),
    ).toBeInTheDocument();

    // Wipe ALL data deletes set-aside copies and updates the viewer back to empty
    await user.click(screen.getByRole("button", { name: "Wipe all data on this device…" }));
    expect(screen.getByText(SET_ASIDE_EMPTY_TEXT)).toBeInTheDocument();
    expect(storage.loadSetAsideCopies()).toEqual([]);
  });
});
