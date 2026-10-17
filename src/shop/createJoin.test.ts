import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCatalog, saveLogs, savePeople, saveSettings } from "../storage";
import { makeLog, makeShopProduct } from "../test/fixtures";
import { MemoryStorage } from "../test/memoryStorage";
import { buildShopPinAuth, verifyPin, type ShopPinAuth } from "./pinCrypto";
import { hasMigratedShop, markShopMigrated } from "./migrateMarker";
import {
  getSessionMutationEpoch,
  isSessionAuthenticated,
  loadShopSession,
  saveShopSession,
} from "./session";
import type { ShopDocument, ShopMembers } from "./types";

// Scope: every export of createJoin.ts, i.e. the shared-shop create / join / unlock /
// PIN bootstrap / change-PIN / sign-out / leave flows behind Settings. Real session,
// migrate marker, PIN hashing (pinCrypto) and LocalShopStore + storage.ts run against
// an in-memory localStorage. Firebase is mocked at the module boundary:
// firebaseConfig (configured toggle), firebaseAuth (anonymous uid), pinFunctions (cf1
// callables + VITE_SHOP_PIN_FUNCTIONS toggle) and RemoteShopStore (an in-memory
// Firestore stand-in keyed by shop code that records every put / membership write).

const fb = vi.hoisted(() => ({
  configured: true,
  uid: "uid-me",
  authError: null as unknown,
  fnEnabled: false,
}));

type Grant = { updatedAt: string; members: ShopMembers; ownerUid?: string };
type Fail = { ok: false; error: string; conflict?: boolean };

const cloud = vi.hoisted(() => ({
  docs: new Map<string, ShopDocument>(),
  getError: null as string | null,
  putResult: null as Fail | null,
  memberResult: null as Fail | null,
  puts: [] as { shopId: string; doc: ShopDocument }[],
  memberCalls: [] as { shopId: string; args: Record<string, unknown> }[],
  probes: [] as string[],
  clock: 0,
  onPut: null as null | (() => void),
  onMember: null as null | (() => void),
  codes: [] as string[],
}));

function stamp(): string {
  cloud.clock += 1;
  return `2026-10-17T20:00:${String(cloud.clock).padStart(2, "0")}.000Z`;
}

vi.mock("./firebaseConfig", () => ({
  isFirebaseConfigured: () => fb.configured,
  getFirebaseConfig: () =>
    fb.configured ? { apiKey: "k", authDomain: "d", projectId: "p", appId: "a" } : null,
}));

vi.mock("./firebaseAuth", () => ({
  ensureAnonymousAuth: vi.fn(async () => {
    if (fb.authError !== null) throw fb.authError;
    return { uid: fb.uid };
  }),
}));

const joinShopWithPinFn = vi.fn<(...a: unknown[]) => Promise<{ ok: true; value: Grant } | Fail>>();
const bootstrapShopPinsFn = vi.fn<(...a: unknown[]) => Promise<{ ok: true; value: Grant } | Fail>>();
const changeShopPinsFn = vi.fn<(...a: unknown[]) => Promise<{ ok: true; value: { updatedAt: string } } | Fail>>();
vi.mock("./pinFunctions", () => ({
  shopPinFunctionsEnabled: () => fb.fnEnabled,
  joinShopWithPinFn: (...a: unknown[]) => joinShopWithPinFn(...a),
  bootstrapShopPinsFn: (...a: unknown[]) => bootstrapShopPinsFn(...a),
  changeShopPinsFn: (...a: unknown[]) => changeShopPinsFn(...a),
}));

vi.mock("./shopCode", async (importOriginal) => {
  const real = await importOriginal<typeof import("./shopCode")>();
  return {
    ...real,
    generateShopCode: () => cloud.codes.shift() ?? real.generateShopCode(),
  };
});

vi.mock("./RemoteShopStore", () => ({
  RemoteShopStore: class {
    readonly mode = "shared" as const;
    constructor(
      _config: unknown,
      readonly shopId: string,
    ) {}
    async getShop() {
      cloud.probes.push(this.shopId);
      if (cloud.getError) return { ok: false, error: cloud.getError };
      const doc = cloud.docs.get(this.shopId);
      if (!doc) {
        return {
          ok: false,
          error: `Shop "${this.shopId}" was not found in Firestore (shops/${this.shopId}).`,
        };
      }
      return { ok: true, value: structuredClone(doc) };
    }
    async putShop(doc: ShopDocument) {
      cloud.puts.push({ shopId: this.shopId, doc: structuredClone(doc) });
      cloud.onPut?.();
      if (cloud.putResult) return cloud.putResult;
      const updatedAt = stamp();
      cloud.docs.set(this.shopId, { ...structuredClone(doc), updatedAt });
      return { ok: true, value: { updatedAt } };
    }
    async addMembership(args: {
      expectedUpdatedAt: string;
      uid: string;
      role: "office" | "tech";
      claimOwnerIfMissing?: boolean;
    }) {
      cloud.memberCalls.push({ shopId: this.shopId, args: { ...args } });
      cloud.onMember?.();
      if (cloud.memberResult) return cloud.memberResult;
      const doc = cloud.docs.get(this.shopId)!;
      const members = { ...(doc.members ?? {}), [args.uid]: args.role };
      const ownerUid = doc.ownerUid ?? (args.claimOwnerIfMissing ? args.uid : undefined);
      const updatedAt = stamp();
      cloud.docs.set(this.shopId, { ...doc, members, ownerUid, updatedAt });
      return { ok: true, value: { updatedAt, members, ownerUid } };
    }
  },
}));

