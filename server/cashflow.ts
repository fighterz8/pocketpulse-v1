import type { Transaction, TransactionCategory } from "@shared/schema";
import { flowTypeFromAmount } from "./transactionUtils";

export interface CashflowSummary {
  totalInflows: number;
  totalOutflows: number;
  recurringIncome: number;
  recurringExpenses: number;
  oneTimeIncome: number;
  oneTimeExpenses: number;
  safeToSpend: number;
  netCashflow: number;
  utilitiesBaseline: number;
  subscriptionsBaseline: number;
  discretionarySpend: number;
}

export interface MetricDelta {
  current: number;
  previous: number;
  delta: number;
  deltaPct: number | null;
}

export interface TrendPoint {
  period: string;
  inflows: number;
  outflows: number;
  netCashflow: number;
  discretionarySpend: number;
}

export interface CategoryBreakdownItem {
  category: TransactionCategory;
  amount: number;
  monthlyBaseline: number;
  share: number;
  occurrences: number;
}

export interface CashflowAnalysis {
  summary: CashflowSummary;
  previousSummary: CashflowSummary;
  comparisons: {
    inflows: MetricDelta;
    outflows: MetricDelta;
    netCashflow: MetricDelta;
    safeToSpend: MetricDelta;
    discretionarySpend: MetricDelta;
  };
  trend: TrendPoint[];
  categoryBreakdown: CategoryBreakdownItem[];
  leakPreview: LeakItem[];
  recurringConfidence: number;
}

export type DashboardMetric =
  | "totalInflows"
  | "totalOutflows"
  | "recurringIncome"
  | "recurringExpenses"
  | "oneTimeIncome"
  | "oneTimeExpenses"
  | "safeToSpend"
  | "netCashflow"
  | "utilitiesBaseline"
  | "subscriptionsBaseline"
  | "discretionarySpend";

export interface DashboardMetricDefinition {
  label: string;
  description: string;
}

const SUBSCRIPTION_LIKE_CATEGORIES = new Set<TransactionCategory>(["subscriptions", "business_software"]);
const DISCRETIONARY_CATEGORIES = new Set<TransactionCategory>(["dining", "shopping", "entertainment"]);
const ESSENTIAL_LEAK_EXCLUSIONS = new Set<TransactionCategory>([
  "utilities",
  "subscriptions",
  "business_software",
  "insurance",
  "housing",
  "debt",
  "groceries",
  "health",
  "transportation",
  "fees",
  "income",
  "transfers",
]);

const DASHBOARD_METRIC_DEFINITIONS: Record<DashboardMetric, DashboardMetricDefinition> = {
  totalInflows: {
    label: "Total inflows",
    description: "All non-transfer, non-refund inflows in the selected range.",
  },
  totalOutflows: {
    label: "Total outflows",
    description: "All non-transfer, non-refund outflows in the selected range.",
  },
  recurringIncome: {
    label: "Recurring income baseline",
    description: "Recurring inflows in the selected range, normalized into a monthly baseline.",
  },
  recurringExpenses: {
    label: "Recurring expense baseline",
    description: "Recurring outflows in the selected range, normalized into a monthly baseline.",
  },
  oneTimeIncome: {
    label: "One-time income",
    description: "Non-recurring inflows in the selected range.",
  },
  oneTimeExpenses: {
    label: "One-time expenses",
    description: "Non-recurring outflows in the selected range.",
  },
  safeToSpend: {
    label: "Safe to spend",
    description: "Recurring income baseline minus recurring expense baseline for the selected range.",
  },
  netCashflow: {
    label: "Net cashflow",
    description: "Total inflows minus total outflows in the selected range.",
  },
  utilitiesBaseline: {
    label: "Utilities baseline",
    description: "Utility outflows in the selected range, normalized into a monthly baseline.",
  },
  subscriptionsBaseline: {
    label: "Subscriptions baseline",
    description: "Subscription and software outflows in the selected range, normalized into a monthly baseline.",
  },
  discretionarySpend: {
    label: "Discretionary spend",
    description: "Dining, shopping, and entertainment spend in the selected range.",
  },
};

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function getMonthFactor(rangeDays?: number): number {
  if (!rangeDays || rangeDays <= 0) {
    return 1;
  }

  return Math.max(1, rangeDays / 30);
}

function isSummaryTransaction(transaction: Transaction): boolean {
  return transaction.transactionClass !== "transfer" && transaction.transactionClass !== "refund";
}

