import { describe, expect, it } from "vitest";

import {
  deriveSignedAmount,
  inferFlowType,
  normalizeAmount,
  normalizeMerchant,
  parseDate,
} from "./transactionUtils.js";

describe("normalizeAmount", () => {
  it("parses a plain number string", () => {
    expect(normalizeAmount("123.45")).toBe(123.45);
  });

  it("strips dollar signs and commas", () => {
    expect(normalizeAmount("$1,234.56")).toBe(1234.56);
  });

  it("handles parenthetical negatives (accounting format)", () => {
    expect(normalizeAmount("(500.00)")).toBe(-500.0);
  });

  it("handles explicit negative sign", () => {
    expect(normalizeAmount("-42.10")).toBe(-42.1);
  });

  it("handles whitespace around the value", () => {
    expect(normalizeAmount("  $100.00  ")).toBe(100.0);
  });

  it("returns NaN for non-numeric input", () => {
    expect(normalizeAmount("abc")).toBeNaN();
  });

  it("returns NaN for empty string", () => {
    expect(normalizeAmount("")).toBeNaN();
  });

  it("handles zero", () => {
    expect(normalizeAmount("0.00")).toBe(0);
  });
});

describe("deriveSignedAmount", () => {
  it("returns amount directly when only amount is provided", () => {
    expect(deriveSignedAmount({ amount: -50 })).toBe(-50);
  });

  it("derives from debit column (negative)", () => {
    expect(deriveSignedAmount({ debit: 100 })).toBe(-100);
  });

  it("derives from credit column (positive)", () => {
    expect(deriveSignedAmount({ credit: 200 })).toBe(200);
  });

  it("prefers debit when both debit and credit are provided", () => {
    expect(deriveSignedAmount({ debit: 100, credit: 0 })).toBe(-100);
  });

  it("uses credit when debit is zero", () => {
    expect(deriveSignedAmount({ debit: 0, credit: 75 })).toBe(75);
  });

  it("returns 0 when all inputs are zero or missing", () => {
    expect(deriveSignedAmount({})).toBe(0);
  });
});

describe("inferFlowType", () => {
  it("returns 'outflow' for negative amounts", () => {
    expect(inferFlowType(-100)).toBe("outflow");
  });

  it("returns 'inflow' for positive amounts", () => {
    expect(inferFlowType(250)).toBe("inflow");
  });

  it("returns 'inflow' for zero", () => {
    expect(inferFlowType(0)).toBe("inflow");
  });
});

describe("normalizeMerchant", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeMerchant("  Netflix   Inc  ")).toBe("Netflix Inc");
  });

  it("strips trailing reference numbers", () => {
    expect(normalizeMerchant("AMAZON.COM #12345")).toBe("Amazon.com");
  });

  it("strips POS prefixes like SQ *", () => {
    expect(normalizeMerchant("SQ *COFFEE SHOP")).toBe("Coffee Shop");
  });

  it("title-cases the result", () => {
    expect(normalizeMerchant("WHOLE FOODS MARKET")).toBe("Whole Foods Market");
  });

  it("handles empty string", () => {
    expect(normalizeMerchant("")).toBe("");
  });

  it("preserves single-word merchants", () => {
    expect(normalizeMerchant("SPOTIFY")).toBe("Spotify");
  });
});

describe("parseDate", () => {
  it("parses MM/DD/YYYY", () => {
    expect(parseDate("01/15/2026")).toBe("2026-01-15");
  });

  it("parses M/D/YYYY", () => {
    expect(parseDate("1/5/2026")).toBe("2026-01-05");
  });

  it("parses YYYY-MM-DD as-is", () => {
    expect(parseDate("2026-03-20")).toBe("2026-03-20");
  });

  it("parses MM-DD-YYYY", () => {
    expect(parseDate("03-20-2026")).toBe("2026-03-20");
  });

  it("returns null for unparseable dates", () => {
    expect(parseDate("not-a-date")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseDate("")).toBeNull();
  });
});
