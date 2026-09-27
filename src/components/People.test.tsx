// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../types";

// Scope: People.tsx (office tech roster): list + chips, license / CE warnings and card
// tone, add / edit form validation and save shape, cancel, delete confirm.
// Import-boundary mocks, same approach as NewLogForm.test.tsx:
// - ../storage → only `emptyPerson` (real impl).
// - ../ids     → deterministic "id-N" ids (the mount-time empty draft consumes id-1).
// peopleWarnings / dates run for real. Date is faked; TZ is America/Chicago.

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { emptyPerson: actual.emptyPerson };
});

let idCounter = 0;
vi.mock("../ids", () => ({ newId: () => `id-${++idCounter}` }));

const { People } = await import("./People");

vi.setConfig({ testTimeout: 15_000 });

const NOW = new Date("2026-09-26T15:00:00.000Z"); // Sat Sep 26 2026, 10:00 AM CDT

const ALICE: Person = {
  id: "alice",
  name: "Alice Applicator",
  licenseNumber: "TX-111",
  roleTags: ["applying", "supervising"],
  licenseExpiry: "2027-06-30",
  ceDueDate: "",
};
const BOB_SOON: Person = {
  id: "bob",
  name: "Bob Soon",
  licenseNumber: "TX-222",
  roleTags: ["receiving_training"],
  licenseExpiry: "2026-10-10",
  ceDueDate: "2026-12-01",
};
const CARL_OVERDUE: Person = {
  id: "carl",
  name: "Carl Late",
  licenseNumber: "",
  roleTags: ["applying"],
  licenseExpiry: "2027-01-01",
  ceDueDate: "2026-09-20",
};

let upsertOk: boolean;
const onUpsertSpy = vi.fn<(p: Person) => void>();
const onDeleteSpy = vi.fn<(id: string) => void>();

function Harness({ initial }: { initial: Person[] }) {
  const [people, setPeople] = useState(initial);
  return (
    <People
      people={people}
      onUpsert={(p) => {
        onUpsertSpy(structuredClone(p));
        if (!upsertOk) return false;
        setPeople((ps) => (ps.some((x) => x.id === p.id) ? ps.map((x) => (x.id === p.id ? p : x)) : [...ps, p]));
        return true;
      }}
      onDelete={(id) => {
        onDeleteSpy(id);
        setPeople((ps) => ps.filter((x) => x.id !== id));
      }}
    />
  );
}

function setup(initial: Person[] = [ALICE, BOB_SOON, CARL_OVERDUE]) {
  const user = userEvent.setup();
  return { user, ...render(<Harness initial={initial} />) };
}

beforeEach(() => {
  idCounter = 0;
  upsertOk = true;
  onUpsertSpy.mockReset();
  onDeleteSpy.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Labels wrap inputs and error text renders inside the label → match by prefix.
const form = () => screen.getByRole("heading", { name: /^(Add|Edit) tech$/ }).closest("form") as HTMLFormElement;
const nameInput = () => within(form()).getByLabelText(/^Name/) as HTMLInputElement;
const licenseInput = () => within(form()).getByLabelText(/^License number/) as HTMLInputElement;
const expiryInput = () => within(form()).getByLabelText(/^License expiry/) as HTMLInputElement;
const ceInput = () => within(form()).getByLabelText(/^CE due date/) as HTMLInputElement;
const roleBox = (label: string) => within(form()).getByRole("checkbox", { name: label }) as HTMLInputElement;
const setDate = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });
const errors = () => Array.from(form().querySelectorAll(".error")).map((e) => e.textContent);
function personCard(name: string): HTMLElement {
  return screen.getByText(name, { selector: "strong" }).closest("article") as HTMLElement;
}

describe("People: list", () => {
  it("shows the empty hint when there are no techs", () => {
    setup([]);
    expect(screen.getByText("No techs yet. Add people the office uses on application logs.")).toBeInTheDocument();
  });

  it("renders license # and role chips, expiry and CE lines", () => {
    setup();
    const a = personCard("Alice Applicator");
    expect(Array.from(a.querySelectorAll(".chip")).map((c) => c.textContent)).toEqual(["TX-111", "Applying", "Supervising"]);
    expect(a).toHaveTextContent("License expires 2027-06-30");
    expect(a).not.toHaveTextContent("CE due");
    expect(personCard("Bob Soon")).toHaveTextContent("License expires 2026-10-10 · CE due 2026-12-01");
    expect(personCard("Carl Late").querySelector(".chip")).toHaveTextContent("no license #");
  });

  it("license due within 30 days warns with a 'soon' tone; CE outside Nov/Dec does not", () => {
    setup();
    const b = personCard("Bob Soon");
    expect(b).toHaveClass("card-warn-soon");
    expect(within(b).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      "License due in 14 days (2026-10-10)",
    ]);
    const a = personCard("Alice Applicator");
    expect(a.className).toBe("card");
    expect(a.querySelector(".warn-list")).toBeNull();
  });

  it("an overdue CE date gives the 'overdue' tone", () => {
    setup();
    const c = personCard("Carl Late");
    expect(c).toHaveClass("card-warn-overdue");
    expect(c).toHaveTextContent("CE overdue by 6 days (2026-09-20)");
  });

  it("in November a same-year CE date shows the year-end reminder", () => {
    vi.setSystemTime(new Date("2026-11-05T15:00:00.000Z"));
    setup([{ ...ALICE, ceDueDate: "2026-12-31" }]);
    const a = personCard("Alice Applicator");
    expect(a).toHaveTextContent("CE due this calendar year (2026-12-31) — year-end reminder");
    expect(a).toHaveClass("card-warn-soon");
  });
});

