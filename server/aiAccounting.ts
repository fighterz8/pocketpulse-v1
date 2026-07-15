import type pg from "pg";

import type {
  AiAttemptStatus,
  AiOperation,
  AiReservationStatus,
} from "../shared/schema.js";
import {
  AI_PROVIDER_TOKEN_CEILINGS,
  calculateMaximumRequestCostMicrousd,
  calculateUsageCostMicrousd,
  validateNormalizedTokenUsage,
  type NormalizedTokenUsage,
} from "./aiPricing.js";
import { pool } from "./db.js";

export type AiBudgetLimits = {
  userDayMicrousd: number;
  userMonthMicrousd: number;
  appDayMicrousd: number;
  appMonthMicrousd: number;
};

export type ReserveAiBudgetInput = {
  reservationId: string;
  userId: number;
  accountId?: number;
  uploadId?: number;
  jobId?: number;
  operation: AiOperation;
  model: string;
};

export type ReserveAiBudgetResult = {
  reservationId: string;
  status: AiReservationStatus;
  reservedCostMicrousd: number;
  finalCostMicrousd: number | null;
};

/** Approved beta ceilings. Request callers cannot override these values. */
export const AI_BUDGET_LIMITS: Readonly<AiBudgetLimits> = Object.freeze({
  userDayMicrousd: 50_000,
  userMonthMicrousd: 250_000,
  appDayMicrousd: 500_000,
  appMonthMicrousd: 5_000_000,
});

export type AiReconciliationOutcome =
  | {
      type: "actual";
      attemptStatus: Extract<AiAttemptStatus, "succeeded" | "failed">;
      providerRequestId?: string | null;
      latencyMs?: number | null;
      usage: NormalizedTokenUsage;
      errorCode?: string | null;
    }
  | { type: "reserved_unknown"; errorCode: string }
  | { type: "released"; errorCode: string };

export type ReconcileAiBudgetResult = {
  reservationId: string;
  status: AiReservationStatus;
  finalCostMicrousd: number;
  usageEventId: number;
  alreadyReconciled: boolean;
};

export class AiBudgetExceededError extends Error {
  readonly code = "AI_BUDGET_EXCEEDED" as const;

  constructor(
    readonly scope: "app" | "user",
    readonly period: "day" | "month",
  ) {
    super(`AI ${scope} ${period} budget is exhausted`);
    this.name = "AiBudgetExceededError";
  }
}

export class AiReservationAlreadyExistsError extends Error {
  readonly code = "AI_RESERVATION_ALREADY_EXISTS" as const;

  constructor(reservationId: string) {
    super(
      `AI reservation ${JSON.stringify(reservationId)} was already authorized`,
    );
    this.name = "AiReservationAlreadyExistsError";
  }
}

export class AiAttributionMismatchError extends Error {
  readonly code = "AI_ATTRIBUTION_MISMATCH" as const;

  constructor() {
    super("AI accounting attribution does not belong to the requesting user");
    this.name = "AiAttributionMismatchError";
  }
}

export class AiAccountingInvariantError extends Error {
  readonly code = "AI_ACCOUNTING_INVARIANT" as const;

  constructor(message: string) {
    super(message);
    this.name = "AiAccountingInvariantError";
  }
}

type ReservationRow = {
  id: string;
  user_id: number | null;
  account_id: number | null;
  upload_id: number | null;
  job_id: number | null;
  operation: AiOperation;
  provider: string;
  model: string;
  pricing_version: string;
  reserved_cost_microusd: string;
  final_cost_microusd: string | null;
  status: AiReservationStatus;
  created_at: Date;
};

type BucketRow = {
  id: number;
  scope: "app" | "user";
  period: "day" | "month";
  configured_limit_microusd: string;
  reserved_cost_microusd: string;
  committed_cost_microusd: string;
};

type BucketSpec = {
  scope: "app" | "user";
  userId: number | null;
  period: "day" | "month";
  periodStart: string;
  limitMicrousd: number;
};

function assertNonEmpty(value: string, field: string, maxLength = 160): void {
  if (value.trim() === "" || value.length > maxLength) {
    throw new RangeError(`${field} must be non-empty and at most ${maxLength} characters`);
  }
}

function assertPositiveId(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function assertMicrousd(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function parseMicrousd(value: string | null, field: string): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AiAccountingInvariantError(`${field} is outside the supported range`);
  }
  return parsed;
}

function utcPeriodStarts(now: Date): { day: string; month: string } {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), month: `${iso.slice(0, 7)}-01` };
}

