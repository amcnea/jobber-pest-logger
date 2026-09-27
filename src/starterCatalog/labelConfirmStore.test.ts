import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPendingLabelConfirm,
  clearPendingLabelConfirm,
  listPendingLabelConfirmIds,
  requiresLabelConfirm,
  STARTER_LABEL_CONFIRM_KEY,
} from "./labelConfirmStore";

// Scope: labelConfirmStore public API on an in-memory localStorage. The private
// readIds/writeIds helpers are covered through it. Key property: reads fail closed —
// malformed or unreadable storage is { ok: false } and is never repaired/overwritten.

class MemoryStorage {
  map = new Map<string, string>();
  failSet = false;
  failGet = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    if (this.failGet) throw new Error("getItem failed");
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.failSet) throw new Error("QuotaExceededError");
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function raw() {
  return storage.getItem(STARTER_LABEL_CONFIRM_KEY);
}

function put(value: unknown) {
  storage.setItem(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(value));
}

/** Malformed-but-parseable and unparseable payloads that must fail closed. */
const MALFORMED: [string, string][] = [
  ["object", JSON.stringify({ ids: ["a"] })],
  ["string", JSON.stringify("a")],
  ["number", "42"],
  ["null literal", "null"],
  ["true literal", "true"],
  ["array with a number", JSON.stringify(["a", 1])],
  ["array with null", JSON.stringify([null])],
  ["array with nested array", JSON.stringify([["a"]])],
  ["array with object", JSON.stringify([{ id: "a" }])],
  ["invalid JSON", "{not json"],
];

describe("STARTER_LABEL_CONFIRM_KEY", () => {
  it("uses the v1 key", () => {
    expect(STARTER_LABEL_CONFIRM_KEY).toBe("jobber-pest-logger:starter-label-confirm:v1");
  });
});

describe("listPendingLabelConfirmIds", () => {
  it("is ok and empty when nothing is stored", () => {
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: [] });
  });

  it("treats an empty stored string as empty", () => {
    storage.setItem(STARTER_LABEL_CONFIRM_KEY, "");
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: [] });
  });

  it("returns stored ids in order", () => {
    put(["b", "a", "c"]);
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: ["b", "a", "c"] });
  });

  it("trims ids, skips blanks and dedupes (first occurrence wins)", () => {
    put([" a ", "", "   ", "b", "a", " b"]);
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: ["a", "b"] });
  });

  for (const [name, payload] of MALFORMED) {
    it(`fails closed on ${name} without repairing storage`, () => {
      storage.setItem(STARTER_LABEL_CONFIRM_KEY, payload);
      expect(listPendingLabelConfirmIds()).toEqual({ ok: false });
      expect(raw()).toBe(payload);
    });
  }

  it("fails closed when storage reads throw", () => {
    storage.failGet = true;
    expect(listPendingLabelConfirmIds()).toEqual({ ok: false });
  });

  it("returns a fresh array each call", () => {
    put(["a"]);
    const first = listPendingLabelConfirmIds();
    if (first.ok) first.ids.push("mutated");
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: ["a"] });
  });
});

describe("requiresLabelConfirm", () => {
  it("is not required for a blank id, without reading storage", () => {
    storage.failGet = true;
    expect(requiresLabelConfirm("")).toEqual({ ok: true, required: false });
    expect(requiresLabelConfirm("   ")).toEqual({ ok: true, required: false });
  });

  it("is required only for pending ids (trimmed on both sides)", () => {
    put([" prod-1 ", "prod-2"]);
    expect(requiresLabelConfirm("prod-1")).toEqual({ ok: true, required: true });
    expect(requiresLabelConfirm("  prod-2  ")).toEqual({ ok: true, required: true });
    expect(requiresLabelConfirm("prod-3")).toEqual({ ok: true, required: false });
  });

  it("is exact and case-sensitive (no substring or case folding)", () => {
    put(["prod-10"]);
    expect(requiresLabelConfirm("prod-1")).toEqual({ ok: true, required: false });
    expect(requiresLabelConfirm("PROD-10")).toEqual({ ok: true, required: false });
  });

  it("is not required when nothing is stored", () => {
    expect(requiresLabelConfirm("prod-1")).toEqual({ ok: true, required: false });
  });

  it("fails closed (ok:false, not required:false) on malformed or unreadable storage", () => {
    for (const [, payload] of MALFORMED) {
      storage.setItem(STARTER_LABEL_CONFIRM_KEY, payload);
      expect(requiresLabelConfirm("prod-1"), payload).toEqual({ ok: false });
    }
    storage.failGet = true;
    expect(requiresLabelConfirm("prod-1")).toEqual({ ok: false });
  });
});

