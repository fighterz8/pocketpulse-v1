/**
 * Unit tests for detectLeaks() — focusing on Task #38 requirements:
 *   (a) mutual exclusion with recurring merchant keys
 *   (b) catch-all repeat-purchase rule for unfamiliar categories
 *   (c) inactive recurring merchants (not in exclusion set) can surface as leaks
 * Plus Task #49 requirements:
 *   (d) rangeDays parameter governs monthlyAmount normalisation
 */

import { describe, expect, it } from "vitest";
import { detectLeaks } from "./cashflow.js";

type TxRow = {
  transactionClass: string;
  category: string;
  merchant: string;
  amount: string | number;
  date: string;
  recurrenceType?: string | null;
  excludedFromAnalysis?: boolean | null;
};

function makeTx(overrides: Partial<TxRow> & { merchant: string }): TxRow {
  return {
    transactionClass: "expense",
    category:         overrides.category ?? "dining",
    merchant:         overrides.merchant,
    amount:           overrides.amount ?? "-25.00",
    date:             overrides.date ?? "2026-01-15",
    recurrenceType:   overrides.recurrenceType ?? "one-time",
    excludedFromAnalysis: overrides.excludedFromAnalysis ?? false,
  };
}

/** Build N monthly expense transactions for the same merchant. */
function monthlyTxns(
  merchant: string,
  amount: string,
  category: string,
  n = 4,
): TxRow[] {
  return Array.from({ length: n }, (_, i) => {
    const month = String(i + 1).padStart(2, "0");
    return makeTx({ merchant, amount, category, date: `2026-${month}-15` });
  });
}

// ─── (a) Mutual exclusion with active recurring merchant keys ─────────────────

describe("detectLeaks: recurringMerchantKeys mutual exclusion", () => {
  it("merchant in recurringMerchantKeys is excluded from leaks entirely", () => {
    const txns = monthlyTxns("Netflix.com", "-15.99", "entertainment", 6);
    const leaks = detectLeaks(txns, {
      rangeDays: 180,
      recurringMerchantKeys: new Set(["netflix"]),
    });
    expect(leaks.some((l) => l.merchantKey === "netflix")).toBe(false);
  });

  it("same merchant NOT in recurringMerchantKeys still appears as a leak", () => {
    const txns = monthlyTxns("Hulu.com", "-7.99", "entertainment", 6);
    const leaks = detectLeaks(txns, {
      rangeDays: 180,
      recurringMerchantKeys: new Set(["netflix"]), // hulu not in the set
    });
    expect(leaks.some((l) => l.merchantKey === "hulu")).toBe(true);
  });

  it("a merchant blocked by recurringMerchantKeys does not appear even if it meets leak thresholds", () => {
    // Starbucks 4× counts as convenience leak — but if it were in the recurring set, skip it
    const txns = monthlyTxns("Starbucks", "-8.50", "coffee", 4);
    const leaks = detectLeaks(txns, {
      rangeDays: 120,
      recurringMerchantKeys: new Set(["starbucks"]),
    });
    expect(leaks.find((l) => l.merchantKey === "starbucks")).toBeUndefined();
  });
});

// ─── (b) Catch-all repeat-purchase rule ──────────────────────────────────────

describe("detectLeaks: catch-all repeat-purchase rule", () => {
  it("'banking' category merchant with ≥3 txns, avg ≥$25, total ≥$75 appears as Low-confidence leak via catch-all", () => {
    // 'banking' is NOT in ESSENTIAL_LEAK_EXCLUSIONS, NOT in DISCRETIONARY_CATEGORIES,
    // NOT in CATCH_ALL_HARD_EXCLUSIONS — so only the catch-all rule qualifies it → Low confidence.
    const txns = monthlyTxns("QuickPay ProcessingFee", "-30.00", "banking", 3);
    const leaks = detectLeaks(txns, { rangeDays: 90 });
    const found = leaks.find((l) => l.merchantKey === "quickpay processingfee");
    expect(found).toBeDefined();
    expect(found!.confidence).toBe("Low");
    expect(found!.bucket).toBe("repeat_discretionary");
  });

  it("non-discretionary non-excluded category surfaces only via catch-all (Low confidence, not Medium)", () => {
    // 'software' is now outside ESSENTIAL_LEAK_EXCLUSIONS and outside DISCRETIONARY_CATEGORIES.
    // 3 txns of $35 each = total $105 ≥ $75, avg $35 ≥ $25 → catch-all fires → Low confidence.
    const txns = monthlyTxns("DevToolX", "-35.00", "software", 3);
    const leaks = detectLeaks(txns, { rangeDays: 90 });
    const found = leaks.find((l) => l.merchantKey === "devtoolx");
    expect(found).toBeDefined();
    expect(found!.confidence).toBe("Low");
  });

  it("housing category merchant is NEVER surfaced by catch-all (hard exclusion)", () => {
    const txns = monthlyTxns("Mortgage Payment", "-1500.00", "housing", 6);
    const leaks = detectLeaks(txns, { rangeDays: 180 });
    expect(leaks.some((l) => l.merchantKey.includes("mortgage"))).toBe(false);
  });

  it("catch-all requires ≥3 transactions — 2 transactions do not qualify", () => {
    const txns = [
      makeTx({ merchant: "RareSoftwareTool", amount: "-49.99", category: "other", date: "2026-01-15" }),
      makeTx({ merchant: "RareSoftwareTool", amount: "-49.99", category: "other", date: "2026-02-15" }),
    ];
    const leaks = detectLeaks(txns, { rangeDays: 60 });
    expect(leaks.some((l) => l.merchantKey === "raresoftwaretool")).toBe(false);
  });

  it("catch-all requires avg ≥$25 — low-average-amount merchant below threshold is not surfaced", () => {
    // avg = $10, total = $30 — both below thresholds
    const txns = monthlyTxns("TinyPurchase", "-10.00", "other", 3);
    const leaks = detectLeaks(txns, { rangeDays: 90 });
    expect(leaks.some((l) => l.merchantKey === "tinypurchase")).toBe(false);
  });

  it("software category repeat purchases now surface as leaks (software removed from exclusion list)", () => {
    // A software tool bought 3× at $35/ea with category 'software' — NOT in CATCH_ALL_HARD_EXCLUSIONS
    const txns = monthlyTxns("SomeDevTool", "-35.00", "software", 3);
    const leaks = detectLeaks(txns, { rangeDays: 90 });
    const found = leaks.find((l) => l.merchantKey === "somedevtool");
    expect(found).toBeDefined();
    expect(found!.confidence).toBe("Low");
  });
});