function bucketSpecs(
  userId: number,
  now: Date,
  limits: AiBudgetLimits,
): BucketSpec[] {
  const starts = utcPeriodStarts(now);
  return [
    {
      scope: "app",
      userId: null,
      period: "day",
      periodStart: starts.day,
      limitMicrousd: limits.appDayMicrousd,
    },
    {
      scope: "app",
      userId: null,
      period: "month",
      periodStart: starts.month,
      limitMicrousd: limits.appMonthMicrousd,
    },
    {
      scope: "user",
      userId,
      period: "day",
      periodStart: starts.day,
      limitMicrousd: limits.userDayMicrousd,
    },
    {
      scope: "user",
      userId,
      period: "month",
      periodStart: starts.month,
      limitMicrousd: limits.userMonthMicrousd,
    },
  ];
}

function validateReservationInput(input: ReserveAiBudgetInput): void {
  assertNonEmpty(input.reservationId, "reservationId");
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.accountId, "accountId");
  assertPositiveId(input.uploadId, "uploadId");
  assertPositiveId(input.jobId, "jobId");
  assertNonEmpty(input.model, "model", 100);
  if (!Object.hasOwn(AI_PROVIDER_TOKEN_CEILINGS, input.operation)) {
    throw new RangeError("operation is not supported for paid AI accounting");
  }
  for (const [field, value] of Object.entries(AI_BUDGET_LIMITS)) {
    assertMicrousd(value, `limits.${field}`);
  }
}

async function databaseNow(client: pg.PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>(
    `SELECT clock_timestamp() AS now`,
  );
  return result.rows[0]!.now;
}

async function insertBucket(client: pg.PoolClient, spec: BucketSpec): Promise<void> {
  if (spec.scope === "app") {
    await client.query(
      `INSERT INTO ai_budget_buckets (
         scope, user_id, period, period_start, configured_limit_microusd
       ) VALUES ('app', NULL, $1, $2, $3)
       ON CONFLICT (period, period_start) WHERE scope = 'app' DO NOTHING`,
      [spec.period, spec.periodStart, spec.limitMicrousd],
    );
    return;
  }
  await client.query(
    `INSERT INTO ai_budget_buckets (
       scope, user_id, period, period_start, configured_limit_microusd
     ) VALUES ('user', $1, $2, $3, $4)
     ON CONFLICT (user_id, period, period_start) WHERE scope = 'user' DO NOTHING`,
    [spec.userId, spec.period, spec.periodStart, spec.limitMicrousd],
  );
}

async function lockBucket(client: pg.PoolClient, spec: BucketSpec): Promise<BucketRow> {
  const values =
    spec.scope === "app"
      ? [spec.period, spec.periodStart]
      : [spec.userId, spec.period, spec.periodStart];
  const result = await client.query<BucketRow>(
    spec.scope === "app"
      ? `SELECT id, scope, period, configured_limit_microusd,
                reserved_cost_microusd, committed_cost_microusd
         FROM ai_budget_buckets
         WHERE scope = 'app' AND user_id IS NULL AND period = $1 AND period_start = $2
         FOR UPDATE`
      : `SELECT id, scope, period, configured_limit_microusd,
                reserved_cost_microusd, committed_cost_microusd
         FROM ai_budget_buckets
         WHERE scope = 'user' AND user_id = $1 AND period = $2 AND period_start = $3
         FOR UPDATE`,
    values,
  );
  const row = result.rows[0];
  if (!row) throw new AiAccountingInvariantError("required AI budget bucket is missing");
  return row;
}

async function assertAttributionOwnership(
  client: pg.PoolClient,
  input: ReserveAiBudgetInput,
): Promise<void> {
  if (input.uploadId !== undefined) {
    const upload = await client.query<{
      user_id: number;
      account_id: number;
      account_user_id: number;
    }>(
      `SELECT u.user_id, u.account_id, a.user_id AS account_user_id
       FROM uploads u
       JOIN accounts a ON a.id = u.account_id
       WHERE u.id = $1
       FOR UPDATE OF u, a`,
      [input.uploadId],
    );
    const row = upload.rows[0];
    if (
      row?.user_id !== input.userId ||
      row.account_user_id !== input.userId ||
      (input.accountId !== undefined && row.account_id !== input.accountId)
    ) {
      throw new AiAttributionMismatchError();
    }
    return;
  }
  if (input.accountId !== undefined) {
    const account = await client.query<{ user_id: number }>(
      `SELECT user_id FROM accounts WHERE id = $1 FOR UPDATE`,
      [input.accountId],
    );
    if (account.rows[0]?.user_id !== input.userId) {
      throw new AiAttributionMismatchError();
    }
  }
}

