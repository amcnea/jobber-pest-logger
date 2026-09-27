import { pbkdf2Sync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildShopPinAuth,
  createPinHash,
  isPinHashRecord,
  isShopRole,
  isValidPin,
  parseShopPinAuth,
  PIN_HASH_ALGORITHM,
  PIN_PBKDF2_ITERATIONS,
  pinRecordForRole,
  verifyPin,
  type PinHashRecord,
  type ShopPinAuth,
} from "./pinCrypto";

// Uses Node's built-in Web Crypto (globalThis.crypto.subtle), same API as browsers.
// Expected hashes are computed independently with node:crypto pbkdf2Sync.

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function b64(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64");
}

function expectedHashB64(pin: string, salt: Uint8Array): string {
  return b64(pbkdf2Sync(pin, salt, PIN_PBKDF2_ITERATIONS, 32, "sha256"));
}

const FIXED_SALT = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

function fixedRecord(pin: string, salt: Uint8Array = FIXED_SALT): PinHashRecord {
  return {
    algorithm: PIN_HASH_ALGORITHM,
    iterations: PIN_PBKDF2_ITERATIONS,
    saltB64: b64(salt),
    hashB64: expectedHashB64(pin, salt),
  };
}

function stubSalt(bytes: Uint8Array) {
  return vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((arr: ArrayBufferView) => {
    (arr as Uint8Array).set(bytes.subarray(0, (arr as Uint8Array).length));
    return arr;
  }) as typeof crypto.getRandomValues);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Constants / simple predicates
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("pins the hash format", () => {
    expect(PIN_HASH_ALGORITHM).toBe("PBKDF2-SHA256");
    expect(PIN_PBKDF2_ITERATIONS).toBe(100_000);
  });
});

describe("isValidPin", () => {
  it.each(["1234", "0000", "12345", "1234567", "12345678", "00001234"])("accepts %j", (pin) => {
    expect(isValidPin(pin)).toBe(true);
  });

  it.each(["", "123", "123456789", "12a4", "12 34", " 1234", "1234 ", "1234\n", "-1234", "12.34", "１２３４", "١٢٣٤"])(
    "rejects %j",
    (pin) => {
      expect(isValidPin(pin)).toBe(false);
    },
  );
});

