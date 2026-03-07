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

export function calculateCashflow(
  transactions: Transaction[],
  options: { windowDays?: number } = {},
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
    } else {
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
  }

  const monthFactor = Math.max(1, (options.windowDays ?? 90) / 30);
  const recurringIncomeBaseline = recurringIncome / monthFactor;
  const recurringExpenseBaseline = recurringExpenses / monthFactor;
  const utilitiesBaseline = utilitiesExpenses / monthFactor;
  const subscriptionsBaseline = subscriptionsExpenses / monthFactor;
  const safeToSpend = recurringIncomeBaseline - recurringExpenseBaseline;
  const netCashflow = totalInflows - totalOutflows;

  return {
    totalInflows: Math.round(totalInflows * 100) / 100,
    totalOutflows: Math.round(totalOutflows * 100) / 100,
    recurringIncome: Math.round(recurringIncomeBaseline * 100) / 100,
    recurringExpenses: Math.round(recurringExpenseBaseline * 100) / 100,
    oneTimeIncome: Math.round(oneTimeIncome * 100) / 100,
    oneTimeExpenses: Math.round(oneTimeExpenses * 100) / 100,
    safeToSpend: Math.round(safeToSpend * 100) / 100,
    netCashflow: Math.round(netCashflow * 100) / 100,
    utilitiesBaseline: Math.round(utilitiesBaseline * 100) / 100,
    subscriptionsBaseline: Math.round(subscriptionsBaseline * 100) / 100,
    discretionarySpend: Math.round(discretionarySpend * 100) / 100,
  };
}

export interface LeakItem {
  merchant: string;
  merchantFilter: string;
  category: TransactionCategory;
  bucket: "repeat_discretionary" | "micro_spend" | "high_frequency_convenience";
  label: string;
  monthlyAmount: number;
  annualAmount: number;
  occurrences: number;
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
  averageAmount: number;
  recentSpend: number;
  transactionClass: "expense";
  recurrenceType?: "recurring" | "one-time";
}

export function detectLeaks(transactions: Transaction[]): LeakItem[] {
  const monthFactor = Math.max(1, transactions.length ? getMonthFactorFromTransactions(transactions) : 1);
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
  for (const [merchantKey, group] of Object.entries(merchantGroups)) {
    if (group.amounts.length < 2) continue;
    
    const totalSpend = group.amounts.reduce((a, b) => a + b, 0);
    const avgAmount = totalSpend / group.amounts.length;
    const sortedDates = group.dates.sort().reverse();
    const amountVariance = group.amounts.length > 1
      ? Math.max(...group.amounts) - Math.min(...group.amounts)
      : 0;
    const isRecurring = group.recurrenceTypes.includes("recurring");
    const isMicroSpend = avgAmount <= 20 && group.amounts.length >= 4;
    const isConvenience = group.category === "dining" && group.amounts.length >= 4;
    const isRepeatDiscretionary =
      ["dining", "shopping", "entertainment"].includes(group.category) &&
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
      monthlyAmount: Math.round((totalSpend / monthFactor) * 100) / 100,
      annualAmount: Math.round((totalSpend / monthFactor) * 12 * 100) / 100,
      occurrences: group.amounts.length,
      lastDate: sortedDates[0],
      confidence,
      averageAmount: Math.round(avgAmount * 100) / 100,
      recentSpend: Math.round(totalSpend * 100) / 100,
      transactionClass: "expense",
      recurrenceType: isRecurring ? "recurring" : undefined,
    });
  }

  return leaks.sort((a, b) => b.annualAmount - a.annualAmount);
}

function getMonthFactorFromTransactions(transactions: Transaction[]): number {
  const dates = transactions
    .map((tx) => tx.date)
    .filter(Boolean)
    .sort();

  if (dates.length < 2) {
    return 1;
  }

  const minDate = new Date(`${dates[0]}T00:00:00Z`);
  const maxDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  const dayDiff = Math.max(1, Math.ceil((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)));
  return Math.max(1, dayDiff / 30);
}
