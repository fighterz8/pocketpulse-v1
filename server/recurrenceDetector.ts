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
 *
 * Detection is CATEGORY-STRATIFIED:
 *  • Bill categories (utilities, housing, insurance, medical, debt) —
 *    liberal amount tolerance (25 %) and category+amount grouping
 *    (utilities $10, insurance $20, housing $200, debt $50 rounding)
 *    so cross-bank merchant name variance still clusters correctly.
 *  • Subscription categories (software, entertainment) — tight tolerance
 *    (10 %) because SaaS prices are fixed.
 *  • Lifestyle categories (dining, coffee, delivery, convenience, shopping)
 *    — HARD BLOCKED from recurring detection. Starbucks, Amazon retail,
 *    DoorDash, etc. can never be "recurring expenses" regardless of how
 *    often they appear. Exception: known subscription brands that happen
 *    to be tagged in a lifestyle category (e.g. meal-kit services).
 *  • All other categories — moderate tolerance (15 %).
 *
 * Recurrence is evaluated against the latest date in the imported dataset,
 * not the wall clock. This keeps a historical statement internally coherent
 * and prevents a newly started or previously ended recurring obligation from
 * being rejected merely because unrelated history covers more months.
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
   */
  isSubscriptionLike: boolean;
};

/**
 * Canonical set of transaction rows that a recurrence sync must mark recurring.
 * This intentionally includes already-expense-classified rows as well as
 * transfer rows that may need a separate class promotion.
 */
export function collectRecurringTransactionIds(
  candidates: ReadonlyArray<Pick<RecurringCandidate, "transactionIds">>,
): Set<number> {
  const ids = new Set<number>();
  for (const candidate of candidates) {
    for (const id of candidate.transactionIds) ids.add(id);
  }
  return ids;
}

/**
 * Transaction-level recurring evidence supplied by rules, bank categories,
 * AI/cache classifications, or a user correction. These rows are recurring
 * even before enough history exists for the pattern detector to confirm a
 * schedule. Detector-authored rows are intentionally excluded so a later sync
 * can still revoke a pattern that has stopped matching.
 */
export function collectRecurringEvidenceTransactionIds(
  transactions: ReadonlyArray<TransactionLike>,
): Set<number> {
  return new Set(
    transactions
      .filter(
        (transaction) =>
          transaction.flowType === "outflow" &&
          !transaction.excludedFromAnalysis &&
          transaction.recurrenceType === "recurring" &&
          ["hint", "manual"].includes(transaction.recurrenceSource ?? ""),
      )
      .map((transaction) => transaction.id),
  );
}

type TransactionLike = {
  id: number;
  date: string;
  amount: string;
  merchant: string;
  flowType: string;
  category: string;
  excludedFromAnalysis: boolean;
  recurrenceType?: string;
  recurrenceSource?: string;
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
  { frequency: "weekly", expectedDays: 7, toleranceDays: 2 },
  { frequency: "biweekly", expectedDays: 14, toleranceDays: 3 },
  { frequency: "monthly", expectedDays: 30.4, toleranceDays: 6 },
  { frequency: "quarterly", expectedDays: 91.3, toleranceDays: 18 },
  { frequency: "annual", expectedDays: 365, toleranceDays: 30 },
];

