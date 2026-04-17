/**
 * Cashflow analysis helpers — pure functions, no DB access.
 *
 * `detectLeaks()` scans expense transactions for high-frequency, micro-spend,
 * and repeat discretionary patterns and returns a ranked list of LeakItems.
 * Groups by normalized merchant key so each merchant appears at most once
 * regardless of how many categories its transactions span.
 */

import { AUTO_ESSENTIAL_CATEGORIES } from "../shared/schema.js";
import type { V1Category } from "../shared/schema.js";
import { recurrenceKey } from "./recurrenceDetector.js";

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
 *
 * NOTE: "software" was intentionally removed. Software merchants that ARE
 * recurring (e.g. Netflix, iCloud) are excluded by the recurring mutual-exclusion
 * rule. Software merchants that are NOT recurring (e.g. a one-off tool purchase
 * repeated a few times) correctly appear as leaks.
 */
const ESSENTIAL_LEAK_EXCLUSIONS = new Set<string>([
  ...AUTO_ESSENTIAL_CATEGORIES,
  "income",
  "groceries",
  "gas",
  "auto",
  "parking",
  "travel",
  "fees",
]);

/**
 * Categories that are excluded from the catch-all repeat-purchase rule.
 * These are non-negotiable financial obligations that should never be flagged
 * as "leaks" regardless of frequency or amount.
 */
