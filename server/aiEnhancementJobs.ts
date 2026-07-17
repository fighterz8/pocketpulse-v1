import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

import type { AiEnhancementJobStatus } from "../shared/schema.js";
import { pool } from "./db.js";
import { calculateMaximumRequestCostMicrousd } from "./aiPricing.js";
import { recurrenceKey } from "./recurrenceDetector.js";

export const AI_ENHANCEMENT_MAX_MERCHANTS_PER_JOB = 250;
export const AI_ENHANCEMENT_BATCH_SIZE = 25;
export const AI_ENHANCEMENT_MAX_JOBS_PER_USER_DAY = 2;
export const AI_ENHANCEMENT_MODEL = "gpt-5-nano";
export const AI_ENHANCEMENT_ITEM_LEASE_TTL_MS = 60_000;

const USER_JOB_LOCK_NAMESPACE = 1_347_370_827;
const MAX_STORED_MERCHANT_KEY_LENGTH = 240;

export function enhancementMerchantKey(merchant: string): string {
  const canonical = recurrenceKey(merchant);
  if (canonical.length <= MAX_STORED_MERCHANT_KEY_LENGTH) return canonical;
  return `${canonical.slice(0, 220)}-${createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 16)}`;
}

export type AiEnhancementJobView = {
  id: number;
  uploadId: number;
  accountId: number;
  status: AiEnhancementJobStatus;
  totalMerchants: number;
  completedMerchants: number;
  skippedMerchants: number;
  failedMerchants: number;
  progress: number;
  estimatedMaxCostMicrousd: number;
  actualCostMicrousd: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AiEnhancementAvailability = {
  uploadId: number;
  state: "not_needed" | "available" | "active" | "complete" | "blocked";
  unresolvedTransactionCount: number;
  unresolvedMerchantCount: number;
  activeJobId?: number;
  blockedReason?:
    | "FEATURE_DISABLED"
    | "PLUS_REQUIRED"
    | "ACTIVE_JOB_EXISTS"
    | "USER_LIMIT_REACHED"
    | "PROVIDER_UNAVAILABLE";
  resetAt?: string;
};

type JobRow = {
  id: number;
  upload_id: number;
  account_id: number;
  status: AiEnhancementJobStatus;
  total_merchants: number;
  completed_merchants: number;
  skipped_merchants: number;
  failed_merchants: number;
  estimated_max_cost_microusd: string;
  actual_cost_microusd: string;
  created_at: Date;
  updated_at: Date;
};

type UnresolvedRow = {
  id: number;
  merchant: string;
};

export type AiEnhancementClaimItem = {
  id: number;
  merchantKey: string;
  representativeTransactionId: number | null;
  attemptCount: number;
};

export type AiEnhancementBatchClaimResult =
  | {
      state: "claimed";
      job: AiEnhancementJobView;
      batchKey: string;
      leaseToken: string;
      leaseExpiresAt: Date;
      items: AiEnhancementClaimItem[];
      unknownReservationIds: string[];
    }
  | {
      state: "busy" | "result_ready" | "empty" | "terminal";
      job: AiEnhancementJobView;
      unknownReservationIds: string[];
    };

export class AiEnhancementUploadNotFoundError extends Error {
  readonly code = "AI_ENHANCEMENT_UPLOAD_NOT_FOUND" as const;

  constructor() {
    super("Enhancement upload was not found");
    this.name = "AiEnhancementUploadNotFoundError";
  }
}

export class AiEnhancementUploadNotReadyError extends Error {
  readonly code = "AI_ENHANCEMENT_UPLOAD_NOT_READY" as const;

  constructor() {
    super("Enhancement upload is not ready");
    this.name = "AiEnhancementUploadNotReadyError";
  }
}

export class AiEnhancementNotNeededError extends Error {
  readonly code = "AI_ENHANCEMENT_NOT_NEEDED" as const;

  constructor() {
    super("No unresolved merchants remain for this upload");
    this.name = "AiEnhancementNotNeededError";
  }
}

export class AiEnhancementActiveJobError extends Error {
  readonly code = "AI_ENHANCEMENT_ACTIVE_JOB" as const;

  constructor(readonly activeJobId: number) {
    super("An enhancement job is already active for this user");
    this.name = "AiEnhancementActiveJobError";
  }
}

export class AiEnhancementDailyJobLimitError extends Error {
  readonly code = "AI_ENHANCEMENT_DAILY_JOB_LIMIT" as const;

  constructor() {
    super("The daily enhancement job allowance has been reached");
    this.name = "AiEnhancementDailyJobLimitError";
  }
}

export class AiEnhancementIdempotencyMismatchError extends Error {
  readonly code = "AI_ENHANCEMENT_IDEMPOTENCY_MISMATCH" as const;

  constructor() {
    super("The idempotency key was already used for a different upload");
    this.name = "AiEnhancementIdempotencyMismatchError";
  }
}

export class AiEnhancementJobNotFoundError extends Error {
  readonly code = "AI_ENHANCEMENT_JOB_NOT_FOUND" as const;

  constructor() {
    super("Enhancement job was not found");
    this.name = "AiEnhancementJobNotFoundError";
  }
}

export class AiEnhancementJobNotCancellableError extends Error {
  readonly code = "AI_ENHANCEMENT_JOB_NOT_CANCELLABLE" as const;

  constructor() {
    super("Enhancement job can no longer be cancelled");
    this.name = "AiEnhancementJobNotCancellableError";
  }
}

export class AiEnhancementClaimStaleError extends Error {
  readonly code = "AI_ENHANCEMENT_CLAIM_STALE" as const;

  constructor() {
    super("Enhancement batch claim is no longer active");
    this.name = "AiEnhancementClaimStaleError";
  }
}

export class AiEnhancementJobInvariantError extends Error {
  readonly code = "AI_ENHANCEMENT_JOB_INVARIANT" as const;

  constructor(message: string) {
    super(message);
    this.name = "AiEnhancementJobInvariantError";
  }
}

function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new RangeError(
      "idempotencyKey must be 1-128 URL-safe characters",
    );
  }
  return value;
}

