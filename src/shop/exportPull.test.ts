import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopSections } from "../storage";
import type { ApplicationLog } from "../types";
import type { ResolvedShopStoreInfo } from "./resolveShopStore";
import { bumpSessionMutationEpoch, SHOP_SESSION_KEY } from "./session";

// Module-boundary fakes (no source edits, no Firebase):
// - ./RemoteShopStore is replaced by a small in-memory class so exportPull's
//   `instanceof RemoteShopStore` check can be exercised without loading Firebase.
// - ./resolveShopStore is replaced by a mock that returns whatever store info a
//   test sets up.
// The session helpers are real; localStorage is an in-memory stand-in.

vi.mock("./RemoteShopStore", () => {
  class RemoteShopStore {
    readonly mode = "shared" as const;
    getShop = vi.fn();
    ensureUid = vi.fn();
  }
  return { RemoteShopStore };
});

vi.mock("./resolveShopStore", () => ({
  resolveShopStore: vi.fn(),
}));

const { RemoteShopStore } = await import("./RemoteShopStore");
const { resolveShopStore } = await import("./resolveShopStore");
const { resolveExportSections, sharedExportPullHint, shouldPullSharedExport } = await import("./exportPull");

interface FakeRemote {
  mode: "shared";
  getShop: ReturnType<typeof vi.fn>;
  ensureUid: ReturnType<typeof vi.fn>;
}
/** The mocked class above; typed loosely because tsc still sees the real constructor. */
const FakeRemoteCtor = RemoteShopStore as unknown as new () => FakeRemote;

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const SHOP = "SHOPABCD";
const UID = "uid-office";
const NOW = new Date("2026-09-27T00:05:00.000Z");
let storage: MemoryStorage;

function setSession(session: Record<string, unknown> | null) {
  if (session === null) storage.removeItem(SHOP_SESSION_KEY);
  else storage.setItem(SHOP_SESSION_KEY, JSON.stringify(session));
}

function officeSession(shopId = SHOP) {
  setSession({ shopId, role: "office", verifiedAt: NOW.toISOString(), lastActiveAt: NOW.toISOString() });
}

function techSession(shopId = SHOP) {
  setSession({ shopId, role: "tech", verifiedAt: NOW.toISOString(), lastActiveAt: NOW.toISOString() });
}

function makeLog(id: string): ApplicationLog {
  return {
    id,
    createdAt: NOW.toISOString(),
    sampleData: false,
    jobberJobNumber: "",
    jobberAddress: "",
    customerBillingName: "Jane",
    customerBillingAddress: "1 Main",
    serviceAddress: "2 Oak",
    poleLocation: "",
    products: [],
    targetPestOrPurpose: "Ants",
    dateUsed: "2026-09-26",
    personnel: [],
    shopTpclNumber: "1",
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
}

const localSections: ShopSections = {
  logs: [makeLog("local")],
  catalog: [],
  people: [],
  settings: { shopName: "Local", shopTpclNumber: "1", shopTpclLetter: "" },
};

function remoteDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: "1",
    updatedAt: NOW.toISOString(),
    logs: [makeLog("remote")],
    catalog: [],
    people: [],
    settings: { shopName: "Remote", shopTpclNumber: "2", shopTpclLetter: "B" },
    ownerUid: "someone-else",
    members: { [UID]: "office" },
    ...overrides,
  };
}

function newRemote(): FakeRemote {
  const r = new FakeRemoteCtor();
  r.getShop.mockResolvedValue({ ok: true, value: remoteDoc() });
  r.ensureUid.mockResolvedValue(UID);
  return r;
}

function sharedInfo(store: unknown, shopId: string | null = SHOP): ResolvedShopStoreInfo {
  return { store, mode: "shared", shopId, role: "office", locked: false } as unknown as ResolvedShopStoreInfo;
}

function localInfo(): ResolvedShopStoreInfo {
  const store = { mode: "local", getShop: vi.fn() };
  return { store, mode: "local", shopId: null, role: null, locked: false } as unknown as ResolvedShopStoreInfo;
}

const resolveMock = vi.mocked(resolveShopStore);

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  officeSession();
  resolveMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// shouldPullSharedExport
// ---------------------------------------------------------------------------

