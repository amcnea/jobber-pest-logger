// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogOutboxEntry } from "../shop/logOutbox";
import type { RemoteShopStore } from "../shop/RemoteShopStore";
import { makeLog } from "../test/fixtures";
import type { Person } from "../types";

// Scope: SyncConflicts UI wiring only; resolution logic is covered in shop/conflicts.test.ts.
const takeShopCopy = vi.fn();
const keepDeviceCopy = vi.fn();
let conflicts: LogOutboxEntry[] = [];

vi.mock("../shop/conflicts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shop/conflicts")>();
  return {
    SET_ASIDE_CONFIRM: actual.SET_ASIDE_CONFIRM,
    REUPLOAD_DONE_MSG: actual.REUPLOAD_DONE_MSG,
    listSyncConflicts: () => conflicts,
    takeShopCopy: (...args: unknown[]) => takeShopCopy(...args),
    keepDeviceCopy: (...args: unknown[]) => keepDeviceCopy(...args),
  };
});

const { SyncConflicts } = await import("./SyncConflicts");

const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const remote = {} as RemoteShopStore;
const BANNED =
  /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;
const entry: LogOutboxEntry = {
  shopId: "SHOP1",
  queuedAt: "2026-10-17T23:00:00.000Z",
  entryId: "e1",
  log: makeLog({ id: "L1", dateUsed: "2026-10-01", serviceAddress: "200 Oak Ave" }),
  lastError: "x",
};

beforeEach(() => {
  conflicts = [entry];
  takeShopCopy.mockReset().mockResolvedValue({ ok: true, logs: [], log: entry.log });
  keepDeviceCopy.mockReset().mockResolvedValue({ ok: true, logs: [], log: entry.log });
});
afterEach(() => vi.restoreAllMocks());

function renderIt() {
  const onResolved = vi.fn();
  const utils = render(
    <SyncConflicts shopId="SHOP1" remote={remote} people={PEOPLE} refreshKey={0} onResolved={onResolved} />,
  );
  return { ...utils, onResolved };
}

describe("SyncConflicts", () => {
  it("renders nothing without conflicts", () => {
    conflicts = [];
    const { container } = renderIt();
    expect(container).toBeEmptyDOMElement();
  });

  it("Take shop copy asks the exact confirm text and needs a person", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onResolved, container } = renderIt();
    const row = screen.getByLabelText("Conflict L1");
    expect(within(row).getByText("2026-10-01 · 200 Oak Ave")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Take shop copy" }));
    const go = within(row).getByRole("button", { name: "Take shop copy" });
    expect(go).toBeDisabled();
    await userEvent.selectOptions(within(row).getByLabelText("Set aside by"), "p-ana");
    await userEvent.click(go);
    expect(confirmSpy).toHaveBeenCalledWith(
      "This device's version will be set aside, not uploaded. It stays in the backup.",
    );
    expect(takeShopCopy).toHaveBeenCalledWith(remote, "SHOP1", entry, { setAsideBy: "p-ana", people: PEOPLE });
    expect(onResolved).toHaveBeenCalled();
    expect(container.textContent ?? "").not.toMatch(BANNED);
  });

  it("declining the confirm does nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Take shop copy" }));
    await userEvent.selectOptions(screen.getByLabelText("Set aside by"), "p-ana");
    await userEvent.click(screen.getByRole("button", { name: "Take shop copy" }));
    expect(takeShopCopy).not.toHaveBeenCalled();
  });

  it("Keep this device's copy needs Changed by and a Reason, then saves as a correction", async () => {
    const { container } = renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Keep this device's copy" }));
    expect(
      screen.getByText(
        "Uploads this device's copy to the shop. If the shop still has this log, it's saved as a correction with change history.",
      ),
    ).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save as a correction" });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Changed by"), "p-ana");
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "Tech logged fleas");
    await userEvent.click(save);
    expect(keepDeviceCopy).toHaveBeenCalledWith(remote, "SHOP1", entry, {
      changedBy: "p-ana",
      reason: "Tech logged fleas",
      people: PEOPLE,
    });
    expect(container.textContent ?? "").not.toMatch(BANNED);
  });

  it("shows the error when a resolution fails", async () => {
    keepDeviceCopy.mockResolvedValue({ ok: false, error: "No fields changed." });
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Keep this device's copy" }));
    await userEvent.selectOptions(screen.getByLabelText("Changed by"), "p-ana");
    await userEvent.type(screen.getByLabelText("Reason"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save as a correction" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No fields changed.");
  });
});

describe("SyncConflicts — partial failure (#170)", () => {
  it("passes the saved logs to App with the error, and shows the error", async () => {
    const saved = [{ ...entry.log, revision: 3 }];
    keepDeviceCopy.mockResolvedValue({ ok: false, error: "offline", logs: saved, log: saved[0] });
    const { onResolved } = renderIt();
    const row = screen.getByLabelText("Conflict L1");
    await userEvent.click(within(row).getByRole("button", { name: "Keep this device's copy" }));
    await userEvent.selectOptions(within(row).getByLabelText("Changed by"), "p-ana");
    await userEvent.type(within(row).getByLabelText("Reason"), "Keep tech copy");
    await userEvent.click(within(row).getByRole("button", { name: "Save as a correction" }));
    expect(onResolved).toHaveBeenCalledWith(saved, "offline");
    expect(within(row).getByRole("alert")).toHaveTextContent("offline");
  });

  it("a failure before any save does not touch App state", async () => {
    keepDeviceCopy.mockResolvedValue({ ok: false, error: "Enter a reason for the change." });
    const { onResolved } = renderIt();
    const row = screen.getByLabelText("Conflict L1");
    await userEvent.click(within(row).getByRole("button", { name: "Keep this device's copy" }));
    await userEvent.selectOptions(within(row).getByLabelText("Changed by"), "p-ana");
    await userEvent.type(within(row).getByLabelText("Reason"), "x");
    await userEvent.click(within(row).getByRole("button", { name: "Save as a correction" }));
    expect(onResolved).not.toHaveBeenCalled();
  });
});

describe("SyncConflicts — shop no longer had the log (#175)", () => {
  it("after saving, shows the re-upload message", async () => {
    keepDeviceCopy.mockImplementation(async () => {
      conflicts = [];
      return { ok: true, logs: [entry.log], log: entry.log, reuploaded: true };
    });
    const { onResolved, rerender } = renderIt();
    const row = screen.getByLabelText("Conflict L1");
    await userEvent.click(within(row).getByRole("button", { name: "Keep this device's copy" }));
    await userEvent.selectOptions(within(row).getByLabelText("Changed by"), "p-ana");
    await userEvent.type(within(row).getByLabelText("Reason"), "Shop lost it");
    await userEvent.click(within(row).getByRole("button", { name: "Save as a correction" }));
    expect(onResolved).toHaveBeenCalledWith([entry.log]);
    rerender(<SyncConflicts shopId="SHOP1" remote={remote} people={PEOPLE} refreshKey={1} onResolved={onResolved} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "The shop no longer had this log, so this device's copy was uploaded as is. Re-upload recorded.",
    );
    expect(status.textContent ?? "").not.toMatch(BANNED);
  });

  it("a correction on the shop copy shows no re-upload message", async () => {
    renderIt();
    const row = screen.getByLabelText("Conflict L1");
    await userEvent.click(within(row).getByRole("button", { name: "Keep this device's copy" }));
    await userEvent.selectOptions(within(row).getByLabelText("Changed by"), "p-ana");
    await userEvent.type(within(row).getByLabelText("Reason"), "x");
    await userEvent.click(within(row).getByRole("button", { name: "Save as a correction" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
