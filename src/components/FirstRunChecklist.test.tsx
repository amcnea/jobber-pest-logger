// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FirstRunStep } from "../storage";
import { FirstRunChecklist } from "./FirstRunChecklist";

// Scope: FirstRunChecklist.tsx (soft setup banner). Pure props component: no mocks needed.

vi.setConfig({ testTimeout: 15_000 });

const STEPS: FirstRunStep[] = [
  { id: "shop", label: "Add shop name & TPCL", done: true, screen: "settings" },
  { id: "people", label: "Add a tech", done: false, screen: "people" },
  { id: "products", label: "Add a real product", done: false, screen: "products" },
  { id: "backup", label: "Download a backup", done: true, screen: "settings" },
];

describe("FirstRunChecklist", () => {
  it("renders nothing when every step is done", () => {
    const { container } = render(<FirstRunChecklist steps={STEPS.map((s) => ({ ...s, done: true }))} onGo={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty step list", () => {
    const { container } = render(<FirstRunChecklist steps={[]} onGo={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the remaining count (plural) and every step in order", () => {
    render(<FirstRunChecklist steps={STEPS} onGo={vi.fn()} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("First-run checklist");
    expect(banner).toHaveTextContent("(2 steps left)");
    expect(within(banner).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      "✓Add shop name & TPCL",
      "○Add a tech",
      "○Add a real product",
      "✓Download a backup",
    ]);
  });

  it("uses singular 'step' with one left", () => {
    render(<FirstRunChecklist steps={STEPS.map((s) => ({ ...s, done: s.id !== "backup" }))} onGo={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("(1 step left)");
  });

  it("done steps are plain text with a hidden check mark; todo steps are buttons", () => {
    render(<FirstRunChecklist steps={STEPS} onGo={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Add shop name & TPCL" })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Add a tech", "Add a real product"]);
    for (const mark of document.querySelectorAll(".check-mark")) expect(mark).toHaveAttribute("aria-hidden", "true");
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.className)).toEqual(["done", "todo", "todo", "done"]);
  });

  it("clicking a todo step navigates to its screen", async () => {
    const onGo = vi.fn();
    const user = userEvent.setup();
    render(<FirstRunChecklist steps={STEPS} onGo={onGo} />);
    await user.click(screen.getByRole("button", { name: "Add a real product" }));
    await user.click(screen.getByRole("button", { name: "Add a tech" }));
    expect(onGo.mock.calls).toEqual([["products"], ["people"]]);
  });
});
