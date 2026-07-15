import type pg from "pg";

import type { AiEnhancementJobStatus } from "../shared/schema.js";
import { pool } from "./db.js";
import { calculateMaximumRequestCostMicrousd } from "./aiPricing.js";
import { recurrenceKey } from "./recurrenceDetector.js";

export const AI_ENHANCEMENT_MAX_MERCHANTS_PER_JOB = 250;
export const AI_ENHANCEMENT_BATCH_SIZE = 25;
export const AI_ENHANCEMENT_MAX_JOBS_PER_USER_DAY = 2;
export const AI_ENHANCEMENT_MODEL = "gpt-5-nano";

const USER_JOB_LOCK_NAMESPACE = 1_347_370_827;

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

    const unresolved = await client.query<UnresolvedRow>(
      `SELECT id, merchant FROM transactions
       WHERE user_id = $1 AND upload_id = $2
         AND ai_assisted = true
         AND label_source <> 'ai'
         AND label_source NOT IN ('manual', 'propagated')
         AND user_corrected = false
       ORDER BY id
       FOR SHARE`,
      [input.userId, input.uploadId],
    );

    const representatives = new Map<string, number>();
    for (const row of unresolved.rows) {
      const key = recurrenceKey(row.merchant);
      if (!key || representatives.has(key)) continue;
      representatives.set(key, row.id);
      if (representatives.size === AI_ENHANCEMENT_MAX_MERCHANTS_PER_JOB) break;
    }
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

    for (const [merchantKey, transactionId] of representatives) {
      await client.query(
        `INSERT INTO ai_enhancement_job_items (
           job_id, merchant_key, representative_transaction_id, status
         ) VALUES ($1, $2, $3, 'pending')`,
        [job.id, merchantKey, transactionId],
      );
    }

    await client.query("COMMIT");
    return toJobView(job);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
