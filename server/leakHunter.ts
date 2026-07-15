import { detectLeaks } from "./cashflow.js";
import { recurrenceKey } from "./recurrenceDetector.js";
import { LEAK_EXCLUDED_CATEGORIES } from "../shared/schema.js";

export type LeakHunterCoverageQuality =
  | "empty"
  | "limited"
  | "partial"
  | "useful"
  | "strong";

export type LeakHunterFreshness = "current" | "slightly_stale" | "stale";

export type LeakHunterCoverage = {
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  totalTransactions: number;
  accountCount: number;
  coverageDays: number;
  coverageQuality: LeakHunterCoverageQuality;
  freshness: LeakHunterFreshness;
  limitations: string[];
};

export type LeakHunterFinding = {
  id: string;
  merchantKey: string;
  merchant: string;
  status:
    | "active"
    | "possibly_active"
    | "overdue"
    | "inactive"
    | "historical"
    | "insufficient_history";
  kind: "subscription" | "bill" | "habit" | "price_creep" | "unknown";
  firstSeen: string;
  lastSeen: string;
  expectedNextDate?: string;
  cadence?: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  occurrences: number;
  averageAmount: number;
  latestAmount: number;
  monthlyEquivalent: number;
  historicalTotal: number;
  priceChangePct?: number;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  ledgerQuery: Record<string, string>;
};

export type LeakHunterReport = {
  coverage: LeakHunterCoverage;
  summary: {
    activeCount: number;
    inactiveCount: number;
    priceCreepCount: number;
    recentHabitCount: number;
    estimatedActiveMonthly: number;
    estimatedHistoricalTotal: number;
  };
  sections: {
    activeLeaks: LeakHunterFinding[];
    stoppedLeaks: LeakHunterFinding[];
    priceCreep: LeakHunterFinding[];
    recentHabits: LeakHunterFinding[];
    needsReview: LeakHunterFinding[];
  };
};

export type CoverageTransaction = {
  date: string;
  accountId?: number | null;
};

export type LeakHunterTransaction = CoverageTransaction & {
  id?: number;
  amount?: string | number | null;
  merchant?: string | null;
  flowType?: string | null;
  transactionClass?: string | null;
  recurrenceType?: string | null;
  category?: string | null;
  excludedFromAnalysis?: boolean | null;
};

type Cadence = NonNullable<LeakHunterFinding["cadence"]>;

type RecurringGroup = {
  merchantKey: string;
  merchant: string;
  transactions: NormalizedLeakTransaction[];
};

type NormalizedLeakTransaction = {
  id: number;
  date: string;
  amount: number;
  merchant: string;
  merchantKey: string;
  category: string;
  recurrenceType: string;
};

type RecentHabitLeakItem = ReturnType<typeof detectLeaks>[number];

const CADENCE_MONTHLY_FACTOR: Record<Cadence, number> = {
  weekly: 4.333,
  biweekly: 2.167,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

const CADENCE_TARGET_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  annual: 365,
};

const RECURRING_FRIENDLY_CATEGORIES = new Set([
  "software",
  "entertainment",
  "utilities",
  "insurance",
  "medical",
  "housing",
  "debt",
  "fitness",
  "education",
]);

const LIFESTYLE_CATEGORIES = new Set([
  "dining",
  "coffee",
  "delivery",
  "convenience",
  "shopping",
]);

