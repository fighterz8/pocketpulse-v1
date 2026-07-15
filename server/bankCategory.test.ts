import { describe, expect, it } from "vitest";

import { getBankCategoryHint } from "./bankCategory.js";

describe("getBankCategoryHint", () => {
  it("maps Navy Federal spending categories into the PocketPulse taxonomy", () => {
    expect(getBankCategoryHint("Restaurants/Dining")).toMatchObject({
      category: "dining",
      transactionClass: "expense",
    });
    expect(getBankCategoryHint("Gasoline/Fuel")).toMatchObject({
      category: "gas",
      transactionClass: "expense",
    });
    expect(getBankCategoryHint("Mortgages")).toMatchObject({
      category: "housing",
      transactionClass: "expense",
    });
  });

  it("treats clear balance movements as transfers", () => {
    for (const category of [
      "Transfers",
      "Savings",
      "Securities Trades",
      "Credit Card Payments",
      "ATM/Cash Withdrawals",
    ]) {
      expect(getBankCategoryHint(category)).toMatchObject({
        category: "other",
        transactionClass: "transfer",
      });
    }
  });

  it("recognizes explicit income and refund categories", () => {
    expect(getBankCategoryHint("Paychecks/Salary")).toMatchObject({
      category: "income",
      transactionClass: "income",
    });
    expect(getBankCategoryHint("Refunds/Adjustments")).toMatchObject({
      category: "other",
      transactionClass: "refund",
    });
  });

  it("does not guess unknown bank categories", () => {
    expect(getBankCategoryHint("Something New From A Future Bank")).toBeNull();
    expect(getBankCategoryHint(undefined)).toBeNull();
  });
});
