export type DateRangePreset =
  | "last30"
  | "last60"
  | "last90"
  | "thisMonth"
  | "lastMonth"
  | "quarterToDate"
  | "yearToDate"
  | "custom"
  | "year";

export interface DateRangeInput {
  days?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  preset?: unknown;
  year?: unknown;
}

export interface ResolvedDateRange {
  preset: DateRangePreset;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  rangeDays: number;
  label: string;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date: Date): Date {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function addDays(date: Date, days: number): Date {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function startOfQuarter(date: Date): Date {
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), quarterMonth, 1));
}

function startOfYear(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function differenceInDays(startDate: Date, endDate: Date): number {
  return Math.max(1, Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1);
}

function buildRange(preset: DateRangePreset, startDate: Date, endDate: Date, label: string): ResolvedDateRange {
  const normalizedStart = startOfDay(startDate);
  const normalizedEnd = startOfDay(endDate);
  const rangeDays = differenceInDays(normalizedStart, normalizedEnd);
  const previousEnd = addDays(normalizedStart, -1);
  const previousStart = addDays(previousEnd, -(rangeDays - 1));

  return {
    preset,
    startDate: toIsoDate(normalizedStart),
    endDate: toIsoDate(normalizedEnd),
    previousStartDate: toIsoDate(previousStart),
    previousEndDate: toIsoDate(previousEnd),
    rangeDays,
    label,
  };
}

export function resolveDateRange(input: DateRangeInput = {}): ResolvedDateRange {
  const today = startOfDay(new Date());
  const preset = typeof input.preset === "string" ? input.preset : undefined;
  const requestedYear = parseInt(String(input.year ?? ""), 10);

  if (preset === "custom") {
    const startDate = parseDate(input.startDate);
    const endDate = parseDate(input.endDate);
    if (startDate && endDate && startDate <= endDate) {
      return buildRange("custom", startDate, endDate, `${toIsoDate(startDate)} to ${toIsoDate(endDate)}`);
    }
  }

  if (preset === "year" && Number.isFinite(requestedYear)) {
    const yearStart = new Date(Date.UTC(requestedYear, 0, 1));
    const yearEnd = new Date(Date.UTC(requestedYear, 11, 31));
    return buildRange("year", yearStart, yearEnd, `${requestedYear}`);
  }

  switch (preset) {
    case "thisMonth":
      return buildRange("thisMonth", startOfMonth(today), today, "This month");
    case "lastMonth": {
      const currentMonthStart = startOfMonth(today);
      const previousMonthEnd = addDays(currentMonthStart, -1);
      return buildRange("lastMonth", startOfMonth(previousMonthEnd), endOfMonth(previousMonthEnd), "Last month");
    }
    case "quarterToDate":
      return buildRange("quarterToDate", startOfQuarter(today), today, "Quarter to date");
    case "yearToDate":
      return buildRange("yearToDate", startOfYear(today), today, "Year to date");
  }

  const customStartDate = parseDate(input.startDate);
  const customEndDate = parseDate(input.endDate);
  if (customStartDate && customEndDate && customStartDate <= customEndDate) {
    return buildRange("custom", customStartDate, customEndDate, `${toIsoDate(customStartDate)} to ${toIsoDate(customEndDate)}`);
  }

  const days = parseInt(String(input.days ?? ""), 10);
  const normalizedDays = [30, 60, 90].includes(days) ? days : 90;
  const startDate = addDays(today, -(normalizedDays - 1));
  return buildRange(`last${normalizedDays}` as DateRangePreset, startDate, today, `Last ${normalizedDays} days`);
}
