// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationLog, Person, ShopProduct, ShopSettings } from "../types";

// Scope: NewLogForm validation and submit behavior as a tech sees it, rendered in jsdom
// with React Testing Library + user-event.
// Import-boundary mocks:
// - ../storage → only `peopleForRole` (the one import the form uses, real implementation).
//   Nothing else from storage is exposed, so any localStorage side effect would fail loudly.
// - ../ids     → deterministic ids ("id-1", "id-2", …) so the saved shape is exact.
// catalog / formDefaults / dates run for real (pure). Date is faked; TZ is America/Chicago.

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { peopleForRole: actual.peopleForRole };
});

let idCounter = 0;
vi.mock("../ids", () => ({ newId: () => `id-${++idCounter}` }));

const { NewLogForm } = await import("./NewLogForm");

// user-event interactions take ~0.1–1s per test locally; give slower CI runners headroom.
vi.setConfig({ testTimeout: 15_000 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-26T15:00:00.000Z"); // Sat Sep 26 2026, 10:00 AM CDT

const TALSTAR: ShopProduct = {
  id: "talstar",
  name: "Talstar P",
  epaRegNo: "279-3206",
  is25b: false,
  kind: "pesticide",
  isExample: false,
  archived: false,
};
const ESSENTRIA: ShopProduct = {
  id: "essentria",
  name: "Essentria IC3",
  epaRegNo: null,
  is25b: true,
  kind: "pesticide",
  isExample: false,
  archived: false,
};
const GLUE_BOARD: ShopProduct = {
  id: "glue",
  name: "Glue board",
  epaRegNo: null,
  is25b: false,
  kind: "device",
  isExample: false,
  archived: false,
};
const EXAMPLE: ShopProduct = {
  id: "example-rtu-insecticide",
  name: "Example RTU insecticide",
  epaRegNo: null,
  is25b: false,
  kind: "pesticide",
  isExample: true,
  archived: false,
};
const ARCHIVED: ShopProduct = { ...TALSTAR, id: "old", name: "Old Discontinued", archived: true };

const CATALOG = [TALSTAR, ESSENTRIA, GLUE_BOARD, EXAMPLE, ARCHIVED];

const ALICE: Person = {
  id: "alice",
  name: "Alice Applicator",
  licenseNumber: "TX-111",
  roleTags: ["applying"],
  licenseExpiry: "2027-06-30",
  ceDueDate: "",
};
const BOB: Person = {
  id: "bob",
  name: "Bob Supervisor",
  licenseNumber: "TX-222",
  roleTags: ["supervising"],
  licenseExpiry: "2027-06-30",
  ceDueDate: "",
};

const SETTINGS: ShopSettings = { shopName: "Acme Pest", shopTpclNumber: "12345", shopTpclLetter: "B" };

type RenderOpts = {
  catalog?: ShopProduct[];
  people?: Person[];
  settings?: ShopSettings;
  initialDraft?: ApplicationLog | null;
  isEditing?: boolean;
  onSave?: (log: ApplicationLog) => boolean;
};

function setup(opts: RenderOpts = {}) {
  const onSave = vi.fn(opts.onSave ?? (() => true));
  const user = userEvent.setup();
  const utils = render(
    <NewLogForm
      catalog={opts.catalog ?? CATALOG}
      people={opts.people ?? [ALICE, BOB]}
      settings={opts.settings ?? SETTINGS}
      initialDraft={opts.initialDraft}
      isEditing={opts.isEditing}
      onSave={onSave}
    />,
  );
  return { user, onSave, ...utils };
}

beforeEach(() => {
  idCounter = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Query helpers (labels wrap their inputs, and error text renders inside the label,
// so labels are matched by prefix)
// ---------------------------------------------------------------------------

const field = (label: RegExp) => screen.getByLabelText(label);
const billingName = () => field(/^Billing name/);
const billingAddress = () => field(/^Billing address/);
const serviceAddress = () => field(/^Service address/);
const dateUsed = () => field(/^Date used/) as HTMLInputElement;
const targetPest = () => field(/^Target pest or purpose/);
const tpcl = () => field(/^Shop TPCL number/) as HTMLInputElement;
const picker = () => field(/^Add from shop list/) as HTMLSelectElement;
const addButton = () => screen.getByRole("button", { name: "Add selected product" });
const saveButton = () => screen.getByRole("button", { name: /^Save/ });

function personCard(title: "Applying" | "Supervising" | "Receiving training"): HTMLElement {
  const strong = screen.getAllByText((_, el) => el?.tagName === "STRONG" && el.textContent?.startsWith(title) === true)[0];
  return strong.closest(".card") as HTMLElement;
}

function productCards(): HTMLElement[] {
  return screen
    .queryAllByRole("button", { name: "Remove" })
    .map((b) => b.closest("article") as HTMLElement);
}

/** Error text rendered inside the label that wraps `input`, or null. */
function errorFor(input: HTMLElement): string | null {
  return input.closest("label")?.querySelector(".error")?.textContent ?? null;
}

function allErrors(): string[] {
  return Array.from(document.querySelectorAll(".error")).map((e) => e.textContent ?? "");
}

async function addProduct(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.selectOptions(picker(), id);
  await user.click(addButton());
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(billingName(), "Jane Customer");
  await user.type(billingAddress(), "1 Main St, Austin, TX 78701");
  await user.type(serviceAddress(), "2 Oak St, Austin, TX 78702");
  await user.type(targetPest(), "German cockroaches");
  const applying = personCard("Applying");
  await user.type(within(applying).getByLabelText(/^Name/), "Alice Applicator");
  await user.type(within(applying).getByLabelText(/^License number/), "TX-111");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NewLogForm: initial state", () => {
  it("renders a new log with today's date, shop TPCL from settings and an enabled Save", () => {
    setup();
    expect(screen.getByRole("heading", { name: "New application log" })).toBeInTheDocument();
    expect(dateUsed()).toHaveValue("2026-09-26");
    expect(tpcl()).toHaveValue("12345");
    expect(field(/^TPCL letter/)).toHaveValue("B");
    expect(saveButton()).toHaveTextContent("Save application log");
    expect(saveButton()).toBeEnabled();
    expect(allErrors()).toEqual([]);
    expect(productCards()).toHaveLength(0);
  });

  it("marks required inputs as required for assistive tech", () => {
    setup();
    for (const el of [billingName(), billingAddress(), serviceAddress(), dateUsed(), targetPest(), tpcl()]) {
      expect(el).toBeRequired();
    }
    const applying = personCard("Applying");
    expect(within(applying).getByLabelText(/^Name/)).toBeRequired();
    expect(within(applying).getByLabelText(/^License number/)).toBeRequired();
    expect(within(personCard("Supervising")).getByLabelText(/^Name/)).not.toBeRequired();
    expect(field(/^Pole location/)).not.toBeRequired();
    expect(field(/^Jobber job #/)).not.toBeRequired();
  });

  it("uses the device-local date late in the evening (not the UTC date)", () => {
    vi.setSystemTime(new Date("2026-09-27T04:30:00.000Z")); // Sat Sep 26, 11:30 PM CDT
    setup();
    expect(dateUsed()).toHaveValue("2026-09-26");
  });

  it("leaves TPCL blank when settings have none", () => {
    setup({ settings: { shopName: "", shopTpclNumber: "", shopTpclLetter: "" } });
    expect(tpcl()).toHaveValue("");
  });
});

describe("NewLogForm: required fields", () => {
  it("submitting an empty form shows every required error and does not save", async () => {
    const { user, onSave } = setup();
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(errorFor(billingName())).toBe("Required");
    expect(errorFor(billingAddress())).toBe("Required");
    expect(errorFor(serviceAddress())).toBe("Required");
    expect(errorFor(targetPest())).toBe("Required");
    const applying = personCard("Applying");
    expect(errorFor(within(applying).getByLabelText(/^Name/))).toBe("Required");
    expect(errorFor(within(applying).getByLabelText(/^License number/))).toBe("Required");
    expect(screen.getByText("Add at least one pesticide or device from the shop list.")).toBeInTheDocument();
    // Prefilled date and TPCL are fine; optional fields never error.
    expect(errorFor(dateUsed())).toBeNull();
    expect(errorFor(tpcl())).toBeNull();
    expect(errorFor(within(personCard("Supervising")).getByLabelText(/^Name/))).toBeNull();
    expect(allErrors()).toHaveLength(7);
  });

  it("requires the date and shop TPCL when cleared", async () => {
    const { user, onSave } = setup();
    await user.clear(dateUsed());
    await user.clear(tpcl());
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(errorFor(dateUsed())).toBe("Required");
    expect(errorFor(tpcl())).toBe("Required");
  });

  it("treats whitespace-only answers as missing", async () => {
    const { user, onSave } = setup();
    await addProduct(user, "glue");
    await user.type(billingName(), "   ");
    await user.type(billingAddress(), "  ");
    await user.type(serviceAddress(), " ");
    await user.type(targetPest(), "   ");
    await user.clear(tpcl());
    await user.type(tpcl(), "  ");
    const applying = personCard("Applying");
    await user.type(within(applying).getByLabelText(/^Name/), "  ");
    await user.type(within(applying).getByLabelText(/^License number/), " ");
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(allErrors().filter((e) => e === "Required")).toHaveLength(7);
  });

  it("only the applying person is required; supervising / training are optional", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("clears all shown errors as soon as any field is edited", async () => {
    const { user } = setup();
    await user.click(saveButton());
    expect(allErrors().length).toBeGreaterThan(0);
    await user.type(field(/^Pole location/), "P");
    expect(allErrors()).toEqual([]);
  });

  it("re-validates on each submit (fixed fields drop out, remaining ones stay)", async () => {
    const { user } = setup();
    await user.click(saveButton());
    await user.type(billingName(), "Jane");
    await user.click(saveButton());
    expect(errorFor(billingName())).toBeNull();
    expect(errorFor(billingAddress())).toBe("Required");
  });
});

describe("NewLogForm: date handling", () => {
  it("saves a date picked by the tech", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    fireEvent.change(dateUsed(), { target: { value: "2026-09-20" } });
    expect(dateUsed()).toHaveValue("2026-09-20");
    await user.click(saveButton());
    expect(onSave.mock.calls[0][0].dateUsed).toBe("2026-09-20");
  });

  it("an unparseable date typed into the date input is sanitized to empty and blocks save", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    fireEvent.change(dateUsed(), { target: { value: "09/20/2026" } });
    expect(dateUsed()).toHaveValue("");
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(errorFor(dateUsed())).toBe("Required");
  });

  it("accepts a future date (no range check today)", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    fireEvent.change(dateUsed(), { target: { value: "2027-01-15" } });
    await user.click(saveButton());
    expect(onSave.mock.calls[0][0].dateUsed).toBe("2027-01-15");
  });
});

describe("NewLogForm: product picker", () => {
  it("lists active products grouped by kind with EPA / 25(b) / device / example labels", () => {
    setup();
    const pesticides = within(picker()).getByRole("group", { name: "Pesticides" });
    const devices = within(picker()).getByRole("group", { name: "Devices" });
    expect(within(pesticides).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Talstar P (279-3206)",
      "Essentria IC3 (25(b) — no EPA #)",
      "Example RTU insecticide (example / not a real EPA number)",
    ]);
    expect(within(devices).getAllByRole("option").map((o) => o.textContent)).toEqual(["Glue board (device)"]);
    expect(screen.queryByRole("option", { name: /Old Discontinued/ })).toBeNull();
  });

  it("keeps Add disabled until a product is selected, then resets the picker", async () => {
    const { user } = setup();
    expect(addButton()).toBeDisabled();
    await user.selectOptions(picker(), "talstar");
    expect(addButton()).toBeEnabled();
    await user.click(addButton());
    expect(picker()).toHaveValue("");
    expect(addButton()).toBeDisabled();
    expect(productCards()).toHaveLength(1);
  });

  it("shows an empty-list message and disables the picker with no catalog", () => {
    setup({ catalog: [] });
    expect(
      screen.getByText("The shop list is empty. Add products in the Products tab, then come back."),
    ).toBeInTheDocument();
    expect(picker()).toBeDisabled();
    expect(addButton()).toBeDisabled();
  });

  it("shows an unarchive message when every product is archived", () => {
    setup({ catalog: [ARCHIVED] });
    expect(screen.getByText(/No active products on the shop list\. Unarchive products/)).toBeInTheDocument();
    expect(picker()).toBeDisabled();
  });

  it("can add the same product twice as separate lines", async () => {
    const { user } = setup();
    await addProduct(user, "talstar");
    await addProduct(user, "talstar");
    expect(productCards()).toHaveLength(2);
  });
});

describe("NewLogForm: EPA-registered vs 25(b) vs device vs example lines", () => {
  it("an EPA-registered product shows its EPA # and needs an RTU amount", async () => {
    const { user } = setup();
    await addProduct(user, "talstar");
    const card = productCards()[0];
    expect(within(card).getByText("Talstar P")).toBeInTheDocument();
    expect(within(card).getByText("EPA 279-3206")).toBeInTheDocument();
    expect(within(card).getByLabelText(/^How applied/)).toHaveValue("rtu");
    expect(within(card).getByLabelText(/^Total RTU amount/)).toBeRequired();
    expect(within(card).queryByLabelText(/^Device count/)).toBeNull();
  });

  it("a 25(b) product shows no EPA # and behaves like a pesticide", async () => {
    const { user } = setup();
    await addProduct(user, "essentria");
    const card = productCards()[0];
    expect(within(card).getByText("25(b) · no EPA #")).toBeInTheDocument();
    expect(within(card).queryByText(/^EPA /)).toBeNull();
    expect(within(card).getByLabelText(/^How applied/)).toBeInTheDocument();
  });

  it("a device shows a device count (prefilled 1) and no application method", async () => {
    const { user } = setup();
    await addProduct(user, "glue");
    const card = productCards()[0];
    expect(within(card).getByText("device")).toBeInTheDocument();
    expect(within(card).queryByLabelText(/^How applied/)).toBeNull();
    expect(within(card).getByLabelText(/^Device count/)).toHaveValue("1");
  });

  it("an example seed is flagged as example with the not-a-real-EPA caption", async () => {
    const { user } = setup();
    await addProduct(user, "example-rtu-insecticide");
    const card = productCards()[0];
    expect(within(card).getByText("example")).toBeInTheDocument();
    expect(within(card).getByText("example / not a real EPA number")).toBeInTheDocument();
  });

  it("saves EPA # only for the registered product; 25(b), device and example lines save null", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    for (const id of ["talstar", "essentria", "glue", "example-rtu-insecticide"]) await addProduct(user, id);
    const cards = productCards();
    for (const i of [0, 1, 3]) await user.type(within(cards[i]).getByLabelText(/^Total RTU amount/), "8");
    await user.click(saveButton());
    const saved = onSave.mock.calls[0][0];
    expect(saved.products.map((p) => [p.catalogId, p.epaRegNo, p.is25b, p.isExample, p.method])).toEqual([
      ["talstar", "279-3206", false, false, "rtu"],
      ["essentria", null, true, false, "rtu"],
      ["glue", null, false, false, "device"],
      ["example-rtu-insecticide", null, false, true, "rtu"],
    ]);
    expect(saved.sampleData).toBe(true);
  });

  it("there is no free-text EPA field anywhere on the form", () => {
    setup();
    expect(screen.queryByLabelText(/EPA/i)).toBeNull();
  });
});

describe("NewLogForm: product line validation", () => {
  it("requires an RTU amount", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "talstar");
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    const card = productCards()[0];
    expect(errorFor(within(card).getByLabelText(/^Total RTU amount/))).toBe("RTU amount required");
  });

  it("mixed on site needs a mixing rate or % AI, plus the total applied", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "talstar");
    let card = productCards()[0];
    await user.selectOptions(within(card).getByLabelText(/^How applied/), "mixed");
    card = productCards()[0];
    expect(within(card).queryByLabelText(/^Total RTU amount/)).toBeNull();
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(within(card).getByText("Enter mixing rate or % AI")).toBeInTheDocument();
    expect(errorFor(within(card).getByLabelText(/^Total material applied/))).toBe(
      "Total material applied required",
    );

    await user.type(within(card).getByLabelText(/^% AI/), "0.05");
    await user.type(within(card).getByLabelText(/^Total material applied/), "2");
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    const line = onSave.mock.calls[0][0].products[0];
    expect(line).toMatchObject({ method: "mixed", percentAi: "0.05", mixingRate: "", mixedTotal: "2", mixedUnit: "gal" });
  });

  it("a mixing rate alone satisfies the rate / % AI rule", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "talstar");
    const card = productCards()[0];
    await user.selectOptions(within(card).getByLabelText(/^How applied/), "mixed");
    await user.type(within(card).getByLabelText(/^Mixing rate/), "1 oz / gal");
    await user.type(within(card).getByLabelText(/^Total material applied/), "3");
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("requires a device count", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    const card = productCards()[0];
    await user.clear(within(card).getByLabelText(/^Device count/));
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(errorFor(within(card).getByLabelText(/^Device count/))).toBe("Device count required");
  });

  it("puts the error on the right line when several products are present", async () => {
    const { user } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    await addProduct(user, "talstar");
    await user.click(saveButton());
    const [device, rtu] = productCards();
    expect(errorFor(within(device).getByLabelText(/^Device count/))).toBeNull();
    expect(errorFor(within(rtu).getByLabelText(/^Total RTU amount/))).toBe("RTU amount required");
  });

  it("units default to fl oz (RTU) / gal (mixed) and can be changed", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "talstar");
    const card = productCards()[0];
    expect(within(card).getByLabelText(/^Unit/)).toHaveValue("fl oz");
    await user.type(within(card).getByLabelText(/^Total RTU amount/), "1");
    await user.selectOptions(within(card).getByLabelText(/^Unit/), "gal");
    await user.click(saveButton());
    expect(onSave.mock.calls[0][0].products[0]).toMatchObject({ rtuAmount: "1", rtuUnit: "gal" });
  });
});

