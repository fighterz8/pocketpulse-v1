import { describe, expect, it } from "vitest";

import {
  isClassCompatibleWithFlow,
  reconcileAiTransactionClassification,
  reconcileTransactionDirection,
} from "./transactionDirection.js";

describe("transaction direction invariants", () => {
  it("turns a confirmed inflow from an expense merchant into a categorized refund", () => {
    expect(
      reconcileTransactionDirection({
        flowType: "inflow",
        proposedClass: "expense",
        proposedCategory: "dining",
        fallbackClass: "income",
        fallbackCategory: "income",
      }),
    ).toEqual({ transactionClass: "refund", category: "dining" });
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

  it("lets AI enrich a refund category without rewriting the refund class", () => {
    expect(
      reconcileAiTransactionClassification({
        flowType: "inflow",
        currentClass: "refund",
        currentCategory: "other",
        proposedClass: "income",
        proposedCategory: "shopping",
      }),
    ).toEqual({ transactionClass: "refund", category: "shopping" });
  });

  it("rejects an income category when AI reviews a known refund", () => {
    expect(
      reconcileAiTransactionClassification({
        flowType: "inflow",
        currentClass: "refund",
        currentCategory: "other",
        proposedClass: "income",
        proposedCategory: "income",
      }),
    ).toEqual({ transactionClass: "refund", category: "other" });
  });
});
