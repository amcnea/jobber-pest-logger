// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// ---------------------------------------------------------------------------
// Lock note + #160 clock refresh
// ---------------------------------------------------------------------------

const BANNED_2 =
  /tamper-proof|immutable|audit-proof|legally valid|compliant|noncompliant|violation|invalid|certified|audit/i;

describe("ReviewQueue — reviewed logs", () => {
  it("hides Edit on a reviewed (locked) log and shows the lock note", () => {
    const locked = makeLog({
      id: "r1",
      serviceAddress: "",
      reviewedAt: "2026-10-01T09:00:00-05:00",
      reviewedBy: "Ana Office",
    });
    const { container } = render(
      <ReviewQueue logs={[locked]} catalog={CATALOG} canReview onEdit={() => {}} now={NOW} />,
    );
    const item = screen.getByLabelText("Review r1");
    expect(within(item).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(item).getByText("Reviewed")).toBeInTheDocument();
    expect(
      within(item).getByText("Reviewed logs can't be edited in place; original values kept."),
    ).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(BANNED_2);
  });
});

describe("ReviewQueue — clock refresh (#160)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeClock(at: Date) {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(at);
  }

  it("a future-date flag clears once local midnight passes", () => {
    fakeClock(new Date(2026, 9, 17, 23, 58));
    const log = makeLog({ id: "t1", dateUsed: "2026-10-18" });
    render(<ReviewQueue logs={[log]} catalog={CATALOG} canReview onEdit={() => {}} />);
    expect(screen.getByText("Needs a look: Date used")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000); // 23:59 — still the 17th
    });
    expect(screen.getByText("Needs a look: Date used")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(120_000); // 00:01 on the 18th
    });
    expect(screen.queryByText("Needs a look: Date used")).not.toBeInTheDocument();
    expect(screen.getByText("No logs need a look right now.")).toBeInTheDocument();
  });

  it("a same-day future pretreat time clears once that time passes", () => {
    fakeClock(new Date(2026, 9, 17, 10, 30));
    const log = makeLog({
      id: "t2",
      dateUsed: "2026-10-17",
      isTermite: true,
      termite: {
        areaTreatedSqFt: "1200",
        isBait: false,
        physicalBarrierMeasurement: "",
        diagramNote: "",
        isCommercialPretreat: true,
        tankCount: "2",
        tankGallons: "100",
        startTime: "09:00",
        stopTime: "10:45",
      },
    });
    render(<ReviewQueue logs={[log]} catalog={CATALOG} canReview onEdit={() => {}} />);
    expect(screen.getByText("Needs a look: Pretreat stop time")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(16 * 60_000);
    });
    expect(screen.queryByText("Needs a look: Pretreat stop time")).not.toBeInTheDocument();
  });

  it("refreshes on visibilitychange and focus without waiting for the timer", () => {
    fakeClock(new Date(2026, 9, 17, 23, 59, 30));
    const log = makeLog({ id: "t3", dateUsed: "2026-10-18" });
    render(<ReviewQueue logs={[log]} catalog={CATALOG} canReview onEdit={() => {}} />);
    expect(screen.getByText("Needs a look: Date used")).toBeInTheDocument();
    vi.setSystemTime(new Date(2026, 9, 18, 7, 0)); // tab was asleep overnight
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.queryByText("Needs a look: Date used")).not.toBeInTheDocument();

    cleanup();
    vi.setSystemTime(new Date(2026, 9, 17, 23, 59, 30));
    render(<ReviewQueue logs={[log]} catalog={CATALOG} canReview onEdit={() => {}} />);
    vi.setSystemTime(new Date(2026, 9, 18, 7, 0));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.queryByText("Needs a look: Date used")).not.toBeInTheDocument();
  });

  it("removes its timer on unmount", () => {
    fakeClock(new Date(2026, 9, 17, 10, 0));
    const { unmount } = render(
      <ReviewQueue logs={[makeLog()]} catalog={CATALOG} canReview onEdit={() => {}} />,
    );
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
