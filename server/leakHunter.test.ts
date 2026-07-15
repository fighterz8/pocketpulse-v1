import { describe, expect, it } from "vitest";

import {
  buildCoverageMetadata,
  buildLeakHunterReport,
  coverageQualityForDays,
  detectRecentHabitFindings,
  detectRecurringLifecycleFindings,
  freshnessForCoverageEnd,
  isValidIsoDate,
} from "./leakHunter.js";

const expense = (
  id: number,
  date: string,
  amount: number,
  merchant: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  date,
  amount: amount.toFixed(2),
  merchant,
  flowType: "outflow",
  transactionClass: "expense",
  category: "software",
  excludedFromAnalysis: false,
  accountId: 1,
  ...overrides,
});

describe("isValidIsoDate", () => {
  it("accepts real calendar dates and rejects impossible or malformed dates", () => {
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("02-28-2026")).toBe(false);
  });
});

describe("coverageQualityForDays", () => {
  it("maps empty, limited, partial, useful, and strong windows", () => {
    expect(coverageQualityForDays(0)).toBe("empty");
    expect(coverageQualityForDays(44)).toBe("limited");
    expect(coverageQualityForDays(45)).toBe("partial");
    expect(coverageQualityForDays(89)).toBe("partial");
    expect(coverageQualityForDays(90)).toBe("useful");
    expect(coverageQualityForDays(179)).toBe("useful");
    expect(coverageQualityForDays(180)).toBe("strong");
    expect(coverageQualityForDays(365)).toBe("strong");
  });
});

describe("freshnessForCoverageEnd", () => {
  it("uses coverage end age instead of the current transaction span", () => {
    expect(freshnessForCoverageEnd("2026-06-01", "2026-06-14")).toBe(
      "current",
    );
    expect(freshnessForCoverageEnd("2026-06-01", "2026-06-16")).toBe(
      "slightly_stale",
    );
    expect(freshnessForCoverageEnd("2026-06-01", "2026-07-17")).toBe(
      "stale",
    );
    expect(freshnessForCoverageEnd(null, "2026-07-17")).toBe("stale");
  });
});

describe("buildCoverageMetadata", () => {
  it("derives coverage range, as-of date, accounts, and limitations", () => {
    const coverage = buildCoverageMetadata(
      [
        { date: "2026-03-01", accountId: 10 },
        { date: "2026-06-01", accountId: 10 },
        { date: "not-a-date", accountId: 10 },
      ],
      { today: "2026-06-12" },
    );

    expect(coverage).toMatchObject({
      startDate: "2026-03-01",
      endDate: "2026-06-01",
      asOfDate: "2026-06-01",
      totalTransactions: 3,
      accountCount: 1,
      coverageDays: 93,
      coverageQuality: "useful",
      freshness: "current",
      limitations: ["This only reflects one imported account."],
    });
  });

  it("honors an explicit as-of date without changing coverage end", () => {
    const coverage = buildCoverageMetadata(
      [
        { date: "2025-01-01", accountId: 1 },
        { date: "2026-01-01", accountId: 2 },
      ],
      { asOfDate: "2026-02-15", today: "2026-02-16" },
    );

    expect(coverage.endDate).toBe("2026-01-01");
    expect(coverage.asOfDate).toBe("2026-02-15");
    expect(coverage.accountCount).toBe(2);
    expect(coverage.coverageQuality).toBe("strong");
  });

  it("records selected-account and short-history limitations", () => {
    const coverage = buildCoverageMetadata(
      [
        { date: "2026-05-01", accountId: 1 },
        { date: "2026-05-20", accountId: 1 },
      ],
      { today: "2026-06-20", selectedAccountId: 1 },
    );

    expect(coverage.coverageDays).toBe(20);
    expect(coverage.coverageQuality).toBe("limited");
    expect(coverage.freshness).toBe("slightly_stale");
    expect(coverage.limitations).toEqual([
      "This only reflects the selected account.",
      "Less than 90 days of history can miss monthly subscriptions and stopped leaks.",
    ]);
  });

  it("returns an empty coverage payload when there are no transactions", () => {
    const coverage = buildCoverageMetadata([], { today: "2026-06-20" });

    expect(coverage).toEqual({
      startDate: null,
      endDate: null,
      asOfDate: null,
      totalTransactions: 0,
      accountCount: 0,
      coverageDays: 0,
      coverageQuality: "empty",
      freshness: "stale",
      limitations: [
        "Upload transaction history before running a leak hunt.",
      ],
    });
  });
});

