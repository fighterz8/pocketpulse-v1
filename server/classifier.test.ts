import { describe, expect, it } from "vitest";

import { classifyTransaction, type ClassificationResult } from "./classifier.js";

describe("classifyTransaction", () => {
  it("classifies a subscription service", () => {
    // Merchant-specific brand names live in merchant_classifications_global (global seed).
    // classifyTransaction() only handles structural keywords — use "subscription" keyword.
    const result = classifyTransaction("MONTHLY STREAMING SUBSCRIPTION", -15.99);
    expect(result.category).toBe("software");
    expect(result.transactionClass).toBe("expense");
    expect(result.labelSource).toBe("rule");
    expect(result.labelReason).toBeTruthy();
  });

  it("classifies grocery stores", () => {
    // "grocery"/"supermarket" are structural keywords retained in CATEGORY_RULES.
    const result = classifyTransaction("LOCAL SUPERMARKET GROCERY STORE", -85.20);
    expect(result.category).toBe("groceries");
    expect(result.transactionClass).toBe("expense");
  });

  it("classifies dining/restaurants", () => {
    // "restaurant" is a structural keyword retained in CATEGORY_RULES.
    const result = classifyTransaction("LOCAL RESTAURANT KITCHEN DINER", -12.50);
    expect(result.category).toBe("dining");
  });

  it("classifies utility payments", () => {
    const result = classifyTransaction("ELECTRIC COMPANY", -120.00);
    expect(result.category).toBe("utilities");
  });

  it("classifies income from positive amount", () => {
    const result = classifyTransaction("PAYROLL DEPOSIT", 3500.00);
    expect(result.category).toBe("income");
    expect(result.transactionClass).toBe("income");
    expect(result.flowType).toBe("inflow");
  });

  it("classifies transfers — category is 'other', transactionClass is 'transfer'", () => {
    const result = classifyTransaction("TRANSFER TO SAVINGS", -500.00);
    expect(result.category).toBe("other");
    expect(result.transactionClass).toBe("transfer");
  });

  it("classifies insurance payments", () => {
    const result = classifyTransaction("STATE FARM INSURANCE", -150.00);
    expect(result.category).toBe("insurance");
  });

  it("classifies gas stations", () => {
    const result = classifyTransaction("SHELL GAS STATION", -45.00);
    expect(result.category).toBe("gas");
  });

  it("classifies pharmacy/medical", () => {
    const result = classifyTransaction("CVS PHARMACY", -22.00);
    expect(result.category).toBe("medical");
  });

  it("classifies shopping", () => {
    // "university"/"bookstore"/"tuition" are structural shopping keywords in CATEGORY_RULES.
    const result = classifyTransaction("UNIVERSITY BOOKSTORE CAMPUS STORE", -49.99);
    expect(result.category).toBe("shopping");
  });

  it("classifies fees", () => {
    const result = classifyTransaction("MONTHLY SERVICE FEE", -12.00);
    expect(result.category).toBe("fees");
  });

  it("classifies housing/rent", () => {
    const result = classifyTransaction("RENT PAYMENT", -1200.00);
    expect(result.category).toBe("housing");
  });

  it("classifies refunds", () => {
    const result = classifyTransaction("REFUND FROM AMAZON", 29.99);
    expect(result.transactionClass).toBe("refund");
    expect(result.category).toBe("other");
    expect(result.aiAssisted).toBe(true);
  });

  it("defaults unknown merchants to 'other'", () => {
    const result = classifyTransaction("XYZZY CORP #99", -150.00);
    expect(result.category).toBe("other");
  });

  it("defaults unknown merchants to 'other' regardless of amount", () => {
    // Without amount-range heuristics, any unrecognized merchant lands as 'other'
    const result = classifyTransaction("XYZZY CORP #99", -10.00);
    expect(result.category).toBe("other");
    expect(result.transactionClass).toBe("expense");
  });

  it("returns confidence score between 0 and 1", () => {
    const result = classifyTransaction("MONTHLY STREAMING SUBSCRIPTION", -15.99);
    expect(result.labelConfidence).toBeGreaterThanOrEqual(0);
    expect(result.labelConfidence).toBeLessThanOrEqual(1);
  });

  it("sets recurrenceType to one-time by default", () => {
    const result = classifyTransaction("RANDOM STORE", -5.00);
    expect(result.recurrenceType).toBe("one-time");
  });

  it("hints recurring for membership/subscription keyword transactions", () => {
    // Brand names like Spotify are in global seed; "membership" is a structural hint keyword.
    const result = classifyTransaction("ABC MEMBERSHIP FEE", -9.99);
    expect(result.recurrenceType).toBe("recurring");
  });

  it("classifies software/SaaS via subscription keyword", () => {
    // Brand names like GitHub are in global seed; "subscription" is a structural keyword.
    const result = classifyTransaction("MONTHLY SUBSCRIPTION SOFTWARE", -4.00);
    expect(result.category).toBe("software");
  });

  it("classifies entertainment via theater/theater keyword", () => {
    // Brand names like AMC are in global seed; "theater" is a structural keyword.
    const result = classifyTransaction("LOCAL MOVIE THEATER CONCERT", -18.00);
    expect(result.category).toBe("entertainment");
  });

  it("classifies debt payments", () => {
    const result = classifyTransaction("STUDENT LOAN PAYMENT", -300.00);
    expect(result.category).toBe("debt");
  });

  describe("positive-amount expense merchants (unsigned CSV format)", () => {
    it("classifies entertainment merchant as expense when amount is positive (unsigned CSV)", () => {
      // Structural keyword "theater" triggers Pass 6 → corrects positive-amount to expense/outflow.
      const result = classifyTransaction("LOCAL MOVIE THEATER CONCERT", 15.99);
      expect(result.category).toBe("entertainment");
      expect(result.transactionClass).toBe("expense");
      expect(result.flowType).toBe("outflow");
    });

    it("classifies grocery store as expense when amount is positive", () => {
      // Structural keyword "grocery" triggers Pass 6 → corrects positive-amount to expense/outflow.
      const result = classifyTransaction("LOCAL SUPERMARKET GROCERY STORE", 85.00);
      expect(result.category).toBe("groceries");
      expect(result.transactionClass).toBe("expense");
      expect(result.flowType).toBe("outflow");
    });

    it("classifies coffee shop as expense when amount is positive", () => {
      // Structural keyword "coffee shop" triggers Pass 6 → corrects positive-amount to expense/outflow.
      const result = classifyTransaction("COFFEE SHOP ESPRESSO CAFE BAR", 5.50);
      expect(result.category).toBe("coffee");
      expect(result.transactionClass).toBe("expense");
      expect(result.flowType).toBe("outflow");
    });

    it("classifies campus bookstore as expense when amount is positive", () => {
      // Structural keyword "bookstore"/"university" triggers Pass 6 → corrects positive-amount to expense/outflow.
      const result = classifyTransaction("UNIVERSITY BOOKSTORE CAMPUS STORE", 42.00);
      expect(result.category).toBe("shopping");
      expect(result.transactionClass).toBe("expense");
      expect(result.flowType).toBe("outflow");
    });

    it("still classifies payroll as income regardless", () => {
      const result = classifyTransaction("PAYROLL DEPOSIT", 3500.00);
      expect(result.category).toBe("income");
      expect(result.transactionClass).toBe("income");
      expect(result.flowType).toBe("inflow");
    });

    it("still classifies refunds correctly — merchant match does not override refund class", () => {
      const result = classifyTransaction("REFUND FROM AMAZON", 29.99);
      expect(result.transactionClass).toBe("refund");
    });

    it("classifies TRANSFER TO AUTO LOAN as debt/expense, not transfer", () => {
      const result = classifyTransaction("TRANSFER TO AUTO LOAN PAYMENT", -500.00);
      expect(result.category).toBe("debt");
      expect(result.transactionClass).toBe("expense");
      expect(result.flowType).toBe("outflow");
    });

    it("classifies positive-amount TRANSFER TO AUTO LOAN as debt/expense", () => {
      const result = classifyTransaction("TRANSFER TO AUTO LOAN PAYMENT", 500.00);
      expect(result.category).toBe("debt");
      expect(result.transactionClass).toBe("expense");
      expect(result.flowType).toBe("outflow");
    });

    it("returns merchant name from the classifier", () => {
      const result = classifyTransaction("SQ *STARBUCKS #12345 SAN DIEGO CA", -4.50);
      expect(result.merchant).toBeTruthy();
      expect(result.merchant.toLowerCase()).toContain("starbucks");
    });

    it("sets aiAssisted=true for genuinely unknown transactions", () => {
      const result = classifyTransaction("XYZZY CORP #99", -150.00);
      expect(result.aiAssisted).toBe(true);
    });

    it("sets aiAssisted=false for matched structural keyword rules", () => {
      // "subscription" hits a structural CATEGORY_RULE → matchedRule=true → aiAssisted=false.
      const result = classifyTransaction("MONTHLY SUBSCRIPTION SERVICE", -15.99);
      expect(result.aiAssisted).toBe(false);
    });
  });

  describe("recurrenceSource field", () => {
    it("returns recurrenceSource='none' for a non-recurring transaction", () => {
      const result = classifyTransaction("WHOLE FOODS MARKET", -85.20);
      expect(result.recurrenceSource).toBe("none");
      expect(result.recurrenceType).toBe("one-time");
    });

    it("returns recurrenceSource='hint' when Pass 8 fires on 'recurring' keyword", () => {
      // No CategoryRule matches 'GENERIC RECURRING PAYMENT' → Pass 8 fires and owns the recurrenceSource
      const result = classifyTransaction("GENERIC RECURRING PAYMENT DEPT123", -9.99);
      expect(result.recurrenceType).toBe("recurring");
      expect(result.recurrenceSource).toBe("hint");
    });

    it("returns recurrenceSource='hint' when Pass 8 fires on 'membership' keyword", () => {
      const result = classifyTransaction("ABC MEMBERSHIP FEE", -20.00);
      expect(result.recurrenceType).toBe("recurring");
      expect(result.recurrenceSource).toBe("hint");
    });

    it("returns recurrenceSource='hint' when Pass 9 fires on payroll income (positive amount)", () => {
      // Pass 9 only fires for income transactions; must use a positive amount
      const result = classifyTransaction("PAYROLL DEPOSIT", 3500.00);
      expect(result.recurrenceType).toBe("recurring");
      expect(result.recurrenceSource).toBe("hint");
    });

    it("returns recurrenceSource='none' when a CategoryRule sets recurrenceType (rule wins over keyword passes)", () => {
      // "subscription" CATEGORY_RULE directly sets recurrenceType:"recurring" in Pass 6.
      // Pass 8's guard (recurrenceType === 'one-time') then fails
      // → recurrenceSource stays 'none' (rule-based, not a keyword hint).
      const result = classifyTransaction("MONTHLY SUBSCRIPTION SERVICE", -15.99);
      expect(result.recurrenceType).toBe("recurring");
      expect(result.recurrenceSource).toBe("none");
    });

    it("never returns recurrenceSource='detected' (only the batch detector sets that)", () => {
      const unknown = classifyTransaction("XYZZY CORP #99", -150.00);
      expect(unknown.recurrenceSource).not.toBe("detected");

      const subscription = classifyTransaction("MONTHLY SUBSCRIPTION SERVICE", -15.99);
      expect(subscription.recurrenceSource).not.toBe("detected");
    });
  });

  describe("recurrenceSource provenance transitions", () => {
    /**
     * Documents the end-to-end state machine for recurrenceSource:
     *
     *   UPLOAD   → recurrenceSource = "hint"     (classifier keyword pass fires)
     *   UPLOAD   → recurrenceSource = "none"     (no keyword; or override resets it)
     *   DETECTOR → recurrenceSource = "detected" (syncRecurringCandidates runs)
     *
     * Tests here cover the upload-phase transitions because classifier.ts is
     * the entry point; detector promotion is tested implicitly by the sync
     * writeback semantics in routes.ts.
     */

    it("payroll inflow: starts as hint/recurring at upload, waiting for detector confirmation", () => {
      const atUpload = classifyTransaction("PAYROLL DEPOSIT", 3500);
      // Classifier keyword fires → hint, not yet detector-confirmed
      expect(atUpload.recurrenceSource).toBe("hint");
      expect(atUpload.recurrenceType).toBe("recurring");
      // Detector never runs on inflows; this row will remain hint/recurring
      // (detector is outflow-only by design)
    });

    it("unknown outflow: starts as none/one-time, becomes detected/one-time after sync", () => {
      const atUpload = classifyTransaction("XYZZY CORP #99", -150.00);
      // No keyword match → none at upload
      expect(atUpload.recurrenceSource).toBe("none");
      expect(atUpload.recurrenceType).toBe("one-time");
      // After syncRecurringCandidates Step 1: becomes detected/one-time
      // (tested here as a documented provenance expectation, not live DB call)
      const afterSync: Pick<ClassificationResult, "recurrenceSource" | "recurrenceType"> = {
        recurrenceSource: "detected",
        recurrenceType: "one-time",
      };
      expect(afterSync.recurrenceSource).toBe("detected");
    });

    it("recurring keyword outflow: starts as hint/recurring, becomes detected/recurring after sync confirms pattern", () => {
      // "GENERIC RECURRING PAYMENT" has no CategoryRule match so Pass 8 fires on "recurring" keyword → hint
      const atUpload = classifyTransaction("GENERIC RECURRING PAYMENT DEPT123", -9.99);
      expect(atUpload.recurrenceSource).toBe("hint");
      expect(atUpload.recurrenceType).toBe("recurring");
      // After syncRecurringCandidates Step 2 (multi-month pattern confirmed):
      // recurrenceSource → "detected", recurrenceType stays "recurring"
      const afterSync: Pick<ClassificationResult, "recurrenceSource" | "recurrenceType"> = {
        recurrenceSource: "detected",
        recurrenceType: "recurring",
      };
      expect(afterSync.recurrenceSource).toBe("detected");
      expect(afterSync.recurrenceType).toBe("recurring");
    });
  });
});
