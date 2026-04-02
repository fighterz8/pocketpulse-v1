/**
 * Recurring transaction detection engine.
 *
 * Groups outflow transactions by normalized merchant key, sub-groups by
 * amount bucket, detects frequency via median interval matching, and
 * scores confidence from four weighted signals: interval regularity,
 * amount consistency, transaction count, and recency.
 */

export type RecurringCandidate = {
  candidateKey: string;
  merchantKey: string;
  merchantDisplay: string;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  averageAmount: number;
  amountStdDev: number;
  confidence: number;
  reasonFlagged: string;
  transactionIds: number[];
  firstSeen: string;
  lastSeen: string;
  expectedNextDate: string;
  category: string;
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
  { frequency: "weekly", expectedDays: 7, toleranceDays: 2 },
  { frequency: "biweekly", expectedDays: 14, toleranceDays: 3 },
  { frequency: "monthly", expectedDays: 30.4, toleranceDays: 5 },
  { frequency: "quarterly", expectedDays: 91.3, toleranceDays: 15 },
  { frequency: "annual", expectedDays: 365, toleranceDays: 30 },
];

const AMOUNT_TOLERANCE_PERCENT = 0.25;
const AMOUNT_TOLERANCE_FLOOR = 2.0;
const CONFIDENCE_THRESHOLD = 0.35;
const VARIABLE_AMOUNT_CATEGORIES = ["utilities", "insurance", "health"];

const WEIGHTS = {
  interval: 0.35,
  amount: 0.25,
  count: 0.20,
  recency: 0.20,
};