const cj = await import("./createJoin");

vi.setConfig({ testTimeout: 15_000 });

const OFFICE_PIN = "1234";
const TECH_PIN = "5678";
const PINS = {
  officePin: OFFICE_PIN,
  officePinConfirm: OFFICE_PIN,
  techPin: TECH_PIN,
  techPinConfirm: TECH_PIN,
};
const CODE = "SHOPABCD";
const ENV_ERROR =
  "Firebase env is not configured. Copy .env.example (VITE_FIREBASE_*) and rebuild to use a shared shop.";

let AUTH: ShopPinAuth;
let store: MemoryStorage;

beforeAll(async () => {
  AUTH = await buildShopPinAuth(OFFICE_PIN, TECH_PIN);
});

function emptyDoc(over: Partial<ShopDocument> = {}): ShopDocument {
  return {
    version: "1.2",
    updatedAt: "2026-10-17T19:00:00.000Z",
    logs: [],
    catalog: [],
    people: [],
    settings: { shopName: "", shopTpclNumber: "", shopTpclLetter: "" },
    ...over,
  };
}

/** A legacy (client-verify) shop with readable PIN hashes and one owner. */
function seedShop(over: Partial<ShopDocument> = {}, id = CODE): ShopDocument {
  const doc = emptyDoc({
    auth: AUTH,
    ownerUid: "uid-owner",
    members: { "uid-owner": "office" },
    logs: [makeLog({ id: "cloud-log" })],
    ...over,
  });
  cloud.docs.set(id, doc);
  return doc;
}

function seedLocalData() {
  expect(saveLogs([makeLog({ id: "local-1" }), makeLog({ id: "local-2" })])).toBe(true);
  expect(saveCatalog([makeShopProduct()])).toBe(true);
  expect(savePeople([])).toBe(true);
  expect(saveSettings({ shopName: "Acme Pest", shopTpclNumber: "12345", shopTpclLetter: "B" })).toBe(true);
}

function signedIn(role: "office" | "tech", shopId = CODE) {
  const now = new Date().toISOString();
  expect(saveShopSession({ shopId, role, verifiedAt: now, lastActiveAt: now })).toBe(true);
}

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal("localStorage", store);
  Object.assign(fb, { configured: true, uid: "uid-me", authError: null, fnEnabled: false });
  cloud.docs.clear();
  Object.assign(cloud, {
    getError: null,
    putResult: null,
    memberResult: null,
    puts: [],
    memberCalls: [],
    probes: [],
    clock: 0,
    onPut: null,
    onMember: null,
    codes: [],
  });
  joinShopWithPinFn.mockReset();
  bootstrapShopPinsFn.mockReset();
  changeShopPinsFn.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// shopDocumentHasMeaningfulData
// ---------------------------------------------------------------------------

