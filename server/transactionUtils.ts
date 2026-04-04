/**
 * Transaction normalization utilities.
 *
 * Handles amount parsing (currency strings, accounting-format negatives),
 * signed-amount derivation from single or split debit/credit columns,
 * flow-type inference, direction hinting, merchant name cleanup, and date normalization.
 */

/**
 * Tier 1: Strong outflow signals. Checked first because misidentifying an
 * outflow as income is worse than the reverse. These are unambiguous
 * operational bank terms ("POS", "ACH DEBIT", "withdrawal") that only
 * appear in outflow contexts.
 */
const STRONG_OUTFLOW_HINT_PATTERNS: RegExp[] = [
  /\btransfer to\b/i,
  /\bpayment to\b/i,
  /\bach debit\b/i,
  /\bpos\b/i,
  /\bpurchase\b/i,
  /\bwithdrawal\b/i,
  /\bwithdraw\b/i,
  /\batm fee\b/i,
  /\batm\b/i,
  /\bbill pay\b/i,
  /\bautopay\b/i,
  /\bdebit\b/i,
];

/**
 * Tier 2: Inflow signals. Checked second. "Transfer FROM" vs "Transfer TO"
 * is critical — checking outflow first ensures "transfer to" is caught before
 * a bare "transfer" fragment in "transfer from" creates confusion.
 */
const INFLOW_HINT_PATTERNS: RegExp[] = [
  /\btransfer from\b/i,
  /\bach credit\b/i,
  /\bdirect deposit\b/i,
  /\bdeposit\b/i,
  /\bsalary\b/i,
  /\bpayroll\b/i,
  /\bpayment received\b/i,
  /\bwire from\b/i,
  /\bincoming\b/i,
  /\brefund\b/i,
  /\breversal\b/i,
  /\breturn\b/i,
  /\badjustment.?credit\b/i,
];

/**
 * Inspects the raw transaction description for directional language.
 * Returns "inflow" or "outflow" when a strong hint is found, null otherwise.
 *
 * A null return means we genuinely cannot determine direction from the text —
 * the caller should rely on the amount sign and may flag the row as ambiguous.
 */
export function getDirectionHint(
  description: string,
): "inflow" | "outflow" | null {
  for (const pattern of STRONG_OUTFLOW_HINT_PATTERNS) {
    if (pattern.test(description)) return "outflow";
  }
  for (const pattern of INFLOW_HINT_PATTERNS) {
    if (pattern.test(description)) return "inflow";
  }
  return null;
}

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
 * Common bank/POS prefixes that appear before the real merchant name.
 * Ordered from most specific to most general to avoid partial stripping.
 * Each entry is a regex source string; they are joined into one pattern.
 */
const POS_PREFIX_PATTERNS: string[] = [
  // Square POS variants
  "SQ\\s*\\*[\\s*]*",
  // Toast POS
  "TST\\s*\\*[\\s*]*",
  // Stripe / Shopify / various
  "SP\\s*\\*[\\s*]*",
  // Stripe
  "STR\\s*\\*[\\s*]*",
  // PayPal
  "PAYPAL\\s*\\*[\\s*]*",
  "PP\\.[\\s*]*",
  // Amazon
  "AMZN MKTPLACE\\s*",
  "AMZN\\s*\\*[\\s*]*",
  "AMAZON\\.COM\\*[\\s*]*",
  // Apple iTunes/App Store coded entries
  "APPLE\\.COM/BILL\\s*",
  // Recurring ACH descriptors
  "DES:\\s*",
  "ACH\\s+(?:DEBIT|CREDIT|PMT|PYMT)\\s+",
  // Bank-specific debit card formats (e.g. "DEBIT-DC 6851 " or "POS DEBIT-DC 4305 ")
  "DEBIT-DC\\s+\\d+\\s+",
  "DEBIT-\\s*XX\\s+\\d+\\s+",
  "POS\\s+DEBIT-DC\\s+\\d+\\s+",
  // "- VISA CHECK CARD XX51 - " prefix format (Bank of America style)
  "-\\s*VISA\\s+CHECK\\s+CARD\\s+\\w+\\s+-\\s+",
  // Point-of-sale terminals
  "POS\\s+(?:PURCHASE|DEBIT|CREDIT|PMT)?\\s*",
  "PUR\\s+",
  // Check card / debit card qualifiers
  "CHK\\s+CARD\\s+\\d+\\s+",
  "CHECK\\s+CARD\\s+\\d+\\s+",
  "DEBIT\\s+CARD\\s+\\d+\\s+",
  "CHECKCARD\\s+\\d+\\s+",
  // Misc
  "ORIG\\s+CO\\s+NAME:\\s*",
  "ORIG\\s*:\\s*",
  "PMT\\s*:\\s*",
  "ONLINE\\s+PAYMENT\\s*[-–]?\\s*",
  "ONLINE\\s+BANKING\\s+PAYMENT\\s*[-–]?\\s*",
  "RECURRING\\s+",
  "AUTOPAY\\s*[-–]?\\s*",
];

const POS_PREFIX_REGEX = new RegExp(
  `^(?:${POS_PREFIX_PATTERNS.join("|")})`,
  "i",
);

/** Trailing noise: card last-four, reference/auth codes, date stamps, cardholder names. */
const TRAILING_NOISE_REGEX =
  /\s*(?:[#*]\s*\d+|\bREF\b\s*#?\s*\w+|\bAUTH\b\s*#?\s*\w+|\b\d{4,}\b|\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:Pos\s+)?Transaction)\s*$/i;

/** State/location suffix like " CA", " TX 12345" appended by some banks. */
const LOCATION_SUFFIX_REGEX = /\s+[A-Z]{2}(?:\s+\d{5})?\s*$/;

/**
 * Clean up a raw merchant/description string: trim, strip bank-specific POS
 * prefixes, location suffixes, reference codes, then title-case.
 *
 * Multiple passes are applied until no further change occurs so that stacked
 * prefixes (e.g. "POS PURCHASE SQ * Coffee Shop") are fully stripped.
 */
export function normalizeMerchant(raw: string): string {
  if (!raw.trim()) return "";

  let cleaned = raw.trim();

  // Iteratively strip leading POS prefixes (handles stacked prefixes)
  let prev = "";
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned.replace(POS_PREFIX_REGEX, "").trim();
  }

  // Strip trailing location suffix (e.g. " CA", " TX 77001")
  cleaned = cleaned.replace(LOCATION_SUFFIX_REGEX, "").trim();

  // Strip trailing reference/auth codes
  cleaned = cleaned.replace(TRAILING_NOISE_REGEX, "").trim();

  // Collapse internal whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (!cleaned) return raw.trim();

  // Title case
  cleaned = cleaned
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());

  return cleaned;
}

/**
 * Parse a date string from common CSV formats into ISO YYYY-MM-DD.
 * Supports: MM/DD/YYYY, M/D/YYYY, MM-DD-YYYY, YYYY-MM-DD, MM/DD/YY.
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

  // MM/DD/YY (2-digit year)
  const shortYearMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (shortYearMatch) {
    const [, m, d, y] = shortYearMatch;
    const month = +m!;
    const day = +d!;
    const year = +y! + (+y! >= 50 ? 1900 : 2000);
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
