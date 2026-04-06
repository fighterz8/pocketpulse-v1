/**
 * Recurring transaction detection engine.
 *
 * Groups outflow transactions by normalized merchant key, sub-groups by
 * amount bucket, detects frequency via median interval matching, and
 * scores confidence from four weighted signals: interval regularity,
 * amount consistency, transaction count, and recency.
 *
 * Only considers transactions from the past 18 months so stale
 * subscriptions that were cancelled years ago don't contaminate results.
 */

export type RecurringCandidate = {
  candidateKey: string;
  merchantKey: string;
  merchantDisplay: string;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  averageAmount: number;
  amountStdDev: number;
  monthlyEquivalent: number; // normalised to $/month for comparison
  annualEquivalent: number;
  confidence: number;
  reasonFlagged: string;
  transactionIds: number[];
  firstSeen: string;
  lastSeen: string;
  expectedNextDate: string;
  category: string;
  /** true if the last charge is within 2× the median interval from today */
  isActive: boolean;
  /** estimated days overdue (positive) or days until next charge (negative) */
  daysSinceExpected: number;
  /**
   * true when the charge pattern looks like a digital subscription rather
   * than a lifestyle habit (coffee, dining, gym visits, etc.).
   *
   * Used in the Leaks page to split candidates into "Subscriptions" and
   * "Habits" sections so the user knows which ones they can cancel vs. change.
   *
   * Criteria (any one suffices):
   *  1. Category is software, entertainment, or streaming-adjacent (fitness)
   *  2. Monthly/annual and the average amount has a ".99" or ".00" suffix
   *     (classic SaaS pricing)
   *  3. Merchant key contains a known subscription brand name
   */
  isSubscriptionLike: boolean;
};

type TransactionLike = {
  id: number;
  date: string;
  amount: string;
  merchant: string;
  flowType: string;
  category: string;
  excludedFromAnalysis: boolean;
};

type MerchantGroup = {
  key: string;
  transactions: TransactionLike[];
};

type AmountBucket = {
  centroid: number;
  transactions: TransactionLike[];
};

type FrequencyResult = {
  frequency: RecurringCandidate["frequency"];
  medianInterval: number;
  intervalStdDev: number;
};

type FrequencyDef = {
  frequency: RecurringCandidate["frequency"];
  expectedDays: number;
  toleranceDays: number;
};

const FREQUENCY_DEFS: FrequencyDef[] = [
  { frequency: "weekly",    expectedDays: 7,     toleranceDays: 2  },
  { frequency: "biweekly",  expectedDays: 14,    toleranceDays: 3  },
  { frequency: "monthly",   expectedDays: 30.4,  toleranceDays: 6  },
  { frequency: "quarterly", expectedDays: 91.3,  toleranceDays: 18 },
  { frequency: "annual",    expectedDays: 365,   toleranceDays: 30 },
];

// Monthly multiplier for each frequency
const MONTHLY_FACTOR: Record<RecurringCandidate["frequency"], number> = {
  weekly:    4.333,
  biweekly:  2.167,
  monthly:   1,
  quarterly: 1 / 3,
  annual:    1 / 12,
};

const AMOUNT_TOLERANCE_PERCENT = 0.30; // 30% tolerance — more flexible
const AMOUNT_TOLERANCE_FLOOR   = 3.0;  // at least $3 tolerance
const CONFIDENCE_THRESHOLD     = 0.30; // lower floor, UI shows confidence badge
const VARIABLE_AMOUNT_CATEGORIES = new Set(["utilities", "insurance", "medical", "housing"]);

/**
 * Categories that are almost always digital subscriptions (billed to a card,
 * cancellable online) rather than in-person lifestyle habits.
 */
const SUBSCRIPTION_CATEGORIES = new Set(["software", "entertainment"]);

/**
 * Merchant key fragments that unambiguously indicate a subscription product.
 * Matched against the lowercased candidateKey with a simple includes() check.
 */
