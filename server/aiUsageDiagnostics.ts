import type { AiOperation } from "../shared/schema.js";
import type { AiUsageSummaryFilters } from "./aiUsageQueries.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_REPORT_WINDOW_MS = 366 * DAY_MS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OPERATIONS = new Set<AiOperation>([
  "transaction_classification",
  "csv_format_detection",
]);

export type AiUsageReportFilterInput = Record<string, unknown>;

function singleString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RangeError(`${field} must be provided once as a string`);
  }
  return value;
}

function parseDate(value: unknown, field: "from" | "to"): Date | undefined {
  const raw = singleString(value, field);
  if (raw === undefined) return undefined;
  if (!ISO_DATE.test(raw) && !ISO_TIMESTAMP.test(raw)) {
    throw new RangeError(`${field} must be an ISO UTC date or timestamp`);
  }
  const date = new Date(ISO_DATE.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  const calendarDateMatches =
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw.slice(0, 10);
  if (!calendarDateMatches) {
    throw new RangeError(`${field} must be a valid ISO UTC date or timestamp`);
  }
  return date;
}

function parseId(value: unknown, field: "userId" | "accountId"): number | undefined {
  const raw = singleString(value, field);
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return id;
}

function parseOperation(value: unknown): AiOperation | undefined {
  const raw = singleString(value, "operation");
  if (raw === undefined) return undefined;
  if (!OPERATIONS.has(raw as AiOperation)) {
    throw new RangeError("operation is not supported");
  }
  return raw as AiOperation;
}

export function parseAiUsageReportFilters(
  input: AiUsageReportFilterInput,
  now = new Date(),
): AiUsageSummaryFilters {
  if (Number.isNaN(now.getTime())) throw new RangeError("now must be a valid Date");
  const to = parseDate(input.to, "to") ?? new Date(now);
  const from = parseDate(input.from, "from") ?? new Date(to.getTime() - 30 * DAY_MS);
  if (from.getTime() >= to.getTime()) {
    throw new RangeError("from must be before to");
  }
  if (to.getTime() - from.getTime() > MAX_REPORT_WINDOW_MS) {
    throw new RangeError("AI usage reports are limited to 366 days");
  }
  return {
    from,
    to,
    userId: parseId(input.userId, "userId"),
    accountId: parseId(input.accountId, "accountId"),
    operation: parseOperation(input.operation),
  };
}

const CLI_OPTIONS = new Set(["from", "to", "userId", "accountId", "operation"]);

export function parseAiUsageCliArgs(
  args: string[],
  now = new Date(),
): AiUsageSummaryFilters {
  const input: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      throw new RangeError(`unexpected AI usage argument: ${argument}`);
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (!CLI_OPTIONS.has(name)) {
      throw new RangeError(`unknown AI usage option: --${name}`);
    }
    if (Object.hasOwn(input, name)) {
      throw new RangeError(`duplicate AI usage option: --${name}`);
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new RangeError(`--${name} requires a value`);
    }
    input[name] = value;
  }
  return parseAiUsageReportFilters(input, now);
}