const CATCH_ALL_HARD_EXCLUSIONS = new Set<string>([
  "housing", "utilities", "insurance", "medical", "debt",
  "income", "groceries", "gas", "auto", "parking", "travel",
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
  /** Display name — the raw merchant string from the most recent transaction. */
  merchant: string;
  /** Normalized merchant key used for deduplication. */
  merchantKey: string;
  /**
   * Display merchant name passed as ?search= in Ledger drilldowns so the
   * ILIKE filter catches all of the merchant's expense transactions.
   */
  merchantFilter: string;
  /** Dominant category (most frequent by transaction count within the group). */
  dominantCategory: V1Category;
  /** Per-category breakdown within the merchant group. Sorted by count desc. */
  categoryBreakdown: Array<{ category: string; total: number; count: number }>;
  bucket: "repeat_discretionary" | "micro_spend" | "high_frequency_convenience";
  /** Human-readable bucket label shown under the merchant name. */
  label: string;
  /**
   * totalSpend / monthFactor — normalized per-month cost.
   * monthFactor = max(1, rangeDays / 30)
   */
  monthlyAmount: number;
  occurrences: number;
  /** ISO date of earliest transaction in the group. */
  firstDate: string;
  /** ISO date of most recent transaction in the group. */
  lastDate: string;
  confidence: "High" | "Medium" | "Low";
  averageAmount: number;
  /** Raw total spend in the selected window (not normalized). */
  recentSpend: number;
  /** Daily average spend — populated only for micro_spend items. */
  dailyAverage?: number;
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
  /** "detected" = batch detector confirmed; "hint" = classifier guess; "none" = not recurring. */
  recurrenceSource?: string | null;
  excludedFromAnalysis?: boolean | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function getMonthFactor(rangeDays: number): number {
  return Math.max(1, rangeDays / 30);
}

// ─── Core algorithm ───────────────────────────────────────────────────────────

/**
 * Detect expense spending patterns that are likely avoidable.
 *
 * Pure function — takes a transaction array, returns a ranked LeakItem list.
 * Does NOT touch the database. Groups by normalized merchant key (recurrenceKey)
 * so the same physical merchant never produces more than one leak card even when
 * its transactions span multiple categories.
 *
 * @param txns   Flat transaction rows (all classes/flow-types are accepted — the
 *               function itself filters to `transactionClass === "expense"` and
 *               excludes the essential category set).
 * @param options.rangeDays             The query-window length in days (required). Used to
 *                                      normalise monthlyAmount so it reflects the actual
 *                                      period the user is looking at, not the transactions'
 *                                      own date span (which can be much shorter and would
 *                                      artificially inflate the per-month figure).
 * @param options.recurringMerchantKeys Normalized merchant keys (output of recurrenceKey())
 *                                      of currently active recurring candidates. Any merchant
 *                                      whose key appears in this set is SKIPPED — preventing
 *                                      double-counting between the Recurring Expenses and
 *                                      Leaks views. Pass an empty set when unknown.
 */
export function detectLeaks(
  txns: TxRow[],
  options: { rangeDays: number; recurringMerchantKeys?: ReadonlySet<string> },
): LeakItem[] {
  const rangeDays = options.rangeDays;
  const monthFactor = getMonthFactor(rangeDays);
  const recurringKeys = options.recurringMerchantKeys ?? new Set<string>();

  // Filter to leak candidates: expense class, non-essential category, not excluded
  const candidates = txns.filter(
    (tx) =>
      tx.transactionClass === "expense" &&
      !ESSENTIAL_LEAK_EXCLUSIONS.has(tx.category) &&
      !tx.excludedFromAnalysis,
  );

  // Group by normalized merchant key so one physical merchant → one group,
  // regardless of how many categories its transactions fall under.
  type TxEntry = {
    date: string;
    merchant: string;
    amount: number;
    category: string;
    recurrenceType: string;
    recurrenceSource: string;
  };
  const merchantGroups: Record<string, TxEntry[]> = {};

  for (const tx of candidates) {
    const key = recurrenceKey(tx.merchant);
    // Mutual exclusion: skip merchants that are currently tracked as recurring.
    // This prevents the same merchant from appearing on both the Recurring Expenses
    // dashboard card and the Leaks page simultaneously.
    if (recurringKeys.has(key)) continue;
    if (!merchantGroups[key]) merchantGroups[key] = [];
    merchantGroups[key].push({
      date: tx.date,
      merchant: tx.merchant,
      amount: Math.abs(parseFloat(String(tx.amount))),
      category: tx.category,
      recurrenceType: tx.recurrenceType ?? "one-time",
      recurrenceSource: tx.recurrenceSource ?? "none",
    });
  }

  const leaks: LeakItem[] = [];

  for (const [key, entries] of Object.entries(merchantGroups)) {
    if (entries.length < 2) continue;

    const amounts = entries.map((e) => e.amount);
    const totalSpend = amounts.reduce((a, b) => a + b, 0);
    const avgAmount = totalSpend / amounts.length;

    const sortedDates = [...entries.map((e) => e.date)].sort();
    const firstDate = sortedDates[0]!;
    const lastDate = sortedDates[sortedDates.length - 1]!;

    // Display merchant: raw string from the most recent transaction
    const mostRecent = entries.reduce((a, b) => (a.date >= b.date ? a : b));
    const displayMerchant = mostRecent.merchant;

    const amountVariance =
      amounts.length > 1 ? Math.max(...amounts) - Math.min(...amounts) : 0;

    const isRecurring = entries.some(
      (e) => e.recurrenceSource === "detected" && e.recurrenceType === "recurring",
    );

    // Build per-category breakdown (sorted by count desc, tiebreak by total desc)
    const catMap: Record<string, { total: number; count: number }> = {};
    for (const e of entries) {
      if (!catMap[e.category]) catMap[e.category] = { total: 0, count: 0 };
      catMap[e.category].total += e.amount;
      catMap[e.category].count += 1;
    }
    const categoryBreakdown = Object.entries(catMap)
      .map(([category, { total, count }]) => ({
        category,
        total: roundCurrency(total),
        count,
      }))
      .sort((a, b) => b.count - a.count || b.total - a.total);

    // Dominant category: most frequent by count, tiebreak by total
    const dominantCategory = categoryBreakdown[0]?.category ?? "other";

    // Category diversity: number of distinct categories in the group
    const uniqueCategories = categoryBreakdown.length;

    // ── Bucket threshold checks ──────────────────────────────────────────────
    const isMicroSpend = avgAmount <= 20 && amounts.length >= 4;

    // Convenience: dominant category is dining/coffee/delivery with ≥3 charges
    const isConvenience =
      (dominantCategory === "dining" ||
        dominantCategory === "coffee" ||
        dominantCategory === "delivery") &&
      amounts.length >= 3;

    // Standard repeat discretionary: known discretionary dominant category, ≥3 charges, ≥$60 total
    const isRepeatDiscretionary =
      DISCRETIONARY_CATEGORIES.has(dominantCategory) &&
      amounts.length >= 3 &&
      totalSpend >= 60;

    // High-spend fallback: ≥2 charges AND ≥$150 total qualifies as repeat_discretionary.
    // Catches bimonthly large-spend merchants (e.g. two $90 restaurant visits).
    const isHighSpendFallback =
      DISCRETIONARY_CATEGORIES.has(dominantCategory) &&
      amounts.length >= 2 &&
      totalSpend >= 150;

    // Catch-all repeat-purchase rule: any merchant with ≥3 transactions, avg ≥$25,
    // and total ≥$75 is surfaced as a low-confidence leak regardless of category,
    // as long as it is not a hard-excluded essential obligation.
    // This catches unfamiliar merchant types (e.g. "other" or unknown categories)
    // for new CSV sources where discretionary classification may be imprecise.
    const isRepeatPurchaseCatchAll =
      amounts.length >= 3 &&
      avgAmount >= 25 &&
      totalSpend >= 75 &&
      !CATCH_ALL_HARD_EXCLUSIONS.has(dominantCategory);

    // isRecurring boosts confidence and adjusts bucket metadata, but does NOT
    // independently qualify a group as a leak — one of the behavioral
    // thresholds must still be met.
    if (
      !isMicroSpend &&
      !isConvenience &&
      !isRepeatDiscretionary &&
      !isHighSpendFallback &&
      !isRepeatPurchaseCatchAll
    ) {
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
      amounts.length >= 6 ||
      (isRecurring && amountVariance < avgAmount * 0.15)
    ) {
      confidence = "High";
    } else if (amounts.length <= 2) {
      confidence = "Low";
    }

    // Category diversity penalty: spread across 3+ categories lowers confidence
    // (less certain this is one habitual spend pattern vs. a multi-purpose merchant).
    if (uniqueCategories >= 3) {
      if (confidence === "High") confidence = "Medium";
      else if (confidence === "Medium") confidence = "Low";
    }

    // Catch-all-only items: cap at Low confidence since they qualified solely
    // on frequency/amount heuristics without a strong discretionary category signal.
    if (
      isRepeatPurchaseCatchAll &&
      !isMicroSpend &&
      !isConvenience &&
      !isRepeatDiscretionary &&
      !isHighSpendFallback
    ) {
      confidence = "Low";
    }

    // Daily average — only for micro_spend items
    const dailyAverage =
      bucket === "micro_spend"
        ? roundCurrency(totalSpend / Math.max(1, rangeDays))
        : undefined;

    leaks.push({
      merchant: displayMerchant,
      merchantKey: key,
      merchantFilter: key,
      dominantCategory: dominantCategory as V1Category,
      categoryBreakdown,
      bucket,
      label,
      monthlyAmount: roundCurrency(totalSpend / monthFactor),
      occurrences: amounts.length,
      firstDate,
      lastDate,
      confidence,
      averageAmount: roundCurrency(avgAmount),
      recentSpend: roundCurrency(totalSpend),
      dailyAverage,
      transactionClass: "expense",
      recurrenceType: isRecurring ? "recurring" : undefined,
      isSubscriptionLike: detectSubscriptionLike(
        displayMerchant,
        dominantCategory,
        isRecurring,
        amountVariance,
        avgAmount,
      ),
    });
  }

  // Sort descending by raw window spend (highest dollar leak first)
  return leaks.sort((a, b) => b.recentSpend - a.recentSpend);
}
