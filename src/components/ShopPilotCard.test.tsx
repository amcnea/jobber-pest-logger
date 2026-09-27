// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAWGICAL_DISCLAIMER } from "../disclaimer";
import { MemoryStorage } from "../test/memoryStorage";

// Scope: ShopPilotCard.tsx (Jobber how-to onboarding card): content, live link safety,
// dismiss persistence and failure.
// Import-boundary mocks, same approach as NewLogForm.test.tsx:
// - ../storage → only `loadPilotCardDismissed` / `dismissPilotCard` (real impl) over an
//   in-memory localStorage stub.

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { loadPilotCardDismissed: actual.loadPilotCardDismissed, dismissPilotCard: actual.dismissPilotCard };
});

const { ShopPilotCard } = await import("./ShopPilotCard");

vi.setConfig({ testTimeout: 15_000 });

const KEY = "jobber-pest-logger:pilot-card-dismissed:v1";
const NAME = "Shop pilot — how we use this with Jobber";
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ShopPilotCard", () => {
  it("is a labelled region with five steps and the disclaimer", () => {
    render(<ShopPilotCard />);
    const card = screen.getByRole("region", { name: NAME });
    expect(within(card).getAllByRole("listitem")).toHaveLength(5);
    expect(card).toHaveTextContent("does not replace Jobber scheduling, invoicing, or routing");
    expect(card).toHaveTextContent("at least two years");
    expect(within(card).getByText(LAWGICAL_DISCLAIMER)).toBeInTheDocument();
  });

  it("links the live URL in a new tab with noopener noreferrer", () => {
    render(<ShopPilotCard />);
    const link = screen.getByRole("link", { name: "https://amcnea.github.io/jobber-pest-logger/" });
    expect(link).toHaveAttribute("href", "https://amcnea.github.io/jobber-pest-logger/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not render when previously dismissed", () => {
    storage.setItem(KEY, "1");
    render(<ShopPilotCard />);
    expect(screen.queryByRole("region", { name: NAME })).toBeNull();
  });

  it("renders when the dismissed flag cannot be read", () => {
    storage.failGet = true;
    render(<ShopPilotCard />);
    expect(screen.getByRole("region", { name: NAME })).toBeInTheDocument();
  });

  it("Got it hides the card and persists the dismissal", async () => {
    const user = userEvent.setup();
    render(<ShopPilotCard />);
    await user.click(screen.getByRole("button", { name: "Got it — hide this card" }));
    expect(screen.queryByRole("region", { name: NAME })).toBeNull();
    expect(storage.getItem(KEY)).toBe("1");
  });

  it("stays visible if the dismissal cannot be saved", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    storage.failSet = true;
    const user = userEvent.setup();
    render(<ShopPilotCard />);
    await user.click(screen.getByRole("button", { name: "Got it — hide this card" }));
    expect(screen.getByRole("region", { name: NAME })).toBeInTheDocument();
    expect(err).toHaveBeenCalled();
  });
});
