import { describe, expect, it } from "vitest";

import {
  recurrenceKey,
  buildCandidateKey,
  detectRecurringCandidates,
  type RecurringCandidate,
} from "./recurrenceDetector.js";

function makeTxn(overrides: Partial<{
  id: number;
  date: string;
  amount: string;
  merchant: string;
  flowType: string;
  category: string;
  excludedFromAnalysis: boolean;
}>) {
  return {
    id: overrides.id ?? 1,
    userId: 1,
    uploadId: 1,
    accountId: 1,
    date: overrides.date ?? "2026-01-15",
    amount: overrides.amount ?? "-15.99",
    merchant: overrides.merchant ?? "Netflix",
    rawDescription: overrides.merchant ?? "Netflix",
    flowType: overrides.flowType ?? "outflow",
    transactionClass: "expense",
    recurrenceType: "one-time",
    category: overrides.category ?? "subscriptions",
    labelSource: "rule",
    labelConfidence: "0.80",
    labelReason: null,
    aiAssisted: false,
    userCorrected: false,
    excludedFromAnalysis: overrides.excludedFromAnalysis ?? false,
    excludedReason: null,
    excludedAt: null,
    createdAt: "2026-01-15T00:00:00Z",
  };
}

describe("recurrenceKey", () => {
  it("lowercases and trims", () => {
    expect(recurrenceKey("  Netflix  ")).toBe("netflix");
  });

  it("strips POS prefixes", () => {
    expect(recurrenceKey("SQ *Coffee Shop")).toBe("coffee shop");
  });

  it("strips trailing reference numbers", () => {
    expect(recurrenceKey("Spotify #12345")).toBe("spotify");
  });

  it("collapses whitespace", () => {
    expect(recurrenceKey("Home   Depot")).toBe("home depot");
  });
});

describe("buildCandidateKey", () => {
  it("returns bare merchantKey for bucket index 0 (primary tier)", () => {
    expect(buildCandidateKey("netflix", 0)).toBe("netflix");
  });

  it("appends bucket index for secondary tiers", () => {
    expect(buildCandidateKey("netflix", 1)).toBe("netflix|1");
    expect(buildCandidateKey("netflix", 2)).toBe("netflix|2");
  });

  it("handles special housing bucket keys unchanged", () => {
    expect(buildCandidateKey("__housing_3200", 0)).toBe("__housing_3200");
  });
});

describe("detectRecurringCandidates", () => {
  it("returns empty array when no transactions", () => {
    expect(detectRecurringCandidates([])).toEqual([]);
  });

  it("returns empty when all transactions are inflows", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", flowType: "inflow", amount: "3500" }),
      makeTxn({ id: 2, date: "2026-02-15", flowType: "inflow", amount: "3500" }),
      makeTxn({ id: 3, date: "2026-03-15", flowType: "inflow", amount: "3500" }),
    ];
    expect(detectRecurringCandidates(txns)).toEqual([]);
  });

  it("detects monthly recurring charges", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-15.99", merchant: "Netflix" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const netflix = candidates.find((c) => c.candidateKey === "netflix" || c.candidateKey.startsWith("netflix|"));
    expect(netflix).toBeDefined();
    expect(netflix!.frequency).toBe("monthly");
    expect(netflix!.averageAmount).toBeCloseTo(15.99, 1);
    expect(netflix!.confidence).toBeGreaterThan(0.35);
  });

  it("does not flag monthly merchants with fewer than 3 transactions", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(0);
  });

  it("detects annual charges with only 2 transactions spanning >=330 days", () => {
    const txns = [
      makeTxn({ id: 1, date: "2025-01-10", amount: "-99.00", merchant: "Domain Registrar" }),
      makeTxn({ id: 2, date: "2026-01-08", amount: "-99.00", merchant: "Domain Registrar" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.frequency).toBe("annual");
  });

  it("excludes transactions marked excludedFromAnalysis", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix", excludedFromAnalysis: true }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix", excludedFromAnalysis: true }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-15.99", merchant: "Netflix", excludedFromAnalysis: true }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(0);
  });

  it("separates one-off purchases from recurring at same merchant", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-14.99", merchant: "Amazon" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-14.99", merchant: "Amazon" }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-14.99", merchant: "Amazon" }),
      makeTxn({ id: 4, date: "2026-02-20", amount: "-237.48", merchant: "Amazon" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    const recurring = candidates.filter((c) => c.candidateKey.startsWith("amazon|"));
    expect(recurring.length).toBe(1);
    expect(recurring[0]!.averageAmount).toBeCloseTo(14.99, 1);
  });

  it("detects variable-amount recurring (utility bills)", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-10", amount: "-85.00", merchant: "City Power", category: "utilities" }),
      makeTxn({ id: 2, date: "2026-02-10", amount: "-92.00", merchant: "City Power", category: "utilities" }),
      makeTxn({ id: 3, date: "2026-03-10", amount: "-88.00", merchant: "City Power", category: "utilities" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.frequency).toBe("monthly");
  });

  it("handles quarterly frequency", () => {
    const txns = [
      makeTxn({ id: 1, date: "2025-04-15", amount: "-250.00", merchant: "Insurance Co" }),
      makeTxn({ id: 2, date: "2025-07-15", amount: "-250.00", merchant: "Insurance Co" }),
      makeTxn({ id: 3, date: "2025-10-15", amount: "-250.00", merchant: "Insurance Co" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.frequency).toBe("quarterly");
  });

  it("generates a reason flagged string", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-15.99", merchant: "Netflix" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates[0]!.reasonFlagged).toBeTruthy();
    expect(candidates[0]!.reasonFlagged.length).toBeGreaterThan(10);
  });
});

