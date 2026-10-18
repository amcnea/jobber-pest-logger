// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCorrection, loadLogs, saveLogs, upsertLog } from "../storage";
import { makeLog, makeShopProduct } from "../test/fixtures";
import type { ApplicationLog, Person, ShopSettings } from "../types";
import { CORRECTION_HINT, NewLogForm } from "./NewLogForm";

// Scope: "Correct this log" — NewLogForm in correction mode wired to the real
// applyCorrection (jsdom localStorage), as App wires it.

vi.setConfig({ testTimeout: 15_000 });

const NOW = new Date(2026, 9, 17, 18, 5); // 6:05 PM CDT
const SETTINGS: ShopSettings = { shopName: "Acme Pest", shopTpclNumber: "12345", shopTpclLetter: "" };
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
  { id: "p-blank", name: "  ", licenseNumber: "", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const BANNED =
  /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;
const REVIEWED = makeLog({
  id: "L1",
  dateUsed: "2026-10-01",
  reviewedAt: "2026-10-16T09:00:00-05:00",
  reviewedBy: "Ana Office",
});

function setup(log: ApplicationLog = REVIEWED) {
  const onSave = vi.fn(() => true);
  const onSubmit = vi.fn((next: ApplicationLog, changedBy: string, reason: string) => {
    const res = applyCorrection(next.id, next, { changedBy, reason, people: PEOPLE });
    return res.ok ? null : res.error;
  });
  const user = userEvent.setup();
  const utils = render(
    <NewLogForm
      catalog={[makeShopProduct()]}
      people={PEOPLE}
      settings={SETTINGS}
      initialDraft={log}
      isEditing
      onSave={onSave}
      correction={{ onSubmit }}
    />,
  );
  return { user, onSave, onSubmit, ...utils };
}

const save = () => screen.getByRole("button", { name: "Save correction" });
const changedBy = () => screen.getByLabelText(/^Changed by/) as HTMLSelectElement;
const reason = () => screen.getByLabelText(/^Reason/);
const serviceAddress = () => screen.getByLabelText(/^Service address/);

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  expect(saveLogs([REVIEWED])).toBe(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("NewLogForm — Correct this log", () => {
  it("shows the correction heading, hint, Changed by / Reason and Save correction", () => {
    const { container } = setup();
    expect(screen.getByRole("heading", { name: "Correct this log" })).toBeInTheDocument();
    expect(screen.getByText(CORRECTION_HINT)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Change history" })).toBeInTheDocument();
    // Only named People are offered.
    expect([...changedBy().options].map((o) => o.textContent)).toEqual(["Choose…", "Ana Office"]);
    expect(save()).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(BANNED);
  });

  it("requires Changed by from People", async () => {
    const { user, onSubmit, onSave } = setup();
    await user.clear(serviceAddress());
    await user.type(serviceAddress(), "101 Main St");
    await user.type(reason(), "Wrong house number");
    await user.click(save());
    expect(screen.getByRole("alert")).toHaveTextContent("Choose who made the change from People.");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(loadLogs()[0]).toEqual(REVIEWED);
  });

  it("requires a non-blank reason", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(changedBy(), "p-ana");
    await user.type(reason(), "   ");
    await user.click(save());
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a reason for the change.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses a save with no field changes", async () => {
    const { user, onSubmit } = setup();
    await user.selectOptions(changedBy(), "p-ana");
    await user.type(reason(), "Checked");
    await user.click(save());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("No fields changed.");
    expect(loadLogs()[0]).toEqual(REVIEWED);
  });

  it("saves a correction: rev +1, local-offset changedAt, roster name, diff, review stamp kept", async () => {
    const { user, onSave } = setup();
    await user.clear(serviceAddress());
    await user.type(serviceAddress(), "101 Main St");
    await user.selectOptions(changedBy(), "p-ana");
    await user.type(reason(), "  Wrong house number ");
    await user.click(save());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onSave).not.toHaveBeenCalled(); // never the plain in-place save
    const [saved] = loadLogs();
    expect(saved.serviceAddress).toBe("101 Main St");
    expect(saved.revision).toBe(1);
    expect(saved).toMatchObject({ reviewedAt: REVIEWED.reviewedAt, reviewedBy: "Ana Office", createdAt: REVIEWED.createdAt });
    expect(saved.history).toHaveLength(1);
    expect(saved.history![0]).toMatchObject({
      revision: 1,
      changedAt: "2026-10-17T18:05:00-05:00",
      changedBy: "Ana Office",
      reason: "Wrong house number",
      changes: [{ field: "serviceAddress", old: "100 Main St", new: "101 Main St" }],
    });
    expect(saved.history![0].priorSnapshot).toMatchObject({ serviceAddress: "100 Main St", reviewedBy: "Ana Office" });
  });

  it("plain edit stays refused for the reviewed log", () => {
    const res = upsertLog({ ...REVIEWED, serviceAddress: "999 Elm" });
    expect(res.locked).toBe(true);
    expect(loadLogs()[0].serviceAddress).toBe("100 Main St");
  });

  it("without correction mode the form is the normal edit form", () => {
    render(
      <NewLogForm catalog={[]} people={PEOPLE} settings={SETTINGS} initialDraft={makeLog()} isEditing onSave={() => true} />,
    );
    expect(screen.getByRole("heading", { name: "Edit application log" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Changed by/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });
});
