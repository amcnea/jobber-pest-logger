// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Scope: ShopSessionGate.tsx: the shared-shop unlock form (prefill, role radios, PIN,
// busy state, errors, pins-missing → PIN bootstrap) and ShopSessionTimeoutWatcher
// (expiry checks on mount / interval / focus / visibility / storage events, activity
// touch throttling, listener cleanup).
// Import-boundary mocks, same approach as NewLogForm.test.tsx:
// - ../shop → controllable fakes for the session + sign-in API (Binder's shop code has
//   its own unit tests; this file only tests how the component drives it).

const SHOP_SESSION_KEY = "jobber-pest-logger:shop-session:test";
const fake = vi.hoisted(() => ({
  session: { shopId: "", role: "tech" as "tech" | "office", authenticated: false },
  joined: false,
}));

const signInShop = vi.fn();
const bootstrapShopPins = vi.fn();
const enforceSessionExpiry = vi.fn();
const touchSessionActivity = vi.fn((_now: number) => true);
const bumpSessionMutationEpoch = vi.fn();
const sessionAuthIdentityChanged = vi.fn((_o: string | null, _n: string | null) => false);

vi.mock("../shop", () => ({
  SHOP_SESSION_KEY,
  signInShop: (...a: unknown[]) => signInShop(...a),
  bootstrapShopPins: (...a: unknown[]) => bootstrapShopPins(...a),
  enforceSessionExpiry: () => enforceSessionExpiry(),
  touchSessionActivity: (now: number) => touchSessionActivity(now),
  bumpSessionMutationEpoch: () => bumpSessionMutationEpoch(),
  sessionAuthIdentityChanged: (o: string | null, n: string | null) => sessionAuthIdentityChanged(o, n),
  hasJoinedShop: () => fake.joined,
  loadShopSession: () => ({ ...fake.session }),
  isSessionAuthenticated: (s?: { authenticated: boolean }) => (s ?? fake.session).authenticated,
}));

const { ShopSessionGate, ShopSessionTimeoutWatcher } = await import("./ShopSessionGate");

vi.setConfig({ testTimeout: 15_000 });

