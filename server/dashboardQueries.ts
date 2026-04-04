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
        totalInflow:        sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='inflow' THEN ${transactions.amount} ELSE 0 END),0)`,
        totalOutflow:       sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='outflow' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        recurringIncome:    sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='inflow'  AND ${transactions.recurrenceType}='recurring' THEN ${transactions.amount} ELSE 0 END),0)`,
        oneTimeIncome:      sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='inflow'  AND ${transactions.recurrenceType}='one-time'  THEN ${transactions.amount} ELSE 0 END),0)`,
        oneTimeExpenses:    sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='outflow' AND ${transactions.recurrenceType}='one-time'  THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        discretionarySpend: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType}='outflow' AND ${discIn} THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        utilitiesTotal:     sql<string>`COALESCE(SUM(CASE WHEN ${transactions.category}='utilities' AND ${transactions.flowType}='outflow' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        softwareTotal:      sql<string>`COALESCE(SUM(CASE WHEN ${transactions.category}='software'  AND ${transactions.flowType}='outflow' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
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
      .where(and(baseWhere, eq(transactions.flowType, "outflow")))
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
  const oneTimeIncome      = parseFloat(t.oneTimeIncome) || 0;
  const oneTimeExpenses    = parseFloat(t.oneTimeExpenses) || 0;
  const discretionarySpend = parseFloat(t.discretionarySpend) || 0;

  // Calculate period length for monthly baselines
  const periodDays = range?.dateFrom && range?.dateTo
    ? Math.max(1, Math.ceil((new Date(range.dateTo).getTime() - new Date(range.dateFrom).getTime()) / 86_400_000))
    : 90;
  const months = Math.max(1, periodDays / 30);

  const utilitiesMonthly = (parseFloat(t.utilitiesTotal) || 0) / months;
  const softwareMonthly  = (parseFloat(t.softwareTotal)  || 0) / months;

  // ── Detector-based recurring & leak calculations ──────────────────────────
  // Running the detector here ensures recurringExpenses is always a stable
  // monthly baseline (sum of monthlyEquivalent for active recurring candidates)
  // rather than a raw sum of transactions that happen to fall in the window.
  // Quarterly/annual charges are correctly normalised to their monthly fraction.
  const allTxns     = await listAllTransactionsForExport({ userId });
  const candidates  = detectRecurringCandidates(allTxns as any);
  const activeCands = candidates.filter((c) => c.isActive);

  const recurringExpenses = Math.round(
    activeCands.reduce((sum, c) => sum + c.monthlyEquivalent, 0) * 100,
  ) / 100;

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
