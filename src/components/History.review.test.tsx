// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeLog, makeShopProduct } from "../test/fixtures";
import type { ApplicationLog, Person } from "../types";

// Scope: History.tsx lock-on-review controls (correction history 2/4).
// Same storage import-boundary mock as History.test.tsx.
vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { groupLogsByServiceAddress: actual.groupLogsByServiceAddress };
});

const { History } = await import("./History");

const NOW = new Date(2026, 9, 17, 17, 5);
const CATALOG = [makeShopProduct()];
const PEOPLE: Person[] = [
  { id: "p-ana", name: "Ana Office", licenseNumber: "TX-9", roleTags: [], licenseExpiry: "", ceDueDate: "" },
];
const BANNED =
  /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;

function renderHistory(
  logs: ApplicationLog[],
  over: Partial<Parameters<typeof History>[0]> = {},
) {
  const props = {
    logs,
    canEditDelete: true,
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onLogAgainHere: vi.fn(),
    onDuplicateLastStop: vi.fn(),
    catalog: CATALOG,
    people: PEOPLE,
    onMarkReviewed: vi.fn(() => null as string | null),
    now: NOW,
    ...over,
  };
  const utils = render(<History {...props} />);
  return { ...utils, props };
}

function card(text: RegExp | string): HTMLElement {
  return screen.getByText(text).closest("article") as HTMLElement;
}

describe("History — Mark reviewed (office)", () => {
  it("clean log: pick a roster person, then Mark reviewed calls back with log id + person id", async () => {
    const { props } = renderHistory([makeLog({ id: "L1", dateUsed: "2026-10-01" })]);
    const c = card("2026-10-01");
    await userEvent.click(within(c).getByRole("button", { name: "Mark reviewed" }));
    const confirm = within(c).getByRole("button", { name: "Mark reviewed" });
    expect(confirm).toBeDisabled(); // reviewedBy required
    await userEvent.selectOptions(within(c).getByLabelText("Reviewed by"), "p-ana");
    await userEvent.click(confirm);
    expect(props.onMarkReviewed).toHaveBeenCalledWith("L1", "p-ana");
  });

  it("shows the storage error when marking fails", async () => {
    renderHistory([makeLog({ id: "L1", dateUsed: "2026-10-01" })], {
      onMarkReviewed: vi.fn(() => "Clear the Review queue items on this log first."),
    });
    const c = card("2026-10-01");
    await userEvent.click(within(c).getByRole("button", { name: "Mark reviewed" }));
    await userEvent.selectOptions(within(c).getByLabelText("Reviewed by"), "p-ana");
    await userEvent.click(within(c).getByRole("button", { name: "Mark reviewed" }));
    expect(within(c).getByRole("alert")).toHaveTextContent("Clear the Review queue items on this log first.");
  });

  it("log with flags: no Mark reviewed button, short note instead", () => {
    renderHistory([makeLog({ id: "L1", dateUsed: "2026-10-01", targetPestOrPurpose: "" })]);
    const c = card("2026-10-01");
    expect(within(c).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    expect(
      within(c).getByText("Mark reviewed is available once this log is off the Review queue."),
    ).toBeInTheDocument();
  });

  it("future-dated log counts as flagged (uses the clock)", () => {
    renderHistory([makeLog({ id: "L1", dateUsed: "2026-10-18" })]);
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
  });

  it("no roster: asks to add people first", async () => {
    renderHistory([makeLog({ id: "L1", dateUsed: "2026-10-01" })], { people: [] });
    await userEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(screen.getByText("Add people first to mark a log reviewed.")).toBeInTheDocument();
  });

  it("reviewed log: Reviewed chip + stamp, Edit hidden, lock note, no Mark reviewed", () => {
    const { container } = renderHistory([
      makeLog({
        id: "L1",
        dateUsed: "2026-10-01",
        reviewedAt: "2026-10-17T17:05:00-05:00",
        reviewedBy: "Ana Office",
      }),
    ]);
    const c = card("2026-10-01");
    expect(within(c).getByText("Reviewed")).toBeInTheDocument();
    expect(within(c).getByText("Reviewed 2026-10-17 17:05 by Ana Office")).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    expect(
      within(c).getByText("Reviewed logs can't be edited in place; original values kept."),
    ).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(BANNED);
  });

  it("unreviewed log keeps the normal Edit button", () => {
    renderHistory([makeLog({ id: "L1", dateUsed: "2026-10-01" })]);
    expect(within(card("2026-10-01")).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});

describe("History — tech session", () => {
  it("tech never sees Mark reviewed, even with callbacks wired", () => {
    renderHistory([makeLog({ id: "L1", dateUsed: "2026-10-01" })], { canEditDelete: false });
    expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("tech sees the Reviewed chip but no office lock note", () => {
    renderHistory(
      [
        makeLog({
          id: "L1",
          dateUsed: "2026-10-01",
          reviewedAt: "2026-10-17T17:05:00-05:00",
          reviewedBy: "Ana Office",
        }),
      ],
      { canEditDelete: false },
    );
    expect(screen.getByText("Reviewed")).toBeInTheDocument();
    expect(
      screen.queryByText("Reviewed logs can't be edited in place; original values kept."),
    ).not.toBeInTheDocument();
  });
});
