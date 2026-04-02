import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";

import { accounts, transactions } from "../shared/schema.js";
import { db } from "./db.js";

export type DashboardDateRange = {
  dateFrom?: string;
  dateTo?: string;
};

export type DashboardSummary = {
  totals: {
    totalInflow: number;
    totalOutflow: number;
    netCashflow: number;
    transactionCount: number;
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

  const [
    totalsResult,
    categoryResult,
    monthlyResult,
    recentResult,
    accountResult,
  ] = await Promise.all([
    db
      .select({
        totalInflow: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType} = 'inflow' THEN ${transactions.amount} ELSE 0 END), 0)`,
        totalOutflow: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType} = 'outflow' THEN ABS(${transactions.amount}) ELSE 0 END), 0)`,
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
        inflow: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType} = 'inflow' THEN ${transactions.amount} ELSE 0 END), 0)`,
        outflow: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.flowType} = 'outflow' THEN ABS(${transactions.amount}) ELSE 0 END), 0)`,
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
  ]);

  const totals = totalsResult[0]!;
  const totalInflow = parseFloat(totals.totalInflow) || 0;
  const totalOutflow = parseFloat(totals.totalOutflow) || 0;

  return {
    totals: {
      totalInflow,
      totalOutflow,
      netCashflow: totalInflow - totalOutflow,
      transactionCount: Number(totals.count) || 0,
    },
    categoryBreakdown: categoryResult.map((r) => ({
      category: r.category,
      total: parseFloat(r.total) || 0,
      count: Number(r.count) || 0,
    })),
    monthlyTrend: monthlyResult.map((r) => {
      const inflow = parseFloat(r.inflow) || 0;
      const outflow = parseFloat(r.outflow) || 0;
      return {
        month: r.month,
        inflow,
        outflow,
        net: inflow - outflow,
      };
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
