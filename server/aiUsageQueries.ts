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

type SummaryRow = Record<keyof AiUsageSummary, string>;

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

export async function getAiUsageSummary(
  filters: AiUsageSummaryFilters,
): Promise<AiUsageSummary> {
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

  const result = await pool.query<SummaryRow>(
    `SELECT
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
         AS "reservedUnknownCostMicrousd"
     FROM ai_usage_events
     WHERE ${clauses.join(" AND ")}`,
    values,
  );
  const row = result.rows[0]!;
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