describe("buildLeakHunterReport", () => {
  it("returns the planned report envelope with coverage metadata", () => {
    const report = buildLeakHunterReport(
      [{ date: "2026-01-01", accountId: 1 }],
      { today: "2026-01-02" },
    );

    expect(report.coverage.asOfDate).toBe("2026-01-01");
    expect(report.analysisWindow).toEqual({
      startDate: "2025-01-02",
      endDate: "2026-01-01",
      days: 365,
      totalTransactions: 1,
    });
    expect(report.summary).toEqual({
      activeCount: 0,
      inactiveCount: 0,
      priceCreepCount: 0,
      recentHabitCount: 0,
      estimatedActiveMonthly: 0,
      estimatedHistoricalTotal: 0,
    });
    expect(report.sections).toEqual({
      activeLeaks: [],
      stoppedLeaks: [],
      priceCreep: [],
      recentHabits: [],
      needsReview: [],
    });
  });

  it("fills active, stopped, and price-creep report sections", () => {
    const txns = [
      expense(1, "2026-01-01", 10, "OpenAI"),
      expense(2, "2026-02-01", 10, "OpenAI"),
      expense(3, "2026-03-01", 10, "OpenAI"),
      expense(4, "2026-04-01", 10, "OpenAI"),
      expense(5, "2025-09-10", 25, "Old SaaS"),
      expense(6, "2025-10-10", 25, "Old SaaS"),
      expense(7, "2025-11-10", 25, "Old SaaS"),
      expense(8, "2026-01-15", 12, "Cloud Storage"),
      expense(9, "2026-02-15", 12, "Cloud Storage"),
      expense(10, "2026-03-15", 18, "Cloud Storage"),
    ];

    const report = buildLeakHunterReport(txns, {
      asOfDate: "2026-04-20",
      today: "2026-04-20",
    });

    expect(report.summary.activeCount).toBe(2);
    expect(report.summary.inactiveCount).toBe(1);
    expect(report.summary.priceCreepCount).toBe(1);
    expect(report.sections.activeLeaks.map((finding) => finding.merchant)).toEqual(
      ["Cloud Storage", "OpenAI"],
    );
    expect(report.sections.activeLeaks[0]?.transactions).toEqual([
      {
        id: 10,
        date: "2026-03-15",
        merchant: "Cloud Storage",
        amount: 18,
        category: "software",
      },
      {
        id: 9,
        date: "2026-02-15",
        merchant: "Cloud Storage",
        amount: 12,
        category: "software",
      },
      {
        id: 8,
        date: "2026-01-15",
        merchant: "Cloud Storage",
        amount: 12,
        category: "software",
      },
    ]);
    expect(report.sections.stoppedLeaks[0]).toMatchObject({
      merchant: "Old SaaS",
      status: "inactive",
    });
    expect(report.sections.priceCreep[0]).toMatchObject({
      merchant: "Cloud Storage",
      kind: "price_creep",
      priceChangePct: 50,
    });
  });

  it("does not let transactions after the as-of date create findings", () => {
    const report = buildLeakHunterReport(
      [
        expense(1, "2026-01-01", 8, "Before App"),
        expense(2, "2026-02-01", 8, "Before App"),
        expense(3, "2026-03-01", 8, "Before App"),
        expense(4, "2026-04-01", 8, "After App"),
        expense(5, "2026-04-08", 8, "After App"),
        expense(6, "2026-04-15", 8, "After App"),
        expense(7, "2026-04-22", 8, "After App"),
      ],
      { asOfDate: "2026-03-15", today: "2026-04-30" },
    );

    const allFindings = [
      ...report.sections.activeLeaks,
      ...report.sections.stoppedLeaks,
      ...report.sections.priceCreep,
      ...report.sections.recentHabits,
      ...report.sections.needsReview,
    ];

    expect(report.coverage.endDate).toBe("2026-04-22");
    expect(report.coverage.asOfDate).toBe("2026-03-15");
    expect(allFindings.map((finding) => finding.merchant)).toContain("Before App");
    expect(allFindings.map((finding) => finding.merchant)).not.toContain("After App");
  });

  it("limits default comparisons to the latest 365 days", () => {
    const report = buildLeakHunterReport(
      [
        expense(1, "2023-01-05", 12, "Old Streaming"),
        expense(2, "2023-02-05", 12, "Old Streaming"),
        expense(3, "2023-03-05", 12, "Old Streaming"),
        expense(4, "2026-06-01", 12, "Old Streaming"),
      ],
      { asOfDate: "2026-06-15", today: "2026-06-15" },
    );

    expect(report.analysisWindow).toEqual({
      startDate: "2025-06-16",
      endDate: "2026-06-15",
      days: 365,
      totalTransactions: 1,
    });
    expect(Object.values(report.sections).flat()).toEqual([]);
  });

  it("fills recent habit findings without double-counting active recurring merchants", () => {
    const txns = [
      expense(1, "2026-01-01", 12, "Streaming Box", {
        category: "entertainment",
        recurrenceType: "recurring",
      }),
      expense(2, "2026-02-01", 12, "Streaming Box", {
        category: "entertainment",
        recurrenceType: "recurring",
      }),
      expense(3, "2026-03-01", 12, "Streaming Box", {
        category: "entertainment",
        recurrenceType: "recurring",
      }),
      expense(4, "2026-04-01", 12, "Streaming Box", {
        category: "entertainment",
        recurrenceType: "recurring",
      }),
      expense(5, "2026-03-05", 8, "Corner Coffee", {
        category: "coffee",
      }),
      expense(6, "2026-03-09", 7, "Corner Coffee", {
        category: "coffee",
      }),
      expense(7, "2026-03-14", 9, "Corner Coffee", {
        category: "coffee",
      }),
      expense(8, "2026-03-20", 8, "Corner Coffee", {
        category: "coffee",
      }),
    ];

    const report = buildLeakHunterReport(txns, {
      asOfDate: "2026-04-10",
      today: "2026-04-10",
    });

    expect(report.summary.recentHabitCount).toBe(1);
    expect(report.sections.recentHabits[0]).toMatchObject({
      merchant: "Corner Coffee",
      kind: "habit",
      status: "active",
      occurrences: 4,
      ledgerQuery: {
        merchant: "corner coffee",
        startDate: "2026-03-05",
        endDate: "2026-03-20",
      },
      transactions: [
        {
          id: 8,
          date: "2026-03-20",
          merchant: "Corner Coffee",
          amount: 8,
          category: "coffee",
        },
        {
          id: 7,
          date: "2026-03-14",
          merchant: "Corner Coffee",
          amount: 9,
          category: "coffee",
        },
        {
          id: 6,
          date: "2026-03-09",
          merchant: "Corner Coffee",
          amount: 7,
          category: "coffee",
        },
        {
          id: 5,
          date: "2026-03-05",
          merchant: "Corner Coffee",
          amount: 8,
          category: "coffee",
        },
      ],
    });
    expect(report.sections.recentHabits.map((finding) => finding.merchant))
      .not.toContain("Streaming Box");
  });

  it("groups normalized merchant variants despite changing amounts", () => {
    const report = buildLeakHunterReport(
      [
        expense(1, "2026-05-02", 6.5, "TST* Corner Coffee 123456", {
          category: "coffee",
        }),
        expense(2, "2026-05-09", 9.2, "Corner Coffee #8492", {
          category: "coffee",
        }),
        expense(3, "2026-05-17", 7.1, "CORNER COFFEE 998877", {
          category: "coffee",
        }),
        expense(4, "2026-05-28", 11, "Corner Coffee", {
          category: "coffee",
        }),
      ],
      { asOfDate: "2026-06-01", today: "2026-06-01" },
    );

    expect(report.sections.recentHabits).toHaveLength(1);
    expect(report.sections.recentHabits[0]).toMatchObject({
      merchantKey: "corner coffee",
      kind: "habit",
      occurrences: 4,
    });
    expect(report.sections.recentHabits[0]?.transactions).toHaveLength(4);
  });
});