describe("NewLogForm: removing products", () => {
  it("Remove deletes just that line", async () => {
    const { user } = setup();
    await addProduct(user, "talstar");
    await addProduct(user, "glue");
    await user.click(within(productCards()[0]).getByRole("button", { name: "Remove" }));
    const cards = productCards();
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText("Glue board")).toBeInTheDocument();
  });

  it("removing the last line brings back the at-least-one-product error on submit", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    await user.click(within(productCards()[0]).getByRole("button", { name: "Remove" }));
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Add at least one pesticide or device from the shop list.")).toBeInTheDocument();
  });

  it("removing an invalid line lets the log save", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "glue");
    await addProduct(user, "talstar"); // RTU amount left blank → invalid
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    await user.click(within(productCards()[1]).getByRole("button", { name: "Remove" }));
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("NewLogForm: people", () => {
  it("picking from the roster fills name and license; typing switches back to manual", async () => {
    const { user } = setup();
    const applying = personCard("Applying");
    const pick = within(applying).getByLabelText(/^Pick from roster/);
    const defaults = within(pick).getByRole("group", { name: "Default applying" });
    expect(within(defaults).getAllByRole("option").map((o) => o.textContent)).toEqual(["Alice Applicator · TX-111"]);
    await user.selectOptions(pick, "alice");
    expect(within(applying).getByLabelText(/^Name/)).toHaveValue("Alice Applicator");
    expect(within(applying).getByLabelText(/^License number/)).toHaveValue("TX-111");
    await user.type(within(applying).getByLabelText(/^License number/), "-X");
    expect(pick).toHaveValue("");
    expect(within(applying).getByLabelText(/^License number/)).toHaveValue("TX-111-X");
  });

  it("with no roster the picks are disabled and manual entry still works", async () => {
    const { user, onSave } = setup({ people: [] });
    expect(screen.getByText(/Roster is empty/)).toBeInTheDocument();
    expect(within(personCard("Applying")).getByLabelText(/^Pick from roster/)).toBeDisabled();
    await fillRequired(user);
    await addProduct(user, "glue");
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("NewLogForm: termite extras", () => {
  async function termiteReady(user: ReturnType<typeof userEvent.setup>) {
    await fillRequired(user);
    await addProduct(user, "glue");
    await user.click(screen.getByLabelText("This stop is termite work"));
  }

  it("termite fields are hidden until the stop is marked termite work", async () => {
    const { user } = setup();
    expect(screen.queryByLabelText(/^Area treated/)).toBeNull();
    await user.click(screen.getByLabelText("This stop is termite work"));
    expect(field(/^Area treated/)).toBeInTheDocument();
  });

  it("non-bait termite work requires area treated", async () => {
    const { user, onSave } = setup();
    await termiteReady(user);
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(errorFor(field(/^Area treated/))).toBe("Required for non-bait termite work");
  });

  it("bait systems hide area treated and do not require it", async () => {
    const { user, onSave } = setup();
    await termiteReady(user);
    await user.click(screen.getByLabelText(/^Bait system/));
    expect(screen.queryByLabelText(/^Area treated/)).toBeNull();
    expect(screen.queryByLabelText(/^Commercial pretreat/)).toBeNull();
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].termite.isBait).toBe(true);
  });

  it("commercial pretreat requires tank count, gallons, start and stop (one combined message)", async () => {
    const { user, onSave } = setup();
    await termiteReady(user);
    await user.type(field(/^Area treated/), "1200");
    await user.click(screen.getByLabelText(/^Commercial pretreat/));
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText("Tank count required · Tank gallons required · Start time required · Stop time required"),
    ).toBeInTheDocument();

    await user.type(field(/^Tank count/), "2");
    await user.type(field(/^Tank gallons/), "100");
    fireEvent.change(field(/^Start time/), { target: { value: "08:00" } });
    await user.click(saveButton());
    expect(screen.getByText("Stop time required")).toBeInTheDocument();
    fireEvent.change(field(/^Stop time/), { target: { value: "09:30" } });
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].termite).toEqual({
      areaTreatedSqFt: "1200",
      isBait: false,
      physicalBarrierMeasurement: "",
      diagramNote: "",
      isCommercialPretreat: true,
      tankCount: "2",
      tankGallons: "100",
      startTime: "08:00",
      stopTime: "09:30",
    });
  });

  it("switching to bait turns commercial pretreat off", async () => {
    const { user } = setup();
    await termiteReady(user);
    await user.click(screen.getByLabelText(/^Commercial pretreat/));
    await user.click(screen.getByLabelText(/^Bait system/));
    await user.click(screen.getByLabelText(/^Bait system/));
    expect(screen.getByLabelText(/^Commercial pretreat/)).not.toBeChecked();
  });
});