describe("shopDocumentHasMeaningfulData", () => {
  it("is false for an empty doc and for a doc holding only example catalog seeds", () => {
    expect(cj.shopDocumentHasMeaningfulData(emptyDoc())).toBe(false);
    const examples = emptyDoc({
      catalog: [makeShopProduct({ id: "example-rtu-insecticide", isExample: true })],
    });
    expect(cj.shopDocumentHasMeaningfulData(examples)).toBe(false);
  });

  it.each([
    ["a log", { logs: [makeLog()] }],
    ["a person", { people: [{ id: "p", name: "P", licenseNumber: "", roleTags: [], licenseExpiry: "", ceDueDate: "" }] }],
    ["a shop name", { settings: { shopName: "Acme", shopTpclNumber: "", shopTpclLetter: "" } }],
    ["a TPCL number", { settings: { shopName: " ", shopTpclNumber: "123", shopTpclLetter: "" } }],
    ["a real catalog product", { catalog: [makeShopProduct()] }],
  ] as const)("is true when the doc has %s", (_label, over) => {
    expect(cj.shopDocumentHasMeaningfulData(emptyDoc(over as Partial<ShopDocument>))).toBe(true);
  });

  it("ignores whitespace-only settings", () => {
    const doc = emptyDoc({ settings: { shopName: "  ", shopTpclNumber: "\t", shopTpclLetter: "" } });
    expect(cj.shopDocumentHasMeaningfulData(doc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createShop
// ---------------------------------------------------------------------------

describe("createShop", () => {
  it("fails closed when Firebase is not configured", async () => {
    fb.configured = false;
    expect(await cj.createShop(PINS)).toEqual({ ok: false, error: ENV_ERROR });
    expect(cloud.puts).toEqual([]);
  });

  it.each([
    ["office PIN too short", { officePin: "12", officePinConfirm: "12" }, "Office PIN must be 4–8 digits."],
    ["office PIN not digits", { officePin: "12ab", officePinConfirm: "12ab" }, "Office PIN must be 4–8 digits."],
    ["office confirm mismatch", { officePinConfirm: "1235" }, "Office PIN confirmation does not match."],
    ["tech PIN too long", { techPin: "123456789", techPinConfirm: "123456789" }, "Tech PIN must be 4–8 digits."],
    ["tech confirm mismatch", { techPinConfirm: "5679" }, "Tech PIN confirmation does not match."],
    ["same PIN for both roles", { techPin: OFFICE_PIN, techPinConfirm: OFFICE_PIN }, "Office and tech PINs must be different."],
  ])("rejects %s before touching Firebase", async (_label, over, error) => {
    expect(await cj.createShop({ ...PINS, ...over })).toEqual({ ok: false, error });
    expect(cloud.probes).toEqual([]);
  });

  it("refuses when this device already joined a shop", async () => {
    saveShopSession({ shopId: "OTHER234" });
    const r = await cj.createShop(PINS);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already joined a shop/) });
    expect(cloud.probes).toEqual([]);
  });

  it("reports an anonymous-auth failure with the console hint", async () => {
    fb.authError = new Error("auth/operation-not-allowed.");
    expect(await cj.createShop(PINS)).toEqual({
      ok: false,
      error: "auth/operation-not-allowed. Enable Anonymous Auth in the Firebase console for this project.",
    });
    fb.authError = "not an Error";
    expect(await cj.createShop(PINS)).toMatchObject({
      error: "Could not sign in anonymously to Firebase. Enable Anonymous Auth in the Firebase console for this project.",
    });
  });

  it("uploads the local snapshot with owner membership and PIN hashes, then signs in as office", async () => {
    seedLocalData();
    cloud.codes = [CODE];
    const r = await cj.createShop(PINS);
    expect(r).toEqual({
      ok: true,
      shopId: CODE,
      role: "office",
      migrated: true,
      message: `Shop created as office owner. Share code ${CODE} and the tech PIN with field devices — never the office PIN.`,
    });
    expect(cloud.puts).toHaveLength(1);
    const { shopId, doc } = cloud.puts[0]!;
    expect(shopId).toBe(CODE);
    expect(doc.logs.map((l) => l.id).sort()).toEqual(["local-1", "local-2"]);
    expect(doc.settings.shopName).toBe("Acme Pest");
    expect(doc.ownerUid).toBe("uid-me");
    expect(doc.members).toEqual({ "uid-me": "office" });
    // Hashes, never plaintext, and they verify for the right role only.
    expect(JSON.stringify(doc)).not.toMatch(/"1234"|"5678"/);
    expect(await verifyPin(OFFICE_PIN, doc.auth!.officePin)).toBe(true);
    expect(await verifyPin(TECH_PIN, doc.auth!.techPin)).toBe(true);
    expect(await verifyPin(TECH_PIN, doc.auth!.officePin)).toBe(false);

    const session = loadShopSession();
    expect(session).toMatchObject({ shopId: CODE, role: "office" });
    expect(isSessionAuthenticated(session)).toBe(true);
    expect(hasMigratedShop(CODE)).toBe(true);
    expect(changeShopPinsFn).not.toHaveBeenCalled();
  });

  it("retries when the generated code is already taken", async () => {
    seedShop({}, "TAKEN234");
    cloud.codes = ["TAKEN234", "FREE2345"];
    const r = await cj.createShop(PINS);
    expect(r).toMatchObject({ ok: true, shopId: "FREE2345" });
    expect(cloud.probes.slice(0, 2)).toEqual(["TAKEN234", "FREE2345"]);
    expect(cloud.puts.map((p) => p.shopId)).toEqual(["FREE2345"]);
  });

  it("gives up after six taken codes without writing anything", async () => {
    const codes = ["TAKENAAA", "TAKENBBB", "TAKENCCC", "TAKENDDD", "TAKENEEE", "TAKENFFF"];
    for (const c of codes) seedShop({}, c);
    cloud.codes = [...codes];
    const r = await cj.createShop(PINS);
    // Current wording is the last probe message ("…retrying…") even though it stopped.
    expect(r).toEqual({ ok: false, error: "Shop code collision; retrying…" });
    expect(cloud.probes).toEqual(codes);
    expect(cloud.puts).toEqual([]);
    expect(loadShopSession().shopId).toBe("");
  });

  it("stops on a probe error that is not 'not found'", async () => {
    cloud.getError = "permission-denied";
    expect(await cj.createShop(PINS)).toEqual({ ok: false, error: "permission-denied" });
    expect(cloud.puts).toEqual([]);
  });

  it("does not save a session when the cloud write fails", async () => {
    cloud.codes = [CODE];
    cloud.putResult = { ok: false, error: "quota exceeded" };
    expect(await cj.createShop(PINS)).toEqual({ ok: false, error: "quota exceeded" });
    expect(loadShopSession().shopId).toBe("");
    expect(hasMigratedShop(CODE)).toBe(false);
  });

  it("names the shop code when the cloud write worked but the device session could not be saved", async () => {
    cloud.codes = [CODE];
    cloud.onPut = () => {
      store.failSet = true;
    };
    const r = await cj.createShop(PINS);
    expect(r).toEqual({
      ok: false,
      error: `Shop ${CODE} was created in the cloud, but this device could not save the session (storage blocked).`,
    });
  });

  it("with shop functions on, hands the PINs to the server right after create", async () => {
    fb.fnEnabled = true;
    cloud.codes = [CODE];
    changeShopPinsFn.mockResolvedValue({ ok: true, value: { updatedAt: stamp() } });
    expect(await cj.createShop(PINS)).toMatchObject({ ok: true, shopId: CODE });
    expect(changeShopPinsFn).toHaveBeenCalledWith(expect.anything(), CODE, OFFICE_PIN, TECH_PIN);
  });

  it("with shop functions on, a failed PIN hand-off tells the office how to finish and saves no session", async () => {
    fb.fnEnabled = true;
    cloud.codes = [CODE];
    changeShopPinsFn.mockResolvedValue({ ok: false, error: "internal" });
    const r = await cj.createShop(PINS);
    expect(r).toEqual({
      ok: false,
      error: `Shop ${CODE} was created, but the shop server could not secure its PINs (internal). Join shop ${CODE} with the office PIN to finish setup; that also secures the PINs.`,
    });
    expect(loadShopSession().shopId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// joinShop
// ---------------------------------------------------------------------------

describe("joinShop: guards", () => {
  it("fails closed when Firebase is not configured", async () => {
    fb.configured = false;
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({ ok: false, error: ENV_ERROR });
  });

  it("refuses while signed in to a shop, but allows re-joining a remembered (signed-out) shop", async () => {
    seedShop();
    signedIn("tech");
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({
      ok: false,
      error: "This device already joined a shop. Sign out or leave before joining another.",
    });
    saveShopSession({ shopId: CODE });
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({ ok: true });
  });

  it("rejects an unknown role", async () => {
    const r = await cj.joinShop(CODE, { role: "admin" as "office", pin: TECH_PIN });
    expect(r).toEqual({ ok: false, error: "Choose office or tech." });
  });

  it.each(["", "   ", "A/B", "..", "__X__"])("rejects invalid shop code %j", async (code) => {
    const r = await cj.joinShop(code, { role: "tech", pin: TECH_PIN });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^That shop code is not valid/) });
    expect(cloud.probes).toEqual([]);
  });

  it("trims and uppercases the typed code", async () => {
    seedShop();
    const r = await cj.joinShop("  shopabcd ", { role: "tech", pin: TECH_PIN });
    expect(r).toMatchObject({ ok: true, shopId: CODE });
    expect(cloud.probes).toEqual([CODE]);
  });

  it("never invents a shop for an unknown code", async () => {
    const r = await cj.joinShop("NOPE2345", { role: "tech", pin: TECH_PIN });
    expect(r).toEqual({
      ok: false,
      error: "No shop found for code NOPE2345. Check the code with the office — this app will not invent a shop.",
    });
    expect(cloud.puts).toEqual([]);
    expect(loadShopSession().shopId).toBe("");
  });

  it("passes through other read errors", async () => {
    cloud.getError = "unavailable";
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({ ok: false, error: "unavailable" });
  });

  it("reports anonymous-auth failure", async () => {
    fb.authError = new Error("network down.");
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^network down\. Enable Anonymous Auth/),
    });
  });
});

describe("joinShop: PIN check (client verify)", () => {
  it("blocks a shop whose PIN auth is unreadable instead of treating it as missing", async () => {
    seedShop({ auth: undefined, authUnreadable: true });
    const r = await cj.joinShop(CODE, { role: "office", pin: OFFICE_PIN });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/PIN auth is corrupt or unreadable/) });
    expect(cloud.memberCalls).toEqual([]);
  });

  it("flags pins-missing for a shop with no PINs yet", async () => {
    seedShop({ auth: undefined });
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({
      ok: false,
      error: "This shop has no PINs yet. An office device must set office and tech PINs before unlock/join.",
      reason: "pins-missing",
    });
  });

  it("rejects a malformed PIN", async () => {
    seedShop();
    expect(await cj.joinShop(CODE, { role: "tech", pin: "12" })).toEqual({
      ok: false,
      error: "PIN must be 4–8 digits.",
    });
  });

  it("rejects the wrong PIN, including the other role's PIN, and writes nothing", async () => {
    seedShop();
    for (const input of [
      { role: "tech" as const, pin: "9999" },
      { role: "tech" as const, pin: OFFICE_PIN },
      { role: "office" as const, pin: TECH_PIN },
    ]) {
      expect(await cj.joinShop(CODE, input)).toEqual({
        ok: false,
        error: "Incorrect PIN for that role. Try again or ask the office.",
      });
    }
    expect(cloud.memberCalls).toEqual([]);
    expect(cloud.puts).toEqual([]);
    expect(loadShopSession().shopId).toBe("");
  });

  it("explains that this build can't check server-held PINs", async () => {
    seedShop({ auth: undefined, pinsConfigured: true });
    const r = await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^This shop's PINs are checked by the shop server/) });
  });

  it("tech join: adds this device as a tech member and saves a tech session", async () => {
    const doc = seedShop();
    const r = await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN });
    expect(r).toEqual({ ok: true, shopId: CODE, role: "tech", migrated: false, hint: undefined, message: `Joined ${CODE} as tech.` });
    expect(cloud.memberCalls).toEqual([
      {
        shopId: CODE,
        args: { expectedUpdatedAt: doc.updatedAt, uid: "uid-me", role: "tech", claimOwnerIfMissing: false },
      },
    ]);
    expect(cloud.docs.get(CODE)!.members).toEqual({ "uid-owner": "office", "uid-me": "tech" });
    expect(loadShopSession()).toMatchObject({ shopId: CODE, role: "tech" });
    expect(hasMigratedShop(CODE)).toBe(true);
  });

  it("office join on a legacy shop with no owner claims ownership", async () => {
    seedShop({ ownerUid: undefined, members: undefined });
    expect(await cj.joinShop(CODE, { role: "office", pin: OFFICE_PIN })).toMatchObject({ ok: true, role: "office" });
    expect(cloud.memberCalls[0]!.args).toMatchObject({ role: "office", claimOwnerIfMissing: true });
    expect(cloud.docs.get(CODE)!.ownerUid).toBe("uid-me");
  });

  it("skips the membership write when already a member with that role", async () => {
    seedShop({ members: { "uid-owner": "office", "uid-me": "tech" } });
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({ ok: true });
    expect(cloud.memberCalls).toEqual([]);
  });

  it("passes through a membership write conflict without saving a session", async () => {
    seedShop();
    cloud.memberResult = { ok: false, error: "Shop was updated elsewhere; reload and try again.", conflict: true };
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({
      ok: false,
      error: "Shop was updated elsewhere; reload and try again.",
    });
    expect(loadShopSession().shopId).toBe("");
  });
});

