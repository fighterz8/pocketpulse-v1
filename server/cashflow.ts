import type { Transaction } from "@shared/schema";

export interface CashflowSummary {
  totalInflows: number;
  totalOutflows: number;
  recurringIncome: number;
  recurringExpenses: number;
  oneTimeIncome: number;
  oneTimeExpenses: number;
  safeToSpend: number;
  netCashflow: number;
}

export function calculateCashflow(transactions: Transaction[]): CashflowSummary {
  let totalInflows = 0;
  let totalOutflows = 0;
  let recurringIncome = 0;
  let recurringExpenses = 0;
  let oneTimeIncome = 0;
  let oneTimeExpenses = 0;

  for (const tx of transactions) {
    const amount = Math.abs(parseFloat(tx.amount));

    if (tx.transactionClass === "transfer" || tx.transactionClass === "refund") {
      continue;
    }

    if (tx.flowType === "inflow") {
      totalInflows += amount;
      if (tx.recurrenceType === "recurring") {
        recurringIncome += amount;
      } else {
        oneTimeIncome += amount;
      }
    } else {
      totalOutflows += amount;
      if (tx.recurrenceType === "recurring") {
        recurringExpenses += amount;
      } else {
        oneTimeExpenses += amount;
      }
    }
  }

  const safeToSpend = recurringIncome - recurringExpenses;
  const netCashflow = totalInflows - totalOutflows;

  return {
    totalInflows: Math.round(totalInflows * 100) / 100,
    totalOutflows: Math.round(totalOutflows * 100) / 100,
    recurringIncome: Math.round(recurringIncome * 100) / 100,
    recurringExpenses: Math.round(recurringExpenses * 100) / 100,
    oneTimeIncome: Math.round(oneTimeIncome * 100) / 100,
    oneTimeExpenses: Math.round(oneTimeExpenses * 100) / 100,
    safeToSpend: Math.round(safeToSpend * 100) / 100,
    netCashflow: Math.round(netCashflow * 100) / 100,
  };
}

export interface LeakItem {
  merchant: string;
  monthlyAmount: number;
  annualAmount: number;
  occurrences: number;
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
}

export function detectLeaks(transactions: Transaction[]): LeakItem[] {
  const recurringExpenses = transactions.filter(
    tx => tx.transactionClass === "expense" && tx.recurrenceType === "recurring"
  );

  const merchantGroups: Record<string, { amounts: number[]; dates: string[] }> = {};
  for (const tx of recurringExpenses) {
    const key = tx.merchant.toLowerCase();
    if (!merchantGroups[key]) merchantGroups[key] = { amounts: [], dates: [] };
    merchantGroups[key].amounts.push(Math.abs(parseFloat(tx.amount)));
    merchantGroups[key].dates.push(tx.date);
  }

  const leaks: LeakItem[] = [];
  for (const [, group] of Object.entries(merchantGroups)) {
    if (group.amounts.length < 1) continue;
    
    const avgAmount = group.amounts.reduce((a, b) => a + b, 0) / group.amounts.length;
    const sortedDates = group.dates.sort().reverse();
    const merchant = recurringExpenses.find(
      tx => tx.merchant.toLowerCase() === Object.keys(merchantGroups).find(k => merchantGroups[k] === group)
    )?.merchant || "Unknown";

    const amountVariance = group.amounts.length > 1
      ? Math.max(...group.amounts) - Math.min(...group.amounts)
      : 0;

    let confidence: "High" | "Medium" | "Low" = "Medium";
    if (group.amounts.length >= 3 && amountVariance < avgAmount * 0.1) {
      confidence = "High";
    } else if (group.amounts.length === 1) {
      confidence = "Low";
    }

    leaks.push({
      merchant,
      monthlyAmount: Math.round(avgAmount * 100) / 100,
      annualAmount: Math.round(avgAmount * 12 * 100) / 100,
      occurrences: group.amounts.length,
      lastDate: sortedDates[0],
      confidence,
    });
  }

  return leaks.sort((a, b) => b.annualAmount - a.annualAmount);
}
