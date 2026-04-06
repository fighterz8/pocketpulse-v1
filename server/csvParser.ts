/**
 * CSV parser for PocketPulse upload workflow.
 *
 * Auto-detects date, description, and amount (or debit/credit) columns
 * from the header row using case-insensitive keyword matching. Normalizes
 * each row into { date, description, amount } using transactionUtils.
 *
 * Headerless format fallback: When no recognizable column headers are found
 * but the first row's first cell looks like a date and the second cell is a
 * number, the parser assumes a Wells Fargo-style positional layout:
 *   col 0 = date, col 1 = amount (signed), last text col = description.
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
  /**
   * True when the direction of this row was determined by heuristic rather
   * than an explicit debit/credit column or type indicator. A positive-signed
   * amount from a single "Amount" column falls into this bucket — the bank
   * may display all amounts as positive and rely on descriptions for direction.
   * Rows where ambiguous=true get flagged for extra AI review.
   */
  ambiguous: boolean;
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
  "posted date",
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
// Include plural forms for banks like PNC (Withdrawals/Deposits)
const DEBIT_PATTERNS  = ["debit", "debit amount", "withdrawal", "withdrawals"];
const CREDIT_PATTERNS = ["credit", "credit amount", "deposit", "deposits"];
const TYPE_PATTERNS   = ["type", "transaction type", "trans type", "dr/cr"];

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
  const debitIdx  = findColumnIndex(headers, DEBIT_PATTERNS);
  const creditIdx = findColumnIndex(headers, CREDIT_PATTERNS);
  const typeIdx   = findColumnIndex(headers, TYPE_PATTERNS);

  if (amountIdx === -1 && debitIdx === -1 && creditIdx === -1) {
    return "Could not detect an amount column. Expected headers like: Amount, Debit/Credit, or Withdrawal/Deposit";
  }

  return {
    dateIdx,
    descriptionIdx,
    amountIdx:  amountIdx  !== -1 ? amountIdx  : null,
    debitIdx:   debitIdx   !== -1 ? debitIdx   : null,
    creditIdx:  creditIdx  !== -1 ? creditIdx  : null,
    typeIdx:    typeIdx    !== -1 ? typeIdx    : null,
  };
}

/**
 * Attempt positional (headerless) column detection for banks like Wells Fargo
 * that export CSVs without a header row.
 *
 * Heuristic: if the first cell of the first row parses as a date and the
 * second cell parses as a number, treat it as:
 *   col 0 = date, col 1 = amount (signed), last descriptive col = description.
 *
 * The "last descriptive column" is the last non-empty cell that is neither a
 * date nor a pure number and is not a single punctuation/wildcard character.
 */
function tryPositionalFallback(firstRow: string[]): ColumnMapping | null {
  if (firstRow.length < 2) return null;

  if (!parseDate(firstRow[0] ?? "")) return null;

  const amtCandidate = normalizeAmount(firstRow[1] ?? "");
  if (isNaN(amtCandidate)) return null;

  // Find the last column that looks like a description (text, not date, not number, not "*")
  let descIdx = -1;
  for (let i = firstRow.length - 1; i >= 2; i--) {
    const cell = (firstRow[i] ?? "").trim();
    if (!cell || cell === "*") continue;
    if (!isNaN(normalizeAmount(cell))) continue;
    if (parseDate(cell)) continue;
    descIdx = i;
    break;
  }
  if (descIdx === -1) return null;

  return {
    dateIdx: 0,
    descriptionIdx: descIdx,
    amountIdx: 1,
    debitIdx: null,
    creditIdx: null,
    typeIdx: null,
  };
}

/**
 * Classify a raw type-column value to determine transaction direction.
 *
 * Returns:
 *   "debit"  — transaction is definitely an outflow (expense / card charge)
 *   "credit" — transaction is definitely an inflow (income / payment received)
 *   null     — type value is unrecognized; caller should trust the amount sign
 *
 * Handles bank-specific values such as:
 *   Chase:   "ACH_DEBIT" / "ACH_CREDIT" / "Sale" / "Payment"
 *   US Bank: "DEBIT" / "CREDIT"
 *   generic: "DR" / "CR" / "deb" / "cred"
 */
