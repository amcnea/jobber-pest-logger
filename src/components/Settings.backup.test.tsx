// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportPullResult } from "../shop/exportPull";
import type { ShopSections } from "../storage";
import { makeLog, makeShopProduct } from "../test/fixtures";
import type { Person, ShopSettings } from "../types";

// Scope: the Settings "Backup & restore" section a pilot shop uses for its premises copy:
// download (local, shared snapshot, shared-pull fallback, canceled pull), restore from file
// (round trip, bad JSON, rejected backup, cancel, locked session), and the quarantine notice.
// storage.ts runs for real against jsdom localStorage so the round trip is end to end.
// ../shop is replaced with local-only fakes (Binder's shared-shop code has its own tests);
// ShopSessionGate is stubbed out. URL.createObjectURL captures the downloaded Blob.

const shop = vi.hoisted(() => ({
  pull: null as null | ((s: ShopSections) => Promise<ExportPullResult>),
  hint: null as string | null,
  locked: false,
}));
const resolveExportSections = vi.fn(async (s: ShopSections): Promise<ExportPullResult> =>
  shop.pull ? shop.pull(s) : { kind: "local", sections: s },
);

vi.mock("../shop", () => ({
  canAccessOffice: () => true,
  changeShopPins: vi.fn(),
  createShop: vi.fn(),
  formatDurationMs: () => "8 hours",
  hasJoinedShop: () => false,
  isFirebaseConfigured: () => false,
  isSessionAuthenticated: () => false,
  joinShop: vi.fn(),
  leaveShop: vi.fn(),
  loadShopSession: () => ({ shopId: "", role: "tech" }),
  needsShopUnlock: () => shop.locked,
  resolveExportSections: (s: ShopSections) => resolveExportSections(s),
  SESSION_IDLE_MS: 8 * 3_600_000,
  SESSION_TTL_MS: 14 * 86_400_000,
  sessionRole: () => null,
  sharedExportPullHint: () => shop.hint,
  shopStoreStatusHint: () => "Local only.",
  signOutShop: vi.fn(),
}));
vi.mock("./ShopSessionGate", () => ({ ShopSessionGate: () => null }));

const storage = await import("../storage");
const { Settings } = await import("./Settings");

vi.setConfig({ testTimeout: 15_000 });

const NOW = new Date("2026-10-17T19:00:00.000Z"); // Sat Oct 17 2026, 2:00 PM CDT
const SETTINGS: ShopSettings = { shopName: "Acme Pest", shopTpclNumber: "12345", shopTpclLetter: "B" };
const ALICE: Person = {
  id: "alice",
  name: "Alice Applicator",
  licenseNumber: "TX-111",
  roleTags: ["applying"],
  licenseExpiry: "2027-06-30",
  ceDueDate: "",
};
const LOG_A = makeLog({ id: "log-a", dateUsed: "2026-10-01" });
const LOG_B = makeLog({ id: "log-b", dateUsed: "2026-10-02", serviceAddress: "7 Oak Ave" });
const TALSTAR = makeShopProduct();

let blobs: Blob[];

function seedDevice() {
  expect(storage.saveLogs([LOG_A, LOG_B])).toBe(true);
  expect(storage.saveCatalog([TALSTAR])).toBe(true);
  expect(storage.savePeople([ALICE])).toBe(true);
  expect(storage.saveSettings(SETTINGS)).toBe(true);
}

function setup(settings: ShopSettings = SETTINGS) {
  const user = userEvent.setup();
  const onRestored = vi.fn();
  const onBackupStampChange = vi.fn();
  const utils = render(
    <Settings
      settings={settings}
      lastBackupAt={null}
      onSave={() => true}
      onRestored={onRestored}
      onBackupStampChange={onBackupStampChange}
      onClearExamples={() => ({ ok: true, summary: "" })}
      onWipeAll={() => ({ ok: true, summary: "" })}
    />,
  );
  return { user, onRestored, onBackupStampChange, ...utils };
}

