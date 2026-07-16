import type { AiOperation } from "../shared/schema.js";
import { pool } from "./db.js";

export type AiUsageSummaryFilters = {
  from: Date;
  to: Date;
  userId?: number;
  accountId?: number;
  uploadId?: number;
  jobId?: number;
  operation?: AiOperation;
};

export type AiUsageSummary = {
  requestCount: number;
  succeededCount: number;
  failedCount: number;
  releasedCount: number;
  unknownCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  reservedCostMicrousd: number;
  finalCostMicrousd: number;
  actualCostMicrousd: number;
  estimatedCostMicrousd: number;
  reservedUnknownCostMicrousd: number;
};

export type AiUsageBreakdownRow = AiUsageSummary & {
  key: number | string | null;
};

export type AiBudgetUtilization = {
  scope: "app" | "user";
  userId: number | null;
  period: "day" | "month";
  periodStart: string;
  configuredLimitMicrousd: number;
  reservedCostMicrousd: number;
  committedCostMicrousd: number;
  utilizedCostMicrousd: number;
  utilizationBasisPoints: number;
  blocksNewReservations: boolean;
  alertedThroughPercent: number;
};

export type AiUsageReport = {
  window: { from: string; to: string };
  filters: {
    userId?: number;
    accountId?: number;
    operation?: AiOperation;
  };
  summary: AiUsageSummary;
  breakdowns: {
    byUser: AiUsageBreakdownRow[];
    byFinancialAccount: AiUsageBreakdownRow[];
    byOperation: AiUsageBreakdownRow[];
    byDay: AiUsageBreakdownRow[];
    byMonth: AiUsageBreakdownRow[];
    byError: AiUsageBreakdownRow[];
  };
  budgets: AiBudgetUtilization[];
};

type SummaryRow = Record<keyof AiUsageSummary, string>;

type BudgetRow = {
  scope: "app" | "user";
  userId: number | null;
  period: "day" | "month";
  periodStart: string;
  configuredLimitMicrousd: string;
  reservedCostMicrousd: string;
  committedCostMicrousd: string;
  alertedThroughPercent: number;
};

const SUMMARY_SELECT = `
  COUNT(*)::text AS "requestCount",
  COUNT(*) FILTER (WHERE attempt_status = 'succeeded')::text AS "succeededCount",
  COUNT(*) FILTER (WHERE attempt_status = 'failed')::text AS "failedCount",
  COUNT(*) FILTER (WHERE attempt_status = 'released')::text AS "releasedCount",
  COUNT(*) FILTER (WHERE attempt_status = 'unknown')::text AS "unknownCount",
  COALESCE(SUM(input_tokens), 0)::text AS "inputTokens",
  COALESCE(SUM(cached_input_tokens), 0)::text AS "cachedInputTokens",
  COALESCE(SUM(output_tokens), 0)::text AS "outputTokens",
  COALESCE(SUM(reasoning_tokens), 0)::text AS "reasoningTokens",
  COALESCE(SUM(total_tokens), 0)::text AS "totalTokens",
  COALESCE(SUM(reserved_cost_microusd), 0)::text AS "reservedCostMicrousd",
  COALESCE(SUM(final_cost_microusd), 0)::text AS "finalCostMicrousd",
  COALESCE(SUM(final_cost_microusd) FILTER (WHERE usage_source = 'actual'), 0)::text
    AS "actualCostMicrousd",
  COALESCE(SUM(final_cost_microusd) FILTER (WHERE usage_source = 'estimated'), 0)::text
    AS "estimatedCostMicrousd",
  COALESCE(SUM(final_cost_microusd) FILTER (WHERE usage_source = 'reserved_unknown'), 0)::text
    AS "reservedUnknownCostMicrousd"`;

function validateDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${field} must be a valid Date`);
  }
}

function validateId(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function parseAggregate(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${field} is outside the supported integer range`);
  }
  return parsed;
}