// ─── (c) Inactive recurring merchants do NOT over-suppress leaks ──────────────

describe("detectLeaks: inactive recurring merchants", () => {
  it("a merchant key NOT in recurringMerchantKeys can appear as a leak (inactive candidates do not suppress)", () => {
    // Simulate: Netflix was recurring but now inactive (not passed in the set)
    const txns = monthlyTxns("Netflix.com", "-15.99", "entertainment", 4);
    // Empty exclusion set = no active recurring candidates
    const leaks = detectLeaks(txns, {
      rangeDays: 120,
      recurringMerchantKeys: new Set<string>(), // netflix is NOT excluded
    });
    expect(leaks.some((l) => l.merchantKey === "netflix")).toBe(true);
  });

  it("passing only the active subset in recurringMerchantKeys leaves inactive merchants unblocked", () => {
    const netflix = monthlyTxns("Netflix.com",  "-15.99", "entertainment", 6);
    const hulu    = monthlyTxns("Hulu.com",     "-7.99",  "entertainment", 6);
    const all     = [...netflix, ...hulu];

    // Only netflix is currently active; hulu is inactive (not in the set)
    const leaks = detectLeaks(all, {
      rangeDays: 180,
      recurringMerchantKeys: new Set(["netflix"]),
    });

    expect(leaks.some((l) => l.merchantKey === "netflix")).toBe(false); // excluded
    expect(leaks.some((l) => l.merchantKey === "hulu")).toBe(true);     // not excluded
  });
});

// ─── (e) isRecurring honours recurrenceType regardless of recurrenceSource ────

describe("detectLeaks: isRecurring based on recurrenceType only", () => {
  it("merchant with recurrenceSource='manual' and recurrenceType='recurring' is flagged isSubscriptionLike", () => {
    // "PayBoost" in "dining" with fixed $15 amounts and recurrenceSource='manual'
    // — not in any subscription-pattern list, not in SUBSCRIPTION_LIKE_CATEGORIES.
    // Before fix: isRecurring=false → isSubscriptionLike=false.
    // After fix:  isRecurring=true + zero variance → isSubscriptionLike=true.
    const txns = [1, 2, 3, 4].map((i) => ({
      transactionClass: "expense",
      category: "dining",
      merchant: "PayBoost",
      amount: "-15.00",
      date: `2026-0${i}-15`,
      recurrenceType: "recurring" as const,
      recurrenceSource: "manual",
      excludedFromAnalysis: false,
    }));
    const leaks = detectLeaks(txns, { rangeDays: 120 });
    const leak = leaks.find((l) => l.merchantKey === "payboost");
    expect(leak).toBeDefined();
    expect(leak!.isSubscriptionLike).toBe(true);
  });

  it("merchant with recurrenceSource='detected' and recurrenceType='recurring' still flagged isSubscriptionLike (no regression)", () => {
    const txns = [1, 2, 3, 4].map((i) => ({
      transactionClass: "expense",
      category: "dining",
      merchant: "PayBoost",
      amount: "-15.00",
      date: `2026-0${i}-15`,
      recurrenceType: "recurring" as const,
      recurrenceSource: "detected",
      excludedFromAnalysis: false,
    }));
    const leaks = detectLeaks(txns, { rangeDays: 120 });
    const leak = leaks.find((l) => l.merchantKey === "payboost");
    expect(leak).toBeDefined();
    expect(leak!.isSubscriptionLike).toBe(true);
  });

  it("merchant with recurrenceType='one-time' only is NOT flagged isSubscriptionLike (dining, no pattern match)", () => {
    const txns = [1, 2, 3, 4].map((i) => ({
      transactionClass: "expense",
      category: "dining",
      merchant: "PayBoost",
      amount: "-15.00",
      date: `2026-0${i}-15`,
      recurrenceType: "one-time" as const,
      recurrenceSource: "none",
      excludedFromAnalysis: false,
    }));
    const leaks = detectLeaks(txns, { rangeDays: 120 });
    const leak = leaks.find((l) => l.merchantKey === "payboost");
    expect(leak).toBeDefined();
    expect(leak!.isSubscriptionLike).toBe(false);
  });
});