const SUBSCRIPTION_BRAND_FRAGMENTS = [
  "netflix", "spotify", "hulu", "disney", "hbo", "max.com", "paramount",
  "peacock", "peacocktv", "audible", "apple music", "apple tv", "icloud",
  "google one", "youtube", "amazon prime", "openai", "anthropic", "chatgpt",
  "replit", "github", "notion", "figma", "canva", "adobe", "dropbox",
  "box.com", "zoom", "slack", "linear", "loom", "1password", "lastpass",
  "nordvpn", "expressvpn", "surfshark", "proton", "fastmail", "hey.com",
  "elevenlabs", "shopify", "quickbooks", "freshbooks", "xero", "squarespace",
  "wix", "godaddy", "namecheap", "cloudflare", "digitalocean", "linode",
  "aws", "azure", "heroku", "vercel", "netlify", "twilio",
];

/**
 * Merchant key fragments that are NEVER subscription-like, regardless of amount
 * or frequency. These represent cash/banking transactions that recur by nature
 * but cannot be "cancelled" — they should always land in Habits, not Subscriptions.
 *
 * Checked against the lowercased candidateKey with includes() — any match forces
 * isSubscriptionLike to false, short-circuiting all other signals.
 *
 * Outflow-only note: inflows (direct deposits, wire transfers in, ACH credits,
 * mobile deposits) are already excluded from candidate detection at the grouping
 * stage (flowType !== "outflow" filter), so they never reach this check.
 */
const NEVER_SUBSCRIPTION_FRAGMENTS = [
  "atm",              // ATM withdrawals / ATM fees (round-dollar amounts trigger isSaasPrice)
  "wire transfer",    // outgoing wire transfers (not cancellable)
  "ach credit",       // inbound ACH credits (direct deposits, refunds, government payments)
  "mobile deposit",   // mobile check deposits
  "interest payment", // bank interest paid to user or loan interest charges
  "zelle",            // Zelle P2P payments
  "venmo",            // Venmo P2P payments / cashouts
  "cash app",         // CashApp P2P transfers
  "cashout",          // "ACH CREDIT VENMO CASHOUT" and similar P2P cashout descriptions
];

/**
 * Transaction categories that are never subscription-like.
 * Includes "banking" and "transfer" as future-proof guards even though these
 * category values do not currently exist in V1_CATEGORIES — if they are added
 * later, affected transactions will be protected immediately.
 * "income" catches any edge case where an inflow slips through the flowType filter.
 */
const NEVER_SUBSCRIPTION_CATEGORIES = new Set(["income", "banking", "transfer"]);

/** Only look at transactions from the past 18 months */
const LOOKBACK_DAYS = 548; // ~18 months

const WEIGHTS = {
  interval: 0.35,
  amount:   0.25,
  count:    0.20,
  recency:  0.20,
};

// ─── Merchant key normalisation ─────────────────────────────────────────────

/**
 * Strips payment processor prefixes, account numbers, "-dc NNNN" prefixes,
 * "Payment To " prefixes, and known suffix noise so that
 *   "-dc 4305 Replit, Inc. Replit.com"  →  "replit"
 *   "Payment To At&t"                   →  "at&t"
 *   "Openai Httpsopenai.c Ca Null"       →  "openai"
 *   "Chatgpt Subscripti Httpsopenai.c"  →  "openai"
 */
