import type { FlowType, RecurrenceType } from "@shared/schema";

const MIN_MONTHLY_GAP_DAYS = 25;
const MAX_MONTHLY_GAP_DAYS = 40;
const MIN_MONTHLY_OCCURRENCES = 3;

export interface RecurrenceCandidate {
  merchant: string;
  date: string;
  amount: string | number;
  flowType: FlowType;
  recurrenceType: RecurrenceType;
  userCorrected?: boolean;
  labelReason?: string | null;
}

export interface RecurrencePatternMatch {
  matchedIndexes: Set<number>;
  reasonByIndex: Map<number, string>;
}

function normalizeMerchant(merchant: string): string {
  return merchant
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeAmountToCents(amount: string | number): number {
  const parsed = typeof amount === "number" ? amount : parseFloat(amount);
  return Math.round(Math.abs(parsed) * 100);
}

function diffInDays(left: string, right: string): number {
  const leftDate = new Date(`${left}T00:00:00Z`);
  const rightDate = new Date(`${right}T00:00:00Z`);
  return Math.round((rightDate.getTime() - leftDate.getTime()) / (1000 * 60 * 60 * 24));
}

function isMonthlyGap(days: number): boolean {
  return days >= MIN_MONTHLY_GAP_DAYS && days <= MAX_MONTHLY_GAP_DAYS;
}

export function detectMonthlyRecurringPatterns(candidates: RecurrenceCandidate[]): RecurrencePatternMatch {
  const groups = new Map<string, Array<{ index: number; candidate: RecurrenceCandidate }>>();

  candidates.forEach((candidate, index) => {
    if (candidate.userCorrected) {
      return;
    }

    const key = [
      normalizeMerchant(candidate.merchant),
      candidate.flowType,
      normalizeAmountToCents(candidate.amount),
    ].join("::");

    const existing = groups.get(key) ?? [];
    existing.push({ index, candidate });
    groups.set(key, existing);
  });

  const matchedIndexes = new Set<number>();
  const reasonByIndex = new Map<number, string>();

  for (const group of Array.from(groups.values())) {
    if (group.length < MIN_MONTHLY_OCCURRENCES) {
      continue;
    }

    const sorted = [...group].sort((left, right) => left.candidate.date.localeCompare(right.candidate.date));
    let streakStart = 0;

    for (let current = 1; current <= sorted.length; current += 1) {
      const hasNext = current < sorted.length;
      const gapDays = hasNext
        ? diffInDays(sorted[current - 1].candidate.date, sorted[current].candidate.date)
        : undefined;

      if (hasNext && gapDays !== undefined && isMonthlyGap(gapDays)) {
        continue;
      }

      const streak = sorted.slice(streakStart, current);
      if (streak.length >= MIN_MONTHLY_OCCURRENCES) {
        const cadenceDays = streak
          .slice(1)
          .map((entry, entryIndex) => diffInDays(streak[entryIndex].candidate.date, entry.candidate.date));
        const cadenceSummary = `${Math.min(...cadenceDays)}-${Math.max(...cadenceDays)} days apart`;
        const reason = `Detected monthly duplicate pattern: ${streak.length} charges, ${cadenceSummary}`;

        for (const entry of streak) {
          matchedIndexes.add(entry.index);
          reasonByIndex.set(entry.index, reason);
        }
      }

      streakStart = current;
    }
  }

  return { matchedIndexes, reasonByIndex };
}
