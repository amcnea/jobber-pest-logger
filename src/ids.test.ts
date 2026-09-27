import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "./ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("newId", () => {
  describe("with crypto.randomUUID (normal browsers / Node)", () => {
    it("returns an RFC 4122 v4 UUID", () => {
      expect(newId()).toMatch(UUID_V4);
    });

    it("returns unique ids", () => {
      const ids = new Set(Array.from({ length: 1000 }, () => newId()));
      expect(ids.size).toBe(1000);
    });

    it("delegates to crypto.randomUUID", () => {
      const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-2222-4333-8444-555555555555");
      expect(newId()).toBe("11111111-2222-4333-8444-555555555555");
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe("fallback: getRandomValues only (no randomUUID)", () => {
    function stubCryptoWithBytes(bytes: number[]) {
      const getRandomValues = vi.fn((arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = bytes[i % bytes.length];
        return arr;
      });
      vi.stubGlobal("crypto", { getRandomValues });
      return getRandomValues;
    }

    it("builds a v4 UUID from 16 random bytes", () => {
      const spy = stubCryptoWithBytes([0xff]);
      const id = newId();
      expect(id).toMatch(UUID_V4);
      expect(spy).toHaveBeenCalledOnce();
      expect((spy.mock.calls[0][0] as Uint8Array).length).toBe(16);
    });

    it("sets the version nibble to 4 and the variant bits to 10xx", () => {
      stubCryptoWithBytes([0x00]);
      expect(newId()).toBe("00000000-0000-4000-8000-000000000000");
      stubCryptoWithBytes([0xff]);
      expect(newId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    });

    it("hex-encodes bytes in order with 8-4-4-4-12 grouping", () => {
      stubCryptoWithBytes([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe]);
      // byte 6 (0xcd) -> 0x4d; byte 8 (0x10) -> 0x90
      expect(newId()).toBe("01234567-89ab-4def-9032-547698badcfe");
    });

    it("always matches the v4 format across random inputs", () => {
      vi.stubGlobal("crypto", {
        getRandomValues: (arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
          return arr;
        },
      });
      for (let i = 0; i < 200; i++) expect(newId()).toMatch(UUID_V4);
    });
  });

  describe("last-resort fallback: no crypto", () => {
    it("builds an id from the time and Math.random", () => {
      vi.stubGlobal("crypto", undefined);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
      vi.spyOn(Math, "random").mockReturnValue(0.123456789);
      const ts = Date.now().toString(36);
      const rand = (0.123456789).toString(36).slice(2, 10);
      expect(newId()).toBe(`id-${ts}-${rand}`);
    });

    it("also falls back when crypto exists but has neither API", () => {
      vi.stubGlobal("crypto", {});
      expect(newId()).toMatch(/^id-[0-9a-z]+-[0-9a-z]{1,8}$/);
    });
  });
});
