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
