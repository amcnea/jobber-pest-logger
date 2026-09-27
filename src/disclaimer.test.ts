import { describe, expect, it } from "vitest";
import { LAWGICAL_DISCLAIMER } from "./disclaimer";

// Scope: the compliance disclaimer constant. It is "paste-as-is; do not shorten", so the
// whole text is pinned: any wording change must be a deliberate, reviewed edit to this test.

const EXPECTED =
  "This export is a Texas Structural Pest Control Service (SPCS) pesticide/device use-record aid based on 4 TAC § 7.144. The licensed shop and its responsible certified applicator are responsible for the accuracy of each record and for keeping records for at least two years on the business premises (or employer premises for noncommercial applicators) and producing them to the Texas Department of Agriculture on request. This tool is not legal advice, is not affiliated with or approved by TDA, and is not an official TDA form.";

describe("LAWGICAL_DISCLAIMER", () => {
  it("is the exact approved text", () => {
    expect(LAWGICAL_DISCLAIMER).toBe(EXPECTED);
  });

  it("keeps the key compliance statements", () => {
    for (const phrase of [
      "4 TAC § 7.144",
      "at least two years",
      "Texas Department of Agriculture",
      "not legal advice",
      "not affiliated with or approved by TDA",
      "not an official TDA form",
    ]) {
      expect(LAWGICAL_DISCLAIMER).toContain(phrase);
    }
  });

  it("is a single trimmed line with no line breaks or doubled spaces", () => {
    expect(LAWGICAL_DISCLAIMER).toBe(LAWGICAL_DISCLAIMER.trim());
    expect(LAWGICAL_DISCLAIMER).not.toMatch(/[\r\n\t]/);
    expect(LAWGICAL_DISCLAIMER).not.toMatch(/ {2}/);
  });

  it("uses the real section sign (not a lookalike) and ends with a period", () => {
    expect(LAWGICAL_DISCLAIMER).toContain("\u00a7 7.144");
    expect(LAWGICAL_DISCLAIMER.endsWith(".")).toBe(true);
  });
});
