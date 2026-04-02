/**
 * Transaction normalization utilities.
 *
 * Handles amount parsing (currency strings, accounting-format negatives),
 * signed-amount derivation from single or split debit/credit columns,
 * flow-type inference, merchant name cleanup, and date normalization.
 */

export function normalizeAmount(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return NaN;

  const isParenNegative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const stripped = trimmed
    .replace(/[()$,]/g, "")
    .trim();

  const value = parseFloat(stripped);
  if (isNaN(value)) return NaN;

  return isParenNegative ? -value : value;
}

export type SignedAmountInput = {
  amount?: number;
  debit?: number;
  credit?: number;
};

/**
 * Resolve a single signed amount from either a combined amount column
 * or split debit/credit columns. Debit is treated as outflow (negative),
 * credit as inflow (positive).
 */
export function deriveSignedAmount(input: SignedAmountInput): number {
  if (input.amount !== undefined && input.amount !== 0) {
    return input.amount;
  }

  const debit = input.debit ?? 0;
  const credit = input.credit ?? 0;

  if (debit !== 0) return -Math.abs(debit);
  if (credit !== 0) return Math.abs(credit);

  if (input.amount !== undefined) return input.amount;

  return 0;
}

export function inferFlowType(signedAmount: number): "inflow" | "outflow" {
  return signedAmount < 0 ? "outflow" : "inflow";
}

/**
 * Clean up a raw merchant/description string: trim, collapse whitespace,
 * strip trailing reference numbers (e.g. #12345) and common POS prefixes
 * (e.g. SQ *), then title-case.
 */
export function normalizeMerchant(raw: string): string {
  if (!raw.trim()) return "";

  let cleaned = raw.trim();

  // Strip common POS prefixes
  cleaned = cleaned.replace(/^(SQ\s*\*|TST\s*\*|SP\s*\*)\s*/i, "");

  // Strip trailing reference numbers (#xxx, *xxx, or trailing digits after space)
  cleaned = cleaned.replace(/\s*[#*]\s*\d+\s*$/, "");

  // Collapse internal whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Title case
  cleaned = cleaned
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());

  return cleaned;
}

/**
 * Parse a date string from common CSV formats into ISO YYYY-MM-DD.
 * Supports: MM/DD/YYYY, M/D/YYYY, MM-DD-YYYY, YYYY-MM-DD.
 * Returns null if the date cannot be parsed.
 */
export function parseDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already ISO: YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    if (isValidDate(+y!, +m!, +d!)) return trimmed;
    return null;
  }

  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    const month = +m!;
    const day = +d!;
    const year = +y!;
    if (isValidDate(year, month, day)) {
      return `${year}-${pad(month)}-${pad(day)}`;
    }
    return null;
  }

  // MM-DD-YYYY
  const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const [, m, d, y] = dashMatch;
    const month = +m!;
    const day = +d!;
    const year = +y!;
    if (isValidDate(year, month, day)) {
      return `${year}-${pad(month)}-${pad(day)}`;
    }
    return null;
  }

  return null;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}