function classifyTypeColumn(rawType: string): "debit" | "credit" | null {
  const t = rawType.toLowerCase().trim();
  if (!t) return null;

  // Explicit debit indicators (purchase / outflow)
  if (
    t === "debit"    || t === "dr"  || t === "deb" ||
    t.includes("debit") ||
    t === "sale"     || t === "purchase"
  ) {
    return "debit";
  }

  // Explicit credit indicators (income / payment received)
  if (
    t === "credit"   || t === "cr"  ||
    t.includes("credit") ||
    t === "payment"
  ) {
    return "credit";
  }

  return null;
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

  const warnings: string[] = [];

  // ── Column detection ────────────────────────────────────────────────────────
  // First try header-based detection. If that fails, attempt positional fallback
  // for headerless formats (e.g. Wells Fargo).
  const firstRow = records[0]!;
  let mapping: ColumnMapping;
  let dataRows: string[][];
  let usedPositionalFallback = false;

  const headerResult = detectColumns(firstRow);
  if (typeof headerResult === "string") {
    // Header-based detection failed — try positional fallback
    const positional = tryPositionalFallback(firstRow);
    if (!positional) {
      return { ok: false, error: headerResult };
    }
    mapping = positional;
    dataRows = records; // no header row to skip
    usedPositionalFallback = true;
    warnings.push(
      "No column headers detected — using positional column layout (Wells Fargo-style). " +
      "Verify that amounts and descriptions look correct after upload.",
    );
  } else {
    mapping = headerResult;
    dataRows = records.slice(1);
  }

  if (dataRows.length === 0) {
    return {
      ok: false,
      error: `File "${filename}" has no data rows after the header`,
    };
  }

  const rows: ParsedRow[] = [];

  const rowOffset = usedPositionalFallback ? 1 : 2; // for row number in warnings

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!;
    const rowNum = i + rowOffset;

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
    let ambiguous = false;

    if (mapping.debitIdx !== null || mapping.creditIdx !== null) {
      // Priority 1: Explicit debit/credit columns — direction is unambiguous
      const rawDebit  = mapping.debitIdx  !== null ? row[mapping.debitIdx]  ?? "" : "";
      const rawCredit = mapping.creditIdx !== null ? row[mapping.creditIdx] ?? "" : "";
      const debitVal  = rawDebit  ? normalizeAmount(rawDebit)  : 0;
      const creditVal = rawCredit ? normalizeAmount(rawCredit) : 0;
      amount = deriveSignedAmount({
        debit:  isNaN(debitVal)  ? 0 : debitVal,
        credit: isNaN(creditVal) ? 0 : creditVal,
      });
    } else if (mapping.amountIdx !== null && mapping.typeIdx !== null) {
      // Priority 2: Amount + Type column — direction from type value when known.
      // Falls back to the amount's own sign for unrecognized type values (e.g.
      // banks that export pre-signed amounts alongside an informational type column).
      const rawAmount = row[mapping.amountIdx] ?? "";
      const rawType   = row[mapping.typeIdx] ?? "";
      const parsed    = normalizeAmount(rawAmount);
      const direction = classifyTypeColumn(rawType);

      if (direction === "debit") {
        amount = -Math.abs(parsed);
      } else if (direction === "credit") {
        amount = Math.abs(parsed);
      } else {
        // Unrecognized type — trust the amount's existing sign
        amount = parsed;
        ambiguous = amount >= 0;
      }
    } else if (mapping.amountIdx !== null) {
      // Priority 3: Amount column only — negative sign is reliable, but a
      // positive value in a single-column format is ambiguous: some banks
      // show all amounts as positive and rely on the description for direction.
      const rawAmount = row[mapping.amountIdx] ?? "";
      amount = normalizeAmount(rawAmount);
      ambiguous = amount >= 0;
    } else {
      amount = NaN;
    }

    if (isNaN(amount)) {
      warnings.push(
        `Row ${rowNum}: skipped — could not parse amount`,
      );
      continue;
    }

    rows.push({ date, description, amount, ambiguous });
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error: `File "${filename}" has no valid data rows after parsing`,
    };
  }

  return { ok: true, rows, warnings };
}
