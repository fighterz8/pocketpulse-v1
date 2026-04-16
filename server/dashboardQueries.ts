import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";

import { accounts, recurringReviews, transactions } from "../shared/schema.js";
import { db } from "./db.js";
import { detectRecurringCandidates } from "./recurrenceDetector.js";
import { listAllTransactionsForExport } from "./storage.js";

export type DashboardDateRange = {
  dateFrom?: string;
  dateTo?: string;
};

const DISCRETIONARY_CATEGORIES = [
  "dining",
  "coffee",
  "delivery",
  "convenience",
  "shopping",
  "entertainment",
  "software",
  "travel",
  "parking",
  "fitness",
];

export type DashboardSummary = {
  isAllTime: boolean;
  totals: {
    totalInflow: number;
    totalOutflow: number;
    netCashflow: number;
    transactionCount: number;
    recurringIncome: number;
    recurringExpenses: number;
    oneTimeIncome: number;
    oneTimeExpenses: number;
    discretionarySpend: number;
    safeToSpend: number;
    utilitiesMonthly: number;
    softwareMonthly: number;
    utilitiesTotal: number;
    softwareTotal: number;
    periodDays: number;
  };
  expenseLeaks: {
    count: number;
    monthlyAmount: number;
  };
  categoryBreakdown: Array<{
    category: string;
    total: number;
    count: number;
  }>;
  monthlyTrend: Array<{
    month: string;
    inflow: number;
    outflow: number;
    net: number;
  }>;
  recentTransactions: Array<{
    id: number;
    date: string;
    merchant: string;
    amount: string;
    category: string;
    transactionClass: string;
  }>;
  accountCount: number;
};

/**
 * Pure helper — compute `periodDays` from a min/max date pair (all-time mode).
 * Exported for unit-testing without hitting the database.
 *
 * - Multi-day span:  ceil(diff_ms / 86_400_000) + 1  (inclusive of both endpoints)
 * - Same day:        30  (single-day or empty dataset — default to one month)
 * - One/both absent: 30
 */
export function computePeriodDaysFromSpan(
  minDate: string | null | undefined,
  maxDate: string | null | undefined,
): number {
  if (minDate && maxDate && minDate !== maxDate) {
    return Math.max(
      1,
      Math.ceil(
        (new Date(maxDate).getTime() - new Date(minDate).getTime()) / 86_400_000,
      ) + 1,
    );
  }
  return 30;
}

