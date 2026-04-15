/**
 * Cashflow analysis helpers — pure functions, no DB access.
 *
 * `detectLeaks()` scans expense transactions for high-frequency, micro-spend,
 * and repeat discretionary patterns and returns a ranked list of LeakItems.
 * It never imports from recurrenceDetector.ts or the DB layer.
 */

import { AUTO_ESSENTIAL_CATEGORIES } from "../shared/schema.js";
import type { V1Category } from "../shared/schema.js";

// ─── Category sets ────────────────────────────────────────────────────────────

/**
 * Discretionary categories eligible for leak detection.
 * Notably includes coffee and delivery (not just dining) per V1 spec.
 */
const DISCRETIONARY_CATEGORIES = new Set<string>([
  "dining",
  "coffee",
  "delivery",
  "convenience",
  "shopping",
  "entertainment",
  "other",
]);

/**
 * Categories that are NEVER flagged as leaks.
 * Combines AUTO_ESSENTIAL_CATEGORIES (housing, utilities, insurance, medical, debt)
 * with other obligatory / non-discretionary spend.
 */
const ESSENTIAL_LEAK_EXCLUSIONS = new Set<string>([
  ...AUTO_ESSENTIAL_CATEGORIES,
  "income",
  "groceries",
  "gas",
  "auto",
  "parking",
  "travel",
  "software",
  "fees",
]);

// ─── isSubscriptionLike helpers ───────────────────────────────────────────────

const SUBSCRIPTION_LIKE_CATEGORIES = new Set<string>([
  "software",
  "entertainment",
  "fitness",
]);

const SUBSCRIPTION_MERCHANT_PATTERNS: RegExp[] = [
  /netflix/i, /spotify/i, /hulu/i, /disney/i, /\bhbo\b/i,
  /apple\s*(tv|music|one|arcade)/i, /youtube\s*premium/i,
  /amazon\s*prime/i, /amazon\s*music/i, /audible/i,
  /siriusxm/i, /pandora/i, /tidal/i, /\badobe\b/i,
  /microsoft\s*365/i, /office\s*365/i, /dropbox/i,
  /icloud/i, /google\s*(one|storage)/i,
  /\bslack\b/i, /\bzoom\b/i, /\bnotion\b/i, /\bfigma\b/i,
  /quickbooks/i, /freshbooks/i, /\bshopify\b/i,
  /\bpatreon\b/i, /substack/i,
  /gym\b/i, /planet fitness/i, /anytime fitness/i, /\bcrossfit\b/i,
  /\bpeloton\b/i,
];

function detectSubscriptionLike(
  merchant: string,
  category: string,
  isRecurring: boolean,
  amountVariance: number,
  avgAmount: number,
): boolean {
  if (SUBSCRIPTION_LIKE_CATEGORIES.has(category)) return true;
  if (isRecurring && avgAmount > 0 && amountVariance < avgAmount * 0.2) return true;
  return SUBSCRIPTION_MERCHANT_PATTERNS.some((p) => p.test(merchant));
}

// ─── LeakItem interface ───────────────────────────────────────────────────────

export interface LeakItem {
  merchant: string;
  /** Same as merchant — passed as the ?merchant= query param in Ledger drilldowns. */
  merchantFilter: string;
  category: V1Category;
  bucket: "repeat_discretionary" | "micro_spend" | "high_frequency_convenience";
  /** Human-readable bucket label shown under the merchant name. */
  label: string;
  /**
   * totalSpend / monthFactor — normalized per-month cost.
   * monthFactor = max(1, rangeDays / 30)
   */
  monthlyAmount: number;
  occurrences: number;
  /** ISO date of most recent transaction in the group. */
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
  averageAmount: number;
  /** Raw total spend in the selected window (not normalized). */
  recentSpend: number;
  transactionClass: "expense";
  recurrenceType?: "recurring" | "one-time";
  /** True for fixed/predictable charges (subscriptions, memberships). */
  isSubscriptionLike: boolean;
}

// ─── Input row type ────────────────────────────────────────────────────────────

