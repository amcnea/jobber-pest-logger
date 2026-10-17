// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeApplied, makeLog, makeShopProduct } from "../test/fixtures";
import { ReviewQueue } from "./ReviewQueue";

const NOW = new Date(2026, 9, 17, 10, 30);
const CATALOG = [makeShopProduct()];
const BANNED = /noncompliant|violation|invalid|compliant|audit/i;

describe("ReviewQueue", () => {
  it("lists flagged logs with date, address, applicator and Needs a look lines", () => {
    const flagged = makeLog({
      id: "f1",
      dateUsed: "2026-10-01",
      serviceAddress: "200 Oak Ave",
      products: [makeApplied({ rtuUnit: "" })],
    });
    const clean = makeLog({ id: "c1", serviceAddress: "100 Main St" });
    const { container } = render(
      <ReviewQueue
        logs={[flagged, clean]}
        catalog={CATALOG}
        canReview
        onEdit={() => {}}
        now={NOW}
      />,
    );
    expect(screen.getByRole("heading", { name: "Review queue" })).toBeInTheDocument();
    expect(
      screen.getByText("Logs listed here have fields worth checking before export."),
    ).toBeInTheDocument();
    const item = screen.getByLabelText("Review f1");
    expect(within(item).getByText(/2026-10-01 · 200 Oak Ave/)).toBeInTheDocument();
    expect(within(item).getByText("Applicator: Alice Applicator")).toBeInTheDocument();
    expect(within(item).getByText("Needs a look: Product line 1: unit")).toBeInTheDocument();
    expect(screen.queryByText(/100 Main St/)).not.toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(BANNED);
  });

  it("Edit opens the existing edit flow with that log", async () => {
    const onEdit = vi.fn();
    const flagged = makeLog({ id: "f1", serviceAddress: "" });
    render(
      <ReviewQueue logs={[flagged]} catalog={CATALOG} canReview onEdit={onEdit} now={NOW} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(flagged);
  });

  it("shows an empty note when nothing needs a look", () => {
    render(
      <ReviewQueue logs={[makeLog()]} catalog={CATALOG} canReview onEdit={() => {}} now={NOW} />,
    );
    expect(screen.getByText("No logs need a look right now.")).toBeInTheDocument();
  });

  it("renders nothing for a tech (non-office) session", () => {
    const { container } = render(
      <ReviewQueue
        logs={[makeLog({ serviceAddress: "" })]}
        catalog={CATALOG}
        canReview={false}
        onEdit={() => {}}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