describe("isShopRole", () => {
  it("accepts only office and tech", () => {
    expect(isShopRole("office")).toBe(true);
    expect(isShopRole("tech")).toBe(true);
    for (const v of ["Office", "TECH", "admin", "", null, undefined, 1, {}, ["office"]]) {
      expect(isShopRole(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// createPinHash
// ---------------------------------------------------------------------------

describe("createPinHash", () => {
  it("produces a PBKDF2-SHA256 record with a 16-byte salt and 32-byte hash", async () => {
    const r = await createPinHash("1234");
    expect(r.algorithm).toBe(PIN_HASH_ALGORITHM);
    expect(r.iterations).toBe(PIN_PBKDF2_ITERATIONS);
    expect(r.saltB64).toMatch(B64);
    expect(r.hashB64).toMatch(B64);
    expect(r.saltB64).toHaveLength(24);
    expect(r.hashB64).toHaveLength(44);
    expect(Buffer.from(r.saltB64, "base64")).toHaveLength(16);
    expect(Buffer.from(r.hashB64, "base64")).toHaveLength(32);
    expect(Object.keys(r).sort()).toEqual(["algorithm", "hashB64", "iterations", "saltB64"]);
  });

  it("never contains the raw PIN", async () => {
    const r = await createPinHash("987654");
    expect(JSON.stringify(r)).not.toContain("987654");
  });

  it("is deterministic for a fixed salt and matches an independent PBKDF2", async () => {
    stubSalt(FIXED_SALT);
    const r = await createPinHash("1234");
    expect(r).toEqual(fixedRecord("1234"));
  });

  it("requests exactly 16 salt bytes", async () => {
    const spy = stubSalt(FIXED_SALT);
    await createPinHash("1234");
    expect(spy).toHaveBeenCalledOnce();
    expect((spy.mock.calls[0][0] as Uint8Array).length).toBe(16);
  });

  it("uses a fresh random salt each time (same PIN -> different records)", async () => {
    const a = await createPinHash("1234");
    const b = await createPinHash("1234");
    expect(a.saltB64).not.toBe(b.saltB64);
    expect(a.hashB64).not.toBe(b.hashB64);
  });

  it("gives different hashes for different PINs with the same salt", async () => {
    stubSalt(FIXED_SALT);
    const a = await createPinHash("1234");
    const b = await createPinHash("1235");
    expect(a.saltB64).toBe(b.saltB64);
    expect(a.hashB64).not.toBe(b.hashB64);
  });

  it("rejects invalid PINs before touching crypto", async () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    for (const pin of ["", "123", "123456789", "abcd"]) {
      await expect(createPinHash(pin)).rejects.toThrow("PIN must be 4–8 digits.");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed without a secure random source", async () => {
    vi.stubGlobal("crypto", { subtle: globalThis.crypto.subtle });
    await expect(createPinHash("1234")).rejects.toThrow("Secure random source is unavailable; cannot salt a PIN.");
  });

  it("fails closed without Web Crypto subtle", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    await expect(createPinHash("1234")).rejects.toThrow("Web Crypto is unavailable; cannot hash or verify PINs.");
  });
});

// ---------------------------------------------------------------------------
// verifyPin
// ---------------------------------------------------------------------------

describe("verifyPin", () => {
  it("round-trips with createPinHash", async () => {
    for (const pin of ["1234", "00000000", "271828"]) {
      const r = await createPinHash(pin);
      expect(await verifyPin(pin, r)).toBe(true);
    }
  });

  it("verifies a record built independently with node:crypto", async () => {
    expect(await verifyPin("4321", fixedRecord("4321"))).toBe(true);
  });

  it("rejects the wrong PIN (including near misses and prefixes)", async () => {
    const r = fixedRecord("1234");
    for (const pin of ["1235", "4321", "12340", "01234", "0000"]) {
      expect(await verifyPin(pin, r)).toBe(false);
    }
  });

  it("rejects invalid PIN formats without hashing", async () => {
    const r = fixedRecord("1234");
    const digest = vi.spyOn(globalThis.crypto.subtle, "deriveBits");
    for (const pin of ["", "123", "1234 ", " 1234", "12a4", "123456789"]) {
      expect(await verifyPin(pin, r)).toBe(false);
    }
    expect(digest).not.toHaveBeenCalled();
  });

  it("rejects records with a different algorithm or iteration count", async () => {
    const r = fixedRecord("1234");
    expect(await verifyPin("1234", { ...r, algorithm: "SHA1" as typeof PIN_HASH_ALGORITHM })).toBe(false);
    expect(await verifyPin("1234", { ...r, iterations: 1000 })).toBe(false);
    expect(await verifyPin("1234", { ...r, iterations: PIN_PBKDF2_ITERATIONS + 1 })).toBe(false);
  });

  it("uses the record's salt (same PIN, different salt -> different hash)", async () => {
    const other = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
    const r = { ...fixedRecord("1234"), saltB64: b64(other) };
    expect(await verifyPin("1234", r)).toBe(false);
    expect(await verifyPin("1234", fixedRecord("1234", other))).toBe(true);
  });

  it("accepts salts of at least 8 bytes and rejects shorter ones", async () => {
    const eight = Uint8Array.from({ length: 8 }, (_, i) => i);
    expect(await verifyPin("1234", fixedRecord("1234", eight))).toBe(true);
    const seven = Uint8Array.from({ length: 7 }, (_, i) => i);
    expect(await verifyPin("1234", fixedRecord("1234", seven))).toBe(false);
  });

  it("rejects malformed base64 and empty hashes", async () => {
    const r = fixedRecord("1234");
    expect(await verifyPin("1234", { ...r, saltB64: "not base64!!" })).toBe(false);
    expect(await verifyPin("1234", { ...r, hashB64: "%%%" })).toBe(false);
    expect(await verifyPin("1234", { ...r, hashB64: "" })).toBe(false);
    expect(await verifyPin("1234", { ...r, saltB64: "" })).toBe(false);
  });

  it("rejects a truncated or extended hash", async () => {
    const r = fixedRecord("1234");
    const full = Buffer.from(r.hashB64, "base64");
    expect(await verifyPin("1234", { ...r, hashB64: b64(full.subarray(0, 31)) })).toBe(false);
    expect(await verifyPin("1234", { ...r, hashB64: b64(Buffer.concat([full, Buffer.from([0])])) })).toBe(false);
  });

  it("rejects a hash with a single flipped bit", async () => {
    const r = fixedRecord("1234");
    const bytes = Buffer.from(r.hashB64, "base64");
    bytes[31] ^= 1;
    expect(await verifyPin("1234", { ...r, hashB64: b64(bytes) })).toBe(false);
  });

  it("returns false (does not throw) when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    expect(await verifyPin("1234", fixedRecord("1234"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPinHashRecord / parseShopPinAuth
// ---------------------------------------------------------------------------

describe("isPinHashRecord", () => {
  it("accepts a well-formed record", async () => {
    expect(isPinHashRecord(fixedRecord("1234"))).toBe(true);
    expect(isPinHashRecord(await createPinHash("5678"))).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, "x", 1, true, [], [fixedRecord("1234")]]) {
      expect(isPinHashRecord(v)).toBe(false);
    }
  });

  it("rejects wrong algorithm / iterations / field types", () => {
    const r = fixedRecord("1234");
    expect(isPinHashRecord({ ...r, algorithm: "PBKDF2-SHA1" })).toBe(false);
    expect(isPinHashRecord({ ...r, iterations: "100000" })).toBe(false);
    expect(isPinHashRecord({ ...r, iterations: 99_999 })).toBe(false);
    expect(isPinHashRecord({ ...r, saltB64: 123 })).toBe(false);
    expect(isPinHashRecord({ ...r, hashB64: null })).toBe(false);
    const { hashB64: _h, ...noHash } = r;
    expect(isPinHashRecord(noHash)).toBe(false);
  });

  it("requires a salt of at least 8 bytes", () => {
    const r = fixedRecord("1234");
    expect(isPinHashRecord({ ...r, saltB64: b64(new Uint8Array(8)) })).toBe(true);
    expect(isPinHashRecord({ ...r, saltB64: b64(new Uint8Array(7)) })).toBe(false);
    expect(isPinHashRecord({ ...r, saltB64: "" })).toBe(false);
  });

  it("requires exactly a 32-byte hash", () => {
    const r = fixedRecord("1234");
    expect(isPinHashRecord({ ...r, hashB64: b64(new Uint8Array(31)) })).toBe(false);
    expect(isPinHashRecord({ ...r, hashB64: b64(new Uint8Array(33)) })).toBe(false);
    expect(isPinHashRecord({ ...r, hashB64: b64(new Uint8Array(32)) })).toBe(true);
  });

  it("rejects malformed base64", () => {
    const r = fixedRecord("1234");
    expect(isPinHashRecord({ ...r, saltB64: "@@@@" })).toBe(false);
    expect(isPinHashRecord({ ...r, hashB64: "not valid base64 ###" })).toBe(false);
  });

  it("agrees with verifyPin's structural gates: any record it accepts can verify its own PIN", async () => {
    const r = await createPinHash("2468");
    expect(isPinHashRecord(r)).toBe(true);
    expect(await verifyPin("2468", r)).toBe(true);
  });
});

describe("parseShopPinAuth", () => {
  const good = (): Record<string, unknown> => ({
    version: 1,
    officePin: fixedRecord("1111"),
    techPin: fixedRecord("2222"),
  });

  it("parses a valid v1 auth block and returns only known fields", () => {
    const parsed = parseShopPinAuth({ ...good(), extra: "ignored" });
    expect(parsed).toEqual(good());
    expect(parsed).not.toHaveProperty("extra");
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, "x", 1, [], [good()]]) expect(parseShopPinAuth(v)).toBeUndefined();
  });

  it("rejects other versions", () => {
    for (const version of [0, 2, "1", undefined]) {
      expect(parseShopPinAuth({ ...good(), version })).toBeUndefined();
    }
  });

  it("rejects a missing or malformed office or tech record", () => {
    expect(parseShopPinAuth({ ...good(), officePin: undefined })).toBeUndefined();
    expect(parseShopPinAuth({ ...good(), techPin: { ...fixedRecord("2222"), iterations: 1 } })).toBeUndefined();
    expect(parseShopPinAuth({ ...good(), techPin: { ...fixedRecord("2222"), hashB64: b64(new Uint8Array(16)) } }))
      .toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildShopPinAuth / pinRecordForRole
// ---------------------------------------------------------------------------

describe("buildShopPinAuth", () => {
  it("hashes office and tech PINs separately into a v1 block that parses and verifies", async () => {
    const auth = await buildShopPinAuth("1111", "22222222");
    expect(auth.version).toBe(1);
    expect(parseShopPinAuth(auth)).toEqual(auth);
    expect(await verifyPin("1111", auth.officePin)).toBe(true);
    expect(await verifyPin("22222222", auth.techPin)).toBe(true);
    expect(await verifyPin("1111", auth.techPin)).toBe(false);
    expect(await verifyPin("22222222", auth.officePin)).toBe(false);
    expect(auth.officePin.saltB64).not.toBe(auth.techPin.saltB64);
  });

  it("uses independent salts even when both PINs are equal", async () => {
    const auth = await buildShopPinAuth("1234", "1234");
    expect(auth.officePin.saltB64).not.toBe(auth.techPin.saltB64);
    expect(auth.officePin.hashB64).not.toBe(auth.techPin.hashB64);
  });

  it("rejects when either PIN is invalid", async () => {
    await expect(buildShopPinAuth("12", "1234")).rejects.toThrow("Office and tech PINs must each be 4–8 digits.");
    await expect(buildShopPinAuth("1234", "abcd")).rejects.toThrow("Office and tech PINs must each be 4–8 digits.");
  });
});

describe("pinRecordForRole", () => {
  it("returns the office or tech record", () => {
    const auth: ShopPinAuth = { version: 1, officePin: fixedRecord("1111"), techPin: fixedRecord("2222") };
    expect(pinRecordForRole(auth, "office")).toBe(auth.officePin);
    expect(pinRecordForRole(auth, "tech")).toBe(auth.techPin);
  });
});