describe("joinShop: one-time local upload", () => {
  it("uploads local data once when the shop is empty, keeping PINs and membership", async () => {
    seedLocalData();
    seedShop({ logs: [] });
    const r = await cj.joinShop(CODE, { role: "office", pin: OFFICE_PIN });
    expect(r).toMatchObject({
      ok: true,
      migrated: true,
      message: `Joined ${CODE} as office. Local data was uploaded once (shop was empty).`,
    });
    expect(cloud.puts).toHaveLength(1);
    const put = cloud.puts[0]!.doc;
    expect(put.logs.map((l) => l.id).sort()).toEqual(["local-1", "local-2"]);
    expect(put.auth).toEqual(AUTH);
    expect(put.ownerUid).toBe("uid-owner");
    expect(put.members).toEqual({ "uid-owner": "office", "uid-me": "office" });
    // CAS against the post-membership stamp, not the stale read.
    expect(cloud.memberCalls).toHaveLength(1);
    expect(put.updatedAt).toBe("2026-10-17T20:00:01.000Z");
    expect(hasMigratedShop(CODE)).toBe(true);
  });

  it("an empty shop with only example catalog seeds still counts as empty", async () => {
    seedLocalData();
    seedShop({ logs: [], catalog: [makeShopProduct({ id: "example-rtu-insecticide", isExample: true })] });
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({ ok: true, migrated: true });
  });

  it("never overwrites a shop that already has cloud data, and says so", async () => {
    seedLocalData();
    seedShop();
    const r = await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN });
    expect(r).toMatchObject({ ok: true, migrated: false, message: `Joined ${CODE} as tech.` });
    expect(r.ok && r.hint).toMatch(/^This shop already has cloud data\. Local data on this device was not uploaded\./);
    expect(cloud.puts).toEqual([]);
    expect(hasMigratedShop(CODE)).toBe(true);
  });

  it("does not upload twice from the same device", async () => {
    seedLocalData();
    seedShop({ logs: [] });
    markShopMigrated(CODE);
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({ ok: true, migrated: false });
    expect(cloud.puts).toEqual([]);
  });

  it("an empty device joining an empty shop uploads nothing", async () => {
    seedShop({ logs: [] });
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({ ok: true, migrated: false, hint: undefined });
    expect(cloud.puts).toEqual([]);
  });

  it("a failed upload returns the error and saves no session", async () => {
    seedLocalData();
    seedShop({ logs: [] });
    cloud.putResult = { ok: false, error: "Shop was updated elsewhere; reload and try again.", conflict: true };
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({
      ok: false,
      error: "Shop was updated elsewhere; reload and try again.",
    });
    expect(loadShopSession().shopId).toBe("");
    expect(hasMigratedShop(CODE)).toBe(false);
  });
});