function parseSummary(row: SummaryRow): AiUsageSummary {
  return {
    requestCount: parseAggregate(row.requestCount, "requestCount"),
    succeededCount: parseAggregate(row.succeededCount, "succeededCount"),
    failedCount: parseAggregate(row.failedCount, "failedCount"),
    releasedCount: parseAggregate(row.releasedCount, "releasedCount"),
    unknownCount: parseAggregate(row.unknownCount, "unknownCount"),
    inputTokens: parseAggregate(row.inputTokens, "inputTokens"),
    cachedInputTokens: parseAggregate(row.cachedInputTokens, "cachedInputTokens"),
    outputTokens: parseAggregate(row.outputTokens, "outputTokens"),
    reasoningTokens: parseAggregate(row.reasoningTokens, "reasoningTokens"),
    totalTokens: parseAggregate(row.totalTokens, "totalTokens"),
    reservedCostMicrousd: parseAggregate(
      row.reservedCostMicrousd,
      "reservedCostMicrousd",
    ),
    finalCostMicrousd: parseAggregate(row.finalCostMicrousd, "finalCostMicrousd"),
    actualCostMicrousd: parseAggregate(row.actualCostMicrousd, "actualCostMicrousd"),
    estimatedCostMicrousd: parseAggregate(
      row.estimatedCostMicrousd,
      "estimatedCostMicrousd",
    ),
    reservedUnknownCostMicrousd: parseAggregate(
      row.reservedUnknownCostMicrousd,
      "reservedUnknownCostMicrousd",
    ),
  };
}

function validateFilters(filters: AiUsageSummaryFilters): void {
  validateDate(filters.from, "from");
  validateDate(filters.to, "to");
  if (filters.from.getTime() >= filters.to.getTime()) {
    throw new RangeError("from must be before to");
  }
  validateId(filters.userId, "userId");
  validateId(filters.accountId, "accountId");
  validateId(filters.uploadId, "uploadId");
  validateId(filters.jobId, "jobId");
  if (
    filters.operation !== undefined &&
    !["transaction_classification", "csv_format_detection"].includes(
      filters.operation,
    )
  ) {
    throw new RangeError("operation is not supported");
  }
}

function buildUsageWhere(filters: AiUsageSummaryFilters): {
  clauses: string[];
  values: unknown[];
} {
  const values: unknown[] = [filters.from, filters.to];
  const clauses = ["request_started_at >= $1", "request_started_at < $2"];
  const addFilter = (column: string, value: unknown) => {
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  };
  if (filters.userId !== undefined) addFilter("user_id", filters.userId);
  if (filters.accountId !== undefined) addFilter("account_id", filters.accountId);
  if (filters.uploadId !== undefined) addFilter("upload_id", filters.uploadId);
  if (filters.jobId !== undefined) addFilter("job_id", filters.jobId);
  if (filters.operation !== undefined) addFilter("operation", filters.operation);
  return { clauses, values };
}

export async function getAiUsageSummary(
  filters: AiUsageSummaryFilters,
): Promise<AiUsageSummary> {
  validateFilters(filters);
  const { clauses, values } = buildUsageWhere(filters);

  const result = await pool.query<SummaryRow>(
    `SELECT ${SUMMARY_SELECT}
     FROM ai_usage_events
     WHERE ${clauses.join(" AND ")}`,
    values,
  );
  return parseSummary(result.rows[0]!);
}

type BreakdownDimension =
  | "user"
  | "account"
  | "operation"
  | "day"
  | "month"
  | "error";

const BREAKDOWN_EXPRESSIONS: Record<BreakdownDimension, string> = {
  user: "user_id",
  account: "account_id",
  operation: "operation",
  day: "(request_started_at AT TIME ZONE 'UTC')::date::text",
  month: "to_char(request_started_at AT TIME ZONE 'UTC', 'YYYY-MM')",
  error: "error_code",
};