describe("People: add", () => {
  it("Add tech opens an empty form with 'Applying' pre-ticked and hides the Add button", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    expect(screen.getByRole("heading", { name: "Add tech" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add tech" })).toBeNull();
    expect(screen.queryByText(/No techs yet/)).toBeNull();
    expect(nameInput().value).toBe("");
    expect(roleBox("Applying").checked).toBe(true);
    expect(roleBox("Supervising").checked).toBe(false);
    expect(nameInput()).toHaveAttribute("aria-required", "true");
  });

  it("shows every required-field error on an empty submit and does not save", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    await user.click(roleBox("Applying")); // untick the default
    await user.click(screen.getByRole("button", { name: "Save tech" }));
    expect(errors()).toEqual([
      "Name required",
      "License number required",
      "Pick at least one default role tag",
      "License expiry date required",
    ]);
    expect(onUpsertSpy).not.toHaveBeenCalled();
  });

  it("whitespace-only name / license count as empty", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    await user.type(nameInput(), "   ");
    await user.type(licenseInput(), "  ");
    setDate(expiryInput(), "2027-01-01");
    await user.click(screen.getByRole("button", { name: "Save tech" }));
    expect(errors()).toEqual(["Name required", "License number required"]);
  });

  it("editing any field clears the errors", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    await user.click(screen.getByRole("button", { name: "Save tech" }));
    expect(errors().length).toBeGreaterThan(0);
    await user.type(nameInput(), "D");
    expect(errors()).toEqual([]);
  });

  it("saves a trimmed person with the draft id and closes the form", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    await user.type(nameInput(), "  Dana Tech  ");
    await user.type(licenseInput(), " TX-999 ");
    await user.click(roleBox("Supervising"));
    setDate(expiryInput(), "2027-03-01");
    setDate(ceInput(), "2026-12-15");
    await user.click(screen.getByRole("button", { name: "Save tech" }));
    expect(onUpsertSpy).toHaveBeenCalledWith({
      id: "id-2", // id-1 went to the mount-time empty draft; Add tech makes a fresh one
      name: "Dana Tech",
      licenseNumber: "TX-999",
      roleTags: ["applying", "supervising"],
      licenseExpiry: "2027-03-01",
      ceDueDate: "2026-12-15",
    });
    expect(screen.queryByRole("heading", { name: "Add tech" })).toBeNull();
    expect(personCard("Dana Tech")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add tech" })).toBeInTheDocument();
  });

  it("keeps the form open when onUpsert fails", async () => {
    upsertOk = false;
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    await user.type(nameInput(), "Dana");
    await user.type(licenseInput(), "TX-1");
    setDate(expiryInput(), "2027-03-01");
    await user.click(screen.getByRole("button", { name: "Save tech" }));
    expect(onUpsertSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Add tech" })).toBeInTheDocument();
    expect(nameInput().value).toBe("Dana");
  });

  it("Cancel closes the form without saving; re-opening starts blank", async () => {
    const { user } = setup([]);
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    await user.type(nameInput(), "Scratch");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Add tech" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    expect(nameInput().value).toBe("");
    expect(onUpsertSpy).not.toHaveBeenCalled();
  });
});

describe("People: edit", () => {
  it("Edit replaces that card with a prefilled form", async () => {
    const { user } = setup();
    await user.click(within(personCard("Bob Soon")).getByRole("button", { name: "Edit" }));
    const f = form();
    expect(f.closest("article")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Edit tech" })).toBeInTheDocument();
    expect(nameInput().value).toBe("Bob Soon");
    expect(licenseInput().value).toBe("TX-222");
    expect(expiryInput().value).toBe("2026-10-10");
    expect(ceInput().value).toBe("2026-12-01");
    expect(roleBox("Receiving training").checked).toBe(true);
    expect(roleBox("Applying").checked).toBe(false);
    // the other cards still render normally
    expect(personCard("Alice Applicator")).toBeInTheDocument();
  });

  it("saves changes under the same id (role toggled off/on) and returns to the card", async () => {
    const { user } = setup();
    await user.click(within(personCard("Alice Applicator")).getByRole("button", { name: "Edit" }));
    await user.clear(nameInput());
    await user.type(nameInput(), "Alice A.");
    await user.click(roleBox("Supervising"));
    setDate(ceInput(), "");
    await user.click(screen.getByRole("button", { name: "Save tech" }));
    expect(onUpsertSpy).toHaveBeenCalledWith({ ...ALICE, name: "Alice A.", roleTags: ["applying"] });
    expect(screen.queryByRole("heading", { name: "Edit tech" })).toBeNull();
    expect(personCard("Alice A.")).toBeInTheDocument();
  });

  it("Add tech while editing switches to a blank add form", async () => {
    const { user } = setup();
    await user.click(within(personCard("Alice Applicator")).getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Add tech" }));
    expect(screen.getByRole("heading", { name: "Add tech" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Edit tech" })).toBeNull();
    expect(nameInput().value).toBe("");
  });
});

describe("People: delete", () => {
  it("asks to confirm with the tech's name, then deletes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = setup();
    await user.click(within(personCard("Bob Soon")).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete Bob Soon from the roster?");
    expect(onDeleteSpy).toHaveBeenCalledWith("bob");
    expect(screen.queryByText("Bob Soon", { selector: "strong" })).toBeNull();
  });

  it("cancelling the confirm keeps the tech", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = setup();
    await user.click(within(personCard("Bob Soon")).getByRole("button", { name: "Delete" }));
    expect(onDeleteSpy).not.toHaveBeenCalled();
    expect(personCard("Bob Soon")).toBeInTheDocument();
  });

  it("uses 'this tech' for a nameless row", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = setup([{ ...ALICE, name: "" }]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete this tech from the roster?");
  });
});
