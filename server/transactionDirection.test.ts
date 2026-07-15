import { describe, expect, it } from "vitest";

import {
  isClassCompatibleWithFlow,
  reconcileTransactionDirection,
} from "./transactionDirection.js";

describe("transaction direction invariants", () => {
  it("never allows a confirmed inflow to become an expense", () => {
    expect(
      reconcileTransactionDirection({
        flowType: "inflow",
        proposedClass: "expense",
        proposedCategory: "dining",
        fallbackClass: "income",
        fallbackCategory: "income",
      }),
    ).toEqual({ transactionClass: "income", category: "income" });
  });

  it("never allows a confirmed outflow to become income or a refund", () => {
    expect(
      reconcileTransactionDirection({
        flowType: "outflow",
        proposedClass: "income",
        proposedCategory: "income",
      }),
    ).toEqual({ transactionClass: "expense", category: "other" });
  });

  it("preserves transfers in either direction", () => {
    expect(isClassCompatibleWithFlow("inflow", "transfer")).toBe(true);
    expect(isClassCompatibleWithFlow("outflow", "transfer")).toBe(true);
  });

  it("preserves an inflow refund and its original spending category", () => {
    expect(
      reconcileTransactionDirection({
        flowType: "inflow",
        proposedClass: "refund",
        proposedCategory: "shopping",
      }),
    ).toEqual({ transactionClass: "refund", category: "shopping" });
  });
});