export function recurrenceKey(merchant: string): string {
  let key = merchant.toLowerCase().trim();
  key = key.replace(/^(sq\s*\*|tst\s*\*|sp\s*\*|pos\s*)\s*/i, "");
  key = key.replace(/\s*[#*]\s*\d+\s*$/, "");
  key = key.replace(/\s+/g, " ").trim();
  return key;
}

export function buildCandidateKey(merchantKey: string, avgAmount: number): string {
  return `${merchantKey}|${avgAmount.toFixed(2)}`;
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 86_400_000;
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / msPerDay,
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

function groupTransactions(txns: TransactionLike[]): MerchantGroup[] {
  const map = new Map<string, TransactionLike[]>();
  for (const txn of txns) {
    if (txn.excludedFromAnalysis) continue;
    if (txn.flowType === "inflow") continue;
    const key = recurrenceKey(txn.merchant);
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
    if (isNaN(amt)) continue;
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

function detectFrequency(txns: TransactionLike[]): FrequencyResult | null {
  if (txns.length < 2) return null;

  const intervals: number[] = [];
  for (let i = 1; i < txns.length; i++) {
    intervals.push(daysBetween(txns[i - 1]!.date, txns[i]!.date));
  }

  const med = median(intervals);

  const filtered = intervals.filter((iv) => iv <= med * 2.5);
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

  return {
    frequency: bestMatch.frequency,
    medianInterval: med,
    intervalStdDev: stdDev,
  };
}

function getMinTransactions(frequency: RecurringCandidate["frequency"]): number {
  return frequency === "annual" ? 2 : 3;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function scoreConfidence(
  txns: TransactionLike[],
  freq: FrequencyResult,
  category: string,
): number {
  const n = txns.length;

  const countScore = Math.min(1.0, (n - 2) / 4);

  const cv = freq.medianInterval > 0 ? freq.intervalStdDev / freq.medianInterval : 0;
  const intervalScore = Math.max(0, 1.0 - cv * 2);

  const amounts = txns.map((t) => Math.abs(parseFloat(t.amount)));
  const avgAmt = amounts.reduce((s, v) => s + v, 0) / amounts.length;
  const amtVariance = amounts.reduce((s, v) => s + (v - avgAmt) ** 2, 0) / amounts.length;
  const amtCv = avgAmt > 0 ? Math.sqrt(amtVariance) / avgAmt : 0;

  let amountScore: number;
  if (VARIABLE_AMOUNT_CATEGORIES.includes(category)) {
    amountScore = Math.max(0, 1.0 - amtCv * 2.0);
  } else {
    amountScore = Math.max(0, 1.0 - amtCv * 3.33);
  }

  const daysSinceLast = daysBetween(txns[txns.length - 1]!.date, todayISO());
  const recencyRatio = freq.medianInterval > 0 ? daysSinceLast / freq.medianInterval : 0;
  let recencyScore: number;
  if (recencyRatio <= 1.5) {
    recencyScore = 1.0;
  } else if (recencyRatio >= 3.0) {
    recencyScore = 0;
  } else {
    recencyScore = Math.max(0, 1.0 - (recencyRatio - 1.5) / 1.5);
  }

  const raw =
    countScore * WEIGHTS.count +
    intervalScore * WEIGHTS.interval +
    amountScore * WEIGHTS.amount +
    recencyScore * WEIGHTS.recency;

  return Math.round(raw * 100) / 100;
}

function buildReasonFlagged(
  txnCount: number,
  avgAmount: number,
  frequency: string,
  amountScore: number,
): string {
  const parts: string[] = [];

  parts.push(
    `${txnCount} charges of ~$${avgAmount.toFixed(2)} detected ${frequency}`,
  );

  if (amountScore >= 0.9) {
    parts.push("at a consistent amount");
  } else if (amountScore >= 0.6) {
    parts.push("with minor amount variation");
  } else {
    parts.push("with variable amounts");
  }

  return parts.join(" ");
}

export function detectRecurringCandidates(txns: TransactionLike[]): RecurringCandidate[] {
  if (txns.length === 0) return [];

  const candidates: RecurringCandidate[] = [];
  const groups = groupTransactions(txns);

  for (const group of groups) {
    const buckets = bucketByAmount(group.transactions);

    for (const bucket of buckets) {
      const sorted = bucket.transactions.sort((a, b) => a.date.localeCompare(b.date));

      const freq = detectFrequency(sorted);
      if (!freq) continue;

      const minTxns = getMinTransactions(freq.frequency);
      if (sorted.length < minTxns) continue;

      if (freq.frequency === "annual" && sorted.length === 2) {
        const span = daysBetween(sorted[0]!.date, sorted[1]!.date);
        if (span < 330) continue;
      }

      const category = sorted[sorted.length - 1]!.category;
      const confidence = scoreConfidence(sorted, freq, category);
      if (confidence < CONFIDENCE_THRESHOLD) continue;

      const amounts = sorted.map((t) => Math.abs(parseFloat(t.amount)));
      const avgAmt = amounts.reduce((s, v) => s + v, 0) / amounts.length;
      const amtVariance = amounts.reduce((s, v) => s + (v - avgAmt) ** 2, 0) / amounts.length;
      const amtStdDev = Math.sqrt(amtVariance);
      const amtCv = avgAmt > 0 ? amtStdDev / avgAmt : 0;

      let amountScore: number;
      if (VARIABLE_AMOUNT_CATEGORIES.includes(category)) {
        amountScore = Math.max(0, 1.0 - amtCv * 2.0);
      } else {
        amountScore = Math.max(0, 1.0 - amtCv * 3.33);
      }

      const lastDate = sorted[sorted.length - 1]!.date;
      const nextDate = addDays(lastDate, Math.round(freq.medianInterval));

      const candidateKey = buildCandidateKey(group.key, avgAmt);

      candidates.push({
        candidateKey,
        merchantKey: group.key,
        merchantDisplay: sorted[sorted.length - 1]!.merchant,
        frequency: freq.frequency,
        averageAmount: Math.round(avgAmt * 100) / 100,
        amountStdDev: Math.round(amtStdDev * 100) / 100,
        confidence,
        reasonFlagged: buildReasonFlagged(sorted.length, avgAmt, freq.frequency, amountScore),
        transactionIds: sorted.map((t) => t.id),
        firstSeen: sorted[0]!.date,
        lastSeen: lastDate,
        expectedNextDate: nextDate,
        category,
      });
    }
  }

  return candidates.sort((a, b) =>
    b.confidence - a.confidence || b.averageAmount - a.averageAmount,
  );
}