describe("addPendingLabelConfirm", () => {
  it("rejects a blank id without writing", () => {
    expect(addPendingLabelConfirm("")).toBe(false);
    expect(addPendingLabelConfirm("  ")).toBe(false);
    expect(raw()).toBeNull();
  });

  it("adds a trimmed id and persists it", () => {
    expect(addPendingLabelConfirm("  prod-1 ")).toBe(true);
    expect(JSON.parse(raw()!)).toEqual(["prod-1"]);
    expect(requiresLabelConfirm("prod-1")).toEqual({ ok: true, required: true });
  });

  it("appends in insertion order", () => {
    addPendingLabelConfirm("a");
    addPendingLabelConfirm("b");
    addPendingLabelConfirm("c");
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: ["a", "b", "c"] });
  });

  it("is idempotent and does not rewrite when already pending", () => {
    addPendingLabelConfirm("a");
    const setSpy = vi.spyOn(storage, "setItem");
    expect(addPendingLabelConfirm("a")).toBe(true);
    expect(addPendingLabelConfirm(" a ")).toBe(true);
    expect(setSpy).not.toHaveBeenCalled();
    expect(JSON.parse(raw()!)).toEqual(["a"]);
  });

  it("idempotent even when storage is read-only", () => {
    addPendingLabelConfirm("a");
    storage.failSet = true;
    expect(addPendingLabelConfirm("a")).toBe(true);
  });

  it("normalizes (trims/dedupes) the stored list when it writes", () => {
    put([" a ", "a", "", "b"]);
    expect(addPendingLabelConfirm("c")).toBe(true);
    expect(JSON.parse(raw()!)).toEqual(["a", "b", "c"]);
  });

  it("returns false when the write fails", () => {
    storage.failSet = true;
    expect(addPendingLabelConfirm("a")).toBe(false);
    expect(raw()).toBeNull();
  });

  it("returns false and does not overwrite malformed or unreadable storage", () => {
    for (const [, payload] of MALFORMED) {
      storage.setItem(STARTER_LABEL_CONFIRM_KEY, payload);
      expect(addPendingLabelConfirm("new"), payload).toBe(false);
      expect(raw()).toBe(payload);
    }
    storage.failGet = true;
    expect(addPendingLabelConfirm("new")).toBe(false);
  });
});

describe("clearPendingLabelConfirm", () => {
  it("rejects a blank id without writing", () => {
    put(["a"]);
    expect(clearPendingLabelConfirm("")).toBe(false);
    expect(clearPendingLabelConfirm("  ")).toBe(false);
    expect(JSON.parse(raw()!)).toEqual(["a"]);
  });

  it("removes a pending id (trimmed) and keeps the others in order", () => {
    put(["a", "b", "c"]);
    expect(clearPendingLabelConfirm(" b ")).toBe(true);
    expect(JSON.parse(raw()!)).toEqual(["a", "c"]);
    expect(requiresLabelConfirm("b")).toEqual({ ok: true, required: false });
  });

  it("removes an id stored with whitespace or duplicates", () => {
    put([" a ", "a", "b"]);
    expect(clearPendingLabelConfirm("a")).toBe(true);
    expect(JSON.parse(raw()!)).toEqual(["b"]);
  });

  it("clearing the last id leaves an empty array", () => {
    put(["a"]);
    expect(clearPendingLabelConfirm("a")).toBe(true);
    expect(raw()).toBe("[]");
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: [] });
  });

  it("is a successful no-op (no write) when the id is not pending or nothing is stored", () => {
    const setSpy = vi.spyOn(storage, "setItem");
    expect(clearPendingLabelConfirm("a")).toBe(true);
    expect(raw()).toBeNull();
    storage.map.set(STARTER_LABEL_CONFIRM_KEY, JSON.stringify(["b"]));
    expect(clearPendingLabelConfirm("a")).toBe(true);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("returns false and keeps the id when the write fails", () => {
    put(["a"]);
    storage.failSet = true;
    expect(clearPendingLabelConfirm("a")).toBe(false);
    expect(JSON.parse(raw()!)).toEqual(["a"]);
  });

  it("returns false and does not overwrite malformed or unreadable storage", () => {
    for (const [, payload] of MALFORMED) {
      storage.setItem(STARTER_LABEL_CONFIRM_KEY, payload);
      expect(clearPendingLabelConfirm("a"), payload).toBe(false);
      expect(raw()).toBe(payload);
    }
    storage.failGet = true;
    expect(clearPendingLabelConfirm("a")).toBe(false);
  });
});

describe("add → require → clear lifecycle", () => {
  it("gates a product until its label is confirmed", () => {
    expect(requiresLabelConfirm("starter-bifen")).toEqual({ ok: true, required: false });
    expect(addPendingLabelConfirm("starter-bifen")).toBe(true);
    expect(addPendingLabelConfirm("starter-talstar")).toBe(true);
    expect(requiresLabelConfirm("starter-bifen")).toEqual({ ok: true, required: true });
    expect(clearPendingLabelConfirm("starter-bifen")).toBe(true);
    expect(requiresLabelConfirm("starter-bifen")).toEqual({ ok: true, required: false });
    expect(listPendingLabelConfirmIds()).toEqual({ ok: true, ids: ["starter-talstar"] });
  });

  it("stays blocked after storage becomes unreadable, and recovers when it is readable again", () => {
    addPendingLabelConfirm("a");
    storage.failGet = true;
    expect(requiresLabelConfirm("a")).toEqual({ ok: false });
    expect(clearPendingLabelConfirm("a")).toBe(false);
    storage.failGet = false;
    expect(requiresLabelConfirm("a")).toEqual({ ok: true, required: true });
  });
});
