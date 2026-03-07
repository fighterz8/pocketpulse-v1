import { parse } from "csv-parse/sync";
import { classifyTransaction } from "./classifier";
import type { InsertTransaction } from "@shared/schema";

interface ParsedRow {
  date: string;
  amount: number;
  description: string;
}

function detectColumns(headers: string[]): { dateCol: number; amountCol: number; descCol: number; creditCol?: number; debitCol?: number } {
  const lower = headers.map(h => h.toLowerCase().trim());
  
  let dateCol = lower.findIndex(h => ["date", "transaction date", "posting date", "trans date", "posted date"].includes(h));
  if (dateCol === -1) dateCol = lower.findIndex(h => h.includes("date"));
  
  let amountCol = lower.findIndex(h => ["amount", "transaction amount", "trans amount"].includes(h));
  
  let creditCol: number | undefined;
  let debitCol: number | undefined;
  
  if (amountCol === -1) {
    creditCol = lower.findIndex(h => h.includes("credit") || h.includes("deposit"));
    debitCol = lower.findIndex(h => h.includes("debit") || h.includes("withdrawal") || h.includes("charge"));
    if (creditCol === -1 && debitCol === -1) {
      amountCol = lower.findIndex(h => /^\$?[\d,]+\.?\d*$/.test(h) === false && !["date", "description", "memo", "category"].some(k => h.includes(k)));
    }
  }
  
  let descCol = lower.findIndex(h => ["description", "memo", "payee", "name", "transaction description", "trans description", "merchant"].includes(h));
  if (descCol === -1) descCol = lower.findIndex(h => h.includes("description") || h.includes("memo") || h.includes("payee"));
  
  if (dateCol === -1) dateCol = 0;
  if (amountCol === -1 && creditCol === undefined) amountCol = headers.length > 2 ? 1 : headers.length - 1;
  if (descCol === -1) descCol = Math.max(0, headers.length - 1);

  return { dateCol, amountCol, descCol, creditCol, debitCol };
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
  const { dateCol, amountCol, descCol, creditCol, debitCol } = detectColumns(headers);
  const dataRows = records.slice(1);

  const txns: InsertTransaction[] = [];

  for (const row of dataRows) {
    if (!row[dateCol] || row[dateCol].trim() === "") continue;

    const rawDesc = (row[descCol] || "Unknown").trim();
    
    let amount: number;
    if (creditCol !== undefined && debitCol !== undefined) {
      const credit = parseAmount(row[creditCol] || "");
      const debit = parseAmount(row[debitCol] || "");
      amount = credit > 0 ? credit : -Math.abs(debit);
    } else {
      amount = parseAmount(row[amountCol] || "0");
    }

    if (amount === 0 && rawDesc === "Unknown") continue;

    const date = normalizeDate(row[dateCol]);
    const classification = classifyTransaction(rawDesc, amount);

    txns.push({
      userId,
      uploadId,
      accountId,
      date,
      amount: amount.toFixed(2),
      merchant: classification.merchant,
      rawDescription: rawDesc,
      flowType: classification.flowType,
      transactionClass: classification.transactionClass,
      recurrenceType: classification.recurrenceType,
      aiAssisted: classification.aiAssisted,
      userCorrected: false,
    });
  }

  return txns;
}