export function getDashboardMetricDefinition(metric: DashboardMetric): DashboardMetricDefinition {
  return DASHBOARD_METRIC_DEFINITIONS[metric];
}

export function getDashboardMetricTransactions(
  transactions: Transaction[],
  metric: DashboardMetric,
): Transaction[] {
  return transactions.filter((transaction) => {
    const flowType = flowTypeFromAmount(parseFloat(transaction.amount));

    if (!isSummaryTransaction(transaction)) {
      return false;
    }

    switch (metric) {
      case "totalInflows":
        return flowType === "inflow";
      case "totalOutflows":
        return flowType === "outflow";
      case "recurringIncome":
        return flowType === "inflow" && transaction.recurrenceType === "recurring";
      case "recurringExpenses":
        return flowType === "outflow" && transaction.recurrenceType === "recurring";
      case "oneTimeIncome":
        return flowType === "inflow" && transaction.recurrenceType !== "recurring";
      case "oneTimeExpenses":
        return flowType === "outflow" && transaction.recurrenceType !== "recurring";
      case "safeToSpend":
        return transaction.recurrenceType === "recurring" && (flowType === "inflow" || flowType === "outflow");
      case "netCashflow":
        return true;
      case "utilitiesBaseline":
        return flowType === "outflow" && transaction.category === "utilities";
      case "subscriptionsBaseline":
        return flowType === "outflow" && SUBSCRIPTION_LIKE_CATEGORIES.has(transaction.category as TransactionCategory);
      case "discretionarySpend":
        return flowType === "outflow" && DISCRETIONARY_CATEGORIES.has(transaction.category as TransactionCategory);
    }
  });
}

export function getDashboardMetricValue(
  transactions: Transaction[],
  metric: DashboardMetric,
  options: { rangeDays?: number } = {},
): number {
  const summary = calculateCashflow(transactions, { rangeDays: options.rangeDays });
  return summary[metric];
}

export function calculateCashflow(
  transactions: Transaction[],
  options: { rangeDays?: number } = {},
): CashflowSummary {
  let totalInflows = 0;
  let totalOutflows = 0;
  let recurringIncome = 0;
  let recurringExpenses = 0;
  let oneTimeIncome = 0;
  let oneTimeExpenses = 0;
  let utilitiesExpenses = 0;
  let subscriptionsExpenses = 0;
  let discretionarySpend = 0;

  for (const tx of transactions) {
    const signedAmount = parseFloat(tx.amount);
    const amount = Math.abs(signedAmount);
    const flowType = flowTypeFromAmount(signedAmount);

    if (tx.transactionClass === "transfer" || tx.transactionClass === "refund") {
      continue;
    }

    if (flowType === "inflow") {
      totalInflows += amount;
      if (tx.recurrenceType === "recurring") {
        recurringIncome += amount;
      } else {
        oneTimeIncome += amount;
      }
      continue;
    }

    totalOutflows += amount;
    if (tx.category === "utilities") {
      utilitiesExpenses += amount;
    }
    if (SUBSCRIPTION_LIKE_CATEGORIES.has(tx.category as TransactionCategory)) {
      subscriptionsExpenses += amount;
    }
    if (DISCRETIONARY_CATEGORIES.has(tx.category as TransactionCategory)) {
      discretionarySpend += amount;
    }
    if (tx.recurrenceType === "recurring") {
      recurringExpenses += amount;
    } else {
      oneTimeExpenses += amount;
    }
  }

  const monthFactor = getMonthFactor(options.rangeDays);
  const recurringIncomeBaseline = recurringIncome / monthFactor;
  const recurringExpenseBaseline = recurringExpenses / monthFactor;
  const utilitiesBaseline = utilitiesExpenses / monthFactor;
  const subscriptionsBaseline = subscriptionsExpenses / monthFactor;
  const safeToSpend = recurringIncomeBaseline - recurringExpenseBaseline;
  const netCashflow = totalInflows - totalOutflows;

  return {
    totalInflows: roundCurrency(totalInflows),
    totalOutflows: roundCurrency(totalOutflows),
    recurringIncome: roundCurrency(recurringIncomeBaseline),
    recurringExpenses: roundCurrency(recurringExpenseBaseline),
    oneTimeIncome: roundCurrency(oneTimeIncome),
    oneTimeExpenses: roundCurrency(oneTimeExpenses),
    safeToSpend: roundCurrency(safeToSpend),
    netCashflow: roundCurrency(netCashflow),
    utilitiesBaseline: roundCurrency(utilitiesBaseline),
    subscriptionsBaseline: roundCurrency(subscriptionsBaseline),
    discretionarySpend: roundCurrency(discretionarySpend),
  };
}

