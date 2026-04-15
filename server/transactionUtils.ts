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
 *
 * The checkcard / ach pmt / bill pmt variants below are Navy Federal and
 * similar bank-specific formats that use unsigned amounts. Without these
 * patterns a positive-amount "CHECKCARD 0412 STARBUCKS" would default to
 * income until Pass 6 catches it — adding latency to the correction.
 */
const STRONG_OUTFLOW_HINT_PATTERNS: RegExp[] = [
  /\btransfer to\b/i,
  /\bpayment to\b/i,
  /\bach debit\b/i,
  /\bach pmt\b/i,
  /\bpos\b/i,
  /\bpurchase\b/i,
  /\bwithdrawal\b/i,
  /\bwithdraw\b/i,
  /\batm fee\b/i,
  /\batm\b/i,
  /\bbill pay\b/i,
  /\bbill pmt\b/i,
  /\bautopay\b/i,
  /\bdebit\b/i,
  /\bcheckcard\b/i,
  /\bcheck card\b/i,
  /\brecurring pmt\b/i,
  /\bonline pmt\b/i,
  /\bpoint of sale\b/i,
  // Navy Federal "-dc NNNN" debit card format (e.g. "-dc 4305 Dollartree")
  /-dc\s+\d+/i,
  // Additional patterns for unsigned-amount banks (T3.3 hardening)
  // "Debit Memo" — common core-banking term for an outgoing charge
  /\bdebit memo\b/i,
  // "Sent to" — Zelle / P2P outflow descriptions ("Sent To John Smith")
  /\bsent to\b/i,
  // "Card Charge" — some credit unions output this for POS purchases
  /\bcard charge\b/i,
  // "EFT Debit" / "EFT Payment" — electronic-funds-transfer outflow
  /\beft\s+(?:debit|payment|pmt)\b/i,
  // "Online Transfer Out" / "External Transfer Out" — transfer portals
  /\b(?:online|external|ext)\s+transfer\s+out\b/i,
  // "Preauthorized Debit" / "Pre-authorized Payment" — pre-auth outflows
  /\bpre-?auth(?:orized)?\s+(?:debit|payment|pmt)\b/i,
  // "Memo Debit" — variant of Debit Memo used by some credit unions
  /\bmemo\s+debit\b/i,
  // "Tap to Pay" — contactless POS used by modern banking apps (e.g. Apple Cash, Chase)
  /\btap\s+to\s+pay\b/i,
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
 * Patterns that specifically indicate a debit/credit-card swipe at a POS
 * terminal — as opposed to ACH debits, wires, or other outflow types.
 *
 * Used to distinguish "card payment via CashApp" (expense) from "ACH transfer
 * via CashApp" (genuine transfer) without conflating all outflow signals.
 */
const DEBIT_CARD_PATTERNS: RegExp[] = [
  // Navy Federal "-dc NNNN" debit card format
  /-dc\s+\d+/i,
  // "DEBIT-DC NNNN" and "POS DEBIT-DC NNNN" variants
  /debit-?dc\b/i,
  // "checkcard" / "check card" (common across many credit unions)
  /\bcheckcard\b/i,
  /\bcheck card\b/i,
  // Explicit "debit card" in the description
  /\bdebit card\b/i,
  // Point-of-sale markers (card swipe — NOT present on ACH transactions)
  /\bpos\b/i,
  /\bpurchase\b/i,
  /\bpoint of sale\b/i,
];

/**
 * Returns true when the raw bank description contains a debit/credit-card
 * swipe indicator. This is intentionally narrower than getDirectionHint():
 * "ACH DEBIT CASHAPP" returns false here, while "-dc 4305 CASHAPP" returns true.
 */
export function isDebitCardDescription(description: string): boolean {
  return DEBIT_CARD_PATTERNS.some((p) => p.test(description));
}

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
  // DoorDash payment terminal (e.g. "Dd *doordash Buffa Xx-:")
  "Dd\\s*\\*[\\s*]*",
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
  // Navy Federal "-dc NNNN" debit card format (e.g. "-dc 4305 Dollartree Chula Vista")
  "-\\s*DC\\s+\\d+\\s+",
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

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Parse a date string from common CSV formats into ISO YYYY-MM-DD.
 * Supports: MM/DD/YYYY, M/D/YYYY, MM-DD-YYYY, YYYY-MM-DD, MM/DD/YY,
 *           "Jan 01 2024", "January 1, 2024", "01 Jan 2024", "Jan 1st 2024",
 *           and "YYYY/MM/DD".
 *
 * @param raw  The raw date cell value from the CSV.
 * @param formatHint  Optional format string hint from AI spec (e.g. "MMM D YYYY",
 *                    "D MMM YYYY"). When present, the matching parser is tried first.
 *                    Falls through to all built-in formats on mismatch.
 * Returns null if the date cannot be parsed.
 */
export function parseDate(raw: string, formatHint?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // When the AI spec provides a format hint, try the hint-specific parser first.
  if (formatHint) {
    const hinted = parseDateWithHint(trimmed, formatHint);
    if (hinted) return hinted;
  }

  // Already ISO: YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    if (isValidDate(+y!, +m!, +d!)) return trimmed;
    return null;
  }

  // YYYY/MM/DD
  const isoSlashMatch = trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (isoSlashMatch) {
    const [, y, m, d] = isoSlashMatch;
    if (isValidDate(+y!, +m!, +d!)) return `${y}-${m}-${d}`;
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

  // "Jan 01 2024" / "January 1, 2024" / "Jan 1st 2024" (month-name first)
  const mmmDYYYY = trimmed.match(
    /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i,
  );
  if (mmmDYYYY) {
    const [, mon, d, y] = mmmDYYYY;
    const month = MONTH_NAMES[mon!.toLowerCase()];
    if (month) {
      const day = +d!;
      const year = +y!;
      if (isValidDate(year, month, day)) return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  // "01 Jan 2024" / "1 January 2024" (day first, month name second)
  const dMMMMYYYY = trimmed.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s+(\d{4})$/i,
  );
  if (dMMMMYYYY) {
    const [, d, mon, y] = dMMMMYYYY;
    const month = MONTH_NAMES[mon!.toLowerCase()];
    if (month) {
      const day = +d!;
      const year = +y!;
      if (isValidDate(year, month, day)) return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  // "2024 Jan 01" (year first, then month name)
  const yyyyMMMD = trimmed.match(/^(\d{4})\s+([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (yyyyMMMD) {
    const [, y, mon, d] = yyyyMMMD;
    const month = MONTH_NAMES[mon!.toLowerCase()];
    if (month) {
      const day = +d!;
      const year = +y!;
      if (isValidDate(year, month, day)) return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  return null;
}

/**
 * Try to parse a date using a format hint string returned by the AI spec.
 * Format tokens (case-insensitive):
 *   YYYY / YY — 4 or 2 digit year
 *   MM / M    — numeric month
 *   DD / D    — numeric day
 *   MMM       — abbreviated month name (Jan, Feb …)
 *   MMMM      — full month name
 */
function parseDateWithHint(trimmed: string, fmt: string): string | null {
  // Build a regex from the format token by token, capture groups in order.
  const normalized = fmt.toUpperCase();

  const tokens: Array<{ token: string; pattern: string; type: string }> = [];

  let remaining = normalized;
  while (remaining.length > 0) {
    if (remaining.startsWith("YYYY")) {
      tokens.push({ token: "YYYY", pattern: "(\\d{4})", type: "year4" });
      remaining = remaining.slice(4);
    } else if (remaining.startsWith("YY")) {
      tokens.push({ token: "YY", pattern: "(\\d{2})", type: "year2" });
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("MMMM")) {
      tokens.push({ token: "MMMM", pattern: "([A-Za-z]+)", type: "monthName" });
      remaining = remaining.slice(4);
    } else if (remaining.startsWith("MMM")) {
      tokens.push({ token: "MMM", pattern: "([A-Za-z]+)", type: "monthName" });
      remaining = remaining.slice(3);
    } else if (remaining.startsWith("MM")) {
      tokens.push({ token: "MM", pattern: "(\\d{1,2})", type: "month" });
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("M")) {
      tokens.push({ token: "M", pattern: "(\\d{1,2})", type: "month" });
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("DD")) {
      tokens.push({ token: "DD", pattern: "(\\d{1,2})(?:st|nd|rd|th)?", type: "day" });
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("D")) {
      tokens.push({ token: "D", pattern: "(\\d{1,2})(?:st|nd|rd|th)?", type: "day" });
      remaining = remaining.slice(1);
    } else {
      // Separator character — escape and match literally (or optionally)
      const ch = remaining[0]!;
      tokens.push({ token: ch, pattern: `[${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s,]*`, type: "sep" });
      remaining = remaining.slice(1);
    }
  }

  const regexStr = "^" + tokens.map((t) => t.pattern).join("") + "$";
  let match: RegExpMatchArray | null;
  try {
    match = trimmed.match(new RegExp(regexStr, "i"));
  } catch {
    return null;
  }
  if (!match) return null;

  const capGroups = tokens.filter((t) => t.type !== "sep");
  let year = 0, month = 0, day = 0;

  for (let i = 0; i < capGroups.length; i++) {
    const val = match[i + 1] ?? "";
    const type = capGroups[i]!.type;
    if (type === "year4") year = +val;
    else if (type === "year2") year = +val + (+val >= 50 ? 1900 : 2000);
    else if (type === "month") month = +val;
    else if (type === "monthName") month = MONTH_NAMES[val.toLowerCase()] ?? 0;
    else if (type === "day") day = +val;
  }

  if (!year || !month || !day) return null;
  if (isValidDate(year, month, day)) return `${year}-${pad(month)}-${pad(day)}`;
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
