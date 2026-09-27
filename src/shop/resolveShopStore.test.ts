import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirebaseClientConfig } from "./firebaseConfig";
import type { ResolvedShopStoreInfo } from "./resolveShopStore";
import { SESSION_IDLE_MS, SHOP_SESSION_KEY } from "./session";
import type { ShopStore } from "./types";

// Scope: resolveShopStore() branch logic and shopStoreStatusHint() copy.
// - firebaseConfig is mocked at the import boundary (no import.meta.env reads).
// - RemoteShopStore is replaced by a fake class that only records its constructor args,
//   so no Firebase SDK module is ever loaded.
// - session.ts and LocalShopStore run for real on an in-memory localStorage.

const firebase = vi.hoisted(() => ({
  configured: false,
  config: null as FirebaseClientConfig | null,
}));

vi.mock("./firebaseConfig", () => ({
  isFirebaseConfigured: vi.fn(() => firebase.configured),
  getFirebaseConfig: vi.fn(() => firebase.config),
  readFirebaseEnv: vi.fn(() => ({})),
}));

vi.mock("./RemoteShopStore", () => {
  class FakeRemoteShopStore {
    static instances: FakeRemoteShopStore[] = [];
    readonly mode = "shared" as const;
    constructor(
      public config: FirebaseClientConfig,
      public shopId: string,
    ) {
      FakeRemoteShopStore.instances.push(this);
    }
  }
  return { RemoteShopStore: FakeRemoteShopStore };
});

const { resolveShopStore, shopStoreStatusHint } = await import("./resolveShopStore");
const { getLocalShopStore } = await import("./LocalShopStore");
const firebaseConfigModule = await import("./firebaseConfig");
const { RemoteShopStore } = await import("./RemoteShopStore");

type FakeRemote = { config: FirebaseClientConfig; shopId: string; mode: "shared" };
const FakeRemoteClass = RemoteShopStore as unknown as {
  new (config: FirebaseClientConfig, shopId: string): FakeRemote;
  instances: FakeRemote[];
};

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
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

