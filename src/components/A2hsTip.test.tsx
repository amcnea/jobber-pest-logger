// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../test/memoryStorage";

// Scope: A2hsTip.tsx (Add to Home Screen tip): shown only on phone/tablet browsers that
// are not already running standalone; iOS vs Android copy; iPadOS desktop-UA detection;
// dismiss persistence (and failure); live display-mode changes.
// Import-boundary mocks, same approach as NewLogForm.test.tsx:
// - ../storage → only `loadA2hsTipDismissed` / `dismissA2hsTip` (real impl) over an
//   in-memory localStorage stub.
// navigator.userAgent / maxTouchPoints / standalone and window.matchMedia are stubbed.

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { loadA2hsTipDismissed: actual.loadA2hsTipDismissed, dismissA2hsTip: actual.dismissA2hsTip };
});

const { A2hsTip } = await import("./A2hsTip");

vi.setConfig({ testTimeout: 15_000 });

const KEY = "jobber-pest-logger:a2hs-tip-dismissed:v1";
const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
};

let storage: MemoryStorage;
let standaloneMatches: boolean;
let mqListeners: Set<() => void>;

function device(ua: string, maxTouchPoints = 0, iosStandalone?: boolean) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
  // jsdom has no maxTouchPoints; define it as an own property (removed in afterEach).
  Object.defineProperty(window.navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
  if (iosStandalone !== undefined) {
    Object.defineProperty(window.navigator, "standalone", { value: iosStandalone, configurable: true });
  }
}

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  standaloneMatches = false;
  mqListeners = new Set();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      media: query,
      get matches() {
        return query === "(display-mode: standalone)" && standaloneMatches;
      },
      addEventListener: (_: string, fn: () => void) => mqListeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => mqListeners.delete(fn),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window.navigator as { standalone?: boolean }).standalone;
  delete (window.navigator as { maxTouchPoints?: number }).maxTouchPoints;
});

const tip = () => screen.queryByRole("status");

describe("A2hsTip: when it shows", () => {
  it("iPhone Safari: shows the Share → Add to Home Screen copy", () => {
    device(UA.iphone, 5);
    render(<A2hsTip />);
    expect(tip()).toHaveTextContent("Add to Home Screen");
    expect(tip()).toHaveTextContent("On iPhone/iPad: Share → Add to Home Screen.");
  });

  it("Android Chrome: shows the Install app copy", () => {
    device(UA.android, 5);
    render(<A2hsTip />);
    expect(tip()).toHaveTextContent("On Android Chrome: browser menu → Install app / Add to Home screen.");
  });

  it("iPadOS with a Macintosh UA + touch points is treated as iOS", () => {
    device(UA.mac, 5);
    render(<A2hsTip />);
    expect(tip()).toHaveTextContent("On iPhone/iPad");
  });

  it("desktop Mac (no touch) and Windows do not show it", () => {
    device(UA.mac, 0);
    const { unmount } = render(<A2hsTip />);
    expect(tip()).toBeNull();
    unmount();
    device(UA.windows, 0);
    render(<A2hsTip />);
    expect(tip()).toBeNull();
  });

  it("already installed (display-mode: standalone) does not show", () => {
    device(UA.android, 5);
    standaloneMatches = true;
    render(<A2hsTip />);
    expect(tip()).toBeNull();
  });

  it("iOS home-screen app (navigator.standalone) does not show", () => {
    device(UA.iphone, 5, true);
    render(<A2hsTip />);
    expect(tip()).toBeNull();
  });

  it("works when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    device(UA.iphone, 5);
    render(<A2hsTip />);
    expect(tip()).toHaveTextContent("Add to Home Screen");
  });

  it("previously dismissed does not show; unreadable storage shows", () => {
    device(UA.iphone, 5);
    storage.setItem(KEY, "1");
    const { unmount } = render(<A2hsTip />);
    expect(tip()).toBeNull();
    unmount();
    storage.failGet = true;
    render(<A2hsTip />);
    expect(tip()).not.toBeNull();
  });
});

describe("A2hsTip: dismiss and live changes", () => {
  it("Got it hides the tip and persists the dismissal", async () => {
    device(UA.iphone, 5);
    const user = userEvent.setup();
    render(<A2hsTip />);
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(tip()).toBeNull();
    expect(storage.getItem(KEY)).toBe("1");
  });

  it("if the dismissal cannot be saved the tip stays (and the error is logged)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    device(UA.iphone, 5);
    storage.failSet = true;
    const user = userEvent.setup();
    render(<A2hsTip />);
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(tip()).not.toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it("hides when the page switches to standalone, and unsubscribes on unmount", () => {
    device(UA.android, 5);
    const { unmount } = render(<A2hsTip />);
    expect(tip()).not.toBeNull();
    expect(mqListeners.size).toBe(1);
    standaloneMatches = true;
    act(() => mqListeners.forEach((fn) => fn()));
    expect(tip()).toBeNull();
    unmount();
    expect(mqListeners.size).toBe(0);
  });
});