describe("joinShop: shop server (VITE_SHOP_PIN_FUNCTIONS=1)", () => {
  beforeEach(() => {
    fb.fnEnabled = true;
  });

  it("lets the server verify the PIN and grant membership", async () => {
    seedShop({ auth: undefined, pinsConfigured: true });
    joinShopWithPinFn.mockResolvedValue({
      ok: true,
      value: { updatedAt: stamp(), members: { "uid-owner": "office", "uid-me": "tech" } },
    });
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({ ok: true, role: "tech" });
    expect(joinShopWithPinFn).toHaveBeenCalledWith(expect.anything(), CODE, "tech", TECH_PIN);
    expect(cloud.memberCalls).toEqual([]);
    expect(loadShopSession()).toMatchObject({ shopId: CODE, role: "tech" });
  });

  it("passes through a server PIN rejection and saves no session", async () => {
    seedShop({ auth: undefined, pinsConfigured: true });
    joinShopWithPinFn.mockResolvedValue({ ok: false, error: "Incorrect PIN." });
    expect(await cj.joinShop(CODE, { role: "tech", pin: "9999" })).toEqual({ ok: false, error: "Incorrect PIN." });
    expect(loadShopSession().shopId).toBe("");
  });

  it("checks PIN format before calling the server", async () => {
    seedShop({ auth: undefined, pinsConfigured: true });
    expect(await cj.joinShop(CODE, { role: "tech", pin: "1" })).toEqual({ ok: false, error: "PIN must be 4–8 digits." });
    expect(joinShopWithPinFn).not.toHaveBeenCalled();
  });

  it("flags pins-missing without calling the server", async () => {
    seedShop({ auth: undefined });
    expect(await cj.joinShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({ ok: false, reason: "pins-missing" });
    expect(joinShopWithPinFn).not.toHaveBeenCalled();
  });

  it("a one-time upload after a server join never re-exposes legacy PIN hashes", async () => {
    seedLocalData();
    seedShop({ logs: [] }); // legacy hashes still readable before the server join
    joinShopWithPinFn.mockResolvedValue({
      ok: true,
      value: { updatedAt: "2026-10-17T20:30:00.000Z", members: { "uid-owner": "office", "uid-me": "office" }, ownerUid: "uid-owner" },
    });
    expect(await cj.joinShop(CODE, { role: "office", pin: OFFICE_PIN })).toMatchObject({ ok: true, migrated: true });
    const put = cloud.puts[0]!.doc;
    expect(put.auth).toBeUndefined();
    expect(put.pinsConfigured).toBe(true);
    expect(put.updatedAt).toBe("2026-10-17T20:30:00.000Z");
    expect(put.members).toEqual({ "uid-owner": "office", "uid-me": "office" });
  });
});

// ---------------------------------------------------------------------------
// signInShop (unlock)
// ---------------------------------------------------------------------------

describe("signInShop", () => {
  it("uses the remembered shop code when none is typed, and saves the role session", async () => {
    seedShop({ members: { "uid-owner": "office", "uid-me": "tech" } });
    saveShopSession({ shopId: CODE });
    expect(await cj.signInShop("", { role: "tech", pin: TECH_PIN })).toEqual({
      ok: true,
      shopId: CODE,
      role: "tech",
      message: `Signed in to ${CODE} as tech.`,
    });
    expect(isSessionAuthenticated(loadShopSession())).toBe(true);
    expect(cloud.puts).toEqual([]);
  });

  it("does not re-run the local upload", async () => {
    seedLocalData();
    seedShop({ logs: [] });
    expect(await cj.signInShop(CODE, { role: "office", pin: OFFICE_PIN })).toMatchObject({ ok: true });
    expect(cloud.puts).toEqual([]);
  });

  it("rejects a blank code when no shop is remembered", async () => {
    expect(await cj.signInShop("", { role: "tech", pin: TECH_PIN })).toEqual({
      ok: false,
      error: "Enter a valid shop code.",
    });
  });

  it("rejects a bad role, unknown shop, unreadable auth and wrong PIN", async () => {
    expect(await cj.signInShop(CODE, { role: "x" as "tech", pin: TECH_PIN })).toEqual({ ok: false, error: "Choose office or tech." });
    expect(await cj.signInShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({
      ok: false,
      error: `No shop found for code ${CODE}. Check the code with the office.`,
    });
    seedShop({ auth: undefined, authUnreadable: true });
    expect(await cj.signInShop(CODE, { role: "tech", pin: TECH_PIN })).toMatchObject({
      error: expect.stringMatching(/sign-in cannot treat this as missing PINs/),
    });
    seedShop();
    expect(await cj.signInShop(CODE, { role: "tech", pin: "0000" })).toMatchObject({
      error: "Incorrect PIN for that role. Try again or ask the office.",
    });
    expect(loadShopSession().shopId).toBe("");
  });

  it("is cancelled if the device leaves the shop while the PIN check is in flight", async () => {
    seedShop();
    saveShopSession({ shopId: CODE });
    cloud.onMember = () => {
      expect(cj.leaveShop()).toMatchObject({ ok: true });
    };
    const before = getSessionMutationEpoch();
    expect(await cj.signInShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({
      ok: false,
      error: "Sign-in cancelled — shop session was left on this device.",
    });
    expect(getSessionMutationEpoch()).toBe(before + 1);
    expect(loadShopSession().shopId).toBe("");
  });

  it("names the shop when the PIN was right but the session could not be saved", async () => {
    seedShop();
    cloud.onMember = () => {
      store.failSet = true;
    };
    expect(await cj.signInShop(CODE, { role: "tech", pin: TECH_PIN })).toEqual({
      ok: false,
      error: `Signed in to ${CODE}, but this device could not save the session (storage blocked).`,
    });
  });
});

// ---------------------------------------------------------------------------
// bootstrapShopPins (pre-PIN shops)
// ---------------------------------------------------------------------------

describe("bootstrapShopPins", () => {
  it("validates PINs and the shop code first", async () => {
    expect(await cj.bootstrapShopPins(CODE, { ...PINS, techPinConfirm: "0000" })).toEqual({
      ok: false,
      error: "Tech PIN confirmation does not match.",
    });
    expect(await cj.bootstrapShopPins("", PINS)).toEqual({ ok: false, error: "Enter a valid shop code." });
    expect(cloud.probes).toEqual([]);
  });

  it("refuses a shop that already has PINs (readable or on the server)", async () => {
    seedShop();
    const msg = { ok: false, error: "This shop already has PINs. Sign in with office or tech PIN instead." };
    expect(await cj.bootstrapShopPins(CODE, PINS)).toEqual(msg);
    seedShop({ auth: undefined, pinsConfigured: true });
    expect(await cj.bootstrapShopPins(CODE, PINS)).toEqual(msg);
    expect(cloud.puts).toEqual([]);
  });

  it("refuses to overwrite unreadable PIN auth", async () => {
    seedShop({ auth: undefined, authUnreadable: true });
    expect(await cj.bootstrapShopPins(CODE, PINS)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/must not be overwritten/),
    });
  });

  it("refuses a device that is not the owner or an office member", async () => {
    seedShop({ auth: undefined, members: { "uid-owner": "office", "uid-me": "tech" } });
    expect(await cj.bootstrapShopPins(CODE, PINS)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^This shop already has an owner\/members\./),
    });
    expect(cloud.puts).toEqual([]);
  });

  it("legacy: writes PIN hashes, keeps the owner, adds this device as office and signs in", async () => {
    seedShop({ auth: undefined, members: { "uid-owner": "office", "uid-me": "office" } });
    saveShopSession({ shopId: CODE });
    expect(await cj.bootstrapShopPins("", PINS)).toEqual({
      ok: true,
      shopId: CODE,
      role: "office",
      message: `PINs set for ${CODE}. You are signed in as office owner. Share the tech PIN with field devices.`,
    });
    const put = cloud.puts[0]!.doc;
    expect(put.ownerUid).toBe("uid-owner");
    expect(put.members).toEqual({ "uid-owner": "office", "uid-me": "office" });
    expect(await verifyPin(OFFICE_PIN, put.auth!.officePin)).toBe(true);
    expect(loadShopSession()).toMatchObject({ shopId: CODE, role: "office" });
    expect(hasMigratedShop(CODE)).toBe(true);
  });

  it("legacy: a shop with no owner yet is claimed by this device", async () => {
    seedShop({ auth: undefined, ownerUid: undefined, members: undefined });
    expect(await cj.bootstrapShopPins(CODE, PINS)).toMatchObject({ ok: true });
    expect(cloud.puts[0]!.doc).toMatchObject({ ownerUid: "uid-me", members: { "uid-me": "office" } });
  });

  it("legacy: a failed write saves no session", async () => {
    seedShop({ auth: undefined, ownerUid: undefined, members: undefined });
    cloud.putResult = { ok: false, error: "permission-denied" };
    expect(await cj.bootstrapShopPins(CODE, PINS)).toEqual({ ok: false, error: "permission-denied" });
    expect(loadShopSession().shopId).toBe("");
  });

  it("shop server: calls the bootstrap function instead of writing hashes", async () => {
    fb.fnEnabled = true;
    seedShop({ auth: undefined, ownerUid: undefined, members: undefined });
    bootstrapShopPinsFn.mockResolvedValue({ ok: true, value: { updatedAt: stamp(), members: { "uid-me": "office" } } });
    expect(await cj.bootstrapShopPins(CODE, PINS)).toMatchObject({ ok: true, role: "office" });
    expect(bootstrapShopPinsFn).toHaveBeenCalledWith(expect.anything(), CODE, OFFICE_PIN, TECH_PIN);
    expect(cloud.puts).toEqual([]);
    bootstrapShopPinsFn.mockResolvedValue({ ok: false, error: "already-exists" });
    expect(await cj.bootstrapShopPins(CODE, PINS)).toEqual({ ok: false, error: "already-exists" });
  });
});