const NOW_MS = Date.parse("2026-09-27T01:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();
const SHOP = "SHOPABCD";
const CONFIG: FirebaseClientConfig = {
  apiKey: "key",
  authDomain: "demo.firebaseapp.com",
  projectId: "demo",
  appId: "1:2:web:3",
};

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  firebase.configured = false;
  firebase.config = null;
  FakeRemoteClass.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function firebaseOn() {
  firebase.configured = true;
  firebase.config = { ...CONFIG };
}

function setSession(session: Record<string, unknown>) {
  storage.setItem(SHOP_SESSION_KEY, JSON.stringify(session));
}

function signIn(role: "office" | "tech", shopId = SHOP) {
  setSession({ shopId, role, verifiedAt: NOW, lastActiveAt: NOW });
}

function info(overrides: Partial<ResolvedShopStoreInfo>): ResolvedShopStoreInfo {
  return {
    store: getLocalShopStore() as ShopStore,
    mode: "local",
    shopId: null,
    role: null,
    locked: false,
    firebaseConfigured: true,
    ...overrides,
  };
}

describe("resolveShopStore", () => {
  it("never loads the real Firebase modules", () => {
    expect(vi.isMockFunction(firebaseConfigModule.isFirebaseConfigured)).toBe(true);
    expect(FakeRemoteClass.instances).toEqual([]);
  });

  it("local-only device without Firebase → local, unlocked", () => {
    const r = resolveShopStore();
    expect(r).toEqual({
      store: getLocalShopStore(),
      mode: "local",
      shopId: null,
      role: null,
      locked: false,
      firebaseConfigured: false,
    });
    expect(r.store).toBe(getLocalShopStore());
  });

  it("local-only device with Firebase configured → local, unlocked, firebaseConfigured", () => {
    firebaseOn();
    const r = resolveShopStore();
    expect(r.mode).toBe("local");
    expect(r.store).toBe(getLocalShopStore());
    expect(r.firebaseConfigured).toBe(true);
    expect(r.locked).toBe(false);
    expect(r.shopId).toBeNull();
    expect(FakeRemoteClass.instances).toHaveLength(0);
  });

  it("authenticated office + Firebase → shared RemoteShopStore(config, shopId)", () => {
    firebaseOn();
    signIn("office");
    const r = resolveShopStore();
    expect(r.mode).toBe("shared");
    expect(r.shopId).toBe(SHOP);
    expect(r.role).toBe("office");
    expect(r.locked).toBe(false);
    expect(r.firebaseConfigured).toBe(true);
    expect(FakeRemoteClass.instances).toHaveLength(1);
    expect(r.store).toBe(FakeRemoteClass.instances[0]);
    expect(FakeRemoteClass.instances[0].config).toEqual(CONFIG);
    expect(FakeRemoteClass.instances[0].shopId).toBe(SHOP);
  });

  it("authenticated tech + Firebase → shared with role tech", () => {
    firebaseOn();
    signIn("tech");
    const r = resolveShopStore();
    expect(r.mode).toBe("shared");
    expect(r.role).toBe("tech");
  });

  it("passes the trimmed shopId to RemoteShopStore", () => {
    firebaseOn();
    signIn("office", `  ${SHOP}  `);
    const r = resolveShopStore();
    expect(r.shopId).toBe(SHOP);
    expect(FakeRemoteClass.instances[0].shopId).toBe(SHOP);
  });

  it("creates a new RemoteShopStore on each shared resolve", () => {
    firebaseOn();
    signIn("office");
    const a = resolveShopStore().store;
    const b = resolveShopStore().store;
    expect(a).not.toBe(b);
    expect(FakeRemoteClass.instances).toHaveLength(2);
  });

  it("authenticated session without Firebase → local, role null, not locked", () => {
    signIn("office");
    const r = resolveShopStore();
    expect(r).toEqual({
      store: getLocalShopStore(),
      mode: "local",
      shopId: SHOP,
      role: null,
      locked: false,
      firebaseConfigured: false,
    });
    expect(FakeRemoteClass.instances).toHaveLength(0);
  });

  it("configured but getFirebaseConfig() null → local fallback, not locked", () => {
    firebase.configured = true;
    firebase.config = null;
    signIn("office");
    const r = resolveShopStore();
    expect(r.mode).toBe("local");
    expect(r.store).toBe(getLocalShopStore());
    expect(r.shopId).toBe(SHOP);
    expect(r.role).toBeNull();
    expect(r.locked).toBe(false);
    expect(r.firebaseConfigured).toBe(true);
    expect(FakeRemoteClass.instances).toHaveLength(0);
  });

  it("remembered shop without PIN → local and locked", () => {
    firebaseOn();
    setSession({ shopId: SHOP });
    const r = resolveShopStore();
    expect(r).toEqual({
      store: getLocalShopStore(),
      mode: "local",
      shopId: SHOP,
      role: null,
      locked: true,
      firebaseConfigured: true,
    });
    expect(firebaseConfigModule.getFirebaseConfig).not.toHaveBeenCalled();
  });

  it("remembered shop without Firebase is still reported locked", () => {
    setSession({ shopId: SHOP });
    const r = resolveShopStore();
    expect(r.locked).toBe(true);
    expect(r.firebaseConfigured).toBe(false);
  });

  it("expired PIN session → local and locked", () => {
    firebaseOn();
    signIn("office");
    vi.setSystemTime(NOW_MS + SESSION_IDLE_MS + 1);
    const r = resolveShopStore();
    expect(r.mode).toBe("local");
    expect(r.locked).toBe(true);
    expect(r.role).toBeNull();
    expect(r.shopId).toBe(SHOP);
    expect(FakeRemoteClass.instances).toHaveLength(0);
  });

  it("invalid stored shopId → treated as not joined", () => {
    firebaseOn();
    setSession({ shopId: "a/b", role: "office", verifiedAt: NOW });
    const r = resolveShopStore();
    expect(r.mode).toBe("local");
    expect(r.shopId).toBeNull();
    expect(r.locked).toBe(false);
  });

  it("corrupt session JSON → local, not joined", () => {
    firebaseOn();
    storage.setItem(SHOP_SESSION_KEY, "{broken");
    const r = resolveShopStore();
    expect(r.mode).toBe("local");
    expect(r.shopId).toBeNull();
    expect(r.locked).toBe(false);
  });
});

describe("shopStoreStatusHint", () => {
  it("Firebase not configured wins over everything else", () => {
    const msg = "This device: local only (Firebase env not set — see .env.example)";
    expect(shopStoreStatusHint(info({ firebaseConfigured: false }))).toBe(msg);
    expect(
      shopStoreStatusHint(info({ firebaseConfigured: false, locked: true, shopId: SHOP })),
    ).toBe(msg);
    expect(
      shopStoreStatusHint(
        info({ firebaseConfigured: false, mode: "shared", shopId: SHOP, role: "office" }),
      ),
    ).toBe(msg);
  });

  it("locked with a shopId → unlock prompt", () => {
    expect(shopStoreStatusHint(info({ locked: true, shopId: SHOP }))).toBe(
      `Shop ${SHOP} remembered — enter role + PIN to unlock`,
    );
  });

  it("shared with shop and role → sync copy", () => {
    expect(shopStoreStatusHint(info({ mode: "shared", shopId: SHOP, role: "tech" }))).toBe(
      `Shop ${SHOP} · tech — logs sync to cloud (outbox retries if offline)`,
    );
  });

  it("falls back to not-joined copy for local or incomplete info", () => {
    const msg = "This device: local only (shared shop not joined)";
    expect(shopStoreStatusHint(info({}))).toBe(msg);
    expect(shopStoreStatusHint(info({ locked: true, shopId: null }))).toBe(msg);
    expect(shopStoreStatusHint(info({ mode: "shared", shopId: SHOP, role: null }))).toBe(msg);
    expect(shopStoreStatusHint(info({ mode: "shared", shopId: null, role: "office" }))).toBe(msg);
    expect(shopStoreStatusHint(info({ mode: "local", shopId: SHOP, role: "office" }))).toBe(msg);
  });

  describe("defaults to resolveShopStore()", () => {
    it("no Firebase", () => {
      expect(shopStoreStatusHint()).toBe(
        "This device: local only (Firebase env not set — see .env.example)",
      );
    });

    it("Firebase, not joined", () => {
      firebaseOn();
      expect(shopStoreStatusHint()).toBe("This device: local only (shared shop not joined)");
    });

    it("Firebase, remembered shop", () => {
      firebaseOn();
      setSession({ shopId: SHOP });
      expect(shopStoreStatusHint()).toBe(`Shop ${SHOP} remembered — enter role + PIN to unlock`);
    });

    it("Firebase, signed in office", () => {
      firebaseOn();
      signIn("office");
      expect(shopStoreStatusHint()).toBe(
        `Shop ${SHOP} · office — logs sync to cloud (outbox retries if offline)`,
      );
    });
  });
});