export interface LeakItem {
  merchant: string;
  merchantFilter: string;
  category: TransactionCategory;
  bucket: "repeat_discretionary" | "micro_spend" | "high_frequency_convenience";
  label: string;
  monthlyAmount: number;
  occurrences: number;
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
  averageAmount: number;
  recentSpend: number;
  transactionClass: "expense";
  recurrenceType?: "recurring" | "one-time";
}

export function detectLeaks(
  transactions: Transaction[],
  options: { rangeDays?: number } = {},
): LeakItem[] {
  const monthFactor = getMonthFactor(options.rangeDays ?? getRangeDaysFromTransactions(transactions));
  const candidateExpenses = transactions.filter((tx) =>
    tx.transactionClass === "expense" &&
    !ESSENTIAL_LEAK_EXCLUSIONS.has(tx.category as TransactionCategory),
  );

  const merchantGroups: Record<string, { merchant: string; category: TransactionCategory; amounts: number[]; dates: string[]; recurrenceTypes: Array<"recurring" | "one-time"> }> = {};
  for (const tx of candidateExpenses) {
    const key = `${tx.merchant.toLowerCase()}::${tx.category}`;
    if (!merchantGroups[key]) {
      merchantGroups[key] = {
        merchant: tx.merchant,
        category: tx.category as TransactionCategory,
        amounts: [],
        dates: [],
        recurrenceTypes: [],
      };
    }
    merchantGroups[key].amounts.push(Math.abs(parseFloat(tx.amount)));
    merchantGroups[key].dates.push(tx.date);
    merchantGroups[key].recurrenceTypes.push(tx.recurrenceType as "recurring" | "one-time");
  }

  const leaks: LeakItem[] = [];
  for (const group of Object.values(merchantGroups)) {
    if (group.amounts.length < 2) continue;

    const totalSpend = group.amounts.reduce((a, b) => a + b, 0);
    const avgAmount = totalSpend / group.amounts.length;
    const sortedDates = group.dates.sort().reverse();
    const amountVariance = group.amounts.length > 1 ? Math.max(...group.amounts) - Math.min(...group.amounts) : 0;
    const isRecurring = group.recurrenceTypes.includes("recurring");
    const isMicroSpend = avgAmount <= 20 && group.amounts.length >= 4;
    const isConvenience = group.category === "dining" && group.amounts.length >= 4;
    const isRepeatDiscretionary =
      DISCRETIONARY_CATEGORIES.has(group.category) &&
      group.amounts.length >= 3 &&
      totalSpend >= 60;

    if (!isRecurring && !isMicroSpend && !isConvenience && !isRepeatDiscretionary) {
      continue;
    }

    let bucket: LeakItem["bucket"] = "repeat_discretionary";
    let label = "Repeat discretionary spend";
    if (isMicroSpend) {
      bucket = "micro_spend";
      label = "Frequent micro-purchases";
    } else if (isConvenience) {
      bucket = "high_frequency_convenience";
      label = "High-frequency convenience spend";
    }

    let confidence: "High" | "Medium" | "Low" = "Medium";
    if (group.amounts.length >= 6 || (isRecurring && amountVariance < avgAmount * 0.15)) {
      confidence = "High";
    } else if (group.amounts.length <= 2) {
      confidence = "Low";
    }

    leaks.push({
      merchant: group.merchant,
      merchantFilter: group.merchant,
      category: group.category,
      bucket,
      label,
      monthlyAmount: roundCurrency(totalSpend / monthFactor),
      occurrences: group.amounts.length,
      lastDate: sortedDates[0],
      confidence,
      averageAmount: roundCurrency(avgAmount),
      recentSpend: roundCurrency(totalSpend),
      transactionClass: "expense",
      recurrenceType: isRecurring ? "recurring" : undefined,
    });
  }

  return leaks.sort((a, b) => b.recentSpend - a.recentSpend);
}