type TxRow = {
  transactionClass: string;
  category: string;
  merchant: string;
  amount: string | number;
  date: string;
  recurrenceType?: string | null;
  excludedFromAnalysis?: boolean | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function getMonthFactor(rangeDays: number): number {
  return Math.max(1, rangeDays / 30);
}

function getRangeDaysFromTransactions(txns: TxRow[]): number {
  const dates = txns.map((t) => t.date).filter(Boolean).sort();
  if (dates.length < 2) return 30;
  const minDate = new Date(`${dates[0]}T00:00:00Z`);
  const maxDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  return Math.max(
    1,
    Math.floor((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)) + 1,
  );
}

// ─── Core algorithm ───────────────────────────────────────────────────────────

/**
 * Detect expense spending patterns that are likely avoidable.
 *
 * Pure function — takes a transaction array, returns a ranked LeakItem list.
 * Does NOT touch the database or import from recurrenceDetector.
 *
 * @param txns   Flat transaction rows (all classes/flow-types are accepted — the
 *               function itself filters to `transactionClass === "expense"` and
 *               excludes the essential category set).
 * @param options.rangeDays  Explicit date-window length in days. When omitted the
 *                           function calculates it from the earliest → latest date
 *                           found in the provided transactions.
 */
export function detectLeaks(
  txns: TxRow[],
  options: { rangeDays?: number } = {},
): LeakItem[] {
  const rangeDays = options.rangeDays ?? getRangeDaysFromTransactions(txns);
  const monthFactor = getMonthFactor(rangeDays);

  // Filter to leak candidates: expense class, non-essential category, not excluded
  const candidates = txns.filter(
    (tx) =>
      tx.transactionClass === "expense" &&
      !ESSENTIAL_LEAK_EXCLUSIONS.has(tx.category) &&
      !tx.excludedFromAnalysis,
  );

  // Group by (merchant.lowercase :: category) composite key
  type Group = {
    merchant: string;
    category: string;
    amounts: number[];
    dates: string[];
    recurrenceTypes: string[];
  };

  const merchantGroups: Record<string, Group> = {};

  for (const tx of candidates) {
    const key = `${tx.merchant.toLowerCase()}::${tx.category}`;
    if (!merchantGroups[key]) {
      merchantGroups[key] = {
        merchant: tx.merchant,
        category: tx.category,
        amounts: [],
        dates: [],
        recurrenceTypes: [],
      };
    }
    merchantGroups[key].amounts.push(Math.abs(parseFloat(String(tx.amount))));
    merchantGroups[key].dates.push(tx.date);
    merchantGroups[key].recurrenceTypes.push(tx.recurrenceType ?? "one-time");
  }

  const leaks: LeakItem[] = [];

  for (const group of Object.values(merchantGroups)) {
    if (group.amounts.length < 2) continue;

    const totalSpend = group.amounts.reduce((a, b) => a + b, 0);
    const avgAmount = totalSpend / group.amounts.length;
    const sortedDates = [...group.dates].sort().reverse();
    const amountVariance =
      group.amounts.length > 1
        ? Math.max(...group.amounts) - Math.min(...group.amounts)
        : 0;

    const isRecurring = group.recurrenceTypes.includes("recurring");

    // ── Bucket threshold checks ──────────────────────────────────────────────
    const isMicroSpend = avgAmount <= 20 && group.amounts.length >= 4;

    // Convenience: dining, coffee, OR delivery — any of these convenience categories
    const isConvenience =
      (group.category === "dining" ||
        group.category === "coffee" ||
        group.category === "delivery") &&
      group.amounts.length >= 4;

    const isRepeatDiscretionary =
      DISCRETIONARY_CATEGORIES.has(group.category) &&
      group.amounts.length >= 3 &&
      totalSpend >= 60;

    // isRecurring boosts confidence and adjusts bucket metadata, but does NOT
    // independently qualify a group as a leak — one of the three behavioral
    // thresholds (micro, convenience, or repeat discretionary) must still be met.
    if (!isMicroSpend && !isConvenience && !isRepeatDiscretionary) {
      continue;
    }

    // ── Bucket label (priority: micro_spend > convenience > repeat_discretionary) ──
    let bucket: LeakItem["bucket"] = "repeat_discretionary";
    let label = "Repeat discretionary spend";
    if (isMicroSpend) {
      bucket = "micro_spend";
      label = "Frequent micro-purchases";
    } else if (isConvenience) {
      bucket = "high_frequency_convenience";
      label = "High-frequency convenience spend";
    }

    // ── Confidence ────────────────────────────────────────────────────────────
    // isRecurring contributes here — stable recurring amounts raise confidence.
    let confidence: "High" | "Medium" | "Low" = "Medium";
    if (
      group.amounts.length >= 6 ||
      (isRecurring && amountVariance < avgAmount * 0.15)
    ) {
      confidence = "High";
    } else if (group.amounts.length <= 2) {
      confidence = "Low";
    }

    leaks.push({
      merchant: group.merchant,
      merchantFilter: group.merchant,
      category: group.category as V1Category,
      bucket,
      label,
      monthlyAmount: roundCurrency(totalSpend / monthFactor),
      occurrences: group.amounts.length,
      lastDate: sortedDates[0]!,
      confidence,
      averageAmount: roundCurrency(avgAmount),
      recentSpend: roundCurrency(totalSpend),
      transactionClass: "expense",
      recurrenceType: isRecurring ? "recurring" : undefined,
      isSubscriptionLike: detectSubscriptionLike(
        group.merchant,
        group.category,
        isRecurring,
        amountVariance,
        avgAmount,
      ),
    });
  }

  // Sort descending by raw window spend (highest dollar leak first)
  return leaks.sort((a, b) => b.recentSpend - a.recentSpend);
}