// Monthly multiplier for each frequency
const MONTHLY_FACTOR: Record<RecurringCandidate["frequency"], number> = {
  weekly: 4.333,
  biweekly: 2.167,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

/**
 * Categories where bills legitimately vary in amount (utility usage,
 * insurance adjustments, etc.). Given generous amount tolerance.
 */
const VARIABLE_AMOUNT_CATEGORIES = new Set([
  "utilities",
  "insurance",
  "medical",
  "housing",
  "debt",
]);

/**
 * Categories that are almost always digital subscriptions (billed to a card,
 * cancellable online) rather than in-person lifestyle habits.
 */
const SUBSCRIPTION_CATEGORIES = new Set(["software", "entertainment"]);

/**
 * Lifestyle categories that are HARD BLOCKED from recurring detection.
 *
 * Purchases at Starbucks, Amazon retail, DoorDash, etc. may happen
 * repeatedly but they are NOT recurring expenses — they are discretionary
 * lifestyle spend whose amounts and frequency vary per visit. These should
 * be surfaced as Leaks, not Recurring Expenses.
 *
 * Exception: a merchant whose normalized key appears in
 * SUBSCRIPTION_BRAND_FRAGMENTS is allowed through even if its category
 * lands here (e.g. a meal-kit service tagged "delivery").
 */
const LIFESTYLE_BLOCK_CATEGORIES = new Set([
  "dining",
  "coffee",
  "delivery",
  "convenience",
  "shopping",
]);

/**
 * Merchant key fragments that unambiguously indicate a subscription product.
 * Matched against the lowercased candidateKey with a substring includes() check.
 * Used only for the isSubscriptionLike signal — not for lifestyle gate bypass.
 */
const SUBSCRIPTION_BRAND_FRAGMENTS = [
  "netflix",
  "spotify",
  "hulu",
  "disney",
  "hbo",
  "max.com",
  "paramount",
  "peacock",
  "peacocktv",
  "audible",
  "apple music",
  "apple tv",
  "icloud",
  "google one",
  "youtube",
  "amazon prime",
  "openai",
  "anthropic",
  "chatgpt",
  "replit",
  "github",
  "notion",
  "figma",
  "canva",
  "adobe",
  "dropbox",
  "box.com",
  "zoom",
  "slack",
  "linear",
  "loom",
  "1password",
  "lastpass",
  "nordvpn",
  "expressvpn",
  "surfshark",
  "proton",
  "fastmail",
  "hey.com",
  "elevenlabs",
  "shopify",
  "quickbooks",
  "freshbooks",
  "xero",
  "squarespace",
  "wix",
  "godaddy",
  "namecheap",
  "cloudflare",
  "digitalocean",
  "linode",
  "aws",
  "azure",
  "heroku",
  "vercel",
  "netlify",
  "twilio",
  // Meal-kit subscriptions billed as "delivery" or "shopping"
  "hellofresh",
  "hello fresh",
  "factor",
  "freshly",
  "marley spoon",
  "everyplate",
  "home chef",
  "green chef",
  "dinnerly",
  "gobble",
];

/**
 * Exact canonical merchant keys (output of recurrenceKey()) that are allowed
 * through the LIFESTYLE_BLOCK_CATEGORIES gate.
 *
 * These brands are billed as recurring subscriptions but may be auto-tagged by
 * the categorizer into a lifestyle category (delivery, shopping, convenience).
 * Using exact key matching (vs substring) prevents incidental false positives.
 */
const LIFESTYLE_SUBSCRIPTION_EXCEPTION_KEYS = new Set([
  // Meal-kit subscriptions (often tagged delivery/shopping)
  "hellofresh",
  "factor",
  "freshly",
  "marley spoon",
  "everyplate",
  "home chef",
  "green chef",
  "dinnerly",
  "gobble",
  // Streaming/digital that occasionally lands in shopping
  "amazon prime",
  "amazon prime video",
  "audible",
]);

/**
 * Merchant key fragments that are NEVER subscription-like, regardless of amount
 * or frequency.
 */
const NEVER_SUBSCRIPTION_FRAGMENTS = [
  "atm",
  "wire transfer",
  "ach credit",
  "mobile deposit",
  "interest payment",
  "zelle",
  "venmo",
  "cash app",
  "cashout",
  "amex",
  "american express",
  "credit card payment",
  "card payment",
  "autopay payment",
  "payment thank you",
  "payment received",
];

/**
 * Transaction categories that are never subscription-like.
 */
const NEVER_SUBSCRIPTION_CATEGORIES = new Set([
  "income",
  "banking",
  "transfer",
]);

/** Only look at transactions from the past 18 months */
const LOOKBACK_DAYS = 548; // ~18 months

/**
 * Confidence threshold — candidates below this score are discarded.
 * Raised from 0.30 to 0.42 to cut out borderline weak detections.
 */
const CONFIDENCE_THRESHOLD = 0.42;

const WEIGHTS = {
  interval: 0.35,
  amount: 0.25,
  count: 0.2,
  recency: 0.2,
};

// ─── Category-stratified amount tolerance ────────────────────────────────────

/**
 * Returns the maximum dollar difference allowed when deciding whether a
 * transaction belongs to an existing amount bucket.
 *
 * Tiers:
 *  • Bill categories (utilities, housing, insurance, medical, debt)
 *    → 25 % or $5 minimum (bills legitimately vary by usage/adjustment)
 *  • Subscription categories (software, entertainment)
 *    → 10 % or $1 minimum (SaaS prices are fixed; price bumps stay in bucket)
 *  • All other non-lifestyle categories
 *    → 15 % or $1.50 minimum
 *  • Lifestyle categories (blocked before bucketing)
 *    → 2 % or $0.10 minimum (safety-net only — should never reach here)
 */
function getAmountTolerance(centroid: number, category: string): number {
  if (VARIABLE_AMOUNT_CATEGORIES.has(category)) {
    return Math.max(5.0, centroid * 0.25);
  }
  if (SUBSCRIPTION_CATEGORIES.has(category)) {
    return Math.max(1.0, centroid * 0.1);
  }
  if (LIFESTYLE_BLOCK_CATEGORIES.has(category)) {
    return Math.max(0.1, centroid * 0.02);
  }
  return Math.max(1.5, centroid * 0.15);
}

// ─── Merchant key normalisation ─────────────────────────────────────────────

/**
 * Strips payment processor prefixes, ACH/EFT/bill-pay prefixes, account
 * numbers, URL noise, and known suffix noise so that merchant descriptions
 * from any bank normalise to a clean, comparable key.
 *
 * Examples:
 *   "ACH PMT DUKE ENERGY 8473923"      → "duke energy"
 *   "ACH DEBIT 4305 AT&T WIRELESS"     → "at&t"
 *   "CHECKCARD 1234 STATE FARM INS"    → "state farm ins"
 *   "PYMT*NETFLIX.COM"                 → "netflix"
 *   "-dc 4305 Replit, Inc. Replit.com" → "replit"
 *   "Payment To At&t"                  → "at&t"
 *   "Openai Httpsopenai.c Ca Null"     → "openai"
 */
export function recurrenceKey(merchant: string): string {
  let k = merchant.toLowerCase().trim();

  // Strip leading non-alphanumeric junk (e.g. "- Lakeview Ln" → "Lakeview Ln")
  k = k.replace(/^[\s\-–—_*#]+/, "");

  // Strip leading debit-card prefix: "-dc NNNN " or "debit NNNN "
  k = k.replace(/^-dc\s+\d+\s*/i, "");

  // Strip ACH / EFT / bill-pay / check-card prefixes that banks prepend.
  // These obscure the real merchant name and prevent grouping across banks.
  //   "ACH PMT DUKE ENERGY 8473923" → "DUKE ENERGY 8473923"
  //   "ACH DEBIT 4305 AT&T"         → "AT&T"
  //   "CHECKCARD 1234 STATE FARM"   → "STATE FARM"
  //   "EFT PMT ALLSTATE INS"        → "ALLSTATE INS"
  //   "BILLPAY DISCOVER CARD"       → "DISCOVER CARD"
  //   "PYMT*NETFLIX.COM"            → "NETFLIX.COM"
  k = k.replace(
    /^(ach\s+(pmt|debit|payment|credit|trnsfr|xfer)\s*[\d]*\s*)/i,
    "",
  );
  k = k.replace(/^(eft\s+(pmt|debit|payment)\s*[\d]*\s*)/i, "");
  k = k.replace(/^(checkcard|check\s*card)\s+\d+\s*/i, "");
  k = k.replace(/^(billpay|bill\s*pay)\s+/i, "");
  k = k.replace(/^(pymt|pmt)\s*[*]?\s*/i, "");
  k = k.replace(/^(online\s+(pmt|payment|pmnt)\s*[\d]*\s*)/i, "");
  k = k.replace(/^debit\s+\d+\s*/i, "");

  // Strip payment processor square/toast/stripe/doordash prefixes
  k = k.replace(
    /^(sq\s*\*|tst\s*\*|sp\s*\*|pos\s*|pp\s*\*|paypal\s*\*|dd\s*\*)\s*/i,
    "",
  );

  // Strip "Payment To " prefix (e.g. "Payment To Tesla Insurance")
  k = k.replace(/^payment\s+(to\s+)?/i, "");

  // Strip trailing URL noise
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
    [/\bdoordash\b/, "doordash"],
    [/\bamazon prime video\b/, "amazon prime video"],
    [/\bamazon prime\b/, "amazon prime"],
    [/\bamazon\b|\bamzn\b/, "amazon"],
    [/\bnetflix\b|\bnflx\b/, "netflix"],
    [/\bspotify\b/, "spotify"],
    [/\bhulu\b/, "hulu"],
    [/\byoutube\b|\byt premium\b/, "youtube"],
    [/\bgoogle one\b|\bgoogle storage\b/, "google one"],
    [/\bapple.*music\b/, "apple music"],
    [/\bicloud\b/, "icloud"],
    [/\bshopify\b/, "shopify"],
    [/\belevenlabs\b/, "elevenlabs"],
    [/\b24 hour fitness\b|\b24hr fitness\b|\b24\s*hour\b/, "24 hour fitness"],
    [/\bchuze fitness\b/, "chuze fitness"],
    [/\bplanet fitness\b/, "planet fitness"],
    [/\bcrunchyroll\b/, "crunchyroll"],
    [
      /\bat&t\b|\bat and t\b|\batt\s*(wireless|mobility|u-verse|internet|tv)\b/,
      "at&t",
    ],
    [/\btesla insurance\b/, "tesla insurance"],
    [/\blumetry\b/, "lumetry"],
    // Common utility/telecom aliases
    [/\bverizon\b/, "verizon"],
    [/\bt.?mobile\b|\btmobile\b/, "t-mobile"],
    [/\bcomcast\b|\bxfinity\b/, "xfinity"],
    [/\bspectrum\b/, "spectrum"],
    [/\bcox\s*(comm|cable|internet)?\b/, "cox"],
    [/\bduke\s*energy\b/, "duke energy"],
    [/\bpg&e\b|\bpacific\s*gas\b/, "pge"],
    [/\bconedison\b|\bcon\s*ed\b/, "con edison"],
    [/\bstate\s*farm\b/, "state farm"],
    [/\bgeico\b/, "geico"],
    [/\ballstate\b/, "allstate"],
    [/\bprogressive\s*(ins|insurance)?\b/, "progressive"],
    [/\bnationwide\b/, "nationwide"],
    [/\bhellofresh\b|\bhello\s*fresh\b/, "hellofresh"],
    [/\bfactor\s*(meals|75)?\b/, "factor"],
    [/\bdiscover\s*(card|bank|financial)?\b/, "discover card"],
  ];
  for (const [re, canonical] of ALIASES) {
    if (re.test(k)) {
      k = canonical;
      break;
    }
  }

  return k.replace(/\s+/g, " ").trim();
}

/**
 * Build a stable candidate key from a merchant key and bucket index.
 */
export function buildCandidateKey(
  merchantKey: string,
  bucketIndex: number,
): string {
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

function latestDatasetDate(txns: TransactionLike[]): string {
  return txns
    .map((transaction) => transaction.date)
    .filter(Boolean)
    .sort()
    .at(-1) ?? new Date().toISOString().slice(0, 10);
}

function lookbackCutoff(asOfDate: string): string {
  const d = new Date(`${asOfDate}T00:00:00.000Z`);
  d.setDate(d.getDate() - LOOKBACK_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Categories where we group by category+amount bucket instead of merchant name.
 *
 * Bills in these categories often appear under completely different merchant
 * strings across banks (e.g. "Payment To Lakeview Loan Servicing" vs
 * "- Lakeview Ln Srv Mtg Pymt", or "ACH PMT DUKE ENERGY 8473923" vs
 * "DUKE ENERGY CAROLINAS 9384789"). Grouping by category+amount bucket
 * ensures they still cluster as one recurring item regardless of bank formatting.
 *
 * Rounding granularity is calibrated per category to keep genuinely distinct
 * bills (e.g. two different utility companies charging close amounts) in
 * separate buckets while still grouping the same bill's minor month-to-month
 * fluctuations together.
 */
const CATEGORY_KEY_OVERRIDES = new Set([
  "housing",
  "utilities",
  "insurance",
  "debt",
]);

/**
 * Dollar-rounding applied when building the category+amount group key.
 * Tighter rounding keeps genuinely different bills in separate groups.
 */
const CATEGORY_AMOUNT_ROUNDING: Record<string, number> = {
  housing: 200, // mortgage/rent: round to nearest $200
  debt: 50, // loan/debt payments: round to nearest $50
  utilities: 10, // utility bills: round to nearest $10 (usage varies)
  insurance: 20, // insurance premiums: round to nearest $20 (adjustment cycles)
};

// ─── Grouping ────────────────────────────────────────────────────────────────

function groupTransactions(
  txns: TransactionLike[],
  asOfDate: string,
): MerchantGroup[] {
  const cutoff = lookbackCutoff(asOfDate);
  const map = new Map<string, TransactionLike[]>();
  for (const txn of txns) {
    if (txn.excludedFromAnalysis) continue;
    if (txn.flowType !== "outflow") continue;
    if (txn.date < cutoff) continue;

    let key: string;
    if (CATEGORY_KEY_OVERRIDES.has(txn.category)) {
      const amt = Math.abs(parseFloat(txn.amount) || 0);
      const rounding = CATEGORY_AMOUNT_ROUNDING[txn.category] ?? 200;
      const bucket = Math.round(amt / rounding) * rounding;
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
      const tolerance = getAmountTolerance(bucket.centroid, txn.category);
      if (Math.abs(amt - bucket.centroid) <= tolerance) {
        bucket.transactions.push(txn);
        bucket.centroid =
          bucket.transactions.reduce(
            (s, t) => s + Math.abs(parseFloat(t.amount)),
            0,
          ) / bucket.transactions.length;
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
  const variance =
    filtered.reduce((s, v) => s + (v - mean) ** 2, 0) / filtered.length;
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

  return {
    frequency: bestMatch.frequency,
    medianInterval: med,
    intervalStdDev: stdDev,
  };
}

function getMinTransactions(
  frequency: RecurringCandidate["frequency"],
  category: string,
  merchantKey: string,
  transactions: TransactionLike[],
): number {
  if (frequency === "annual") return 2;
  if (frequency === "quarterly") return 2;
  const hasTransactionEvidence = transactions.some(
    (transaction) =>
      transaction.recurrenceType === "recurring" &&
      ["hint", "manual"].includes(transaction.recurrenceSource ?? ""),
  );
  const hasStrongCategoryEvidence =
    VARIABLE_AMOUNT_CATEGORIES.has(category) ||
    SUBSCRIPTION_CATEGORIES.has(category) ||
    category === "fitness";
  const hasKnownSubscriptionBrand = SUBSCRIPTION_BRAND_FRAGMENTS.some(
    (fragment) => merchantKey.includes(fragment),
  );
  if (
    hasTransactionEvidence ||
    hasStrongCategoryEvidence ||
    hasKnownSubscriptionBrand
  ) {
    return 2;
  }
  return 3;
}

// ─── Confidence scoring ──────────────────────────────────────────────────────

function scoreConfidence(
  txns: TransactionLike[],
  freq: FrequencyResult,
  category: string,
  asOfDate: string,
): { score: number; amountScore: number; recencyScore: number } {
  const n = txns.length;

  // Count signal: plateaus at 6 occurrences
  const countScore = Math.min(1.0, (n - 2) / 4);

  // Interval regularity: coefficient of variation of intervals
  const cv =
    freq.medianInterval > 0 ? freq.intervalStdDev / freq.medianInterval : 0;
  const intervalScore = Math.max(0, 1.0 - cv * 2);

  // Amount consistency
  const amounts = txns.map((t) => Math.abs(parseFloat(t.amount)));
  const avgAmt = amounts.reduce((s, v) => s + v, 0) / amounts.length;
  const amtVariance =
    amounts.reduce((s, v) => s + (v - avgAmt) ** 2, 0) / amounts.length;
  const amtCv = avgAmt > 0 ? Math.sqrt(amtVariance) / avgAmt : 0;
  const amountScore = VARIABLE_AMOUNT_CATEGORIES.has(category)
    ? Math.max(0, 1.0 - amtCv * 2.0)
    : Math.max(0, 1.0 - amtCv * 3.33);

  // Recency: how long since the last charge vs expected interval
  const daysSinceLast = daysBetween(txns[txns.length - 1]!.date, asOfDate);
  const recencyRatio =
    freq.medianInterval > 0 ? daysSinceLast / freq.medianInterval : 0;
  let recencyScore: number;
  if (recencyRatio <= 1.5) recencyScore = 1.0;
  else if (recencyRatio >= 3.5) recencyScore = 0;
  else recencyScore = Math.max(0, 1.0 - (recencyRatio - 1.5) / 2.0);

  const raw =
    countScore * WEIGHTS.count +
    intervalScore * WEIGHTS.interval +
    amountScore * WEIGHTS.amount +
    recencyScore * WEIGHTS.recency;

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
  if (amountScore >= 0.9) parts.push("— consistent amount");
  else if (amountScore >= 0.6) parts.push("— minor amount variation");
  else parts.push("— variable amounts");
  if (!isActive) parts.push("· possibly cancelled");
  return parts.join(" ");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectRecurringCandidates(
  txns: TransactionLike[],
): RecurringCandidate[] {
  if (txns.length === 0) return [];

  const asOfDate = latestDatasetDate(txns);
  const candidates: RecurringCandidate[] = [];

  const groups = groupTransactions(txns, asOfDate);

  for (const group of groups) {
    const buckets = bucketByAmount(group.transactions).sort(
      (a, b) => b.centroid - a.centroid,
    );

    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
      const bucket = buckets[bucketIndex]!;
      const sorted = bucket.transactions.sort((a, b) =>
        a.date.localeCompare(b.date),
      );

      // ── Lifestyle category hard block ────────────────────────────────────
      // Use the most recent transaction's category as the representative.
      // Skip lifestyle categories UNLESS the merchant's canonical key exactly
      // matches a known recurring-subscription brand (meal-kits, etc.) that
      // happens to land in a lifestyle category. Exact key matching (Set.has)
      // avoids incidental substring false positives.
      const category = sorted[sorted.length - 1]!.category;
      if (LIFESTYLE_BLOCK_CATEGORIES.has(category)) {
        if (!LIFESTYLE_SUBSCRIPTION_EXCEPTION_KEYS.has(group.key)) continue;
      }

      const freq = detectFrequency(sorted);
      if (!freq) continue;

      const minTxns = getMinTransactions(
        freq.frequency,
        category,
        group.key,
        sorted,
      );
      if (sorted.length < minTxns) continue;

      // For annual, require the two charges to span at least 10 months
      if (freq.frequency === "annual" && sorted.length === 2) {
        const span = daysBetween(sorted[0]!.date, sorted[1]!.date);
        if (span < 300) continue;
      }

      const {
        score: confidence,
        amountScore,
        recencyScore,
      } = scoreConfidence(sorted, freq, category, asOfDate);
      if (confidence < CONFIDENCE_THRESHOLD) continue;

      // Suppress if low recency AND low confidence (stale cancelled subscriptions)
      if (recencyScore === 0 && confidence < 0.5) continue;

      const amounts = sorted.map((t) => Math.abs(parseFloat(t.amount)));
      const avgAmt = amounts.reduce((s, v) => s + v, 0) / amounts.length;
      const amtVariance =
        amounts.reduce((s, v) => s + (v - avgAmt) ** 2, 0) / amounts.length;
      const amtStdDev = Math.sqrt(amtVariance);

      const lastDate = sorted[sorted.length - 1]!.date;
      const nextDate = addDays(lastDate, Math.round(freq.medianInterval));
      const daysSinceExpected = daysBetween(nextDate, asOfDate);

      // Active = last charge was within 2 full median-intervals of the latest
      // imported transaction date. Dataset freshness is communicated separately.
      const isActive =
        daysBetween(lastDate, asOfDate) <= freq.medianInterval * 2;

      const monthlyEquivalent =
        Math.round(avgAmt * MONTHLY_FACTOR[freq.frequency] * 100) / 100;
      const annualEquivalent = Math.round(monthlyEquivalent * 12 * 100) / 100;

      const candidateKey = buildCandidateKey(group.key, bucketIndex);

      // For category-override groups (e.g. __housing_3400, __debt_300),
      // build a clean display name from the most common merchant name.
      let merchantDisplay: string;
      if (group.key.startsWith("__")) {
        const nameCounts = new Map<string, number>();
        for (const t of sorted) {
          const n = t.merchant.replace(/^[\s\-–—_*#]+/, "").trim();
          nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
        }
        merchantDisplay = [...nameCounts.entries()].sort(
          (a, b) => b[1] - a[1],
        )[0]![0];
      } else {
        merchantDisplay = sorted[sorted.length - 1]!.merchant;
      }

      // ── isSubscriptionLike signal ────────────────────────────────────────
      // Check NEVER_SUBSCRIPTION_FRAGMENTS against both the candidateKey and
      // the original merchant names. This is necessary because ACH/EFT prefix
      // stripping in recurrenceKey() destroys signals like "ach credit" from
      // the normalized key, and category-override keys like "__debt_50" contain
      // no merchant name information at all.
      const rawMerchantLower = sorted.map((t) => t.merchant.toLowerCase());
      const neverFragment = NEVER_SUBSCRIPTION_FRAGMENTS.some(
        (frag) =>
          candidateKey.includes(frag) ||
          rawMerchantLower.some((m) => m.includes(frag)),
      );
      const neverCategory = NEVER_SUBSCRIPTION_CATEGORIES.has(category);

      const roundedAvg = Math.round(avgAmt * 100) / 100;
      const centsStr = roundedAvg.toFixed(2).split(".")[1] ?? "";
      const isSaasPrice =
        !neverFragment &&
        !neverCategory &&
        (freq.frequency === "monthly" ||
          freq.frequency === "annual" ||
          freq.frequency === "quarterly") &&
        (centsStr === "99" || centsStr === "00" || centsStr === "49");
      const isSubscriptionLike =
        !neverFragment &&
        !neverCategory &&
        (SUBSCRIPTION_CATEGORIES.has(category) ||
          SUBSCRIPTION_BRAND_FRAGMENTS.some((frag) =>
            candidateKey.includes(frag),
          ) ||
          isSaasPrice);

      candidates.push({
        candidateKey,
        merchantKey: group.key,
        merchantDisplay,
        frequency: freq.frequency,
        averageAmount: roundedAvg,
        amountStdDev: Math.round(amtStdDev * 100) / 100,
        monthlyEquivalent,
        annualEquivalent,
        confidence,
        reasonFlagged: buildReasonFlagged(
          sorted.length,
          avgAmt,
          freq.frequency,
          amountScore,
          isActive,
        ),
        transactionIds: sorted.map((t) => t.id),
        firstSeen: sorted[0]!.date,
        lastSeen: lastDate,
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