export async function reserveAiBudget(
  input: ReserveAiBudgetInput,
): Promise<ReserveAiBudgetResult> {
  validateReservationInput(input);
  const reservationPrice = calculateMaximumRequestCostMicrousd(
    input.model,
    input.operation,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const now = await databaseNow(client);
    const specs = bucketSpecs(input.userId, now, AI_BUDGET_LIMITS);
    await assertAttributionOwnership(client, input);
    const inserted = await client.query<ReservationRow>(
      `INSERT INTO ai_budget_reservations (
         id, user_id, account_id, upload_id, job_id, operation, provider, model,
         pricing_version, reserved_cost_microusd, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        input.reservationId,
        input.userId,
        input.accountId ?? null,
        input.uploadId ?? null,
        input.jobId ?? null,
        input.operation,
        "openai",
        input.model,
        reservationPrice.pricingVersion,
        reservationPrice.costMicrousd,
        now,
      ],
    );

    if (inserted.rows.length === 0) {
      throw new AiReservationAlreadyExistsError(input.reservationId);
    }

    for (const spec of specs) await insertBucket(client, spec);
    const locked: Array<{ spec: BucketSpec; row: BucketRow }> = [];
    for (const spec of specs) locked.push({ spec, row: await lockBucket(client, spec) });

    for (const { spec, row } of locked) {
      const limit = parseMicrousd(row.configured_limit_microusd, "budget limit")!;
      if (limit !== spec.limitMicrousd) {
        throw new AiAccountingInvariantError(
          `configured ${spec.scope} ${spec.period} budget changed during its active period`,
        );
      }
      const reserved = parseMicrousd(row.reserved_cost_microusd, "reserved spend")!;
      const committed = parseMicrousd(row.committed_cost_microusd, "committed spend")!;
      if (reserved + committed + reservationPrice.costMicrousd > limit) {
        throw new AiBudgetExceededError(spec.scope, spec.period);
      }
    }

    for (const { row } of locked) {
      await client.query(
        `UPDATE ai_budget_buckets
         SET reserved_cost_microusd = reserved_cost_microusd + $1,
             updated_at = $2
         WHERE id = $3`,
        [reservationPrice.costMicrousd, now, row.id],
      );
    }
    await client.query("COMMIT");
    return {
      reservationId: input.reservationId,
      status: "active",
      reservedCostMicrousd: reservationPrice.costMicrousd,
      finalCostMicrousd: null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function validateErrorCode(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!/^[A-Z0-9_]{1,64}$/.test(value)) {
    throw new RangeError("errorCode must be a bounded machine-readable identifier");
  }
  return value;
}

export async function reconcileAiBudgetReservation(input: {
  reservationId: string;
  outcome: AiReconciliationOutcome;
}): Promise<ReconcileAiBudgetResult> {
  assertNonEmpty(input.reservationId, "reservationId");
  const errorCode = validateErrorCode(input.outcome.errorCode);
  if (input.outcome.type === "actual") {
    if (
      input.outcome.latencyMs !== undefined &&
      input.outcome.latencyMs !== null &&
      (!Number.isSafeInteger(input.outcome.latencyMs) || input.outcome.latencyMs < 0)
    ) {
      throw new RangeError("latencyMs must be a non-negative safe integer");
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const now = await databaseNow(client);
    const selected = await client.query<ReservationRow>(
      `SELECT * FROM ai_budget_reservations WHERE id = $1 FOR UPDATE`,
      [input.reservationId],
    );
    const reservation = selected.rows[0];
    if (!reservation) {
      throw new AiAccountingInvariantError("AI budget reservation does not exist");
    }

    if (reservation.status !== "active") {
      const event = await client.query<{ id: number; final_cost_microusd: string }>(
        `SELECT id, final_cost_microusd FROM ai_usage_events WHERE reservation_id = $1`,
        [input.reservationId],
      );
      const existing = event.rows[0];
      if (!existing) {
        throw new AiAccountingInvariantError(
          "reconciled reservation is missing its usage event",
        );
      }
      await client.query("COMMIT");
      return {
        reservationId: reservation.id,
        status: reservation.status,
        finalCostMicrousd: parseMicrousd(
          existing.final_cost_microusd,
          "final cost",
        )!,
        usageEventId: existing.id,
        alreadyReconciled: true,
      };
    }

    const reservedCost = parseMicrousd(
      reservation.reserved_cost_microusd,
      "reserved cost",
    )!;
    if (input.outcome.type === "actual") {
      validateNormalizedTokenUsage(input.outcome.usage);
      const ceiling = AI_PROVIDER_TOKEN_CEILINGS[reservation.operation];
      if (
        input.outcome.usage.inputTokens > ceiling.inputTokens ||
        input.outcome.usage.outputTokens > ceiling.outputTokens
      ) {
        throw new AiAccountingInvariantError(
          "provider usage exceeds the cost reserved before the request",
        );
      }
    }
    const actualCost = input.outcome.type === "actual"
      ? calculateUsageCostMicrousd(reservation.model, input.outcome.usage)
      : null;
    if (actualCost && actualCost.pricingVersion !== reservation.pricing_version) {
      throw new AiAccountingInvariantError(
        "reservation pricing version no longer matches the reviewed model rate",
      );
    }

    const finalCost =
      input.outcome.type === "actual"
        ? actualCost!.costMicrousd
        : input.outcome.type === "reserved_unknown"
          ? reservedCost
          : 0;
    if (finalCost > reservedCost) {
      throw new AiAccountingInvariantError(
        "final provider cost exceeds the authorized reservation",
      );
    }
    const nextStatus: AiReservationStatus =
      input.outcome.type === "actual"
        ? "committed"
        : input.outcome.type === "reserved_unknown"
          ? "reserved_unknown"
          : "released";
    const usageSource =
      input.outcome.type === "actual"
        ? "actual"
        : input.outcome.type === "reserved_unknown"
          ? "reserved_unknown"
          : "estimated";
    const attemptStatus: AiAttemptStatus =
      input.outcome.type === "actual"
        ? input.outcome.attemptStatus
        : input.outcome.type === "reserved_unknown"
          ? "unknown"
          : "released";
    const usage: NormalizedTokenUsage =
      input.outcome.type === "actual"
        ? input.outcome.usage
        : {
            inputTokens: 0,
            cachedInputTokens: 0,
            uncachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          };

    const starts = utcPeriodStarts(reservation.created_at);
    const bucketResult = await client.query<BucketRow>(
      `SELECT id, scope, period, configured_limit_microusd,
              reserved_cost_microusd, committed_cost_microusd
       FROM ai_budget_buckets
       WHERE (
         scope = 'app' AND user_id IS NULL AND
         ((period = 'day' AND period_start = $1) OR
          (period = 'month' AND period_start = $2))
       ) OR (
         $3::integer IS NOT NULL AND scope = 'user' AND user_id = $3 AND
         ((period = 'day' AND period_start = $1) OR
          (period = 'month' AND period_start = $2))
       )
       ORDER BY scope, period
       FOR UPDATE`,
      [starts.day, starts.month, reservation.user_id],
    );
    const expectedBucketCount = reservation.user_id === null ? 2 : 4;
    if (bucketResult.rows.length !== expectedBucketCount) {
      throw new AiAccountingInvariantError("reservation budget buckets are incomplete");
    }

    for (const bucket of bucketResult.rows) {
      const updated = await client.query(
        `UPDATE ai_budget_buckets
         SET reserved_cost_microusd = reserved_cost_microusd - $1,
             committed_cost_microusd = committed_cost_microusd + $2,
             updated_at = $3
         WHERE id = $4 AND reserved_cost_microusd >= $1
           AND committed_cost_microusd + $2 <= configured_limit_microusd
         RETURNING id`,
        [reservedCost, finalCost, now, bucket.id],
      );
      if (updated.rows.length !== 1) {
        throw new AiAccountingInvariantError(
          "budget bucket does not contain the reservation being reconciled",
        );
      }
    }

    const event = await client.query<{ id: number }>(
      `INSERT INTO ai_usage_events (
         reservation_id, user_id, account_id, upload_id, job_id, operation,
         provider, model, pricing_version, provider_request_id, attempt_status,
         latency_ms, input_tokens, cached_input_tokens, output_tokens,
         reasoning_tokens, total_tokens, reserved_cost_microusd,
         final_cost_microusd, usage_source, error_code, request_started_at,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, $23
       ) RETURNING id`,
      [
        reservation.id,
        reservation.user_id,
        reservation.account_id,
        reservation.upload_id,
        reservation.job_id,
        reservation.operation,
        reservation.provider,
        reservation.model,
        reservation.pricing_version,
        input.outcome.type === "actual"
          ? (input.outcome.providerRequestId ?? null)
          : null,
        attemptStatus,
        input.outcome.type === "actual" ? (input.outcome.latencyMs ?? null) : null,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.outputTokens,
        usage.reasoningOutputTokens,
        usage.totalTokens,
        reservedCost,
        finalCost,
        usageSource,
        errorCode,
        reservation.created_at,
        now,
      ],
    );
    await client.query(
      `UPDATE ai_budget_reservations
       SET status = $1, final_cost_microusd = $2, reconciled_at = $3
       WHERE id = $4`,
      [nextStatus, finalCost, now, reservation.id],
    );
    await client.query("COMMIT");
    return {
      reservationId: reservation.id,
      status: nextStatus,
      finalCostMicrousd: finalCost,
      usageEventId: event.rows[0]!.id,
      alreadyReconciled: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