async function getBreakdown(
  filters: AiUsageSummaryFilters,
  dimension: BreakdownDimension,
): Promise<AiUsageBreakdownRow[]> {
  const { clauses, values } = buildUsageWhere(filters);
  if (dimension === "error") clauses.push("error_code IS NOT NULL");
  const expression = BREAKDOWN_EXPRESSIONS[dimension];
  const result = await pool.query<SummaryRow & { key: string | number | null }>(
    `SELECT ${expression} AS key, ${SUMMARY_SELECT}
     FROM ai_usage_events
     WHERE ${clauses.join(" AND ")}
     GROUP BY ${expression}
     ORDER BY ${expression} ASC NULLS LAST`,
    values,
  );
  return result.rows.map((row) => ({ key: row.key, ...parseSummary(row) }));
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function utcMonthStart(value: Date): string {
  return `${value.toISOString().slice(0, 7)}-01`;
}

async function getBudgetUtilization(
  filters: AiUsageSummaryFilters,
): Promise<AiBudgetUtilization[]> {
  const inclusiveEnd = new Date(filters.to.getTime() - 1);
  const values: unknown[] = [
    utcDate(filters.from),
    utcDate(inclusiveEnd),
    utcMonthStart(filters.from),
    utcMonthStart(inclusiveEnd),
  ];
  const userClauses: string[] = [];
  if (filters.userId !== undefined) {
    values.push(filters.userId);
    userClauses.push(`user_id = $${values.length}`);
  }
  if (filters.accountId !== undefined) {
    values.push(filters.accountId);
    userClauses.push(
      `user_id = (SELECT user_id FROM accounts WHERE id = $${values.length})`,
    );
  }
  const userScope = userClauses.length > 0
    ? `scope = 'user' AND ${userClauses.join(" AND ")}`
    : "scope = 'user'";
  const result = await pool.query<BudgetRow>(
    `SELECT scope, user_id AS "userId", period, period_start::text AS "periodStart",
            configured_limit_microusd::text AS "configuredLimitMicrousd",
            reserved_cost_microusd::text AS "reservedCostMicrousd",
            committed_cost_microusd::text AS "committedCostMicrousd",
            alerted_through_percent AS "alertedThroughPercent"
     FROM ai_budget_buckets
     WHERE (scope = 'app' OR (${userScope}))
       AND ((period = 'day' AND period_start BETWEEN $1::date AND $2::date)
         OR (period = 'month' AND period_start BETWEEN $3::date AND $4::date))
     ORDER BY period_start, scope, user_id NULLS FIRST, period`,
    values,
  );
  return result.rows.map((row) => {
    const configuredLimitMicrousd = parseAggregate(
      row.configuredLimitMicrousd,
      "configuredLimitMicrousd",
    );
    const reservedCostMicrousd = parseAggregate(
      row.reservedCostMicrousd,
      "reservedCostMicrousd",
    );
    const committedCostMicrousd = parseAggregate(
      row.committedCostMicrousd,
      "committedCostMicrousd",
    );
    const utilizedCostMicrousd = reservedCostMicrousd + committedCostMicrousd;
    return {
      ...row,
      configuredLimitMicrousd,
      reservedCostMicrousd,
      committedCostMicrousd,
      utilizedCostMicrousd,
      utilizationBasisPoints:
        configuredLimitMicrousd === 0
          ? (utilizedCostMicrousd === 0 ? 0 : 10_000)
          : Math.min(
              10_000,
              Math.floor((utilizedCostMicrousd * 10_000) / configuredLimitMicrousd),
            ),
      blocksNewReservations: utilizedCostMicrousd >= configuredLimitMicrousd,
    };
  });
}

export async function getAiUsageReport(
  filters: AiUsageSummaryFilters,
): Promise<AiUsageReport> {
  validateFilters(filters);
  const [
    summary,
    byUser,
    byFinancialAccount,
    byOperation,
    byDay,
    byMonth,
    byError,
    budgets,
  ] = await Promise.all([
    getAiUsageSummary(filters),
    getBreakdown(filters, "user"),
    getBreakdown(filters, "account"),
    getBreakdown(filters, "operation"),
    getBreakdown(filters, "day"),
    getBreakdown(filters, "month"),
    getBreakdown(filters, "error"),
    getBudgetUtilization(filters),
  ]);
  return {
    window: { from: filters.from.toISOString(), to: filters.to.toISOString() },
    filters: {
      ...(filters.userId === undefined ? {} : { userId: filters.userId }),
      ...(filters.accountId === undefined ? {} : { accountId: filters.accountId }),
      ...(filters.operation === undefined ? {} : { operation: filters.operation }),
    },
    summary,
    breakdowns: {
      byUser,
      byFinancialAccount,
      byOperation,
      byDay,
      byMonth,
      byError,
    },
    budgets,
  };
}
