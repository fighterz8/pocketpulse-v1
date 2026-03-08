import { parse } from "csv-parse/sync";
import { classifyTransaction } from "./classifier";
import type { InsertTransaction } from "@shared/schema";
import { deriveSignedAmount, flowTypeFromAmount, normalizeAmountForClass } from "./transactionUtils";
import { detectMonthlyRecurringPatterns } from "./recurrenceDetector";

interface ParsedRow {
  date: string;
  amount: number;
  description: string;
}

function detectColumns(headers: string[]): {
  dateCol: number;
  amountCol: number;
  descCol: number;
  creditCol?: number;
  debitCol?: number;
  indicatorCol?: number;
  typeCol?: number;
} {
  const lower = headers.map(h => h.toLowerCase().trim());
  
  let dateCol = lower.findIndex(h => ["date", "transaction date", "posting date", "trans date", "posted date"].includes(h));
  if (dateCol === -1) dateCol = lower.findIndex(h => h.includes("date"));
  
  let amountCol = lower.findIndex(h => ["amount", "transaction amount", "trans amount"].includes(h));
  
  let creditCol: number | undefined;
  let debitCol: number | undefined;
  let indicatorCol: number | undefined;
  let typeCol: number | undefined;
  
  if (amountCol === -1) {
    creditCol = lower.findIndex(h => h.includes("credit") || h.includes("deposit"));
    debitCol = lower.findIndex(h => h.includes("debit") || h.includes("withdrawal") || h.includes("charge"));
    if (creditCol === -1 && debitCol === -1) {
      amountCol = lower.findIndex(h => /^\$?[\d,]+\.?\d*$/.test(h) === false && !["date", "description", "memo", "category"].some(k => h.includes(k)));
    }
  }

  indicatorCol = lower.findIndex(h =>
    h.includes("credit debit indicator") ||
    h.includes("debit credit indicator") ||
    h === "credit/debit" ||
    h === "debit/credit" ||
    h.includes("direction") ||
    h === "dr/cr"
  );
  if (indicatorCol === -1) indicatorCol = undefined;

  typeCol = lower.findIndex(h => h === "type" || h === "transaction type");
  if (typeCol === -1) typeCol = undefined;
  
  let descCol = lower.findIndex(h => ["description", "memo", "payee", "name", "transaction description", "trans description", "merchant"].includes(h));
  if (descCol === -1) descCol = lower.findIndex(h => h.includes("description") || h.includes("memo") || h.includes("payee"));
  
  if (dateCol === -1) dateCol = 0;
  if (amountCol === -1 && creditCol === undefined) amountCol = headers.length > 2 ? 1 : headers.length - 1;
  if (descCol === -1) descCol = Math.max(0, headers.length - 1);

  return { dateCol, amountCol, descCol, creditCol, debitCol, indicatorCol, typeCol };
}

function parseAmount(val: string): number {
  if (!val || val.trim() === "") return 0;
  const cleaned = val.replace(/[$,\s"]/g, "").replace(/\((.+)\)/, "-$1");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function normalizeDate(dateStr: string): string {
  const trimmed = dateStr.trim();
  
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  
  const usMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (usMatch) {
    const year = usMatch[3].length === 2 ? `20${usMatch[3]}` : usMatch[3];
    return `${year}-${usMatch[1].padStart(2, '0')}-${usMatch[2].padStart(2, '0')}`;
  }
  
  return trimmed;
}

export function parseCSV(csvContent: string, userId: number, accountId: number, uploadId: number): InsertTransaction[] {
  let records: string[][];
  try {
    records = parse(csvContent, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch {
    throw new Error("Failed to parse CSV file. Please check the format.");
  }

  if (records.length < 2) {
    throw new Error("CSV file must have a header row and at least one data row.");
  }

  const headers = records[0];
  const { dateCol, amountCol, descCol, creditCol, debitCol, indicatorCol, typeCol } = detectColumns(headers);
  const dataRows = records.slice(1);

  const txns: InsertTransaction[] = [];

  for (const row of dataRows) {
    if (!row[dateCol] || row[dateCol].trim() === "") continue;

    const rawDesc = (row[descCol] || "Unknown").trim();
    
    const rawAmount = parseAmount(row[amountCol] || "0");
    const credit = creditCol !== undefined ? parseAmount(row[creditCol] || "") : undefined;
    const debit = debitCol !== undefined ? parseAmount(row[debitCol] || "") : undefined;
    const amountResult = deriveSignedAmount({
      rawAmount,
      creditAmount: credit,
      debitAmount: debit,
      indicator: indicatorCol !== undefined ? row[indicatorCol] : undefined,
      typeHint: typeCol !== undefined ? row[typeCol] : undefined,
      rawDescription: rawDesc,
    });
    const amount = amountResult.amount;

    if (amount === 0 && rawDesc === "Unknown") continue;

    const date = normalizeDate(row[dateCol]);
    const classification = classifyTransaction(rawDesc, amount);
    const normalizedAmount = normalizeAmountForClass(amount, classification.transactionClass);

    txns.push({
      userId,
      uploadId,
      accountId,
      date,
      amount: normalizedAmount.toFixed(2),
      merchant: classification.merchant,
      rawDescription: rawDesc,
      flowType: flowTypeFromAmount(normalizedAmount),
      transactionClass: classification.transactionClass,
      recurrenceType: classification.recurrenceType,
      category: classification.category,
      labelSource: classification.labelSource,
      labelConfidence: classification.labelConfidence,
      labelReason: classification.labelReason,
      aiAssisted: classification.aiAssisted || amountResult.ambiguous,
      userCorrected: false,
    });
  }

  const recurrenceMatches = detectMonthlyRecurringPatterns(txns.map((transaction) => ({
    merchant: transaction.merchant,
    date: transaction.date,
    amount: transaction.amount,
    flowType: transaction.flowType as "inflow" | "outflow",
    recurrenceType: transaction.recurrenceType as "recurring" | "one-time",
    labelReason: transaction.labelReason,
  })));

  return txns.map((transaction, index) => {
    if (!recurrenceMatches.matchedIndexes.has(index) || transaction.recurrenceType === "recurring") {
      return transaction;
    }

    return {
      ...transaction,
      recurrenceType: "recurring",
      labelReason: recurrenceMatches.reasonByIndex.get(index) ?? transaction.labelReason,
    };
  });
}