// ---------------------------------------------------------------------------
// changeShopPins
// ---------------------------------------------------------------------------

describe("changeShopPins", () => {
  it("requires a signed-in office session", async () => {
    const err = { ok: false, error: "Sign in as office to change PINs." };
    expect(await cj.changeShopPins(PINS)).toEqual(err);
    saveShopSession({ shopId: CODE });
    expect(await cj.changeShopPins(PINS)).toEqual(err);
    signedIn("tech");
    expect(await cj.changeShopPins(PINS)).toEqual(err);
    expect(cloud.probes).toEqual([]);
  });

  it("validates the new PINs", async () => {
    signedIn("office");
    expect(await cj.changeShopPins({ ...PINS, techPin: OFFICE_PIN, techPinConfirm: OFFICE_PIN })).toEqual({
      ok: false,
      error: "Office and tech PINs must be different.",
    });
  });

  it("refuses a device that is a tech member on the shop doc", async () => {
    signedIn("office");
    seedShop({ members: { "uid-owner": "office", "uid-me": "tech" } });
    expect(await cj.changeShopPins(PINS)).toEqual({ ok: false, error: "Only the office owner/members can change PINs." });
    expect(cloud.puts).toEqual([]);
  });

  it("legacy: replaces both hashes so the old PINs stop working", async () => {
    signedIn("office");
    seedShop({ members: { "uid-owner": "office", "uid-me": "office" } });
    const next = { officePin: "2468", officePinConfirm: "2468", techPin: "1357", techPinConfirm: "1357" };
    expect(await cj.changeShopPins(next)).toEqual({
      ok: true,
      shopId: CODE,
      role: "office",
      message: "Office and tech PINs updated. Share the new tech PIN with field devices.",
    });
    const auth = cloud.puts[0]!.doc.auth!;
    expect(await verifyPin("2468", auth.officePin)).toBe(true);
    expect(await verifyPin("1357", auth.techPin)).toBe(true);
    expect(await verifyPin(OFFICE_PIN, auth.officePin)).toBe(false);
    expect(await verifyPin(TECH_PIN, auth.techPin)).toBe(false);
    expect(cloud.puts[0]!.doc.members).toEqual({ "uid-owner": "office", "uid-me": "office" });
  });

  it("legacy: explains when this build can't change server-held PINs", async () => {
    signedIn("office");
    seedShop({ auth: undefined, pinsConfigured: true, ownerUid: "uid-me", members: { "uid-me": "office" } });
    expect(await cj.changeShopPins(PINS)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^This shop's PINs are checked by the shop server/),
    });
  });

  it("passes through read and write errors", async () => {
    signedIn("office");
    cloud.getError = "unavailable";
    expect(await cj.changeShopPins(PINS)).toEqual({ ok: false, error: "unavailable" });
    cloud.getError = null;
    seedShop({ ownerUid: "uid-me", members: { "uid-me": "office" } });
    cloud.putResult = { ok: false, error: "permission-denied" };
    expect(await cj.changeShopPins(PINS)).toEqual({ ok: false, error: "permission-denied" });
  });

  it("shop server: delegates to changeShopPins on the server", async () => {
    fb.fnEnabled = true;
    signedIn("office");
    seedShop({ auth: undefined, pinsConfigured: true, ownerUid: "uid-me", members: { "uid-me": "office" } });
    changeShopPinsFn.mockResolvedValue({ ok: true, value: { updatedAt: stamp() } });
    expect(await cj.changeShopPins(PINS)).toMatchObject({ ok: true });
    expect(changeShopPinsFn).toHaveBeenCalledWith(expect.anything(), CODE, OFFICE_PIN, TECH_PIN);
    expect(cloud.puts).toEqual([]);
    changeShopPinsFn.mockResolvedValue({ ok: false, error: "permission-denied" });
    expect(await cj.changeShopPins(PINS)).toEqual({ ok: false, error: "permission-denied" });
  });
});

