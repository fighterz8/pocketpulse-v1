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
  it("combines merchant key and rounded amount", () => {
    expect(buildCandidateKey("netflix", 15.99)).toBe("netflix|15.99");
  });

  it("rounds to 2 decimal places", () => {
    expect(buildCandidateKey("utilities", 127.333)).toBe("utilities|127.33");
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

    const netflix = candidates.find((c) => c.candidateKey.startsWith("netflix|"));
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
