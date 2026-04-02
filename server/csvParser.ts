/**
 * CSV parser for PocketPulse upload workflow.
 *
 * Auto-detects date, description, and amount (or debit/credit) columns
 * from the header row using case-insensitive keyword matching. Normalizes
 * each row into { date, description, amount } using transactionUtils.
 *
 * Returns a discriminated union: { ok: true, rows, warnings } on success,
 * { ok: false, error } on structural failure (empty file, missing columns).
 * Row-level issues (bad dates, unparseable amounts) produce warnings and
 * skip the row rather than failing the entire file.
 */
import { parse } from "csv-parse/sync";

import {
  deriveSignedAmount,
  normalizeAmount,
  parseDate,
} from "./transactionUtils.js";

export type ParsedRow = {
  date: string;
  description: string;
  amount: number;
};

export type CSVParseResult =
  | { ok: true; rows: ParsedRow[]; warnings: string[] }
  | { ok: false; error: string };

type ColumnMapping = {
  dateIdx: number;
  descriptionIdx: number;
  amountIdx: number | null;
  debitIdx: number | null;
  creditIdx: number | null;
  typeIdx: number | null;
};

const DATE_PATTERNS = [
  "date",
  "transaction date",
  "trans date",
  "posting date",
  "post date",
];
const DESC_PATTERNS = [
  "description",
  "transaction description",
  "memo",
  "payee",
  "merchant",
  "name",
  "details",
];
const AMOUNT_PATTERNS = ["amount", "transaction amount", "total"];
const DEBIT_PATTERNS = ["debit", "debit amount", "withdrawal"];
const CREDIT_PATTERNS = ["credit", "credit amount", "deposit"];
const TYPE_PATTERNS = ["type", "transaction type", "trans type", "dr/cr"];

function findColumnIndex(headers: string[], patterns: string[]): number {
  const normalized = headers.map((h) => h.toLowerCase().trim());
  for (const pattern of patterns) {
    const idx = normalized.indexOf(pattern);
    if (idx !== -1) return idx;
  }
  return -1;
}

function detectColumns(headers: string[]): ColumnMapping | string {
  const dateIdx = findColumnIndex(headers, DATE_PATTERNS);
  if (dateIdx === -1) {
    return "Could not detect a date column. Expected headers like: Date, Transaction Date, Posting Date";
  }

  const descriptionIdx = findColumnIndex(headers, DESC_PATTERNS);
  if (descriptionIdx === -1) {
    return "Could not detect a description column. Expected headers like: Description, Memo, Payee, Merchant";
  }

  const amountIdx = findColumnIndex(headers, AMOUNT_PATTERNS);
  const debitIdx = findColumnIndex(headers, DEBIT_PATTERNS);
  const creditIdx = findColumnIndex(headers, CREDIT_PATTERNS);
  const typeIdx = findColumnIndex(headers, TYPE_PATTERNS);

  if (amountIdx === -1 && debitIdx === -1 && creditIdx === -1) {
    return "Could not detect an amount column. Expected headers like: Amount, Debit/Credit, or Withdrawal/Deposit";
  }

  return {
    dateIdx,
    descriptionIdx,
    amountIdx: amountIdx !== -1 ? amountIdx : null,
    debitIdx: debitIdx !== -1 ? debitIdx : null,
    creditIdx: creditIdx !== -1 ? creditIdx : null,
    typeIdx: typeIdx !== -1 ? typeIdx : null,
  };
}

export async function parseCSV(
  buffer: Buffer,
  filename: string,
): Promise<CSVParseResult> {
  if (buffer.length === 0) {
    return { ok: false, error: `File "${filename}" is empty` };
  }

  const content = buffer.toString("utf-8").trim();
  if (!content) {
    return { ok: false, error: `File "${filename}" is empty` };
  }

  let records: string[][];
  try {
    records = parse(content, {
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch {
    return {
      ok: false,
      error: `File "${filename}" could not be parsed as CSV`,
    };
  }

  if (records.length === 0) {
    return { ok: false, error: `File "${filename}" is empty` };
  }

  const headers = records[0]!;
  const mapping = detectColumns(headers);
  if (typeof mapping === "string") {
    return { ok: false, error: mapping };
  }

  const dataRows = records.slice(1);
  if (dataRows.length === 0) {
    return {
      ok: false,
      error: `File "${filename}" has no data rows after the header`,
    };
  }

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!;
    const rowNum = i + 2; // 1-indexed, header is row 1

    const rawDate = row[mapping.dateIdx] ?? "";
    const date = parseDate(rawDate);
    if (!date) {
      warnings.push(
        `Row ${rowNum}: skipped — could not parse date "${rawDate}"`,
      );
      continue;
    }

    const description = row[mapping.descriptionIdx] ?? "";

    let amount: number;
    if (mapping.debitIdx !== null || mapping.creditIdx !== null) {
      // Priority 1: Explicit debit/credit columns
      const rawDebit = mapping.debitIdx !== null ? row[mapping.debitIdx] ?? "" : "";
      const rawCredit = mapping.creditIdx !== null ? row[mapping.creditIdx] ?? "" : "";
      const debitVal = rawDebit ? normalizeAmount(rawDebit) : 0;
      const creditVal = rawCredit ? normalizeAmount(rawCredit) : 0;
      amount = deriveSignedAmount({
        debit: isNaN(debitVal) ? 0 : debitVal,
        credit: isNaN(creditVal) ? 0 : creditVal,
      });
    } else if (mapping.amountIdx !== null && mapping.typeIdx !== null) {
      // Priority 2: Amount + Type column (Debit/Credit or DR/CR)
      const rawAmount = row[mapping.amountIdx] ?? "";
      const rawType = (row[mapping.typeIdx] ?? "").trim().toLowerCase();
      const parsed = normalizeAmount(rawAmount);
      const isDebit = rawType === "debit" || rawType === "dr" || rawType === "deb";
      amount = isDebit ? -Math.abs(parsed) : Math.abs(parsed);
    } else if (mapping.amountIdx !== null) {
      // Priority 3: Amount column only (sign comes from the value itself)
      const rawAmount = row[mapping.amountIdx] ?? "";
      amount = normalizeAmount(rawAmount);
    } else {
      amount = NaN;
    }

    if (isNaN(amount)) {
      warnings.push(
        `Row ${rowNum}: skipped — could not parse amount`,
      );
      continue;
    }

    rows.push({ date, description, amount });
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error: `File "${filename}" has no valid data rows after parsing`,
    };
  }

  return { ok: true, rows, warnings };
}
