import { describe, expect, it } from "vitest";
import { TEXAS_COMMON_STARTER, TEXAS_STARTER_CATALOG_VERSION } from "./texasCommon";

describe("TEXAS_COMMON_STARTER / TEXAS_STARTER_CATALOG_VERSION", () => {
  it("version is a YYYY.MM[.N] stamp", () => {
    expect(TEXAS_STARTER_CATALOG_VERSION).toMatch(/^\d{4}\.\d{2}(\.\d+)?$/);
  });

  it("has unique ids and non-empty names", () => {
    const ids = TEXAS_COMMON_STARTER.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TEXAS_COMMON_STARTER.length).toBeGreaterThan(0);
    for (const s of TEXAS_COMMON_STARTER) {
      expect(s.id.trim()).not.toBe("");
      expect(s.name.trim()).not.toBe("");
      expect(s.kind === "pesticide" || s.kind === "device").toBe(true);
    }
  });

  it("devices and 25(b) pesticides have no EPA #; registered pesticides have one", () => {
    for (const s of TEXAS_COMMON_STARTER) {
      if (s.kind === "device") {
        expect(s.epaRegNo).toBeNull();
        expect(s.is25b).toBe(false);
      } else if (s.is25b) {
        expect(s.epaRegNo).toBeNull();
      } else {
        expect(typeof s.epaRegNo).toBe("string");
        expect(s.epaRegNo!.trim()).not.toBe("");
      }
    }
  });

  it("includes at least one device and one 25(b) pesticide (UI filters depend on both)", () => {
    expect(TEXAS_COMMON_STARTER.some((s) => s.kind === "device")).toBe(true);
    expect(TEXAS_COMMON_STARTER.some((s) => s.kind === "pesticide" && s.is25b)).toBe(true);
    expect(TEXAS_COMMON_STARTER.some((s) => s.kind === "pesticide" && !s.is25b && s.epaRegNo)).toBe(true);
  });
});