// ─── (f) Manually-recurring merchants excluded from leaks ────────────────────

describe("detectLeaks: manually-recurring merchants are excluded via recurringMerchantKeys", () => {
  it("merchant manually flagged recurring (recurrenceSource='manual') does not appear in leaks when its key is in recurringMerchantKeys", () => {
    // Simulate: user manually marks "FitLife Gym" as recurring via the UI.
    // The recurring-candidates batch hasn't run yet, but routes.ts now
    // pre-populates recurringMerchantKeys with keys from manual recurrence.
    const txns = [1, 2, 3, 4].map((i) => ({
      transactionClass: "expense",
      category: "fitness",
      merchant: "FitLife Gym",
      amount: "-40.00",
      date: `2026-0${i}-15`,
      recurrenceType: "recurring" as const,
      recurrenceSource: "manual",
      excludedFromAnalysis: false,
    }));
    const leaks = detectLeaks(txns, {
      rangeDays: 120,
      recurringMerchantKeys: new Set(["fitlife gym"]),
    });
    expect(leaks.some((l) => l.merchantKey === "fitlife gym")).toBe(false);
  });

  it("same merchant without recurringMerchantKeys entry DOES appear as a leak (baseline)", () => {
    const txns = [1, 2, 3, 4].map((i) => ({
      transactionClass: "expense",
      category: "fitness",
      merchant: "FitLife Gym",
      amount: "-40.00",
      date: `2026-0${i}-15`,
      recurrenceType: "recurring" as const,
      recurrenceSource: "manual",
      excludedFromAnalysis: false,
    }));
    const leaks = detectLeaks(txns, {
      rangeDays: 120,
      recurringMerchantKeys: new Set<string>(),
    });
    expect(leaks.some((l) => l.merchantKey === "fitlife gym")).toBe(true);
  });

  it("manual recurring merchant mixed with non-recurring merchants: only non-recurring ones leak", () => {
    const manualRecurring = [1, 2, 3, 4].map((i) => ({
      transactionClass: "expense",
      category: "entertainment",
      merchant: "StreamPlus",
      amount: "-12.99",
      date: `2026-0${i}-15`,
      recurrenceType: "recurring" as const,
      recurrenceSource: "manual",
      excludedFromAnalysis: false,
    }));
    const nonRecurring = monthlyTxns("GameZone", "-12.99", "entertainment", 4);
    const txns = [...manualRecurring, ...nonRecurring];
    const leaks = detectLeaks(txns, {
      rangeDays: 120,
      recurringMerchantKeys: new Set(["streamplus"]),
    });
    expect(leaks.some((l) => l.merchantKey === "streamplus")).toBe(false);
    expect(leaks.some((l) => l.merchantKey === "gamezone")).toBe(true);
  });
});

// ─── (d) rangeDays parameter governs monthlyAmount ───────────────────────────

describe("detectLeaks: rangeDays parameter", () => {
  it("uses the provided rangeDays, not the transactions' date span", () => {
    // 4 transactions clustered in a single week
    const txns = [
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-01" }),
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-03" }),
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-05" }),
      makeTx({ merchant: "CoffeeBar", amount: "-6.00", category: "coffee", date: "2026-03-07" }),
    ];
    // Query window = 90 days → monthFactor = 3 → monthlyAmount = $24 / 3 = $8
    const leaks = detectLeaks(txns, { rangeDays: 90 });
    const leak = leaks.find((l) => l.merchantKey === "coffeebar");
    expect(leak).toBeDefined();
    expect(leak!.monthlyAmount).toBeCloseTo(8.0, 1);
    expect(leak!.recentSpend).toBeCloseTo(24.0, 1);
  });

  it("a 30-day window makes monthlyAmount equal totalSpend", () => {
    const txns = monthlyTxns("Pizza Place", "-20.00", "dining", 4);
    const leaks = detectLeaks(txns, { rangeDays: 30 });
    const leak = leaks.find((l) => l.merchantKey === "pizza place");
    expect(leak).toBeDefined();
    expect(leak!.monthlyAmount).toBeCloseTo(leak!.recentSpend, 1);
  });
});