const downloadBtn = () => screen.getByRole("button", { name: /^(Download backup JSON|Preparing…)$/ });
const fileInput = () => screen.getByLabelText("Restore backup JSON file") as HTMLInputElement;

async function lastBackupJson(): Promise<Record<string, unknown>> {
  expect(blobs.length).toBeGreaterThan(0);
  return JSON.parse(await blobs.at(-1)!.text()) as Record<string, unknown>;
}

async function restoreText(text: string, name = "backup.json") {
  const file = new File([text], name, { type: "application/json" });
  await act(async () => {
    fireEvent.change(fileInput(), { target: { files: [file] } });
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  shop.pull = null;
  shop.hint = null;
  shop.locked = false;
  resolveExportSections.mockClear();
  blobs = [];
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      blobs.push(b);
      return `blob:test-${blobs.length}`;
    }),
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

describe("Settings backup: download (local)", () => {
  it("downloads every section with the version stamp and local provenance, then stamps last backup", async () => {
    seedDevice();
    const { user, onBackupStampChange } = setup();
    await user.click(downloadBtn());
    await waitFor(() => expect(screen.getByText("Backup downloaded.")).toBeInTheDocument());
    const json = await lastBackupJson();
    expect(json.version).toBe(storage.BACKUP_VERSION);
    expect((json.logs as { id: string }[]).map((l) => l.id).sort()).toEqual(["log-a", "log-b"]);
    expect(json.catalog).toEqual([TALSTAR]);
    expect(json.people).toEqual([ALICE]);
    expect(json.settings).toEqual(SETTINGS);
    expect(json.quarantine).toEqual({ logs: [], catalog: [], people: [] });
    expect(json.meta).toMatchObject({ source: "local", shopId: null, recordCount: 2, rangeLabel: "All dates (full backup)" });
    expect(onBackupStampChange).toHaveBeenCalledWith(NOW.toISOString());
    expect(storage.loadLastBackupAt()).toBe(NOW.toISOString());
  });

  it("names the file with the local source and generated date", async () => {
    seedDevice();
    const anchors: HTMLAnchorElement[] = [];
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    const { user } = setup();
    await user.click(downloadBtn());
    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(anchors[0]!.download).toBe("jobber-pest-logger-backup-local-generated-2026-10-17.json");
  });
});

describe("Settings backup: download (shared shop)", () => {
  it("downloads the pulled snapshot with shared provenance", async () => {
    seedDevice();
    const remoteLog = makeLog({ id: "remote-1" });
    shop.pull = async (s) => ({ kind: "shared", shopId: "SHOP-1", sections: { ...s, logs: [remoteLog] } });
    const { user } = setup();
    await user.click(downloadBtn());
    await waitFor(() =>
      expect(screen.getByText("Backup downloaded from shared shop snapshot.")).toBeInTheDocument(),
    );
    const json = await lastBackupJson();
    expect((json.logs as { id: string }[]).map((l) => l.id)).toEqual(["remote-1"]);
    expect(json.meta).toMatchObject({ source: "shared", shopId: "SHOP-1", recordCount: 1 });
  });

  it("a failed pull downloads the local copy and shows an alert naming the shop", async () => {
    seedDevice();
    shop.pull = async (s) => ({ kind: "shared-fallback-local", shopId: "SHOP-1", sections: s, error: "offline." });
    const { user, onBackupStampChange } = setup();
    await user.click(downloadBtn());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Shared shop pull failed \(SHOP-1\): offline\./));
    expect(screen.getByText(/Local backup downloaded/)).toBeInTheDocument();
    expect((await lastBackupJson()).meta).toMatchObject({ source: "shared-fallback-local", shopId: "SHOP-1" });
    expect(onBackupStampChange).toHaveBeenCalled();
  });

  it("a canceled pull downloads nothing and does not stamp a backup", async () => {
    seedDevice();
    shop.pull = async () => ({ kind: "canceled", error: "Shop session changed during the shared pull." });
    const { user, onBackupStampChange } = setup();
    await user.click(downloadBtn());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Shop session changed during the shared pull."));
    expect(blobs).toHaveLength(0);
    expect(onBackupStampChange).not.toHaveBeenCalled();
    expect(storage.loadLastBackupAt()).toBeNull();
  });

  it("disables the button and shows Preparing… while the pull is in flight", async () => {
    seedDevice();
    let release!: () => void;
    shop.pull = (s) => new Promise((res) => (release = () => res({ kind: "local", sections: s })));
    const { user } = setup();
    await user.click(downloadBtn());
    expect(downloadBtn()).toHaveTextContent("Preparing…");
    expect(downloadBtn()).toBeDisabled();
    await act(async () => release());
    expect(downloadBtn()).toHaveTextContent("Download backup JSON");
    expect(downloadBtn()).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

describe("Settings backup: restore from file", () => {
  it("round trip: a downloaded backup restores the same data after the device is cleared", async () => {
    seedDevice();
    const first = setup();
    await first.user.click(downloadBtn());
    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0]!.text();
    first.unmount();

    localStorage.clear();
    expect(storage.loadLogs()).toEqual([]);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onRestored } = setup();
    await restoreText(text);
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    const [data, flash] = onRestored.mock.calls[0]!;
    expect((data.logs as { id: string }[]).map((l) => l.id).sort()).toEqual(["log-a", "log-b"]);
    expect(data.catalog).toEqual([TALSTAR]);
    expect(data.people).toEqual([ALICE]);
    expect(data.settings).toEqual(SETTINGS);
    expect(flash).toMatch(/^Restored backup \(v1\.2\) from 2026-10-17T19:00:00\.000Z\./);
    // Device storage now holds the restored rows.
    expect(storage.loadLogs().map((l) => l.id).sort()).toEqual(["log-a", "log-b"]);
    expect(storage.loadCatalog()).toEqual([TALSTAR]);
    expect(storage.loadPeople()).toEqual([ALICE]);
    expect(storage.loadSettings()).toEqual(SETTINGS);
  });

  it("asks before replacing device data and does nothing when cancelled", async () => {
    seedDevice();
    const backup = { ...storage.buildBackup(), logs: [] };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onRestored } = setup();
    await restoreText(JSON.stringify(backup));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).toBe(
      "Restoring replaces this device's logs with the backup, except logs that have change history or a review the backup doesn't, and logs less than 2 years old that the backup doesn't have. Those stay on this device.",
    );
    expect(onRestored).not.toHaveBeenCalled();
    expect(storage.loadLogs()).toHaveLength(2);
  });

  it("rejects a file that is not JSON without asking or changing data", async () => {
    seedDevice();
    const confirm = vi.spyOn(window, "confirm");
    const { onRestored } = setup();
    await restoreText("not json {");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not read that file as JSON."));
    expect(confirm).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
    expect(storage.loadLogs()).toHaveLength(2);
  });

  it("shows the parse error for a JSON file that is not a valid backup", async () => {
    seedDevice();
    const confirm = vi.spyOn(window, "confirm");
    setup();
    await restoreText(JSON.stringify({ version: "0.9", logs: [] }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Unsupported backup version "0\.9"/));
    expect(confirm).not.toHaveBeenCalled();
    expect(storage.loadLogs()).toHaveLength(2);
  });

  it("blocks the restore if the shared session locked while the confirm was open", async () => {
    seedDevice();
    const backup = { ...storage.buildBackup(), logs: [] };
    vi.spyOn(window, "confirm").mockImplementation(() => {
      shop.locked = true; // idle TTL expired during the dialog
      return true;
    });
    const { onRestored } = setup();
    await restoreText(JSON.stringify(backup));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Unlock the shared shop with a PIN before restoring a backup."),
    );
    expect(onRestored).not.toHaveBeenCalled();
    expect(storage.loadLogs()).toHaveLength(2);
  });

  it("clears the file input so the same file can be picked again", async () => {
    seedDevice();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setup();
    await restoreText(JSON.stringify(storage.buildBackup()));
    expect(fileInput().value).toBe("");
  });

  it("the Restore button opens the hidden file picker", async () => {
    const { user } = setup();
    const click = vi.spyOn(fileInput(), "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "Restore from file…" }));
    expect(click).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Quarantine notice and set-aside rows
// ---------------------------------------------------------------------------

describe("Settings backup: quarantine (set-aside rows)", () => {
  const BAD_LOG = { id: "broken", note: "missing required fields" };

  it("shows no quarantine notice on a clean device", () => {
    seedDevice();
    setup();
    expect(screen.queryByText(/couldn't be read/)).toBeNull();
  });

  it("shows the notice when rows are set aside, and the backup carries them", async () => {
    seedDevice();
    localStorage.setItem(storage.LOGS_QUARANTINE_KEY, JSON.stringify([BAD_LOG]));
    const { user } = setup();
    expect(screen.getByText(/^1 saved record couldn't be read \(1 log\) and was set aside/)).toBeInTheDocument();
    await user.click(downloadBtn());
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect((await lastBackupJson()).quarantine).toEqual({ logs: [BAD_LOG], catalog: [], people: [] });
  });

  it("a main-key row that fails to load is moved to quarantine before the backup is written", async () => {
    seedDevice();
    // Corrupt one row in the main logs key (as an older app version or bad sync might).
    const raw = JSON.parse(localStorage.getItem("jobber-pest-logger:logs:v1")!) as unknown[];
    localStorage.setItem("jobber-pest-logger:logs:v1", JSON.stringify([...raw, BAD_LOG]));
    const { user } = setup();
    await user.click(downloadBtn());
    await waitFor(() => expect(blobs).toHaveLength(1));
    const json = await lastBackupJson();
    expect((json.quarantine as { logs: unknown[] }).logs).toContainEqual(BAD_LOG);
    expect((json.logs as { id: string }[]).map((l) => l.id).sort()).toEqual(["log-a", "log-b"]);
  });

  it("restoring a backup with set-aside rows puts them back in quarantine", async () => {
    const backup = { ...storage.buildBackup(), quarantine: { logs: [BAD_LOG], catalog: [], people: [] } };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onRestored } = setup();
    await restoreText(JSON.stringify(backup));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(storage.loadLogsQuarantine()).toEqual([BAD_LOG]);
  });

  it("restoring a clean backup clears quarantine left on the device", async () => {
    localStorage.setItem(storage.LOGS_QUARANTINE_KEY, JSON.stringify([BAD_LOG]));
    seedDevice();
    const clean = { ...storage.buildBackup(), quarantine: { logs: [], catalog: [], people: [] } };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onRestored } = setup();
    await restoreText(JSON.stringify(clean));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(storage.loadLogsQuarantine()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Restore banner (#163)
// ---------------------------------------------------------------------------

describe("Settings restore banner", () => {
  const BANNED =
    /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;
  const REVIEW = { reviewedAt: "2026-10-16T09:00:00-05:00", reviewedBy: "Alice Applicator" };

  async function restoreOver(deviceLogs: ReturnType<typeof makeLog>[]) {
    seedDevice();
    const backup = storage.buildBackup(); // LOG_A + LOG_B, unreviewed
    expect(storage.saveLogs(deviceLogs)).toBe(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onRestored } = setup();
    await restoreText(JSON.stringify(backup));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    return onRestored.mock.calls[0]![1] as string;
  }

  it("restore confirm text avoids banned terms", async () => {
    const { RESTORE_CONFIRM_TEXT } = await import("./Settings");
    expect(RESTORE_CONFIRM_TEXT).not.toMatch(BANNED);
  });

  it("says device data replaced when no device log was kept", async () => {
    const flash = await restoreOver([LOG_A, LOG_B]);
    expect(flash).toBe("Restored backup (v1.2) from 2026-10-17T19:00:00.000Z. Device data replaced.");
  });

  it("names the one log that kept its change history from this device", async () => {
    const flash = await restoreOver([{ ...LOG_A, ...REVIEW }, LOG_B]);
    expect(flash).toBe(
      "Restored backup (v1.2) from 2026-10-17T19:00:00.000Z. Device data replaced, except 1 log that kept its change history from this device.",
    );
    expect(flash).not.toMatch(BANNED);
    expect(storage.loadLogs().find((l) => l.id === "log-a")).toMatchObject(REVIEW);
  });

  it("counts kept logs, including reviewed device logs missing from the backup", async () => {
    const extra = makeLog({ id: "log-c", dateUsed: "2026-10-03", ...REVIEW });
    const flash = await restoreOver([{ ...LOG_A, ...REVIEW }, LOG_B, extra]);
    expect(flash).toBe(
      "Restored backup (v1.2) from 2026-10-17T19:00:00.000Z. Device data replaced, except 2 logs that kept their change history from this device.",
    );
    expect(flash).not.toMatch(BANNED);
  });
});

// ---------------------------------------------------------------------------
// Wipe confirm (#171)
// ---------------------------------------------------------------------------

describe("Settings wipe confirm and set-aside copies", () => {
  const BANNED =
    /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;
  const WIPE =
    "Wipe ALL Jobber Pest Logger data on this device? Logs, real products, people, and settings will be deleted. Example seeds will be re-added. This cannot be undone.";

  function addAside(n: number) {
    for (let i = 0; i < n; i++) {
      const added = storage.addSetAsideCopy(makeLog({ id: `s${i}` }), {
        setAsideBy: "alice",
        people: [ALICE],
        now: NOW,
      });
      expect(added.ok).toBe(true);
    }
  }

  async function firstConfirmText() {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Wipe all data on this device…" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    return confirm.mock.calls[0]![0] as string;
  }

  it("no set-aside copies: the confirm is unchanged", async () => {
    expect(await firstConfirmText()).toBe(WIPE);
  });

  it("one set-aside copy: singular sentence", async () => {
    addAside(1);
    const text = await firstConfirmText();
    expect(text).toBe(
      `${WIPE} This also deletes 1 set-aside copy from sync conflicts. Download the backup JSON first if you need it.`,
    );
    expect(text).not.toMatch(BANNED);
  });

  it("several set-aside copies: count and plural sentence", async () => {
    addAside(3);
    const text = await firstConfirmText();
    expect(text).toBe(
      `${WIPE} This also deletes 3 set-aside copies from sync conflicts. Download the backup JSON first if you need them.`,
    );
    expect(text).not.toMatch(BANNED);
  });

  it("logs under 2 years: warning with the count, before the set-aside sentence", async () => {
    seedDevice(); // LOG_A / LOG_B, applied 2026-10-01 / 02 (NOW is 2026-10-17)
    expect(storage.saveLogs([LOG_A, LOG_B, makeLog({ id: "old", dateUsed: "2020-01-01" })])).toBe(true);
    addAside(1);
    const text = await firstConfirmText();
    expect(text).toBe(
      `${WIPE} 2 logs are less than 2 years old. Texas requires the shop to keep these records for 2 years. Download the backup JSON or export first. This also deletes 1 set-aside copy from sync conflicts. Download the backup JSON first if you need it.`,
    );
    expect(text).not.toMatch(BANNED);
  });

  it("one log under 2 years: singular warning", async () => {
    expect(storage.saveLogs([LOG_A])).toBe(true);
    expect(await firstConfirmText()).toBe(
      `${WIPE} 1 log is less than 2 years old. Texas requires the shop to keep this record for 2 years. Download the backup JSON or export first.`,
    );
  });

  it("wording helpers avoid banned terms", async () => {
    const { wipeSetAsideSentence, WIPE_CONFIRM_TEXT } = await import("./Settings");
    expect(wipeSetAsideSentence(0)).toBe("");
    for (const s of [WIPE_CONFIRM_TEXT, wipeSetAsideSentence(1), wipeSetAsideSentence(2)]) expect(s).not.toMatch(BANNED);
  });
});