describe("detectRecentHabitFindings", () => {
  it("uses the as-of bounded recent window", () => {
    const findings = detectRecentHabitFindings(
      [
        expense(1, "2025-11-01", 40, "Old Restaurant", {
          category: "dining",
        }),
        expense(2, "2025-11-10", 40, "Old Restaurant", {
          category: "dining",
        }),
        expense(3, "2025-11-20", 40, "Old Restaurant", {
          category: "dining",
        }),
        expense(4, "2026-03-01", 9, "Snack Stop", {
          category: "convenience",
        }),
        expense(5, "2026-03-08", 9, "Snack Stop", {
          category: "convenience",
        }),
        expense(6, "2026-03-15", 9, "Snack Stop", {
          category: "convenience",
        }),
        expense(7, "2026-03-22", 9, "Snack Stop", {
          category: "convenience",
        }),
      ],
      { asOfDate: "2026-03-31", rangeDays: 45 },
    );

    expect(findings.map((finding) => finding.merchant)).toEqual(["Snack Stop"]);
    expect(findings[0]).toMatchObject({
      kind: "habit",
      confidence: "medium",
      monthlyEquivalent: 24,
    });
  });
});

describe("detectRecurringLifecycleFindings", () => {
  it("never treats expected recurring obligations as leaks", () => {
    const obligations = [
      ["Mortgage Payment", "housing", 2400],
      ["Electric Bill", "utilities", 180],
      ["Insurance Premium", "insurance", 140],
      ["Loan Payment", "debt", 450],
      ["Medical Payment Plan", "medical", 90],
    ] as const;
    const txns = obligations.flatMap(([merchant, category, amount], group) =>
      ["2026-01-05", "2026-02-05", "2026-03-05"].map((date, index) =>
        expense(group * 10 + index + 1, date, amount + index * 10, merchant, {
          category,
          recurrenceType: "recurring",
        }),
      ),
    );

    const report = buildLeakHunterReport(txns, {
      asOfDate: "2026-03-25",
      today: "2026-03-25",
    });

    expect(report.summary).toMatchObject({
      activeCount: 0,
      inactiveCount: 0,
      priceCreepCount: 0,
      estimatedActiveMonthly: 0,
      estimatedHistoricalTotal: 0,
    });
    expect(Object.values(report.sections).flat()).toEqual([]);
  });

  it("routes uncategorized recurring patterns to review instead of calling them leaks", () => {
    const report = buildLeakHunterReport(
      [
        expense(1, "2026-01-05", 125, "Unknown Regular Payment", {
          category: "other",
          recurrenceType: "recurring",
        }),
        expense(2, "2026-02-05", 125, "Unknown Regular Payment", {
          category: "other",
          recurrenceType: "recurring",
        }),
        expense(3, "2026-03-05", 125, "Unknown Regular Payment", {
          category: "other",
          recurrenceType: "recurring",
        }),
      ],
      { asOfDate: "2026-03-25", today: "2026-03-25" },
    );

    expect(report.summary).toMatchObject({
      activeCount: 0,
      inactiveCount: 0,
      priceCreepCount: 0,
      estimatedActiveMonthly: 0,
      estimatedHistoricalTotal: 0,
    });
    expect(report.sections.activeLeaks).toEqual([]);
    expect(report.sections.stoppedLeaks).toEqual([]);
    expect(report.sections.priceCreep).toEqual([]);
    expect(report.sections.needsReview[0]).toMatchObject({
      merchant: "Unknown Regular Payment",
      kind: "unknown",
    });
  });

  it("does not clutter review with unknown patterns that already ended", () => {
    const report = buildLeakHunterReport(
      [
        expense(1, "2025-01-05", 125, "Old Unknown Payment", {
          category: "other",
          recurrenceType: "recurring",
        }),
        expense(2, "2025-02-05", 125, "Old Unknown Payment", {
          category: "other",
          recurrenceType: "recurring",
        }),
        expense(3, "2025-03-05", 125, "Old Unknown Payment", {
          category: "other",
          recurrenceType: "recurring",
        }),
      ],
      { asOfDate: "2026-03-25", today: "2026-03-25" },
    );

    expect(report.sections.needsReview).toEqual([]);
    expect(report.sections.stoppedLeaks).toEqual([]);
    expect(report.summary.inactiveCount).toBe(0);
  });

  it("classifies current monthly charges as active", () => {
    const findings = detectRecurringLifecycleFindings(
      [
        expense(1, "2026-01-05", 19.99, "Netflix", {
          category: "entertainment",
        }),
        expense(2, "2026-02-05", 19.99, "Netflix", {
          category: "entertainment",
        }),
        expense(3, "2026-03-05", 19.99, "Netflix", {
          category: "entertainment",
        }),
      ],
      { asOfDate: "2026-03-25", coverageDays: 90 },
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      merchant: "Netflix",
      status: "active",
      cadence: "monthly",
      confidence: "medium",
    });
  });

  it("classifies recently missed monthly charges as overdue", () => {
    const findings = detectRecurringLifecycleFindings(
      [
        expense(1, "2026-01-01", 9.99, "Todo App"),
        expense(2, "2026-02-01", 9.99, "Todo App"),
        expense(3, "2026-03-01", 9.99, "Todo App"),
      ],
      { asOfDate: "2026-05-01", coverageDays: 121 },
    );

    expect(findings[0]).toMatchObject({
      merchant: "Todo App",
      expectedNextDate: "2026-03-31",
      status: "overdue",
    });
  });

  it("classifies long-ended monthly charges as historical", () => {
    const findings = detectRecurringLifecycleFindings(
      [
        expense(1, "2025-01-10", 14, "Retired App"),
        expense(2, "2025-02-10", 14, "Retired App"),
        expense(3, "2025-03-10", 14, "Retired App"),
      ],
      { asOfDate: "2026-01-15", coverageDays: 371 },
    );

    expect(findings[0]).toMatchObject({
      merchant: "Retired App",
      status: "historical",
    });
  });

  it("supports annual renewal candidates with two far-apart charges", () => {
    const findings = detectRecurringLifecycleFindings(
      [
        expense(1, "2025-01-10", 120, "Domain Registrar"),
        expense(2, "2026-01-10", 120, "Domain Registrar"),
      ],
      { asOfDate: "2026-03-01", coverageDays: 416 },
    );

    expect(findings[0]).toMatchObject({
      merchant: "Domain Registrar",
      cadence: "annual",
      status: "active",
      monthlyEquivalent: 10,
    });
  });

  it("puts short-history recurring hints in needs review", () => {
    const report = buildLeakHunterReport(
      [
        expense(1, "2026-06-01", 9, "Short Window"),
        expense(2, "2026-06-08", 9, "Short Window"),
        expense(3, "2026-06-15", 9, "Short Window"),
      ],
      { asOfDate: "2026-06-20", today: "2026-06-20" },
    );

    expect(report.sections.needsReview[0]).toMatchObject({
      merchant: "Short Window",
      status: "insufficient_history",
      cadence: "weekly",
    });
  });
});
