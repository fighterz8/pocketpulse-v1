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

  // Strip UTF-8 BOM (\uFEFF) if present. Some bank export tools (including
  // Bank of America) prepend a BOM that makes the first header cell read as
  // "\uFEFFDate" instead of "Date", breaking column detection.
  const raw = buffer.toString("utf-8").trimStart().replace(/^\uFEFF/, "").trim();

  // ── Content normalisation ──────────────────────────────────────────────────
  // csv-parse throws "Invalid Closing Quote: found non trimable byte after
  // quote" when a quoted field is followed by a non-ASCII whitespace character
  // (e.g. U+00A0 non-breaking space) because the library only trims ASCII
  // space and tab. This is commonly produced by BoA's export tool.
  // We also normalise curly/typographic quote marks to straight ASCII quotes
  // so they don't confuse the CSV tokeniser.
  const content = raw
    // Non-breaking and other Unicode whitespace → regular space
    .replace(/[\u00A0\u2009\u200A\u202F\u205F\u3000]/g, " ")
    // Curly/typographic double quotes → straight ASCII "
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    // Curly/typographic single quotes / apostrophes → straight ASCII '
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
  if (!content) {
    return { ok: false, error: `File "${filename}" is empty` };
  }

  // ── Diagnostic logging (remove before public release) ─────────────────────
  // Log a content preview so the server console shows the raw structure of any
  // file that comes through — invaluable for diagnosing bank-specific formats.
  const previewLines = content
    .split(/\r?\n/)
    .slice(0, 8)
    .map((l, i) => `  [${i}] ${l.slice(0, 120)}`);
  console.log(
    `[csvParser] parsing "${filename}" — ` +
    `buffer=${buffer.length}B content=${content.length}ch ` +
    `lineEnding=${content.includes("\r\n") ? "CRLF" : "LF"}\n` +
    previewLines.join("\n"),
  );

  let records: string[][];
  try {
    records = parse(content, {
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (firstErr: unknown) {
    // First pass failed — retry with relax_quotes which tolerates unbalanced
    // or lone quote characters (seen in some BoA/export-tool variants).
    console.warn(
      `[csvParser] strict parse failed for "${filename}", retrying with relax_quotes. ` +
      `Error: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`,
    );
    try {
      records = parse(content, {
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        trim: true,
      });
      console.log(`[csvParser] relax_quotes retry succeeded for "${filename}"`);
    } catch (secondErr: unknown) {
      const msg =
        secondErr instanceof Error ? secondErr.message : String(secondErr);
      console.error(
        `[csvParser] both parse attempts failed for "${filename}": ${msg}\n` +
        `  content preview: ${content.slice(0, 400).replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`,
      );
      return {
        ok: false,
        error:
          `File "${filename}" could not be parsed as CSV — ` +
          `check that it was exported as CSV (not Excel/XLS) and is not corrupted. ` +
          `Detail: ${msg}`,
      };
    }
  }

  if (records.length === 0) {
    return { ok: false, error: `File "${filename}" is empty` };
  }

  const warnings: string[] = [];

  // ── Column detection ────────────────────────────────────────────────────────
  // Strategy (in order):
  //   1. Header-based detection on row 0.
  //   2. Preamble-row scan: if row 0 fails, try rows 1–9 as the header.
  //      BoA's default export includes a 5-row "Account Summary" block before
  //      the real header (fake header + Beginning balance, Total credits, Total
  //      debits, Ending balance rows, then a blank line). After skip_empty_lines
  //      removes the blank, the real header lands at index 5 — so we scan up to
  //      index 9 to handle any bank that prepends up to 9 preamble rows.
  //   3. Positional fallback for headerless formats (e.g. Wells Fargo).
  let mapping: ColumnMapping | null = null;
  let dataRows: string[][];
  let usedPositionalFallback = false;

  const MAX_PREAMBLE_ROWS = 9; // scan up to the 10th row (index 0–9)
  // Track how many columns the header row had — used for overflow detection.
  let headerColCount = 0;

  let headerRowIndex = -1;
  let firstDetectionError = "";

  for (let i = 0; i <= Math.min(MAX_PREAMBLE_ROWS, records.length - 1); i++) {
    const result = detectColumns(records[i]!);
    if (typeof result !== "string") {
      headerRowIndex = i;
      mapping = result;
      headerColCount = records[i]!.length;
      break;
    }
    if (i === 0) firstDetectionError = result; // keep original error for reporting
  }

  if (mapping === null) {
    // Header-based detection failed on all scanned rows — try positional fallback
    const positional = tryPositionalFallback(records[0]!);
    if (!positional) {
      return { ok: false, error: firstDetectionError };
    }
    mapping = positional;
    dataRows = records; // no header row to skip
    usedPositionalFallback = true;
    warnings.push(
      "No column headers detected — using positional column layout (Wells Fargo-style). " +
      "Verify that amounts and descriptions look correct after upload.",
    );
  } else {
    if (headerRowIndex > 0) {
      warnings.push(
        `Skipped ${headerRowIndex} preamble row${headerRowIndex > 1 ? "s" : ""} before the column header. ` +
        "This is normal for some bank exports (e.g. Bank of America).",
      );
    }
    dataRows = records.slice(headerRowIndex + 1);
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

    // ── Column-overflow correction ──────────────────────────────────────────
    // Some banks (e.g. BoA) do not quote description fields that contain
    // commas. When csv-parse splits such rows it produces more cells than the
    // header has columns. We detect this via row.length > headerColCount,
    // reconstruct the full description by joining the extra cells, and shift
    // all post-description column indices rightward to compensate.
    const overflow =
      !usedPositionalFallback && headerColCount > 0
        ? Math.max(0, row.length - headerColCount)
        : 0;

    let description: string;
    let adjAmountIdx  = mapping.amountIdx;
    let adjDebitIdx   = mapping.debitIdx;
    let adjCreditIdx  = mapping.creditIdx;
    let adjTypeIdx    = mapping.typeIdx;

    if (overflow > 0) {
      // Join the base description cell + the extra cells caused by the overflow
      const parts = row.slice(mapping.descriptionIdx, mapping.descriptionIdx + 1 + overflow);
      description = parts.join(", ").trim();
      // Shift every column index that sits after the description column
      const shift = (idx: number | null): number | null =>
        idx !== null && idx > mapping!.descriptionIdx ? idx + overflow : idx;
      adjAmountIdx = shift(mapping.amountIdx);
      adjDebitIdx  = shift(mapping.debitIdx);
      adjCreditIdx = shift(mapping.creditIdx);
      adjTypeIdx   = shift(mapping.typeIdx);
    } else {
      description = row[mapping.descriptionIdx] ?? "";
    }

    let amount: number;
    let ambiguous = false;

    if (mapping.debitIdx !== null || mapping.creditIdx !== null) {
      // Priority 1: Explicit debit/credit columns — direction is unambiguous
      const rawDebit  = adjDebitIdx  !== null ? row[adjDebitIdx]  ?? "" : "";
      const rawCredit = adjCreditIdx !== null ? row[adjCreditIdx] ?? "" : "";
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
      const rawAmount = adjAmountIdx !== null ? row[adjAmountIdx] ?? "" : "";
      const rawType   = adjTypeIdx   !== null ? row[adjTypeIdx]   ?? "" : "";
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
      const rawAmount = adjAmountIdx !== null ? row[adjAmountIdx] ?? "" : "";
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