export async function buildDashboardSummary(
  userId: number,
  range?: DashboardDateRange,
): Promise<DashboardSummary> {
  const conditions = [
    eq(transactions.userId, userId),
    eq(transactions.excludedFromAnalysis, false),
  ];
  if (range?.dateFrom) conditions.push(gte(transactions.date, range.dateFrom));
  if (range?.dateTo) conditions.push(lte(transactions.date, range.dateTo));
  const baseWhere = and(...conditions);

  const discIn = sql`${transactions.category} IN (${sql.join(DISCRETIONARY_CATEGORIES.map((c) => sql`${c}`), sql`, `)})`;

  const [
    totalsResult,
    categoryResult,
    monthlyResult,
    recentResult,
    accountResult,
    leakResult,
  ] = await Promise.all([
    db
      .select({
        // Use transactionClass (not flowType) so every aggregate matches the ledger's
        // transactionClass filter exactly.  flowType includes transfers; transactionClass
        // does not — the two differ whenever a user has inter-account transfer rows.
        totalInflow:        sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='income'  THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        totalOutflow:       sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='expense' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        recurringIncome:    sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='income'  AND ${transactions.recurrenceType}='recurring' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        recurringExpenses:  sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='expense' AND ${transactions.recurrenceType}='recurring' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        oneTimeIncome:      sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='income'  AND ${transactions.recurrenceType}='one-time'  THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        oneTimeExpenses:    sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='expense' AND ${transactions.recurrenceType}='one-time'  THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        discretionarySpend: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='expense' AND ${discIn} THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        utilitiesTotal:     sql<string>`COALESCE(SUM(CASE WHEN ${transactions.category}='utilities' AND ${transactions.transactionClass}='expense' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        softwareTotal:      sql<string>`COALESCE(SUM(CASE WHEN ${transactions.category}='software'  AND ${transactions.transactionClass}='expense' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        count: count(),
      })
      .from(transactions)
      .where(baseWhere),

    db
      .select({
        category: transactions.category,
        total: sql<string>`COALESCE(SUM(ABS(${transactions.amount})), 0)`,
        count: count(),
      })
      .from(transactions)
      .where(and(baseWhere, eq(transactions.transactionClass, "expense")))
      .groupBy(transactions.category)
      .orderBy(sql`SUM(ABS(${transactions.amount})) DESC`),

    db
      .select({
        month: sql<string>`SUBSTRING(${transactions.date}, 1, 7)`,
        inflow:  sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='inflow'  THEN ${transactions.amount} ELSE 0 END),0)`,
        outflow: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='outflow' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
      })
      .from(transactions)
      .where(baseWhere)
      .groupBy(sql`SUBSTRING(${transactions.date}, 1, 7)`)
      .orderBy(sql`SUBSTRING(${transactions.date}, 1, 7)`),

    db
      .select({
        id: transactions.id,
        date: transactions.date,
        merchant: transactions.merchant,
        amount: transactions.amount,
        category: transactions.category,
        transactionClass: transactions.transactionClass,
      })
      .from(transactions)
      .where(baseWhere)
      .orderBy(desc(transactions.date), desc(transactions.id))
      .limit(10),

    db
      .select({ count: count() })
      .from(accounts)
      .where(eq(accounts.userId, userId)),

    db
      .select({ count: count() })
      .from(recurringReviews)
      .where(and(eq(recurringReviews.userId, userId), eq(recurringReviews.status, "leak"))),
  ]);

  const t = totalsResult[0]!;
  const totalInflow        = parseFloat(t.totalInflow) || 0;
  const totalOutflow       = parseFloat(t.totalOutflow) || 0;
  const recurringIncome    = parseFloat(t.recurringIncome) || 0;
  const recurringExpenses  = parseFloat(t.recurringExpenses) || 0;
  const oneTimeIncome      = parseFloat(t.oneTimeIncome) || 0;
  const oneTimeExpenses    = parseFloat(t.oneTimeExpenses) || 0;
  const discretionarySpend = parseFloat(t.discretionarySpend) || 0;

  // Determine whether this is an all-time (no date range) query.
  const isAllTime = !(range?.dateFrom || range?.dateTo);

  // Calculate period length for monthly baselines.
  // When no explicit date range is supplied (isAllTime) we query the actual
  // first→last transaction span instead of falling back to an arbitrary constant.
  // The two branches are tied directly to isAllTime so a partial range (one bound
  // only) never accidentally triggers the all-time min/max path.
  let periodDays: number;
  if (!isAllTime) {
    // Explicit range mode — use provided bounds when both are present.
    // A single-bound edge case falls back to 30 days (deterministic).
    if (range?.dateFrom && range?.dateTo) {
      periodDays = Math.max(
        1,
        Math.ceil(
          (new Date(range.dateTo).getTime() - new Date(range.dateFrom).getTime()) /
            86_400_000,
        ),
      );
    } else {
      periodDays = 30; // deterministic fallback for single-bound edge case
    }
  } else {
    // All-time mode — derive span from actual transaction data.
    const spanResult = await db
      .select({
        minDate: sql<string>`MIN(${transactions.date})`,
        maxDate: sql<string>`MAX(${transactions.date})`,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.excludedFromAnalysis, false)));
    const minDate = spanResult[0]?.minDate;
    const maxDate = spanResult[0]?.maxDate;
    periodDays = computePeriodDaysFromSpan(minDate, maxDate);
  }
  const months = Math.max(1, periodDays / 30);

  const utilitiesTotal  = parseFloat(t.utilitiesTotal) || 0;
  const softwareTotal   = parseFloat(t.softwareTotal)  || 0;
  const utilitiesMonthly = utilitiesTotal / months;
  const softwareMonthly  = softwareTotal  / months;

  // ── Detector-based leak calculations ─────────────────────────────────────
  // `recurringExpenses` is now a plain SQL aggregate (see totalsResult above),
  // so it correctly matches the ledger's transactionClass=expense filter and
  // respects the selected date range and manual recurrenceType edits.
  // The detector is still needed here to compute leakMonthlyAmount for the
  // confirmed-leak card, which requires the normalised monthly-equivalent rate.
  const allTxns    = await listAllTransactionsForExport({ userId });
  const candidates = detectRecurringCandidates(allTxns as any);

  // leakMonthlyAmount: sum of monthlyEquivalent for CONFIRMED leaks only —
  // not a proxy of total recurring outflow.
  const leakCount = Number(leakResult[0]?.count) || 0;
  let leakMonthlyAmount = 0;
  if (leakCount > 0) {
    const leakReviewRows = await db
      .select({ candidateKey: recurringReviews.candidateKey })
      .from(recurringReviews)
      .where(
        and(
          eq(recurringReviews.userId, userId),
          eq(recurringReviews.status, "leak"),
        ),
      );
    const leakKeys = new Set(leakReviewRows.map((r) => r.candidateKey));
    leakMonthlyAmount = Math.round(
      candidates
        .filter((c) => leakKeys.has(c.candidateKey))
        .reduce((sum, c) => sum + c.monthlyEquivalent, 0) * 100,
    ) / 100;
  }

  return {
    isAllTime,
    totals: {
      totalInflow,
      totalOutflow,
      netCashflow: totalInflow - totalOutflow,
      transactionCount: Number(t.count) || 0,
      recurringIncome,
      recurringExpenses,
      oneTimeIncome,
      oneTimeExpenses,
      discretionarySpend,
      // Net cashflow is a more honest "safe to spend" than recurring-only math.
      // Most small-business expenses are one-time (invoices, supplies, etc.),
      // so recurring-only understates costs significantly.
      safeToSpend: totalInflow - totalOutflow,
      utilitiesMonthly,
      softwareMonthly,
      utilitiesTotal,
      softwareTotal,
      periodDays,
    },
    expenseLeaks: {
      count: leakCount,
      monthlyAmount: leakMonthlyAmount,
    },
    categoryBreakdown: categoryResult.map((r) => ({
      category: r.category,
      total: parseFloat(r.total) || 0,
      count: Number(r.count) || 0,
    })),
    monthlyTrend: monthlyResult.map((r) => {
      const inflow  = parseFloat(r.inflow)  || 0;
      const outflow = parseFloat(r.outflow) || 0;
      return { month: r.month, inflow, outflow, net: inflow - outflow };
    }),
    recentTransactions: recentResult.map((r) => ({
      id: r.id,
      date: r.date,
      merchant: r.merchant,
      amount: String(r.amount),
      category: r.category,
      transactionClass: r.transactionClass,
    })),
    accountCount: Number(accountResult[0]?.count) || 0,
  };
}