// ---------------------------------------------------------------------------
// signOutShop / leaveShop
// ---------------------------------------------------------------------------

describe("signOutShop and leaveShop", () => {
  it("both refuse when the device is not joined", () => {
    const err = { ok: false, error: "This device is not joined to a shared shop." };
    expect(cj.signOutShop()).toEqual(err);
    expect(cj.leaveShop()).toEqual(err);
  });

  it("sign-out drops the role but remembers the shop code", () => {
    signedIn("tech");
    expect(cj.signOutShop()).toEqual({
      ok: true,
      shopId: CODE,
      message: `Signed out of ${CODE}. Shop code is remembered on this device; enter role + PIN to unlock.`,
    });
    expect(loadShopSession()).toEqual({ shopId: CODE });
  });

  it("leave clears the shop, keeps local data, and invalidates in-flight sign-ins", () => {
    seedLocalData();
    signedIn("office");
    const before = getSessionMutationEpoch();
    expect(cj.leaveShop()).toEqual({
      ok: true,
      shopId: CODE,
      message: `Left shop ${CODE}. This device is local-only again. Cloud data was not deleted.`,
    });
    expect(loadShopSession()).toEqual({ shopId: "" });
    expect(getSessionMutationEpoch()).toBe(before + 1);
    expect(JSON.parse(store.getItem("jobber-pest-logger:logs:v1")!)).toHaveLength(2);
  });

  it("report storage failures", () => {
    signedIn("tech");
    store.failSet = true;
    expect(cj.signOutShop()).toEqual({ ok: false, error: "Could not clear session auth on this device." });
    // leaveShop clears via removeItem, not setItem.
    vi.spyOn(store, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(cj.leaveShop()).toEqual({ ok: false, error: "Could not clear shop session on this device." });
  });
});