export function recurrenceKey(merchant: string): string {
  let k = merchant.toLowerCase().trim();

  // Strip leading non-alphanumeric junk (e.g. "- Lakeview Ln" → "Lakeview Ln")
  k = k.replace(/^[\s\-–—_*#]+/, "");

  // Strip leading debit-card prefix: "-dc NNNN " or "debit NNNN "
  k = k.replace(/^-dc\s+\d+\s*/i, "");

  // Strip payment processor square/toast/stripe prefixes
  k = k.replace(/^(sq\s*\*|tst\s*\*|sp\s*\*|pos\s*|pp\s*\*|paypal\s*\*)\s*/i, "");

  // Strip "Payment To " prefix (e.g. "Payment To Tesla Insurance")
  k = k.replace(/^payment\s+(to\s+)?/i, "");

  // Strip trailing URL noise (e.g. "Replit.com", "Httpsopenai.c Ca Null", "Openai.com")
  k = k.replace(/\s+(https?:\S+|http\S*|\w+\.\w{2,4})\s*.*/i, "");
  k = k.replace(/\s+(ca|null|us|co)\s*$/i, "");

  // Strip trailing transaction/account number
  k = k.replace(/\s*[#*]\s*\d+\s*$/, "");
  k = k.replace(/\s+\d{4,}\s*$/, "");

  // Brand aliases — map known variants to a canonical key
  const ALIASES: [RegExp, string][] = [
    [/\bopenai\b|\bchatgpt\b/, "openai"],
    [/\banthropic\b|\bclaude\.ai\b|\bclaude ai\b/, "anthropic"],
    [/\breplit\b/, "replit"],
    [/\bamazon prime video\b/, "amazon prime video"],
    [/\bamazon prime\b/, "amazon prime"],
    [/\bnetflix\b/, "netflix"],
    [/\bspotify\b/, "spotify"],
    [/\bhulu\b/, "hulu"],
    [/\byoutube\b|\byt premium\b/, "youtube"],
    [/\bgoogle one\b|\bgoogle storage\b/, "google one"],
    [/\bapple.*music\b/, "apple music"],
    [/\bicloud\b/, "icloud"],
    [/\bshopify\b/, "shopify"],
    [/\belevenlabs\b/, "elevenlabs"],
    [/\b24 hour fitness\b|\b24hr fitness\b/, "24 hour fitness"],
    [/\bchuze fitness\b/, "chuze fitness"],
    [/\bcrunchyroll\b/, "crunchyroll"],
    [/\bat&t\b|\bat and t\b/, "at&t"],
    [/\btesla insurance\b/, "tesla insurance"],
    [/\blumetry\b/, "lumetry"],
  ];
  for (const [re, canonical] of ALIASES) {
    if (re.test(k)) { k = canonical; break; }
  }

  return k.replace(/\s+/g, " ").trim();
}

/**
 * Build a stable candidate key from a merchant key and bucket index.
 *
 * The primary (most-common-amount) bucket for a merchant gets the bare
 * merchantKey so that a price change (e.g. Netflix $9.99 → $11.99) does NOT
 * create a new key and orphan the user's existing review.
 *
 * Secondary buckets (a merchant with truly distinct price tiers, e.g. a gym
 * that bills both a monthly membership and an annual day-pass fee) get a
 * numeric suffix: "merchant|1", "merchant|2", etc.
 *
 * Migration note: old keys had the format "merchantKey|avgAmount.toFixed(2)".
 * A one-time startup migration (see routes.ts) strips that suffix so existing
 * reviews automatically re-attach to the new key format.
 */
export function buildCandidateKey(merchantKey: string, bucketIndex: number): string {
  return bucketIndex === 0 ? merchantKey : `${merchantKey}|${bucketIndex}`;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000,
  );
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function lookbackCutoff(): string {
  const d = new Date();
  d.setDate(d.getDate() - LOOKBACK_DAYS);
  return d.toISOString().slice(0, 10);
}

// Categories where we group by amount bucket instead of merchant name.
// Mortgage / rent payments often appear with different merchant names in bank
// exports (e.g. "Payment To Lakeview Loan Servicing" vs "- Lakeview Ln Srv Mtg Pymt")
// but always represent the same underlying recurring obligation.
const CATEGORY_KEY_OVERRIDES = new Set(["housing"]);

// ─── Grouping ────────────────────────────────────────────────────────────────

function groupTransactions(txns: TransactionLike[]): MerchantGroup[] {
  const cutoff = lookbackCutoff();
  const map = new Map<string, TransactionLike[]>();
  for (const txn of txns) {
    if (txn.excludedFromAnalysis) continue;
    if (txn.flowType !== "outflow") continue;
    if (txn.date < cutoff) continue; // ignore data older than 18 months

    let key: string;
    if (CATEGORY_KEY_OVERRIDES.has(txn.category)) {
      // Group by category + rounded-amount bucket so mortgage/rent payments
      // cluster together regardless of how the bank formats the merchant name.
      // Round to nearest $200 so minor payment adjustments stay in the same group.
      const amt = Math.abs(parseFloat(txn.amount) || 0);
      const bucket = Math.round(amt / 200) * 200;
      key = `__${txn.category}_${bucket}`;
    } else {
      key = recurrenceKey(txn.merchant);
    }
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(txn);
  }
  return Array.from(map.entries()).map(([key, transactions]) => ({
    key,
    transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
  }));
}

function bucketByAmount(txns: TransactionLike[]): AmountBucket[] {
  const buckets: AmountBucket[] = [];
  for (const txn of txns) {
    const amt = Math.abs(parseFloat(txn.amount));
    if (isNaN(amt) || amt === 0) continue;
    let placed = false;
    for (const bucket of buckets) {
      const tolerance = Math.max(
        bucket.centroid * AMOUNT_TOLERANCE_PERCENT,
        AMOUNT_TOLERANCE_FLOOR,
      );
      if (Math.abs(amt - bucket.centroid) <= tolerance) {
        bucket.transactions.push(txn);
        bucket.centroid =
          bucket.transactions.reduce((s, t) => s + Math.abs(parseFloat(t.amount)), 0) /
          bucket.transactions.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      buckets.push({ centroid: amt, transactions: [txn] });
    }
  }
  return buckets;
}

// ─── Frequency detection ─────────────────────────────────────────────────────

function detectFrequency(txns: TransactionLike[]): FrequencyResult | null {
  if (txns.length < 2) return null;

  const intervals: number[] = [];
  for (let i = 1; i < txns.length; i++) {
    intervals.push(daysBetween(txns[i - 1]!.date, txns[i]!.date));
  }

  const med = median(intervals);
  if (med <= 0) return null;

  // Filter out obvious outlier gaps (>3× median) before computing stddev
  const filtered = intervals.filter((iv) => iv > 0 && iv <= med * 3);
  if (filtered.length === 0) return null;

  const mean = filtered.reduce((s, v) => s + v, 0) / filtered.length;
  const variance = filtered.reduce((s, v) => s + (v - mean) ** 2, 0) / filtered.length;
  const stdDev = Math.sqrt(variance);

  let bestMatch: FrequencyDef | null = null;
  let bestDelta = Infinity;
  for (const fd of FREQUENCY_DEFS) {
    const delta = Math.abs(med - fd.expectedDays);
    if (delta <= fd.toleranceDays && delta < bestDelta) {
      bestMatch = fd;
      bestDelta = delta;
    }
  }
  if (!bestMatch) return null;

  return { frequency: bestMatch.frequency, medianInterval: med, intervalStdDev: stdDev };
}

function getMinTransactions(frequency: RecurringCandidate["frequency"]): number {
  if (frequency === "annual")    return 2;
  if (frequency === "quarterly") return 2;
  return 3;
}

// ─── Confidence scoring ──────────────────────────────────────────────────────

function scoreConfidence(
  txns: TransactionLike[],
  freq: FrequencyResult,
  category: string,
): { score: number; amountScore: number; recencyScore: number } {
  const n = txns.length;

  // Count signal: plateaus at 6 occurrences
  const countScore = Math.min(1.0, (n - 2) / 4);

  // Interval regularity: coefficient of variation of intervals
  const cv = freq.medianInterval > 0 ? freq.intervalStdDev / freq.medianInterval : 0;
  const intervalScore = Math.max(0, 1.0 - cv * 2);

  // Amount consistency
  const amounts = txns.map((t) => Math.abs(parseFloat(t.amount)));
  const avgAmt = amounts.reduce((s, v) => s + v, 0) / amounts.length;
  const amtVariance = amounts.reduce((s, v) => s + (v - avgAmt) ** 2, 0) / amounts.length;
  const amtCv = avgAmt > 0 ? Math.sqrt(amtVariance) / avgAmt : 0;
  const amountScore = VARIABLE_AMOUNT_CATEGORIES.has(category)
    ? Math.max(0, 1.0 - amtCv * 2.0)
    : Math.max(0, 1.0 - amtCv * 3.33);

  // Recency: how long since the last charge vs expected interval
  const daysSinceLast = daysBetween(txns[txns.length - 1]!.date, todayISO());
  const recencyRatio = freq.medianInterval > 0 ? daysSinceLast / freq.medianInterval : 0;
  let recencyScore: number;
  if (recencyRatio <= 1.5)      recencyScore = 1.0;
  else if (recencyRatio >= 3.5) recencyScore = 0;
  else recencyScore = Math.max(0, 1.0 - (recencyRatio - 1.5) / 2.0);

  const raw =
    countScore    * WEIGHTS.count    +
    intervalScore * WEIGHTS.interval +
    amountScore   * WEIGHTS.amount   +
    recencyScore  * WEIGHTS.recency;

  return { score: Math.round(raw * 100) / 100, amountScore, recencyScore };
}

// ─── Reason text ─────────────────────────────────────────────────────────────

function buildReasonFlagged(
  txnCount: number,
  avgAmount: number,
  frequency: string,
  amountScore: number,
  isActive: boolean,
): string {
  const parts: string[] = [
    `${txnCount} charges of ~$${avgAmount.toFixed(2)} ${frequency}`,
  ];
  if (amountScore >= 0.9)      parts.push("— consistent amount");
  else if (amountScore >= 0.6) parts.push("— minor amount variation");
  else                         parts.push("— variable amounts");
  if (!isActive)               parts.push("· possibly cancelled");
  return parts.join(" ");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectRecurringCandidates(txns: TransactionLike[]): RecurringCandidate[] {
  if (txns.length === 0) return [];

  const today = todayISO();
  const candidates: RecurringCandidate[] = [];
  const groups = groupTransactions(txns);

  for (const group of groups) {
    // Sort buckets largest-first so the highest-spend tier gets bucket index 0
    // (the bare merchantKey, no suffix). Lower-spend tiers get |1, |2, etc.
    const buckets = bucketByAmount(group.transactions).sort(
      (a, b) => b.centroid - a.centroid,
    );

    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
      const bucket = buckets[bucketIndex]!;
      const sorted = bucket.transactions.sort((a, b) => a.date.localeCompare(b.date));

      const freq = detectFrequency(sorted);
      if (!freq) continue;

      const minTxns = getMinTransactions(freq.frequency);
      if (sorted.length < minTxns) continue;

      // For annual, require the two charges to span at least 10 months
      if (freq.frequency === "annual" && sorted.length === 2) {
        const span = daysBetween(sorted[0]!.date, sorted[1]!.date);
        if (span < 300) continue;
      }

      const category = sorted[sorted.length - 1]!.category;
      const { score: confidence, amountScore, recencyScore } = scoreConfidence(sorted, freq, category);
      if (confidence < CONFIDENCE_THRESHOLD) continue;

      // Suppress if low recency AND low confidence (stale cancelled subscriptions)
      if (recencyScore === 0 && confidence < 0.5) continue;

      const amounts = sorted.map((t) => Math.abs(parseFloat(t.amount)));
      const avgAmt  = amounts.reduce((s, v) => s + v, 0) / amounts.length;
      const amtVariance = amounts.reduce((s, v) => s + (v - avgAmt) ** 2, 0) / amounts.length;
      const amtStdDev   = Math.sqrt(amtVariance);

      const lastDate = sorted[sorted.length - 1]!.date;
      const nextDate = addDays(lastDate, Math.round(freq.medianInterval));
      const daysSinceExpected = daysBetween(nextDate, today);

      // Active = last charge was within 2 full median-intervals of today
      const isActive = daysBetween(lastDate, today) <= freq.medianInterval * 2;

      const monthlyEquivalent = Math.round(avgAmt * MONTHLY_FACTOR[freq.frequency] * 100) / 100;
      const annualEquivalent  = Math.round(monthlyEquivalent * 12 * 100) / 100;

      const candidateKey = buildCandidateKey(group.key, bucketIndex);

      // For category-override groups (e.g. __housing_3400), build a clean display name
      // from the most common merchant name in the group rather than the raw bucket key.
      let merchantDisplay: string;
      if (group.key.startsWith("__")) {
        // Pick the most frequently appearing merchant name
        const nameCounts = new Map<string, number>();
        for (const t of sorted) {
          const n = t.merchant.replace(/^[\s\-–—_*#]+/, "").trim();
          nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
        }
        merchantDisplay = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      } else {
        merchantDisplay = sorted[sorted.length - 1]!.merchant;
      }

      // ── isSubscriptionLike signal ──────────────────────────────────────
      // A charge is "subscription-like" if any of the following hold:
      //  1. It belongs to a known digital-subscription category
      //  2. The merchant key matches a known SaaS/streaming brand
      //  3. It's a fixed monthly/annual charge with a classic ".99" or ".00"
      //     price point (e.g. $9.99, $14.99, $99.00, $19.00)
      //
      // Two hard overrides force isSubscriptionLike to false first, regardless
      // of all other signals:
      //  A. NEVER_SUBSCRIPTION_FRAGMENTS — cash/banking merchant keywords (ATM,
      //     Zelle, Venmo, wire transfers) that recur by nature but cannot be
      //     cancelled like a subscription.  DEF-014: round-dollar ATM withdrawals
      //     were triggering isSaasPrice and landing in Digital Subscriptions.
      //  B. NEVER_SUBSCRIPTION_CATEGORIES — "income" catches mislabelled inflows
      //     that slipped through the flowType filter.
      const neverFragment = NEVER_SUBSCRIPTION_FRAGMENTS.some((frag) =>
        candidateKey.includes(frag),
      );
      const neverCategory = NEVER_SUBSCRIPTION_CATEGORIES.has(category);

      const roundedAvg = Math.round(avgAmt * 100) / 100;
      const centsStr   = roundedAvg.toFixed(2).split(".")[1] ?? "";
      const isSaasPrice =
        !neverFragment &&
        !neverCategory &&
        (freq.frequency === "monthly" || freq.frequency === "annual" || freq.frequency === "quarterly") &&
        (centsStr === "99" || centsStr === "00" || centsStr === "49");
      const isSubscriptionLike =
        !neverFragment &&
        !neverCategory &&
        (
          SUBSCRIPTION_CATEGORIES.has(category) ||
          SUBSCRIPTION_BRAND_FRAGMENTS.some((frag) => candidateKey.includes(frag)) ||
          isSaasPrice
        );

      candidates.push({
        candidateKey,
        merchantKey:     group.key,
        merchantDisplay,
        frequency:       freq.frequency,
        averageAmount:   roundedAvg,
        amountStdDev:    Math.round(amtStdDev * 100) / 100,
        monthlyEquivalent,
        annualEquivalent,
        confidence,
        reasonFlagged: buildReasonFlagged(sorted.length, avgAmt, freq.frequency, amountScore, isActive),
        transactionIds: sorted.map((t) => t.id),
        firstSeen:  sorted[0]!.date,
        lastSeen:   lastDate,
        expectedNextDate: nextDate,
        category,
        isActive,
        daysSinceExpected,
        isSubscriptionLike,
      });
    }
  }

  // Sort: active first, then by monthly cost descending
  return candidates.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.monthlyEquivalent - a.monthlyEquivalent;
  });
}