describe("NewLogForm: submit", () => {
  it("the Save button is never disabled; validation happens on submit", async () => {
    const { user } = setup();
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    expect(saveButton()).toBeEnabled();
  });

  it("a valid new log calls onSave once with the full expected shape", async () => {
    const { user, onSave } = setup();
    await user.type(field(/^Jobber job #/), "1042");
    await fillRequired(user);
    await user.type(field(/^Pole location/), "Pole 7");
    await user.selectOptions(within(personCard("Supervising")).getByLabelText(/^Pick from roster/), "bob");
    await addProduct(user, "talstar");
    await user.type(within(productCards()[0]).getByLabelText(/^Total RTU amount/), "16");
    await addProduct(user, "glue");
    const later = new Date("2026-09-26T15:05:00.000Z");
    vi.setSystemTime(later);
    await user.click(saveButton());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual({
      id: "id-1",
      createdAt: later.toISOString(), // new logs are stamped at save time
      sampleData: false,
      jobberJobNumber: "1042",
      jobberAddress: "",
      customerBillingName: "Jane Customer",
      customerBillingAddress: "1 Main St, Austin, TX 78701",
      serviceAddress: "2 Oak St, Austin, TX 78702",
      poleLocation: "Pole 7",
      products: [
        {
          lineId: expect.stringMatching(/^id-\d+$/),
          catalogId: "talstar",
          name: "Talstar P",
          epaRegNo: "279-3206",
          is25b: false,
          isExample: false,
          method: "rtu",
          rtuAmount: "16",
          rtuUnit: "fl oz",
          mixingRate: "",
          percentAi: "",
          mixedTotal: "",
          mixedUnit: "gal",
          deviceCount: "",
        },
        {
          lineId: expect.stringMatching(/^id-\d+$/),
          catalogId: "glue",
          name: "Glue board",
          epaRegNo: null,
          is25b: false,
          isExample: false,
          method: "device",
          rtuAmount: "",
          rtuUnit: "fl oz",
          mixingRate: "",
          percentAi: "",
          mixedTotal: "",
          mixedUnit: "gal",
          deviceCount: "1",
        },
      ],
      targetPestOrPurpose: "German cockroaches",
      dateUsed: "2026-09-26",
      personnel: [
        { role: "applying", name: "Alice Applicator", licenseNumber: "TX-111" },
        { role: "supervising", name: "Bob Supervisor", licenseNumber: "TX-222" },
        { role: "receiving_training", name: "", licenseNumber: "" },
      ],
      shopTpclNumber: "12345",
      shopTpclLetter: "B",
      isTermite: false,
      termite: {
        areaTreatedSqFt: "",
        isBait: false,
        physicalBarrierMeasurement: "",
        diagramNote: "",
        isCommercialPretreat: false,
        tankCount: "",
        tankGallons: "",
        startTime: "",
        stopTime: "",
      },
    });
    const [a, b] = onSave.mock.calls[0][0].products;
    expect(a.lineId).not.toBe(b.lineId);
  });

  it("saves typed values as entered (not trimmed)", async () => {
    const { user, onSave } = setup();
    await fillRequired(user);
    await user.type(billingName(), "  ");
    await addProduct(user, "glue");
    await user.click(saveButton());
    expect(onSave.mock.calls[0][0].customerBillingName).toBe("Jane Customer  ");
  });

  it("when onSave reports failure the form stays filled and shows no field errors", async () => {
    const { user, onSave } = setup({ onSave: () => false });
    await fillRequired(user);
    await addProduct(user, "glue");
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(billingName()).toHaveValue("Jane Customer");
    expect(allErrors()).toEqual([]);
    await user.click(saveButton());
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("editing keeps the id and original createdAt and relabels the form", async () => {
    const draft: ApplicationLog = {
      id: "saved-log",
      createdAt: "2026-09-01T12:00:00.000Z",
      sampleData: true, // stale flag, recomputed on save
      jobberJobNumber: "",
      jobberAddress: "",
      customerBillingName: "Jane",
      customerBillingAddress: "1 Main",
      serviceAddress: "2 Oak",
      poleLocation: "",
      products: [
        {
          lineId: "line-a",
          catalogId: "glue",
          name: "Glue board",
          epaRegNo: null,
          is25b: false,
          isExample: false,
          method: "device",
          rtuAmount: "",
          rtuUnit: "fl oz",
          mixingRate: "",
          percentAi: "",
          mixedTotal: "",
          mixedUnit: "gal",
          deviceCount: "4",
        },
      ],
      targetPestOrPurpose: "Ants",
      dateUsed: "2026-09-01",
      personnel: [
        { role: "applying", name: "Alice Applicator", licenseNumber: "TX-111" },
        { role: "supervising", name: "", licenseNumber: "" },
        { role: "receiving_training", name: "", licenseNumber: "" },
      ],
      shopTpclNumber: "999",
      shopTpclLetter: "",
      isTermite: false,
      termite: {
        areaTreatedSqFt: "",
        isBait: false,
        physicalBarrierMeasurement: "",
        diagramNote: "",
        isCommercialPretreat: false,
        tankCount: "",
        tankGallons: "",
        startTime: "",
        stopTime: "",
      },
    };
    const { user, onSave } = setup({ initialDraft: draft, isEditing: true });
    expect(screen.getByRole("heading", { name: "Edit application log" })).toBeInTheDocument();
    expect(saveButton()).toHaveTextContent("Save changes");
    expect(dateUsed()).toHaveValue("2026-09-01");
    expect(tpcl()).toHaveValue("999"); // draft wins over settings
    expect(within(personCard("Applying")).getByLabelText(/^Pick from roster/)).toHaveValue("alice");
    await user.clear(targetPest());
    await user.type(targetPest(), "Fire ants");
    await user.click(saveButton());
    expect(onSave.mock.calls[0][0]).toEqual({
      ...draft,
      sampleData: false,
      targetPestOrPurpose: "Fire ants",
    });
  });

  it("a prefilled (not editing) draft is stamped with a new createdAt", async () => {
    const { user, onSave } = setup({
      initialDraft: {
        ...(await import("../formDefaults")).emptyLog(SETTINGS),
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    });
    await fillRequired(user);
    await addProduct(user, "glue");
    await user.click(saveButton());
    expect(onSave.mock.calls[0][0].createdAt).toBe(NOW.toISOString());
  });

  it("switching RTU → mixed keeps the hidden RTU amount in the saved line", async () => {
    // Documents current behavior (see PR observations): hidden per-method fields persist.
    const { user, onSave } = setup();
    await fillRequired(user);
    await addProduct(user, "talstar");
    const card = productCards()[0];
    await user.type(within(card).getByLabelText(/^Total RTU amount/), "16");
    await user.selectOptions(within(card).getByLabelText(/^How applied/), "mixed");
    await user.type(within(card).getByLabelText(/^% AI/), "0.05");
    await user.type(within(card).getByLabelText(/^Total material applied/), "2");
    await user.click(saveButton());
    expect(onSave.mock.calls[0][0].products[0]).toMatchObject({ method: "mixed", rtuAmount: "16" });
  });

  it("shows the product-name-required error on the line when a product name is blank", async () => {
    const blank: ShopProduct = { ...TALSTAR, id: "blank", name: "   " };
    const { user, onSave } = setup({ catalog: [blank] });
    await fillRequired(user);
    await addProduct(user, "blank");
    await user.type(within(productCards()[0]).getByLabelText(/^Total RTU amount/), "1");
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    const error = within(productCards()[0]).getByText("Product name required");
    expect(error).toHaveClass("error");
  });

  it("puts the product-name-required error only on the blank line", async () => {
    const blank: ShopProduct = { ...GLUE_BOARD, id: "blank-device", name: "" };
    const { user, onSave } = setup({ catalog: [GLUE_BOARD, blank] });
    await fillRequired(user);
    await addProduct(user, "glue");
    await addProduct(user, "blank-device");
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
    const [named, unnamed] = productCards();
    expect(within(named).queryByText("Product name required")).toBeNull();
    expect(within(unnamed).getByText("Product name required")).toHaveClass("error");
    expect(screen.getAllByText("Product name required")).toHaveLength(1);
  });
});