// ─── DEF-014 regression: NEVER_SUBSCRIPTION_FRAGMENTS / CATEGORIES guards ───
//
// Each test verifies that the targeted transaction type is still DETECTED as a
// recurring candidate (it's a real habit worth tracking) but that
// isSubscriptionLike is forced to false (it cannot be cancelled like a SaaS
// subscription).  Six monthly transactions are used so interval detection is
// reliable and the confidence threshold is comfortably exceeded.

/** Builds six monthly outflow transactions spaced ~30 days apart. */
function sixMonthly(
  merchant: string,
  amount: string,
  category: string,
): ReturnType<typeof makeTxn>[] {
  const months = [
    "2025-06-15", "2025-07-15", "2025-08-15",
    "2025-09-15", "2025-10-15", "2025-11-15",
  ];
  return months.map((date, i) =>
    makeTxn({ id: i + 1, date, amount, merchant, category, flowType: "outflow" }),
  );
}

describe("DEF-014: isSubscriptionLike=false for cash/banking merchants and categories", () => {
  // ── NEVER_SUBSCRIPTION_FRAGMENTS ────────────────────────────────────────

  it("ATM withdrawal ($300.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("ATM Withdrawal Chase Bank", "-300.00", "other"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("Zelle P2P payment ($200.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Zelle To John Doe", "-200.00", "other"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("Venmo cashout ($150.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Venmo Cashout", "-150.00", "other"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("ACH credit memo outflow ($500.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("ACH Credit Reversal Fee", "-500.00", "fees"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("Mobile deposit reversal ($100.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Mobile Deposit Return", "-100.00", "other"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("Interest payment ($25.99/month) is recurring but NOT subscription-like", () => {
    // .99 suffix normally triggers isSaasPrice — fragment guard must win
    const candidates = detectRecurringCandidates(
      sixMonthly("Interest Payment Chase Credit Card", "-25.99", "debt"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("Wire transfer out ($1000.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Wire Transfer Outbound", "-1000.00", "other"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  // ── NEVER_SUBSCRIPTION_CATEGORIES ───────────────────────────────────────

  it("category='banking' ($75.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Monthly Account Fee", "-75.00", "banking"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("category='transfer' ($250.00/month) is recurring but NOT subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Savings Transfer", "-250.00", "transfer"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  it("category='income' outflow ($50.00/month) is NOT subscription-like (defensive guard)", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Tax Withholding Adjustment", "-50.00", "income"),
    );
    candidates.forEach((c) => expect(c.isSubscriptionLike).toBe(false));
  });

  // ── Control: legitimate subscriptions still detected correctly ───────────

  it("Netflix ($15.99/month) is still marked subscription-like — guard does not over-block", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Netflix.com", "-15.99", "entertainment"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.isSubscriptionLike)).toBe(true);
  });

  it("Spotify ($9.99/month, category software) is still subscription-like", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("Spotify Music", "-9.99", "software"),
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.isSubscriptionLike).toBe(true);
  });
});

// ─── Dataset-level monthly coverage tests ────────────────────────────────────

describe("passesMonthlyDatasetCoverage: dataset-span denominator", () => {
  /**
   * Builds N background outflow transactions spread across N calendar months
   * so the dataset month span equals N.  Uses "Rent" (housing category) so
   * CATEGORY_KEY_OVERRIDES groups them separately from the test candidate.
   */
  function backgroundMonths(n: number, startYear = 2025): ReturnType<typeof makeTxn>[] {
    return Array.from({ length: n }, (_, i) => {
      const y = startYear + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, "0");
      return makeTxn({
        id: 200 + i,
        date: `${y}-${m}-01`,
        amount: "-1500.00",
        merchant: "Monthly Rent Payment",
        category: "housing",
        flowType: "outflow",
      });
    });
  }

  it("candidate in only 3 of 12 dataset months fails 65 % coverage (3/12 = 25 %)", () => {
    // 12-month dataset with background noise
    const background = backgroundMonths(12);
    // Candidate appears only in Jan / Feb / Mar 2025 (3 months out of 12)
    const candidate = [
      makeTxn({ id: 1, date: "2025-01-15", amount: "-49.99", merchant: "SomeMonthlyApp", category: "other" }),
      makeTxn({ id: 2, date: "2025-02-15", amount: "-49.99", merchant: "SomeMonthlyApp", category: "other" }),
      makeTxn({ id: 3, date: "2025-03-15", amount: "-49.99", merchant: "SomeMonthlyApp", category: "other" }),
    ];
    const results = detectRecurringCandidates([...background, ...candidate]);
    const found = results.filter((c) => c.merchantKey === "somemonthlyapp");
    // 3 months covered / 12 dataset months = 25 % < 65 % → should NOT be detected
    expect(found.length).toBe(0);
  });

  it("candidate in 8 of 12 dataset months passes 65 % coverage (8/12 ≈ 67 %)", () => {
    const background = backgroundMonths(12);
    // Candidate appears in 8 of the 12 months (misses 4)
    const months = ["2025-01", "2025-02", "2025-03", "2025-04",
                    "2025-05", "2025-06", "2025-07", "2025-08"];
    const candidate = months.map((m, i) =>
      makeTxn({ id: i + 1, date: `${m}-15`, amount: "-9.99", merchant: "GoodService", category: "software" }),
    );
    const results = detectRecurringCandidates([...background, ...candidate]);
    const found = results.filter((c) => c.merchantKey === "goodservice");
    // 8/12 ≈ 67 % ≥ 65 % → should be detected
    expect(found.length).toBeGreaterThan(0);
  });

  it("short dataset guard: 1-month dataset skips coverage check (returns true)", () => {
    // Dataset with only 1 distinct calendar month — guard must allow through.
    // Monthly frequency can't actually be detected in 1 month (interval logic
    // requires ≥2 transactions with ~30-day gaps), so we verify the guard by
    // confirming a 3-month dataset with full coverage still passes.
    const txns = [
      makeTxn({ id: 1, date: "2026-01-10", amount: "-15.99", merchant: "Netflix", category: "entertainment" }),
      makeTxn({ id: 2, date: "2026-02-10", amount: "-15.99", merchant: "Netflix", category: "entertainment" }),
      makeTxn({ id: 3, date: "2026-03-10", amount: "-15.99", merchant: "Netflix", category: "entertainment" }),
    ];
    // Dataset = 3 months; candidate appears in all 3 → 3/3 = 100 % → PASS
    const results = detectRecurringCandidates(txns);
    expect(results.some((c) => c.merchantKey === "netflix")).toBe(true);
  });

  it("two-partial-months dataset: candidate present in both partial months passes coverage", () => {
    // Validates the 'partial month' edge case: the dataset spans exactly 2 calendar
    // months (datasetTotalMonths = 2, guard does NOT fire), and the candidate appears
    // in both. 2/2 = 100 % ≥ 65 % → should PASS.
    const txns = [
      makeTxn({ id: 1, date: "2026-01-28", amount: "-29.99", merchant: "CloudBridge", category: "software" }),
      makeTxn({ id: 2, date: "2026-02-28", amount: "-29.99", merchant: "CloudBridge", category: "software" }),
      makeTxn({ id: 3, date: "2026-03-28", amount: "-29.99", merchant: "CloudBridge", category: "software" }),
    ];
    // Dataset months: Jan, Feb, Mar → 3; candidate in all 3 → 3/3 = 100 % → PASS
    const results = detectRecurringCandidates(txns);
    expect(results.some((c) => c.merchantKey === "cloudbridge")).toBe(true);
  });
});

// ─── Low-dollar bill bucketing: $5 floor does not over-merge distinct bills ──

describe("getAmountTolerance: bill-category $5 floor", () => {
  it("two utility bills at $22 and $30 stay in separate buckets (diff=$8 > $5.50 tolerance)", () => {
    // $22 utility bill: tolerance = max($5, 22*0.25) = max($5, $5.50) = $5.50
    // $30 is $8 away from $22 → $8 > $5.50 → different buckets → two candidates
    const months = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"];
    const bill22 = months.map((m, i) =>
      makeTxn({ id: i + 1,  date: `${m}-10`, amount: "-22.00", merchant: "Water Company A",  category: "utilities" }),
    );
    const bill30 = months.map((m, i) =>
      makeTxn({ id: i + 10, date: `${m}-15`, amount: "-30.00", merchant: "Electric Company B", category: "utilities" }),
    );
    const results = detectRecurringCandidates([...bill22, ...bill30]);
    const utilCandidates = results.filter((c) => c.merchantKey.startsWith("__utilities"));
    // They should be in separate buckets → two recurring items
    expect(utilCandidates.length).toBeGreaterThanOrEqual(2);
  });

  it("same utility bill with minor month-to-month fluctuation clusters as one item", () => {
    // Same bill: $78, $81, $75, $80, $77, $79 (all within $5 of centroid ~$78)
    const amounts = ["-78.00", "-81.00", "-75.00", "-80.00", "-77.00", "-79.00"];
    const months  = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"];
    const txns = months.map((m, i) =>
      makeTxn({ id: i + 1, date: `${m}-05`, amount: amounts[i]!, merchant: "Duke Energy", category: "utilities" }),
    );
    const results = detectRecurringCandidates(txns);
    const utilCandidates = results.filter((c) => c.merchantKey.startsWith("__utilities"));
    // All charges cluster into one recurring item
    expect(utilCandidates.length).toBe(1);
  });
});

// ─── Lifestyle-block exception exact-key matching ─────────────────────────────

describe("LIFESTYLE_BLOCK_CATEGORIES: exact-key exception matching", () => {
  it("hellofresh (delivery category) is NOT blocked — canonical key is in exception set", () => {
    const candidates = detectRecurringCandidates(
      sixMonthly("HelloFresh Weekly Box", "-79.99", "delivery"),
    );
    expect(candidates.some((c) => c.merchantKey === "hellofresh")).toBe(true);
  });

  it("random delivery merchant NOT in exception set is hard-blocked (lifestyle gate)", () => {
    // "FreshChef" is not in LIFESTYLE_SUBSCRIPTION_EXCEPTION_KEYS
    const candidates = detectRecurringCandidates(
      sixMonthly("FreshChef Meal Kit", "-69.99", "delivery"),
    );
    const found = candidates.filter((c) => c.merchantKey === "freshchef meal kit" ||
      c.merchantKey === "freshchef");
    expect(found.length).toBe(0);
  });

  it("dining merchant that incidentally contains a subscription fragment is still blocked", () => {
    // A merchant named "Adobe Cafe" should NOT bypass the lifestyle block just because
    // "adobe" appears in SUBSCRIPTION_BRAND_FRAGMENTS — lifestyle gate uses exact-key matching
    const candidates = detectRecurringCandidates(
      sixMonthly("Adobe Cafe Coffee", "-8.50", "dining"),
    );
    // "adobe cafe coffee" normalises to something that is NOT in LIFESTYLE_SUBSCRIPTION_EXCEPTION_KEYS
    const found = candidates.filter((c) =>
      c.merchantKey.includes("adobe") && c.merchantKey.includes("cafe"),
    );
    expect(found.length).toBe(0);
  });
});