beforeEach(() => {
  fake.session = { shopId: "", role: "tech", authenticated: false };
  fake.joined = false;
  for (const m of [signInShop, bootstrapShopPins, enforceSessionExpiry, bumpSessionMutationEpoch]) m.mockReset();
  touchSessionActivity.mockReset().mockReturnValue(true);
  sessionAuthIdentityChanged.mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const codeInput = () => screen.getByRole("textbox", { name: "Shop code" }) as HTMLInputElement;
const pinInput = () => screen.getByLabelText("Role PIN") as HTMLInputElement;
const unlockBtn = () => screen.getByRole("button", { name: /^(Unlock|Working…)$/ });
const radio = (name: "Office" | "Tech") => screen.getByRole("radio", { name }) as HTMLInputElement;

function setupGate(props: { initialShopCode?: string; compact?: boolean } = {}) {
  const user = userEvent.setup();
  const onSessionChange = vi.fn();
  const utils = render(<ShopSessionGate onSessionChange={onSessionChange} {...props} />);
  return { user, onSessionChange, ...utils };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ShopSessionGate: rendering", () => {
  it("renders nothing when the session is already authenticated", () => {
    fake.session.authenticated = true;
    const { container } = setupGate();
    expect(container).toBeEmptyDOMElement();
  });

  it("new device: 'Sign in to shared shop', blank code, Tech selected, roles-not-TDA note", () => {
    setupGate();
    expect(screen.getByRole("heading", { name: "Sign in to shared shop" })).toBeInTheDocument();
    expect(codeInput().value).toBe("");
    expect(radio("Tech").checked).toBe(true);
    expect(radio("Office").checked).toBe(false);
    expect(radio("Tech").name).toBe(radio("Office").name); // one radio group
    expect(screen.getByText(/not TDA or SPCS compliance status/)).toBeInTheDocument();
    expect(pinInput()).toHaveAttribute("type", "password");
    expect(pinInput()).toHaveAttribute("inputmode", "numeric");
  });

  it("joined device: 'Unlock shared shop' with the remembered shop code", () => {
    fake.joined = true;
    fake.session.shopId = "ABCD2345";
    setupGate();
    expect(screen.getByRole("heading", { name: "Unlock shared shop" })).toBeInTheDocument();
    expect(codeInput().value).toBe("ABCD2345");
  });

  it("initialShopCode wins over the remembered code", () => {
    fake.session.shopId = "ABCD2345";
    setupGate({ initialShopCode: "ZZZZ9999" });
    expect(codeInput().value).toBe("ZZZZ9999");
  });

  it("compact vs card styling", () => {
    const { container, unmount } = setupGate({ compact: true });
    expect(container.firstElementChild).toHaveClass("shop-gate", "shop-gate-compact");
    unmount();
    const { container: c2 } = setupGate();
    expect(c2.firstElementChild).toHaveClass("shop-gate", "card");
  });

  it("Unlock is disabled until both shop code and PIN are non-blank", async () => {
    const { user } = setupGate();
    expect(unlockBtn()).toBeDisabled();
    await user.type(codeInput(), "  ");
    await user.type(pinInput(), "1234");
    expect(unlockBtn()).toBeDisabled();
    await user.type(codeInput(), "AB");
    expect(unlockBtn()).toBeEnabled();
    await user.clear(pinInput());
    await user.type(pinInput(), "   ");
    expect(unlockBtn()).toBeDisabled();
  });
});

describe("ShopSessionGate: sign in", () => {
  it("passes code, role and PIN to signInShop; success clears the PIN, shows the message, notifies", async () => {
    signInShop.mockResolvedValue({ ok: true, shopId: "ABCD2345", message: "Signed in to ABCD2345 as office." });
    const { user, onSessionChange } = setupGate();
    await user.type(codeInput(), "abcd2345");
    await user.click(radio("Office"));
    await user.type(pinInput(), "2468");
    await user.click(unlockBtn());
    expect(signInShop).toHaveBeenCalledWith("abcd2345", { role: "office", pin: "2468" });
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(pinInput().value).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("Signed in to ABCD2345 as office.");
  });

  it("while signing in: 'Working…', inputs and role group disabled", async () => {
    const d = deferred<unknown>();
    signInShop.mockReturnValue(d.promise);
    const { user } = setupGate({ initialShopCode: "ABCD2345" });
    await user.type(pinInput(), "1234");
    await user.click(unlockBtn());
    expect(unlockBtn()).toHaveTextContent("Working…");
    expect(unlockBtn()).toBeDisabled();
    expect(codeInput()).toBeDisabled();
    expect(pinInput()).toBeDisabled();
    expect(radio("Office")).toBeDisabled(); // via <fieldset disabled>
    await act(async () => d.resolve({ ok: false, error: "PIN does not match." }));
    expect(unlockBtn()).toHaveTextContent("Unlock");
    expect(codeInput()).toBeEnabled();
  });

  it("failure shows the error as an alert, keeps the PIN, and does not notify", async () => {
    signInShop.mockResolvedValue({ ok: false, error: "PIN does not match." });
    const { user, onSessionChange } = setupGate({ initialShopCode: "ABCD2345" });
    await user.type(pinInput(), "1111");
    await user.click(unlockBtn());
    expect(screen.getByRole("alert")).toHaveTextContent("PIN does not match.");
    expect(pinInput().value).toBe("1111");
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/Pre-#3 shop/)).toBeNull();
  });

  it("typing in the code or PIN clears the error", async () => {
    signInShop.mockResolvedValue({ ok: false, error: "Enter a valid shop code." });
    const { user } = setupGate({ initialShopCode: "X" });
    await user.type(pinInput(), "1234");
    await user.click(unlockBtn());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.type(pinInput(), "5");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(unlockBtn());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.type(codeInput(), "Y");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ShopSessionGate: pins-missing bootstrap", () => {
  const bootstrapField = (label: string) => screen.getByLabelText(label, { exact: true }) as HTMLInputElement;

  async function openBootstrap() {
    signInShop.mockResolvedValue({ ok: false, error: "This shop has no PINs yet.", reason: "pins-missing" });
    const ctx = setupGate({ initialShopCode: "ABCD2345" });
    await ctx.user.type(pinInput(), "1234");
    await ctx.user.click(unlockBtn());
    return ctx;
  }

  it("a pins-missing failure reveals the bootstrap panel alongside the error", async () => {
    await openBootstrap();
    expect(screen.getByRole("alert")).toHaveTextContent("This shop has no PINs yet.");
    expect(screen.getByText(/Pre-#3 shop with no PIN hashes yet/)).toBeInTheDocument();
    for (const l of ["Office PIN", "Confirm office PIN", "Tech PIN", "Confirm tech PIN"]) {
      expect(bootstrapField(l)).toHaveAttribute("type", "password");
      expect(bootstrapField(l)).toHaveAttribute("autocomplete", "new-password");
    }
  });

  it("sends all four PINs; success clears them, hides the panel, shows the message, notifies", async () => {
    const { user, onSessionChange } = await openBootstrap();
    bootstrapShopPins.mockResolvedValue({ ok: true, shopId: "ABCD2345", message: "PINs set. Signed in as office." });
    await user.type(bootstrapField("Office PIN"), "1111");
    await user.type(bootstrapField("Confirm office PIN"), "1111");
    await user.type(bootstrapField("Tech PIN"), "2222");
    await user.type(bootstrapField("Confirm tech PIN"), "2222");
    await user.click(screen.getByRole("button", { name: "Set PINs & sign in as office" }));
    expect(bootstrapShopPins).toHaveBeenCalledWith("ABCD2345", {
      officePin: "1111",
      officePinConfirm: "1111",
      techPin: "2222",
      techPinConfirm: "2222",
    });
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Pre-#3 shop/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("PINs set. Signed in as office.");
  });

  it("bootstrap failure keeps the panel and entered PINs and shows the error", async () => {
    const { user, onSessionChange } = await openBootstrap();
    bootstrapShopPins.mockResolvedValue({ ok: false, error: "Office PINs do not match." });
    await user.type(bootstrapField("Office PIN"), "1111");
    await user.click(screen.getByRole("button", { name: "Set PINs & sign in as office" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Office PINs do not match.");
    expect(bootstrapField("Office PIN").value).toBe("1111");
    expect(screen.getByText(/Pre-#3 shop/)).toBeInTheDocument();
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("bootstrap fields and button are disabled while busy", async () => {
    const { user } = await openBootstrap();
    const d = deferred<unknown>();
    bootstrapShopPins.mockReturnValue(d.promise);
    await user.click(screen.getByRole("button", { name: "Set PINs & sign in as office" }));
    expect(bootstrapField("Tech PIN")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set PINs & sign in as office" })).toBeDisabled();
    expect(unlockBtn()).toHaveTextContent("Working…");
    await act(async () => d.resolve({ ok: false, error: "x" }));
    expect(bootstrapField("Tech PIN")).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Timeout watcher
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-26T15:00:00.000Z");

function setupWatcher() {
  const onSessionChange = vi.fn();
  const utils = render(<ShopSessionTimeoutWatcher onSessionChange={onSessionChange} />);
  return { onSessionChange, ...utils };
}

describe("ShopSessionTimeoutWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    fake.session = { shopId: "ABCD2345", role: "office", authenticated: true };
  });

  it("renders nothing; on mount checks expiry and records activity once", () => {
    const { container, onSessionChange } = setupWatcher();
    expect(container).toBeEmptyDOMElement();
    expect(enforceSessionExpiry).toHaveBeenCalled();
    expect(touchSessionActivity).toHaveBeenCalledTimes(1);
    expect(touchSessionActivity).toHaveBeenCalledWith(T0.getTime());
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("notifies once when an interval check finds the session expired", () => {
    const { onSessionChange } = setupWatcher();
    enforceSessionExpiry.mockImplementation(() => {
      fake.session.authenticated = false;
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_000)); // still locked → no repeat
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it("notifies on a shop change or role change, not on unchanged checks", () => {
    const { onSessionChange } = setupWatcher();
    act(() => vi.advanceTimersByTime(60_000));
    expect(onSessionChange).not.toHaveBeenCalled();
    fake.session.role = "tech";
    act(() => vi.advanceTimersByTime(60_000));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    fake.session.shopId = "ZZZZ9999";
    act(() => vi.advanceTimersByTime(60_000));
    expect(onSessionChange).toHaveBeenCalledTimes(2);
  });

  it("throttles activity writes to about once a minute", () => {
    setupWatcher();
    expect(touchSessionActivity).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.pointerDown(window);
    fireEvent.wheel(window);
    expect(touchSessionActivity).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0.getTime() + 60_000);
    fireEvent.keyDown(window, { key: "a" });
    expect(touchSessionActivity).toHaveBeenCalledTimes(2);
  });

  it("does not record activity when signed out (just re-checks)", () => {
    fake.session.authenticated = false;
    setupWatcher();
    const checks = enforceSessionExpiry.mock.calls.length;
    fireEvent.keyDown(window, { key: "a" });
    expect(touchSessionActivity).not.toHaveBeenCalled();
    expect(enforceSessionExpiry.mock.calls.length).toBe(checks + 1);
  });

  it("re-checks on window focus and when the tab becomes visible (not when hidden)", () => {
    const { onSessionChange } = setupWatcher();
    fake.session.authenticated = false;
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(onSessionChange).not.toHaveBeenCalled();
    vis.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    fake.session.authenticated = true;
    fireEvent.focus(window);
    expect(onSessionChange).toHaveBeenCalledTimes(2);
  });

  it("storage events: ignores other keys; bumps the epoch only on auth identity changes", () => {
    const { onSessionChange } = setupWatcher();
    const checks = () => enforceSessionExpiry.mock.calls.length;
    const before = checks();
    window.dispatchEvent(new StorageEvent("storage", { key: "some-other-key", oldValue: "a", newValue: "b" }));
    expect(checks()).toBe(before);

    window.dispatchEvent(new StorageEvent("storage", { key: SHOP_SESSION_KEY, oldValue: "a", newValue: "b" }));
    expect(sessionAuthIdentityChanged).toHaveBeenCalledWith("a", "b");
    expect(bumpSessionMutationEpoch).not.toHaveBeenCalled(); // activity-only rewrite
    expect(checks()).toBe(before + 1);

    sessionAuthIdentityChanged.mockReturnValue(true);
    fake.session.authenticated = false; // other tab signed out
    window.dispatchEvent(new StorageEvent("storage", { key: SHOP_SESSION_KEY, oldValue: "b", newValue: null }));
    expect(bumpSessionMutationEpoch).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledTimes(1);
  });

  it("a storage clear (key null) is treated as a session change", () => {
    setupWatcher();
    const before = enforceSessionExpiry.mock.calls.length;
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(enforceSessionExpiry.mock.calls.length).toBe(before + 1);
  });

  it("removes listeners and the interval on unmount", () => {
    const { unmount } = setupWatcher();
    unmount();
    const before = enforceSessionExpiry.mock.calls.length;
    act(() => vi.advanceTimersByTime(5 * 60_000));
    fireEvent.focus(window);
    fireEvent.keyDown(window, { key: "a" });
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(enforceSessionExpiry.mock.calls.length).toBe(before);
  });
});