function parseMicrousd(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} is outside the supported range`);
  }
  return parsed;
}

function toJobView(row: JobRow): AiEnhancementJobView {
  const resolved =
    row.completed_merchants + row.skipped_merchants + row.failed_merchants;
  return {
    id: row.id,
    uploadId: row.upload_id,
    accountId: row.account_id,
    status: row.status,
    totalMerchants: row.total_merchants,
    completedMerchants: row.completed_merchants,
    skippedMerchants: row.skipped_merchants,
    failedMerchants: row.failed_merchants,
    progress:
      row.total_merchants === 0
        ? 100
        : Math.min(100, Math.floor((resolved / row.total_merchants) * 100)),
    estimatedMaxCostMicrousd: parseMicrousd(
      row.estimated_max_cost_microusd,
      "estimatedMaxCostMicrousd",
    ),
    actualCostMicrousd: parseMicrousd(
      row.actual_cost_microusd,
      "actualCostMicrousd",
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const JOB_COLUMNS = `
  id, upload_id, account_id, status, total_merchants,
  completed_merchants, skipped_merchants, failed_merchants,
  estimated_max_cost_microusd, actual_cost_microusd,
  created_at, updated_at
`;

async function findIdempotentJob(
  client: pg.PoolClient,
  userId: number,
  idempotencyKey: string,
): Promise<JobRow | null> {
  const existing = await client.query<JobRow>(
    `SELECT ${JOB_COLUMNS}
     FROM ai_enhancement_jobs
     WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  return existing.rows[0] ?? null;
}