export function buildCashflowAnalysis(
  currentTransactions: Transaction[],
  previousTransactions: Transaction[],
  options: { rangeDays: number; leakPreviewLimit?: number } ,
): CashflowAnalysis {
  const summary = calculateCashflow(currentTransactions, { rangeDays: options.rangeDays });
  const previousSummary = calculateCashflow(previousTransactions, { rangeDays: options.rangeDays });

  return {
    summary,
    previousSummary,
    comparisons: {
      inflows: calculateDelta(summary.totalInflows, previousSummary.totalInflows),
      outflows: calculateDelta(summary.totalOutflows, previousSummary.totalOutflows),
      netCashflow: calculateDelta(summary.netCashflow, previousSummary.netCashflow),
      safeToSpend: calculateDelta(summary.safeToSpend, previousSummary.safeToSpend),
      discretionarySpend: calculateDelta(summary.discretionarySpend, previousSummary.discretionarySpend),
    },
    trend: buildTrendSeries(currentTransactions),
    categoryBreakdown: buildCategoryBreakdown(currentTransactions, options.rangeDays),
    leakPreview: detectLeaks(currentTransactions, { rangeDays: options.rangeDays }).slice(0, options.leakPreviewLimit ?? 5),
    recurringConfidence: calculateRecurringConfidence(currentTransactions),
  };
}

function calculateDelta(current: number, previous: number): MetricDelta {
  const delta = current - previous;
  return {
    current,
    previous,
    delta: roundCurrency(delta),
    deltaPct: previous === 0 ? null : roundCurrency((delta / previous) * 100),
  };
}

function buildTrendSeries(transactions: Transaction[]): TrendPoint[] {
  const buckets = new Map<string, TrendPoint>();

  for (const tx of transactions) {
    if (tx.transactionClass === "transfer" || tx.transactionClass === "refund") {
      continue;
    }

    const period = tx.date.slice(0, 7);
    const existing = buckets.get(period) ?? {
      period,
      inflows: 0,
      outflows: 0,
      netCashflow: 0,
      discretionarySpend: 0,
    };
    const signedAmount = parseFloat(tx.amount);
    const amount = Math.abs(signedAmount);
    const flowType = flowTypeFromAmount(signedAmount);

    if (flowType === "inflow") {
      existing.inflows += amount;
    } else {
      existing.outflows += amount;
      if (DISCRETIONARY_CATEGORIES.has(tx.category as TransactionCategory)) {
        existing.discretionarySpend += amount;
      }
    }
    existing.netCashflow = existing.inflows - existing.outflows;
    buckets.set(period, existing);
  }

  return Array.from(buckets.values())
    .sort((left, right) => left.period.localeCompare(right.period))
    .map((point) => ({
      ...point,
      inflows: roundCurrency(point.inflows),
      outflows: roundCurrency(point.outflows),
      netCashflow: roundCurrency(point.netCashflow),
      discretionarySpend: roundCurrency(point.discretionarySpend),
    }));
}

function buildCategoryBreakdown(transactions: Transaction[], rangeDays: number): CategoryBreakdownItem[] {
  const bucketMap = new Map<TransactionCategory, { amount: number; occurrences: number }>();
  let totalExpenses = 0;

  for (const tx of transactions) {
    if (tx.transactionClass !== "expense") {
      continue;
    }

    const amount = Math.abs(parseFloat(tx.amount));
    totalExpenses += amount;
    const category = tx.category as TransactionCategory;
    const existing = bucketMap.get(category) ?? { amount: 0, occurrences: 0 };
    existing.amount += amount;
    existing.occurrences += 1;
    bucketMap.set(category, existing);
  }

  const monthFactor = getMonthFactor(rangeDays);
  return Array.from(bucketMap.entries())
    .map(([category, bucket]) => ({
      category,
      amount: roundCurrency(bucket.amount),
      monthlyBaseline: roundCurrency(bucket.amount / monthFactor),
      share: totalExpenses === 0 ? 0 : roundCurrency((bucket.amount / totalExpenses) * 100),
      occurrences: bucket.occurrences,
    }))
    .sort((left, right) => right.amount - left.amount);
}

function calculateRecurringConfidence(transactions: Transaction[]): number {
  const recurringTransactions = transactions.filter((tx) => tx.recurrenceType === "recurring" && tx.transactionClass !== "transfer");
  const months = new Set(transactions.map((tx) => tx.date.slice(0, 7))).size;
  if (months === 0) {
    return 0;
  }

  const recurringMonths = new Set(recurringTransactions.map((tx) => tx.date.slice(0, 7))).size;
  return roundCurrency(Math.min(100, (recurringMonths / months) * 100));
}

function getRangeDaysFromTransactions(transactions: Transaction[]): number {
  const dates = transactions.map((tx) => tx.date).filter(Boolean).sort();
  if (dates.length < 2) {
    return 30;
  }

  const minDate = new Date(`${dates[0]}T00:00:00Z`);
  const maxDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  return Math.max(1, Math.floor((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
}