describe("shouldPullSharedExport", () => {
  it("is true for a shared store with an authenticated office session", () => {
    expect(shouldPullSharedExport(sharedInfo(newRemote()))).toBe(true);
  });

  it("is false in local mode", () => {
    expect(shouldPullSharedExport(localInfo())).toBe(false);
  });

  it("is false when info says shared but the store itself is local", () => {
    const info = sharedInfo({ mode: "local" });
    expect(shouldPullSharedExport(info)).toBe(false);
  });

  it("is false without a shop id", () => {
    expect(shouldPullSharedExport(sharedInfo(newRemote(), null))).toBe(false);
    expect(shouldPullSharedExport(sharedInfo(newRemote(), ""))).toBe(false);
  });

  it("is false for a tech session, a locked (expired) session, or no session", () => {
    techSession();
    expect(shouldPullSharedExport(sharedInfo(newRemote()))).toBe(false);
    setSession({ shopId: SHOP }); // remembered shop, signed out
    expect(shouldPullSharedExport(sharedInfo(newRemote()))).toBe(false);
    setSession(null);
    expect(shouldPullSharedExport(sharedInfo(newRemote()))).toBe(false);
    officeSession();
    vi.setSystemTime(new Date(NOW.getTime() + 9 * 3600_000)); // idle timeout
    expect(shouldPullSharedExport(sharedInfo(newRemote()))).toBe(false);
  });

  it("defaults to resolveShopStore()", () => {
    resolveMock.mockReturnValue(sharedInfo(newRemote()));
    expect(shouldPullSharedExport()).toBe(true);
    expect(resolveMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// sharedExportPullHint
// ---------------------------------------------------------------------------

describe("sharedExportPullHint", () => {
  it("returns the retention note when a shared pull applies", () => {
    const hint = sharedExportPullHint(sharedInfo(newRemote()));
    expect(hint).toContain("Shared shop: CSV/PDF and backup JSON pull a fresh cloud snapshot before download");
    expect(hint).toContain("§ 7.144 two-year premises retention");
    expect(hint).toContain("Settings → Download backup JSON");
  });

  it("returns null otherwise", () => {
    expect(sharedExportPullHint(localInfo())).toBeNull();
    techSession();
    expect(sharedExportPullHint(sharedInfo(newRemote()))).toBeNull();
  });

  it("defaults to resolveShopStore()", () => {
    resolveMock.mockReturnValue(localInfo());
    expect(sharedExportPullHint()).toBeNull();
    expect(resolveMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// resolveExportSections
// ---------------------------------------------------------------------------

describe("resolveExportSections", () => {
  it("returns the local sections unchanged in local mode (no remote call)", async () => {
    const info = localInfo();
    resolveMock.mockReturnValue(info);
    const res = await resolveExportSections(localSections);
    expect(res).toEqual({ kind: "local", sections: localSections });
    expect(res.kind === "local" && res.sections).toBe(localSections);
    expect((info.store as unknown as { getShop: ReturnType<typeof vi.fn> }).getShop).not.toHaveBeenCalled();
  });

  it("returns local for a non-office (tech) session in shared mode", async () => {
    techSession();
    const remote = newRemote();
    resolveMock.mockReturnValue(sharedInfo(remote));
    expect(await resolveExportSections(localSections)).toEqual({ kind: "local", sections: localSections });
    expect(remote.getShop).not.toHaveBeenCalled();
  });

  it("returns the remote snapshot for an office member", async () => {
    const remote = newRemote();
    resolveMock.mockReturnValue(sharedInfo(remote));
    const doc = remoteDoc();
    expect(await resolveExportSections(localSections)).toEqual({
      kind: "shared",
      shopId: SHOP,
      sections: { logs: doc.logs, catalog: doc.catalog, people: doc.people, settings: doc.settings },
    });
    expect(remote.getShop).toHaveBeenCalledOnce();
    expect(remote.ensureUid).toHaveBeenCalledOnce();
  });

  it("returns only the four sections (no auth, members or other doc fields)", async () => {
    const remote = newRemote();
    remote.getShop.mockResolvedValue({ ok: true, value: remoteDoc({ auth: { secret: true } }) });
    resolveMock.mockReturnValue(sharedInfo(remote));
    const res = await resolveExportSections(localSections);
    expect(res.kind).toBe("shared");
    if (res.kind === "shared") expect(Object.keys(res.sections).sort()).toEqual(["catalog", "logs", "people", "settings"]);
  });

  it("accepts the shop owner even without a members entry", async () => {
    const remote = newRemote();
    remote.getShop.mockResolvedValue({ ok: true, value: remoteDoc({ ownerUid: UID, members: undefined }) });
    resolveMock.mockReturnValue(sharedInfo(remote));
    expect((await resolveExportSections(localSections)).kind).toBe("shared");
  });

  it("trims the shop id from the store info", async () => {
    const remote = newRemote();
    resolveMock.mockReturnValue(sharedInfo(remote, `  ${SHOP} `));
    const res = await resolveExportSections(localSections);
    expect(res).toMatchObject({ kind: "shared", shopId: SHOP });
  });

  it("cancels when the session is for a different shop before the pull", async () => {
    officeSession("OTHERSHP");
    const remote = newRemote();
    resolveMock.mockReturnValue(sharedInfo(remote));
    expect(await resolveExportSections(localSections)).toEqual({
      kind: "canceled",
      error: "Shop session is no longer an authenticated office session for this shop — export canceled.",
    });
    expect(remote.getShop).not.toHaveBeenCalled();
  });

  it("falls back to local with the remote error when getShop fails", async () => {
    const remote = newRemote();
    remote.getShop.mockResolvedValue({ ok: false, error: "offline" });
    resolveMock.mockReturnValue(sharedInfo(remote));
    expect(await resolveExportSections(localSections)).toEqual({
      kind: "shared-fallback-local",
      sections: localSections,
      shopId: SHOP,
      error: "offline",
    });
    expect(remote.ensureUid).not.toHaveBeenCalled();
  });

  it("uses a default fallback message when the remote error is empty", async () => {
    const remote = newRemote();
    remote.getShop.mockResolvedValue({ ok: false, error: "" });
    resolveMock.mockReturnValue(sharedInfo(remote));
    const res = await resolveExportSections(localSections);
    expect(res).toMatchObject({
      kind: "shared-fallback-local",
      error: "Could not load the shared shop. Exporting this device's local copy instead — it may be incomplete.",
    });
  });

  describe("cancels when the session changes during getShop", () => {
    const changed = {
      kind: "canceled",
      error: "Shop session changed during the shared pull — export canceled. Unlock and try again.",
    };

    it("session epoch bumped (e.g. leaveShop)", async () => {
      const remote = newRemote();
      remote.getShop.mockImplementation(async () => {
        bumpSessionMutationEpoch();
        return { ok: true, value: remoteDoc() };
      });
      resolveMock.mockReturnValue(sharedInfo(remote));
      expect(await resolveExportSections(localSections)).toEqual(changed);
    });

    it("switched shops", async () => {
      const remote = newRemote();
      remote.getShop.mockImplementation(async () => {
        officeSession("OTHERSHP");
        return { ok: true, value: remoteDoc() };
      });
      resolveMock.mockReturnValue(sharedInfo(remote));
      expect(await resolveExportSections(localSections)).toEqual(changed);
    });

    it("downgraded to tech / signed out", async () => {
      for (const change of [() => techSession(), () => setSession({ shopId: SHOP })]) {
        const remote = newRemote();
        remote.getShop.mockImplementation(async () => {
          change();
          return { ok: true, value: remoteDoc() };
        });
        resolveMock.mockReturnValue(sharedInfo(remote));
        officeSession();
        expect(await resolveExportSections(localSections)).toEqual(changed);
      }
    });

    it("even when getShop failed (does not fall back to local after a session change)", async () => {
      const remote = newRemote();
      remote.getShop.mockImplementation(async () => {
        bumpSessionMutationEpoch();
        return { ok: false, error: "offline" };
      });
      resolveMock.mockReturnValue(sharedInfo(remote));
      expect(await resolveExportSections(localSections)).toEqual(changed);
    });
  });

  it("cancels when the store is not a RemoteShopStore instance", async () => {
    const lookalike = {
      mode: "shared",
      getShop: vi.fn().mockResolvedValue({ ok: true, value: remoteDoc() }),
      ensureUid: vi.fn().mockResolvedValue(UID),
    };
    resolveMock.mockReturnValue(sharedInfo(lookalike));
    expect(await resolveExportSections(localSections)).toEqual({
      kind: "canceled",
      error: "Shared export requires the remote shop store.",
    });
    expect(lookalike.ensureUid).not.toHaveBeenCalled();
  });

  it("cancels with the error message when ensureUid throws", async () => {
    const remote = newRemote();
    remote.ensureUid.mockRejectedValue(new Error("auth/network-request-failed"));
    resolveMock.mockReturnValue(sharedInfo(remote));
    expect(await resolveExportSections(localSections)).toEqual({
      kind: "canceled",
      error: "auth/network-request-failed",
    });
  });

  it("cancels with a default message when ensureUid throws a non-Error", async () => {
    const remote = newRemote();
    remote.ensureUid.mockRejectedValue("nope");
    resolveMock.mockReturnValue(sharedInfo(remote));
    expect(await resolveExportSections(localSections)).toEqual({
      kind: "canceled",
      error: "Could not verify Firebase identity for export.",
    });
  });

  it("cancels when the session changes during ensureUid", async () => {
    const remote = newRemote();
    remote.ensureUid.mockImplementation(async () => {
      bumpSessionMutationEpoch();
      return UID;
    });
    resolveMock.mockReturnValue(sharedInfo(remote));
    expect(await resolveExportSections(localSections)).toEqual({
      kind: "canceled",
      error: "Shop session changed during identity check — export canceled. Unlock and try again.",
    });
  });

  it("cancels a forged local office session that is not office on the shop document", async () => {
    for (const doc of [
      remoteDoc({ members: { [UID]: "tech" } }),
      remoteDoc({ members: {} }),
      remoteDoc({ members: undefined }),
      remoteDoc({ members: { "other-uid": "office" } }),
    ]) {
      const remote = newRemote();
      remote.getShop.mockResolvedValue({ ok: true, value: doc });
      resolveMock.mockReturnValue(sharedInfo(remote));
      expect(await resolveExportSections(localSections)).toEqual({
        kind: "canceled",
        error: "Shared export requires office membership on the shop document — not only a local office session.",
      });
    }
  });
});