async function listUnresolvedRows(
  client: pg.PoolClient,
  userId: number,
  uploadId: number,
): Promise<UnresolvedRow[]> {
  const unresolved = await client.query<UnresolvedRow>(
    `SELECT id, merchant FROM transactions
     WHERE user_id = $1 AND upload_id = $2
       AND ai_assisted = true
       AND label_source <> 'ai'
       AND label_source NOT IN ('manual', 'propagated')
       AND user_corrected = false
     ORDER BY id
     FOR SHARE`,
    [userId, uploadId],
  );
  return unresolved.rows;
}

function unresolvedSummary(rows: UnresolvedRow[]): {
  transactionCount: number;
  representatives: Map<string, number>;
} {
  const representatives = new Map<string, number>();
  for (const row of rows) {
    const key = enhancementMerchantKey(row.merchant);
    if (key && !representatives.has(key)) representatives.set(key, row.id);
  }
  return { transactionCount: rows.length, representatives };
}

export async function getAiEnhancementJobForUser(
  userId: number,
  jobId: number,
): Promise<AiEnhancementJobView | null> {
  assertPositiveId(userId, "userId");
  assertPositiveId(jobId, "jobId");
  const result = await pool.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ai_enhancement_jobs
     WHERE id = $1 AND user_id = $2`,
    [jobId, userId],
  );
  return result.rows[0] ? toJobView(result.rows[0]) : null;
}

/**
 * Returns the user's one durable active enhancement job, if any.
 *
 * This read-only lookup lets a remounted client resume the right upload
 * without scanning every upload or reviving the retired legacy worker poll.
 */
export async function getActiveAiEnhancementJobForUser(
  userId: number,
): Promise<AiEnhancementJobView | null> {
  assertPositiveId(userId, "userId");
  const result = await pool.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM ai_enhancement_jobs
     WHERE user_id = $1
       AND status IN ('queued', 'processing', 'budget_blocked')
     ORDER BY id DESC
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ? toJobView(result.rows[0]) : null;
}

export async function getAiEnhancementAvailability(input: {
  userId: number;
  uploadId: number;
  featureEnabled: boolean;
  providerAvailable: boolean;
}, connectionPool: Pick<pg.Pool, "connect"> = pool): Promise<AiEnhancementAvailability> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.uploadId, "uploadId");

  const client = await connectionPool.connect();
  try {
    await client.query("BEGIN");
    const upload = await client.query<{ status: string }>(
      `SELECT status FROM uploads WHERE id = $1 AND user_id = $2 FOR SHARE`,
      [input.uploadId, input.userId],
    );
    if (!upload.rows[0]) throw new AiEnhancementUploadNotFoundError();
    if (upload.rows[0].status !== "complete") {
      throw new AiEnhancementUploadNotReadyError();
    }

    const unresolved = unresolvedSummary(
      await listUnresolvedRows(client, input.userId, input.uploadId),
    );
    const base = {
      uploadId: input.uploadId,
      unresolvedTransactionCount: unresolved.transactionCount,
      unresolvedMerchantCount: unresolved.representatives.size,
    };

    // The feature flag is the deployment boundary for the optional job schema.
    // Production can safely ship the Free/Plus preview before those migrations:
    // disabled reads use only the core uploads and transactions tables.
    if (!input.featureEnabled) {
      await client.query("COMMIT");
      return unresolved.transactionCount === 0
        ? { ...base, state: "not_needed" }
        : { ...base, state: "blocked", blockedReason: "FEATURE_DISABLED" };
    }

    const active = await client.query<{ id: number; upload_id: number }>(
      `SELECT id, upload_id FROM ai_enhancement_jobs
       WHERE user_id = $1
         AND status IN ('queued', 'processing', 'budget_blocked')
       LIMIT 1`,
      [input.userId],
    );
    const activeJob = active.rows[0];
    const latest = await client.query<{ id: number; status: string }>(
      `SELECT id, status FROM ai_enhancement_jobs
       WHERE user_id = $1 AND upload_id = $2
       ORDER BY id DESC LIMIT 1`,
      [input.userId, input.uploadId],
    );
    const quota = await client.query<{ count: string; reset_at: Date }>(
      `SELECT COUNT(*)::text AS count,
              date_trunc('day', clock_timestamp()) + interval '1 day' AS reset_at
       FROM ai_enhancement_jobs
       WHERE user_id = $1
         AND created_at >= date_trunc('day', clock_timestamp())`,
      [input.userId],
    );
    await client.query("COMMIT");

    if (activeJob?.upload_id === input.uploadId) {
      return { ...base, state: "active", activeJobId: activeJob.id };
    }
    if (unresolved.transactionCount === 0) {
      return {
        ...base,
        state: latest.rows[0]?.status === "complete" ? "complete" : "not_needed",
      };
    }
    if (!input.providerAvailable) {
      return {
        ...base,
        state: "blocked",
        blockedReason: "PROVIDER_UNAVAILABLE",
      };
    }
    if (activeJob) {
      return {
        ...base,
        state: "blocked",
        activeJobId: activeJob.id,
        blockedReason: "ACTIVE_JOB_EXISTS",
      };
    }
    if (
      Number(quota.rows[0]!.count) >= AI_ENHANCEMENT_MAX_JOBS_PER_USER_DAY
    ) {
      return {
        ...base,
        state: "blocked",
        blockedReason: "USER_LIMIT_REACHED",
        resetAt: quota.rows[0]!.reset_at.toISOString(),
      };
    }
    return { ...base, state: "available" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelAiEnhancementJob(input: {
  userId: number;
  jobId: number;
}): Promise<AiEnhancementJobView> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.jobId, "jobId");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<JobRow & { status: AiEnhancementJobStatus }>(
      `SELECT ${JOB_COLUMNS} FROM ai_enhancement_jobs
       WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [input.jobId, input.userId],
    );
    const job = existing.rows[0];
    if (!job) throw new AiEnhancementJobNotFoundError();
    if (job.status === "cancelled") {
      await client.query("COMMIT");
      return toJobView(job);
    }
    if (!['queued', 'processing', 'budget_blocked'].includes(job.status)) {
      throw new AiEnhancementJobNotCancellableError();
    }
    const cancelled = await client.query<JobRow>(
      `UPDATE ai_enhancement_jobs
       SET status = 'cancelled', cancelled_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING ${JOB_COLUMNS}`,
      [input.jobId],
    );
    await client.query("COMMIT");
    return toJobView(cancelled.rows[0]!);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function refreshJobCounters(
  client: pg.PoolClient,
  jobId: number,
  options: { finishWhenEmpty: boolean },
): Promise<JobRow> {
  const counts = await client.query<{
    completed: number;
    skipped: number;
    failed: number;
    pending: number;
    processing: number;
    result_ready: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'complete')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
       COUNT(*) FILTER (WHERE status = 'result_ready')::int AS result_ready
     FROM ai_enhancement_job_items WHERE job_id = $1`,
    [jobId],
  );
  const count = counts.rows[0]!;
  const empty = count.pending + count.processing + count.result_ready === 0;
  const terminalStatus =
    count.failed > 0
      ? count.completed + count.skipped > 0
        ? "partial"
        : "failed"
      : "complete";
  const updated = await client.query<JobRow>(
    `UPDATE ai_enhancement_jobs
     SET completed_merchants = $2, skipped_merchants = $3,
         failed_merchants = $4,
         status = CASE
           WHEN $5::boolean AND $6::boolean THEN $7
           ELSE status
         END,
         completed_at = CASE
           WHEN $5::boolean AND $6::boolean THEN clock_timestamp()
           ELSE completed_at
         END,
         updated_at = clock_timestamp()
     WHERE id = $1
     RETURNING ${JOB_COLUMNS}`,
    [
      jobId,
      count.completed,
      count.skipped,
      count.failed,
      options.finishWhenEmpty,
      empty,
      terminalStatus,
    ],
  );
  return updated.rows[0]!;
}

export async function claimAiEnhancementBatch(input: {
  userId: number;
  jobId: number;
}): Promise<AiEnhancementBatchClaimResult> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.jobId, "jobId");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobResult = await client.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM ai_enhancement_jobs
       WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [input.jobId, input.userId],
    );
    let job = jobResult.rows[0];
    if (!job) throw new AiEnhancementJobNotFoundError();
    if (["complete", "partial", "failed", "cancelled"].includes(job.status)) {
      await client.query("COMMIT");
      return { state: "terminal", job: toJobView(job), unknownReservationIds: [] };
    }

    const clock = await client.query<{ now: Date }>(
      `SELECT clock_timestamp() AS now`,
    );
    const now = clock.rows[0]!.now;
    const expired = await client.query<{
      id: number;
      batch_key: string;
      reservation_id: string | null;
      attempt_count: number;
      reservation_exists: boolean;
    }>(
      `SELECT i.id, i.batch_key, i.reservation_id, i.attempt_count,
              EXISTS (
                SELECT 1 FROM ai_budget_reservations r
                WHERE r.id = COALESCE(i.reservation_id, i.batch_key)
              ) AS reservation_exists
       FROM ai_enhancement_job_items i
       WHERE i.job_id = $1 AND i.status = 'processing'
         AND i.lease_expires_at <= $2
       FOR UPDATE`,
      [input.jobId, now],
    );
    const unknownReservationIds = new Set<string>();
    for (const item of expired.rows) {
      const authorized =
        item.attempt_count > 0 ||
        item.reservation_id !== null ||
        item.reservation_exists;
      if (authorized) {
        if (item.reservation_exists) {
          unknownReservationIds.add(item.reservation_id ?? item.batch_key);
        }
        await client.query(
          `UPDATE ai_enhancement_job_items
           SET status = 'failed', internal_error_code = 'UNKNOWN_PROVIDER_OUTCOME',
               lease_token = NULL, lease_expires_at = NULL,
               attempt_count = GREATEST(attempt_count, 1),
               completed_at = $2, updated_at = $2
           WHERE id = $1`,
          [item.id, now],
        );
      } else {
        await client.query(
          `UPDATE ai_enhancement_job_items
           SET status = 'pending', batch_key = NULL, lease_token = NULL,
               lease_expires_at = NULL, reservation_id = NULL,
               updated_at = $2
           WHERE id = $1`,
          [item.id, now],
        );
      }
    }

    const ready = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_enhancement_job_items
       WHERE job_id = $1 AND status = 'result_ready'`,
      [input.jobId],
    );
    if (Number(ready.rows[0]!.count) > 0) {
      job = await refreshJobCounters(client, input.jobId, {
        finishWhenEmpty: false,
      });
      await client.query("COMMIT");
      return {
        state: "result_ready",
        job: toJobView(job),
        unknownReservationIds: [...unknownReservationIds],
      };
    }

    const live = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_enhancement_job_items
       WHERE job_id = $1 AND status = 'processing' AND lease_expires_at > $2`,
      [input.jobId, now],
    );
    if (Number(live.rows[0]!.count) > 0) {
      job = await refreshJobCounters(client, input.jobId, {
        finishWhenEmpty: false,
      });
      await client.query("COMMIT");
      return {
        state: "busy",
        job: toJobView(job),
        unknownReservationIds: [...unknownReservationIds],
      };
    }

    const pending = await client.query<{
      id: number;
      merchant_key: string;
      representative_transaction_id: number | null;
      attempt_count: number;
    }>(
      `SELECT id, merchant_key, representative_transaction_id, attempt_count
       FROM ai_enhancement_job_items
       WHERE job_id = $1 AND status = 'pending'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [input.jobId, AI_ENHANCEMENT_BATCH_SIZE],
    );
    if (pending.rows.length === 0) {
      job = await refreshJobCounters(client, input.jobId, {
        finishWhenEmpty: true,
      });
      await client.query("COMMIT");
      return {
        state: "empty",
        job: toJobView(job),
        unknownReservationIds: [...unknownReservationIds],
      };
    }

    const batchKey = `enhancement-${input.jobId}-${randomUUID()}`;
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + AI_ENHANCEMENT_ITEM_LEASE_TTL_MS,
    );
    const itemIds = pending.rows.map((item) => item.id);
    await client.query(
      `UPDATE ai_enhancement_job_items
       SET status = 'processing', batch_key = $2, lease_token = $3,
           lease_expires_at = $4, updated_at = $5
       WHERE id = ANY($1::int[])`,
      [itemIds, batchKey, leaseToken, leaseExpiresAt, now],
    );
    const updatedJob = await client.query<JobRow>(
      `UPDATE ai_enhancement_jobs
       SET status = 'processing', started_at = COALESCE(started_at, $2),
           updated_at = $2
       WHERE id = $1
       RETURNING ${JOB_COLUMNS}`,
      [input.jobId, now],
    );
    await client.query("COMMIT");
    return {
      state: "claimed",
      job: toJobView(updatedJob.rows[0]!),
      batchKey,
      leaseToken,
      leaseExpiresAt,
      items: pending.rows.map((item) => ({
        id: item.id,
        merchantKey: item.merchant_key,
        representativeTransactionId: item.representative_transaction_id,
        attemptCount: item.attempt_count,
      })),
      unknownReservationIds: [...unknownReservationIds],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function attachAiEnhancementReservation(input: {
  userId: number;
  jobId: number;
  batchKey: string;
  leaseToken: string;
  reservationId: string;
}): Promise<number> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.jobId, "jobId");
  validateIdempotencyKey(input.batchKey);
  validateIdempotencyKey(input.leaseToken);
  validateIdempotencyKey(input.reservationId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query<{ status: AiEnhancementJobStatus }>(
      `SELECT status FROM ai_enhancement_jobs
       WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [input.jobId, input.userId],
    );
    if (!job.rows[0]) throw new AiEnhancementJobNotFoundError();
    if (job.rows[0].status === "cancelled") {
      throw new AiEnhancementClaimStaleError();
    }
    const items = await client.query<{
      id: number;
      attempt_count: number;
      reservation_id: string | null;
      lease_expires_at: Date;
    }>(
      `SELECT id, attempt_count, reservation_id, lease_expires_at
       FROM ai_enhancement_job_items
       WHERE job_id = $1 AND batch_key = $2 AND lease_token = $3
         AND status = 'processing'
       FOR UPDATE`,
      [input.jobId, input.batchKey, input.leaseToken],
    );
    if (items.rows.length === 0) throw new AiEnhancementClaimStaleError();
    const clock = await client.query<{ now: Date }>(
      `SELECT clock_timestamp() AS now`,
    );
    const now = clock.rows[0]!.now;
    if (items.rows.some((item) => item.lease_expires_at <= now)) {
      throw new AiEnhancementClaimStaleError();
    }
    const alreadyAttached = items.rows.every(
      (item) =>
        item.attempt_count === 1 && item.reservation_id === input.reservationId,
    );
    if (alreadyAttached) {
      await client.query("COMMIT");
      return items.rows.length;
    }
    if (
      items.rows.some(
        (item) => item.attempt_count !== 0 || item.reservation_id !== null,
      )
    ) {
      throw new AiEnhancementJobInvariantError(
        "Enhancement claim has inconsistent authorization state",
      );
    }
    const updated = await client.query<{ id: number }>(
      `UPDATE ai_enhancement_job_items
       SET attempt_count = 1, reservation_id = $4, updated_at = $5
       WHERE job_id = $1 AND batch_key = $2 AND lease_token = $3
         AND status = 'processing'
       RETURNING id`,
      [
        input.jobId,
        input.batchKey,
        input.leaseToken,
        input.reservationId,
        now,
      ],
    );
    if (updated.rows.length !== items.rows.length) {
      throw new AiEnhancementJobInvariantError(
        "Enhancement authorization did not cover the full claim",
      );
    }
    await client.query("COMMIT");
    return updated.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createAiEnhancementJob(input: {
  userId: number;
  uploadId: number;
  idempotencyKey: string;
}): Promise<AiEnhancementJobView> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.uploadId, "uploadId");
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [
      USER_JOB_LOCK_NAMESPACE,
      input.userId,
    ]);

    const idempotent = await findIdempotentJob(
      client,
      input.userId,
      idempotencyKey,
    );
    if (idempotent) {
      if (idempotent.upload_id !== input.uploadId) {
        throw new AiEnhancementIdempotencyMismatchError();
      }
      await client.query("COMMIT");
      return toJobView(idempotent);
    }

    const upload = await client.query<{
      account_id: number;
      status: string;
    }>(
      `SELECT account_id, status FROM uploads
       WHERE id = $1 AND user_id = $2
       FOR SHARE`,
      [input.uploadId, input.userId],
    );
    if (upload.rows.length === 0) {
      throw new AiEnhancementUploadNotFoundError();
    }
    if (upload.rows[0]!.status !== "complete") {
      throw new AiEnhancementUploadNotReadyError();
    }

    const active = await client.query<{ id: number }>(
      `SELECT id FROM ai_enhancement_jobs
       WHERE user_id = $1
         AND status IN ('queued', 'processing', 'budget_blocked')
       LIMIT 1`,
      [input.userId],
    );
    if (active.rows[0]) {
      throw new AiEnhancementActiveJobError(active.rows[0].id);
    }

    const jobsToday = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_enhancement_jobs
       WHERE user_id = $1
         AND created_at >= date_trunc('day', clock_timestamp())`,
      [input.userId],
    );
    if (
      Number(jobsToday.rows[0]!.count) >= AI_ENHANCEMENT_MAX_JOBS_PER_USER_DAY
    ) {
      throw new AiEnhancementDailyJobLimitError();
    }

    const unresolved = unresolvedSummary(
      await listUnresolvedRows(client, input.userId, input.uploadId),
    );
    const representatives = new Map(
      [...unresolved.representatives].slice(
        0,
        AI_ENHANCEMENT_MAX_MERCHANTS_PER_JOB,
      ),
    );
    if (representatives.size === 0) {
      throw new AiEnhancementNotNeededError();
    }

    const perBatchMaximum = calculateMaximumRequestCostMicrousd(
      AI_ENHANCEMENT_MODEL,
      "transaction_classification",
    ).costMicrousd;
    const estimatedMaxCostMicrousd =
      Math.ceil(representatives.size / AI_ENHANCEMENT_BATCH_SIZE) *
      perBatchMaximum;
    const insertedJob = await client.query<JobRow>(
      `INSERT INTO ai_enhancement_jobs (
         user_id, upload_id, account_id, kind, status, idempotency_key,
         total_merchants, estimated_max_cost_microusd
       ) VALUES ($1, $2, $3, 'transaction_classification', 'queued', $4, $5, $6)
       RETURNING ${JOB_COLUMNS}`,
      [
        input.userId,
        input.uploadId,
        upload.rows[0]!.account_id,
        idempotencyKey,
        representatives.size,
        estimatedMaxCostMicrousd,
      ],
    );
    const job = insertedJob.rows[0]!;

    const snapshot = [...representatives];
    await client.query(
      `INSERT INTO ai_enhancement_job_items (
         job_id, merchant_key, representative_transaction_id, status
       )
       SELECT $1, snapshot.merchant_key, snapshot.transaction_id, 'pending'
       FROM unnest($2::text[], $3::int[])
         AS snapshot(merchant_key, transaction_id)`,
      [
        job.id,
        snapshot.map(([merchantKey]) => merchantKey),
        snapshot.map(([, transactionId]) => transactionId),
      ],
    );

    await client.query("COMMIT");
    return toJobView(job);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