const ACTIONABLE_SUBSCRIPTION_CATEGORIES = new Set([
  "software",
  "entertainment",
  "fitness",
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function toUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function daysBetweenInclusive(startDate: string, endDate: string): number {
  const start = toUtcDate(startDate).getTime();
  const end = toUtcDate(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0;
  }
  return Math.floor((end - start) / 86_400_000) + 1;
}

function daysBetween(startDate: string, endDate: string): number {
  const start = toUtcDate(startDate).getTime();
  const end = toUtcDate(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function addDays(date: string, days: number): string {
  const next = toUtcDate(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function coverageQualityForDays(days: number): LeakHunterCoverageQuality {
  if (days <= 0) return "empty";
  if (days < 45) return "limited";
  if (days < 90) return "partial";
  if (days < 180) return "useful";
  return "strong";
}

export function freshnessForCoverageEnd(
  coverageEnd: string | null,
  today: string,
): LeakHunterFreshness {
  if (!coverageEnd) return "stale";
  const ageDays = daysBetween(coverageEnd, today);
  if (ageDays <= 14) return "current";
  if (ageDays <= 45) return "slightly_stale";
  return "stale";
}

export function buildCoverageMetadata(
  transactions: LeakHunterTransaction[],
  options: {
    asOfDate?: string;
    today?: string;
    selectedAccountId?: number;
  } = {},
): LeakHunterCoverage {
  const dates = transactions
    .map((txn) => txn.date)
    .filter(isValidIsoDate)
    .sort();
  const startDate = dates[0] ?? null;
  const endDate = dates[dates.length - 1] ?? null;
  const asOfDate =
    options.asOfDate && isValidIsoDate(options.asOfDate)
      ? options.asOfDate
      : endDate;
  const today =
    options.today && isValidIsoDate(options.today)
      ? options.today
      : new Date().toISOString().slice(0, 10);
  const accountIds = new Set(
    transactions
      .map((txn) => txn.accountId)
      .filter((id): id is number => typeof id === "number"),
  );
  const coverageDays =
    startDate && endDate ? daysBetweenInclusive(startDate, endDate) : 0;
  const limitations: string[] = [];

  if (transactions.length === 0) {
    limitations.push("Upload transaction history before running a leak hunt.");
  } else if (options.selectedAccountId !== undefined) {
    limitations.push("This only reflects the selected account.");
  } else if (accountIds.size === 1) {
    limitations.push("This only reflects one imported account.");
  }

  if (coverageDays > 0 && coverageDays < 90) {
    limitations.push(
      "Less than 90 days of history can miss monthly subscriptions and stopped leaks.",
    );
  }

  return {
    startDate,
    endDate,
    asOfDate,
    totalTransactions: transactions.length,
    accountCount: accountIds.size,
    coverageDays,
    coverageQuality: coverageQualityForDays(coverageDays),
    freshness: freshnessForCoverageEnd(endDate, today),
    limitations,
  };
}

function normalizeLeakTransactions(
  transactions: LeakHunterTransaction[],
): NormalizedLeakTransaction[] {
  return transactions.flatMap((txn, index) => {
    if (!isValidIsoDate(txn.date) || txn.excludedFromAnalysis) return [];
    const merchant = (txn.merchant ?? "").trim();
    if (!merchant) return [];
    const amount = Math.abs(Number(txn.amount));
    if (!Number.isFinite(amount) || amount <= 0) return [];
    const category = txn.category ?? "other";
    if (LEAK_EXCLUDED_CATEGORIES.has(category)) return [];
    const isExpense =
      txn.flowType === "outflow" ||
      txn.transactionClass === "expense" ||
      Number(txn.amount) < 0;
    if (!isExpense) return [];
    const merchantKey = recurrenceKey(merchant);
    if (!merchantKey) return [];

    return [
      {
        id: typeof txn.id === "number" ? txn.id : index + 1,
        date: txn.date,
        amount,
        merchant,
        merchantKey,
        category,
        recurrenceType: txn.recurrenceType ?? "one-time",
      },
    ];
  });
}

function groupByMerchant(
  transactions: NormalizedLeakTransaction[],
): RecurringGroup[] {
  const groups = new Map<string, NormalizedLeakTransaction[]>();
  for (const txn of transactions) {
    const group = groups.get(txn.merchantKey) ?? [];
    group.push(txn);
    groups.set(txn.merchantKey, group);
  }

  return [...groups.entries()].map(([merchantKey, txns]) => {
    const sorted = txns.sort((a, b) => a.date.localeCompare(b.date));
    return {
      merchantKey,
      merchant: sorted[sorted.length - 1]!.merchant,
      transactions: sorted,
    };
  });
}

function detectCadence(intervalDays: number): Cadence | null {
  const matches: Array<{ cadence: Cadence; diff: number }> = (
    Object.keys(CADENCE_TARGET_DAYS) as Cadence[]
  ).map((cadence) => ({
    cadence,
    diff: Math.abs(intervalDays - CADENCE_TARGET_DAYS[cadence]),
  }));
  const best = matches.sort((a, b) => a.diff - b.diff)[0]!;
  const tolerance = best.cadence === "annual" ? 45 : best.cadence === "quarterly" ? 21 : 7;
  return best.diff <= tolerance ? best.cadence : null;
}

function lifecycleStatus(
  cadence: Cadence,
  medianInterval: number,
  expectedNextDate: string,
  lastSeen: string,
  asOfDate: string,
  coverageDays: number,
): LeakHunterFinding["status"] {
  if (coverageDays < 45) return "insufficient_history";

  const overdueDays = daysBetween(expectedNextDate, asOfDate);
  if (overdueDays <= 0) return "active";
  if (overdueDays <= Math.max(7, medianInterval * 0.35)) {
    return "possibly_active";
  }

  const inactiveAfter =
    cadence === "monthly"
      ? Math.max(medianInterval * 2, 45)
      : cadence === "quarterly"
        ? medianInterval * 1.75
        : cadence === "annual"
          ? 90
          : medianInterval * 2.5;

  if (overdueDays < inactiveAfter) return "overdue";
  return daysBetween(lastSeen, asOfDate) >= 180 ? "historical" : "inactive";
}

function confidenceFor(
  occurrences: number,
  cadence: Cadence,
  status: LeakHunterFinding["status"],
): LeakHunterFinding["confidence"] {
  if (status === "insufficient_history") return "low";
  if (occurrences >= 5 || (cadence === "annual" && occurrences >= 3)) return "high";
  if (occurrences >= 3 || cadence === "annual") return "medium";
  return "low";
}

function kindFor(group: RecurringGroup): LeakHunterFinding["kind"] {
  const category = group.transactions[group.transactions.length - 1]!.category;
  if (category === "utilities" || category === "insurance" || category === "housing" || category === "debt") {
    return "bill";
  }
  if (ACTIONABLE_SUBSCRIPTION_CATEGORIES.has(category)) {
    return "subscription";
  }
  return "unknown";
}

function isActionableRecurringLeak(finding: LeakHunterFinding): boolean {
  return (
    finding.kind === "subscription" &&
    finding.confidence !== "low" &&
    finding.status !== "insufficient_history"
  );
}

function shouldConsiderRecurring(group: RecurringGroup): boolean {
  const latest = group.transactions[group.transactions.length - 1]!;
  if (latest.recurrenceType === "recurring") return true;
  if (RECURRING_FRIENDLY_CATEGORIES.has(latest.category)) return true;
  return !LIFESTYLE_CATEGORIES.has(latest.category);
}

function buildFinding(
  group: RecurringGroup,
  options: { asOfDate: string; coverageDays: number },
): LeakHunterFinding | null {
  if (group.transactions.length < 2 || !shouldConsiderRecurring(group)) return null;

  const intervals = group.transactions
    .slice(1)
    .map((txn, index) => daysBetween(group.transactions[index]!.date, txn.date))
    .filter((days) => days > 0);
  const medianInterval = median(intervals);
  const cadence = detectCadence(medianInterval);
  if (!cadence) return null;

  if (cadence === "annual" && group.transactions.length < 2) return null;
  if (cadence !== "annual" && group.transactions.length < 3) return null;

  const amounts = group.transactions.map((txn) => txn.amount);
  const averageAmount = roundMoney(
    amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length,
  );
  const latest = group.transactions[group.transactions.length - 1]!;
  const first = group.transactions[0]!;
  const expectedNextDate = addDays(latest.date, Math.round(medianInterval));
  const status = lifecycleStatus(
    cadence,
    medianInterval,
    expectedNextDate,
    latest.date,
    options.asOfDate,
    options.coverageDays,
  );
  const monthlyEquivalent = roundMoney(
    averageAmount * CADENCE_MONTHLY_FACTOR[cadence],
  );
  const historicalTotal = roundMoney(
    amounts.reduce((sum, amount) => sum + amount, 0),
  );
  const priceChangePct =
    first.amount > 0
      ? Math.round(((latest.amount - first.amount) / first.amount) * 100)
      : undefined;

  const evidence = [
    `Seen ${group.transactions.length} times from ${first.date} to ${latest.date}.`,
    `Cadence looks ${cadence}; expected again around ${expectedNextDate}.`,
  ];
  if (priceChangePct !== undefined && priceChangePct >= 20) {
    evidence.push(
      `Latest charge is ${priceChangePct}% higher than the first observed charge.`,
    );
  }

  return {
    id: `${group.merchantKey}:${cadence}:${first.date}:${latest.date}`,
    merchantKey: group.merchantKey,
    merchant: group.merchant,
    status,
    kind: kindFor(group),
    firstSeen: first.date,
    lastSeen: latest.date,
    expectedNextDate,
    cadence,
    occurrences: group.transactions.length,
    averageAmount,
    latestAmount: roundMoney(latest.amount),
    monthlyEquivalent,
    historicalTotal,
    priceChangePct,
    confidence: confidenceFor(group.transactions.length, cadence, status),
    evidence,
    ledgerQuery: {
      merchant: group.merchantKey,
      startDate: first.date,
      endDate: latest.date,
    },
  };
}

function transactionsInWindow(
  transactions: LeakHunterTransaction[],
  options: { endDate: string; rangeDays: number },
): LeakHunterTransaction[] {
  const startDate = addDays(options.endDate, -(options.rangeDays - 1));
  return transactions.filter(
    (txn) =>
      isValidIsoDate(txn.date) &&
      txn.date >= startDate &&
      txn.date <= options.endDate,
  );
}

function transactionsOnOrBefore(
  transactions: LeakHunterTransaction[],
  asOfDate: string | null,
): LeakHunterTransaction[] {
  if (!asOfDate) return transactions;
  return transactions.filter(
    (txn) => !isValidIsoDate(txn.date) || txn.date <= asOfDate,
  );
}

function mapRecentHabitFinding(leak: RecentHabitLeakItem): LeakHunterFinding {
  const dailyEvidence =
    leak.dailyAverage !== undefined
      ? `Averages about ${roundMoney(leak.dailyAverage)} per day in the recent window.`
      : `Averages about ${roundMoney(leak.monthlyAmount)} per month in the recent window.`;

  return {
    id: `habit:${leak.merchantKey}:${leak.firstDate}:${leak.lastDate}`,
    merchantKey: leak.merchantKey,
    merchant: leak.merchant,
    status: "active",
    kind: "habit",
    firstSeen: leak.firstDate,
    lastSeen: leak.lastDate,
    occurrences: leak.occurrences,
    averageAmount: leak.averageAmount,
    latestAmount: leak.averageAmount,
    monthlyEquivalent: leak.monthlyAmount,
    historicalTotal: leak.recentSpend,
    confidence:
      leak.confidence === "High"
        ? "high"
        : leak.confidence === "Medium"
          ? "medium"
          : "low",
    evidence: [
      leak.label,
      `Seen ${leak.occurrences} times from ${leak.firstDate} to ${leak.lastDate}.`,
      dailyEvidence,
    ],
    ledgerQuery: {
      merchant: leak.merchantFilter,
      startDate: leak.firstDate,
      endDate: leak.lastDate,
    },
  };
}

export function detectRecentHabitFindings(
  transactions: LeakHunterTransaction[],
  options: {
    asOfDate?: string;
    rangeDays?: number;
    recurringMerchantKeys?: ReadonlySet<string>;
  } = {},
): LeakHunterFinding[] {
  const coverage = buildCoverageMetadata(transactions, {
    asOfDate: options.asOfDate,
  });
  const asOfDate = options.asOfDate ?? coverage.asOfDate;
  if (!asOfDate) return [];

  const rangeDays = options.rangeDays ?? Math.min(90, Math.max(1, coverage.coverageDays));
  const windowTransactions = transactionsInWindow(transactions, {
    endDate: asOfDate,
    rangeDays,
  });
  const leakRows = windowTransactions.map((txn) => ({
    transactionClass: txn.transactionClass ?? "expense",
    category: txn.category ?? "other",
    merchant: txn.merchant ?? "",
    amount: txn.amount ?? "0",
    date: txn.date,
    recurrenceType: txn.recurrenceType ?? "one-time",
    recurrenceSource: "none",
    excludedFromAnalysis: txn.excludedFromAnalysis,
  }));

  return detectLeaks(leakRows, {
    rangeDays,
    recurringMerchantKeys: options.recurringMerchantKeys,
  }).map(mapRecentHabitFinding);
}

export function detectRecurringLifecycleFindings(
  transactions: LeakHunterTransaction[],
  options: { asOfDate?: string; coverageDays?: number } = {},
): LeakHunterFinding[] {
  const coverage = buildCoverageMetadata(transactions, {
    asOfDate: options.asOfDate,
  });
  const asOfDate = options.asOfDate ?? coverage.asOfDate;
  if (!asOfDate) return [];

  return groupByMerchant(normalizeLeakTransactions(transactions))
    .map((group) =>
      buildFinding(group, {
        asOfDate,
        coverageDays: options.coverageDays ?? coverage.coverageDays,
      }),
    )
    .filter((finding): finding is LeakHunterFinding => finding !== null)
    .sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}

export function buildLeakHunterReport(
  transactions: LeakHunterTransaction[],
  options: {
    asOfDate?: string;
    today?: string;
    selectedAccountId?: number;
  } = {},
): LeakHunterReport {
  const coverage = buildCoverageMetadata(transactions, options);
  const analysisTransactions = transactionsOnOrBefore(transactions, coverage.asOfDate);
  const analysisCoverage = buildCoverageMetadata(analysisTransactions, {
    ...options,
    asOfDate: coverage.asOfDate ?? undefined,
  });
  const recurringFindings = detectRecurringLifecycleFindings(analysisTransactions, {
    asOfDate: coverage.asOfDate ?? undefined,
    coverageDays: analysisCoverage.coverageDays,
  });
  const actionableRecurringFindings = recurringFindings.filter(
    isActionableRecurringLeak,
  );
  const activeLeaks = actionableRecurringFindings.filter((finding) =>
    ["active", "possibly_active", "overdue"].includes(finding.status),
  );
  const stoppedLeaks = actionableRecurringFindings.filter((finding) =>
    ["inactive", "historical"].includes(finding.status),
  );
  const activeRecurringKeys = new Set(
    recurringFindings
      .filter((finding) =>
        ["active", "possibly_active", "overdue"].includes(finding.status),
      )
      .map((finding) => finding.merchantKey),
  );
  const priceCreep = actionableRecurringFindings
    .filter(
      (finding) =>
        finding.priceChangePct !== undefined &&
        finding.priceChangePct >= 20 &&
        finding.latestAmount - finding.averageAmount >= 2,
    )
    .map((finding) => ({ ...finding, kind: "price_creep" as const }));
  const needsReview = recurringFindings.filter(
    (finding) => {
      const isCurrentUncertainty = [
        "active",
        "possibly_active",
        "overdue",
        "insufficient_history",
      ].includes(finding.status);
      if (finding.kind === "unknown") return isCurrentUncertainty;
      return (
        finding.kind === "subscription" &&
        (finding.status === "insufficient_history" || finding.confidence === "low")
      );
    },
  );
  const recentHabits = detectRecentHabitFindings(analysisTransactions, {
    asOfDate: coverage.asOfDate ?? undefined,
    rangeDays: 90,
    recurringMerchantKeys: activeRecurringKeys,
  });

  return {
    coverage,
    summary: {
      activeCount: activeLeaks.length,
      inactiveCount: stoppedLeaks.length,
      priceCreepCount: priceCreep.length,
      recentHabitCount: recentHabits.length,
      estimatedActiveMonthly: roundMoney(
        activeLeaks.reduce((sum, finding) => sum + finding.monthlyEquivalent, 0),
      ),
      estimatedHistoricalTotal: roundMoney(
        stoppedLeaks.reduce((sum, finding) => sum + finding.historicalTotal, 0),
      ),
    },
    sections: {
      activeLeaks,
      stoppedLeaks,
      priceCreep,
      recentHabits,
      needsReview,
    },
  };
}
