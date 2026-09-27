import { afterEach, describe, expect, it, vi } from "vitest";
import { generateShopCode, normalizeShopCode } from "./shopCode";
import { isValidShopId } from "./session";

// Only pure helpers live in shopCode.ts. generateShopCode depends on
// crypto.getRandomValues (not Firebase, network, or storage); tests stub it
// where determinism is needed.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Stub getRandomValues to fill with the given byte sequence (repeated). */
function stubBytes(seq: number[]) {
  const fill = (arr: ArrayBufferView) => {
    const view = arr as Uint8Array;
    for (let i = 0; i < view.length; i++) view[i] = seq[i % seq.length];
    return arr;
  };
  return vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(fill as typeof crypto.getRandomValues);
}

describe("generateShopCode", () => {
  it("defaults to 8 characters from the unambiguous alphabet", () => {
    const code = generateShopCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(CODE_RE);
  });

  it("never uses ambiguous characters I, O, 0, 1 or lowercase", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateShopCode(32);
      expect(code).not.toMatch(/[IO01a-z]/);
    }
  });

  it("always produces a valid Firestore shop id", () => {
    for (const len of [4, 8, 16, 32]) {
      expect(isValidShopId(generateShopCode(len))).toBe(true);
    }
  });

  it("honors lengths within 4..32", () => {
    for (const len of [4, 5, 12, 31, 32]) expect(generateShopCode(len)).toHaveLength(len);
  });

  it("clamps lengths below 4 up to 4 and above 32 down to 32", () => {
    expect(generateShopCode(0)).toHaveLength(4);
    expect(generateShopCode(-10)).toHaveLength(4);
    expect(generateShopCode(3)).toHaveLength(4);
    expect(generateShopCode(33)).toHaveLength(32);
    expect(generateShopCode(1000)).toHaveLength(32);
    expect(generateShopCode(Infinity)).toHaveLength(32);
    expect(generateShopCode(-Infinity)).toHaveLength(4);
  });

  it("floors fractional lengths", () => {
    expect(generateShopCode(6.9)).toHaveLength(6);
    expect(generateShopCode(4.2)).toHaveLength(4);
    expect(generateShopCode(3.99)).toHaveLength(4);
  });

  it("fails closed on NaN length rather than returning an empty code", () => {
    expect(() => generateShopCode(Number.NaN)).toThrow("Generated shop code failed isValidShopId");
  });

  it("maps random bytes onto the alphabet modulo 32 (no modulo bias since 256 % 32 === 0)", () => {
    stubBytes([0, 1, 31, 32, 33, 255, 224, 8]);
    // 0->A, 1->B, 31->9, 32->A, 33->B, 255->9, 224->A, 8->J
    expect(generateShopCode(8)).toBe("AB9AB9AJ");
    expect(256 % ALPHABET.length).toBe(0);
  });

  it("requests exactly `length` random bytes", () => {
    const spy = stubBytes([5]);
    generateShopCode(12);
    expect(spy).toHaveBeenCalledOnce();
    expect((spy.mock.calls[0][0] as Uint8Array).length).toBe(12);
  });

  it("covers every alphabet character", () => {
    stubBytes(Array.from({ length: 32 }, (_, i) => i));
    expect(generateShopCode(32)).toBe(ALPHABET);
  });

  it("produces different codes on successive calls (real randomness)", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateShopCode()));
    expect(codes.size).toBe(50);
  });

  it("throws when no secure random source is available", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => generateShopCode()).toThrow("Secure random source is unavailable; cannot generate a shop code.");
    vi.stubGlobal("crypto", {});
    expect(() => generateShopCode()).toThrow(/Secure random source is unavailable/);
  });
});

describe("normalizeShopCode", () => {
  it("trims and uppercases", () => {
    expect(normalizeShopCode("  abcd2345 ")).toBe("ABCD2345");
    expect(normalizeShopCode("\tAbCd\n")).toBe("ABCD");
  });

  it("leaves already-normalized codes unchanged (idempotent)", () => {
    const code = generateShopCode();
    expect(normalizeShopCode(code)).toBe(code);
    expect(normalizeShopCode(normalizeShopCode(" xy "))).toBe("XY");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeShopCode("")).toBe("");
    expect(normalizeShopCode("    ")).toBe("");
  });

  it("does not strip inner spaces/dashes or remap ambiguous characters", () => {
    expect(normalizeShopCode("ab cd-ef")).toBe("AB CD-EF");
    expect(normalizeShopCode("o0i1")).toBe("O0I1");
  });

  it("round-trips a lowercased generated code back to the original", () => {
    const code = generateShopCode(10);
    expect(normalizeShopCode(` ${code.toLowerCase()} `)).toBe(code);
  });
});
