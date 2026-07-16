import type pg from "pg";

import { V1_CATEGORIES } from "../shared/schema.js";
import {
  AiBudgetExceededError,
  reconcileAiBudgetReservation,
  reserveAiBudget,
} from "./aiAccounting.js";
import {
  acquireAiConcurrencyLease,
  releaseAiConcurrencyLease,
} from "./aiConcurrencyLease.js";
import {
  AI_ENHANCEMENT_MODEL,
  AiEnhancementJobNotFoundError,
  claimAiEnhancementBatch,
  enhancementMerchantKey,
  getAiEnhancementJobForUser,
  attachAiEnhancementReservation,
  type AiEnhancementClaimItem,
  type AiEnhancementJobView,
} from "./aiEnhancementJobs.js";
import { pool } from "./db.js";
import {
  executeOpenAiStructuredRequest,
  ProviderInputTooLargeError,
  type OpenAiChatTransport,
  type OpenAiStructuredRequest,
} from "./openaiProvider.js";
import { reconcileAiTransactionClassification } from "./transactionDirection.js";

type EnhancementVerdict = {
  itemId: number;
  category: string;
  transactionClass: "income" | "expense" | "transfer" | "refund";
  recurrenceType: "recurring" | "one-time";
  labelConfidence: number;
  labelReason: string;
};

type RepresentativeInput = {
  itemId: number;
  merchantKey: string;
  merchant: string;
  rawDescription: string;
  amount: number;
  flowType: "inflow" | "outflow";
};

type Resolution = {
  category: string;
  transactionClass: string;
  recurrenceType: string;
  labelConfidence: number;
  source: "rule" | "manual-cache" | "cache";
};

type TransactionRow = {
  id: number;
  merchant: string;
  raw_description: string;
  amount: string;
  flow_type: string;
  transaction_class: string;
  category: string;
  label_source: string;
  user_corrected: boolean;
  ai_assisted: boolean;
};

export type ProcessAiEnhancementBatchResult = {
  state:
    | "complete"
    | "processed"
    | "busy"
    | "budget_blocked"
    | "cancelled";
  job: AiEnhancementJobView;
};

export type ProcessAiEnhancementBatchInput = {
  userId: number;
  jobId: number;
  transport: OpenAiChatTransport;
  providerEnabled: boolean;
  signal?: AbortSignal;
  leaseProvider?: AiEnhancementLeaseProvider;
  hooks?: {
    afterResultsPersisted?: () => void | Promise<void>;
    beforeProvider?: () => void | Promise<void>;
  };
};

export type AiEnhancementLeaseProvider = {
  acquire: typeof acquireAiConcurrencyLease;
  release: typeof releaseAiConcurrencyLease;
};

const DEFAULT_LEASE_PROVIDER: AiEnhancementLeaseProvider = {
  acquire: acquireAiConcurrencyLease,
  release: releaseAiConcurrencyLease,
};

const ALLOWED_CLASSES = new Set(["income", "expense", "transfer", "refund"]);
const ALLOWED_RECURRENCE = new Set(["recurring", "one-time"]);
const ALLOWED_CATEGORIES = new Set<string>(V1_CATEGORIES);

function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("classification result must be an object");
  }
  return value as Record<string, unknown>;
}

function validateVerdicts(value: unknown): EnhancementVerdict[] {
  const root = asRecord(value);
  if (!Array.isArray(root.results)) throw new Error("results must be an array");
  const seen = new Set<number>();
  return root.results.map((raw) => {
    const row = asRecord(raw);
    if (!Number.isSafeInteger(row.itemId) || Number(row.itemId) <= 0) {
      throw new Error("itemId must be a positive integer");
    }
    const itemId = Number(row.itemId);
    if (seen.has(itemId)) throw new Error("duplicate itemId in provider result");
    seen.add(itemId);
    if (typeof row.category !== "string" || !ALLOWED_CATEGORIES.has(row.category)) {
      throw new Error("category is invalid");
    }
    if (
      typeof row.transactionClass !== "string" ||
      !ALLOWED_CLASSES.has(row.transactionClass)
    ) {
      throw new Error("transactionClass is invalid");
    }
    if (
      typeof row.recurrenceType !== "string" ||
      !ALLOWED_RECURRENCE.has(row.recurrenceType)
    ) {
      throw new Error("recurrenceType is invalid");
    }
    if (
      typeof row.labelConfidence !== "number" ||
      !Number.isFinite(row.labelConfidence) ||
      row.labelConfidence < 0 ||
      row.labelConfidence > 1
    ) {
      throw new Error("labelConfidence is invalid");
    }
    if (
      typeof row.labelReason !== "string" ||
      row.labelReason.trim() === "" ||
      row.labelReason.length > 160
    ) {
      throw new Error("labelReason is invalid");
    }
    return {
      itemId,
      category: row.category,
      transactionClass: row.transactionClass as EnhancementVerdict["transactionClass"],
      recurrenceType: row.recurrenceType as EnhancementVerdict["recurrenceType"],
      labelConfidence: row.labelConfidence,
      labelReason: row.labelReason.trim(),
    };
  });
}

const RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "pocketpulse_enhancement_batch",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              itemId: { type: "integer" },
              category: { type: "string", enum: [...V1_CATEGORIES] },
              transactionClass: {
                type: "string",
                enum: ["income", "expense", "transfer", "refund"],
              },
              recurrenceType: { type: "string", enum: ["recurring", "one-time"] },
              labelConfidence: { type: "number", minimum: 0, maximum: 1 },
              labelReason: { type: "string", maxLength: 160 },
            },
            required: [
              "itemId",
              "category",
              "transactionClass",
              "recurrenceType",
              "labelConfidence",
              "labelReason",
            ],
          },
        },
      },
      required: ["results"],
    },
  },
};

function providerRequest(inputs: RepresentativeInput[]): OpenAiStructuredRequest<EnhancementVerdict[]> {
  return {
    operation: "transaction_classification",
    model: AI_ENHANCEMENT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Classify each financial transaction. Preserve itemId. Use the supplied category enum. Transfers move money without spending; refunds reverse prior spending; recurring means a subscription or predictable obligation. Return one result per input and no commentary.",
      },
      {
        role: "user",
        content: JSON.stringify({
          transactions: inputs.map((input) => ({
            itemId: input.itemId,
            merchant: input.merchant.slice(0, 80),
            description: input.rawDescription.slice(0, 120),
            amount: input.amount,
            flowType: input.flowType,
          })),
        }),
      },
    ],
    responseFormat: RESPONSE_FORMAT,
    validate: validateVerdicts,
  };
}

async function loadJobAttribution(userId: number, jobId: number): Promise<{
  accountId: number;
  uploadId: number;
}> {
  const result = await pool.query<{ account_id: number; upload_id: number }>(
    `SELECT account_id, upload_id FROM ai_enhancement_jobs
     WHERE id = $1 AND user_id = $2`,
    [jobId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new AiEnhancementJobNotFoundError();
  return { accountId: row.account_id, uploadId: row.upload_id };
}

function eligible(row: TransactionRow): boolean {
  return (
    row.ai_assisted &&
    !row.user_corrected &&
    !["manual", "propagated", "ai"].includes(row.label_source)
  );
}

async function finishJobRollup(userId: number, jobId: number): Promise<AiEnhancementJobView> {
  await pool.query(
    `WITH counts AS (
       SELECT
         COUNT(*) FILTER (WHERE status = 'complete')::int AS completed,
         COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
         COUNT(*) FILTER (WHERE status = 'result_ready')::int AS ready
       FROM ai_enhancement_job_items WHERE job_id = $1
     ), cost AS (
       SELECT COALESCE(SUM(final_cost_microusd), 0)::bigint AS actual
       FROM ai_usage_events WHERE job_id = $1
     )
     UPDATE ai_enhancement_jobs j
     SET completed_merchants = counts.completed,
         skipped_merchants = counts.skipped,
         failed_merchants = counts.failed,
         actual_cost_microusd = cost.actual,
         status = CASE
           WHEN j.status = 'cancelled' THEN 'cancelled'
           WHEN counts.pending + counts.processing + counts.ready = 0 THEN
             CASE WHEN counts.failed > 0 AND counts.completed + counts.skipped > 0 THEN 'partial'
                  WHEN counts.failed > 0 THEN 'failed' ELSE 'complete' END
           WHEN j.status = 'budget_blocked' THEN 'budget_blocked'
           WHEN counts.processing + counts.ready > 0 THEN 'processing'
           ELSE 'queued'
         END,
         completed_at = CASE
           WHEN j.status <> 'cancelled' AND counts.pending + counts.processing + counts.ready = 0
             THEN COALESCE(j.completed_at, clock_timestamp())
           ELSE j.completed_at
         END,
         updated_at = clock_timestamp()
     FROM counts, cost WHERE j.id = $1`,
    [jobId],
  );
  const job = await getAiEnhancementJobForUser(userId, jobId);
  if (!job) throw new AiEnhancementJobNotFoundError();
  return job;
}

async function freeEvidencePreflight(input: {
  userId: number;
  jobId: number;
  uploadId: number;
  items: AiEnhancementClaimItem[];
}): Promise<RepresentativeInput[]> {
  const keys = input.items.map((item) => item.merchantKey);
  const [rules, caches, transactionResult] = await Promise.all([
    pool.query<{
      merchant_key: string;
      category: string | null;
      transaction_class: string | null;
      recurrence_type: string | null;
    }>(
      `SELECT merchant_key, category, transaction_class, recurrence_type
       FROM merchant_rules WHERE user_id = $1 AND merchant_key = ANY($2::text[])`,
      [input.userId, keys],
    ),
    pool.query<{
      merchant_key: string;
      category: string;
      transaction_class: string;
      recurrence_type: string;
      label_confidence: string;
      source: string;
    }>(
      `SELECT merchant_key, category, transaction_class, recurrence_type,
              label_confidence, source
       FROM merchant_classifications
       WHERE user_id = $1 AND merchant_key = ANY($2::text[])`,
      [input.userId, keys],
    ),
    pool.query<TransactionRow>(
      `SELECT id, merchant, raw_description, amount::text, flow_type,
              transaction_class, category, label_source, user_corrected, ai_assisted
       FROM transactions WHERE user_id = $1 AND upload_id = $2 ORDER BY id`,
      [input.userId, input.uploadId],
    ),
  ]);
  const ruleMap = new Map(
    rules.rows.map((row) => [
      row.merchant_key,
      row.category && row.transaction_class && row.recurrence_type
        ? {
            category: row.category,
            transactionClass: row.transaction_class,
            recurrenceType: row.recurrence_type,
            labelConfidence: 1,
            source: "rule" as const,
          }
        : null,
    ]),
  );
  const cacheMap = new Map(
    caches.rows.map((row) => [
      row.merchant_key,
      {
        category: row.category,
        transactionClass: row.transaction_class,
        recurrenceType: row.recurrence_type,
        labelConfidence: Number(row.label_confidence),
        source: row.source === "manual" ? ("manual-cache" as const) : ("cache" as const),
      },
    ]),
  );
  const grouped = new Map<string, TransactionRow[]>();
  for (const row of transactionResult.rows) {
    const key = enhancementMerchantKey(row.merchant);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const remaining: RepresentativeInput[] = [];
  for (const item of input.items) {
    const rows = (grouped.get(item.merchantKey) ?? []).filter(eligible);
    const resolution = ruleMap.get(item.merchantKey) ?? cacheMap.get(item.merchantKey);
    if (resolution || rows.length === 0) {
      await applyFreeResolution({
        userId: input.userId,
        jobId: input.jobId,
        item,
        rows,
        resolution: resolution ?? null,
      });
      continue;
    }
    const representative = rows[0]!;
    remaining.push({
      itemId: item.id,
      merchantKey: item.merchantKey,
      merchant: representative.merchant,
      rawDescription: representative.raw_description,
      amount: Number(representative.amount),
      flowType: representative.flow_type === "inflow" ? "inflow" : "outflow",
    });
  }
  return remaining;
}

async function applyFreeResolution(input: {
  userId: number;
  jobId: number;
  item: AiEnhancementClaimItem;
  rows: TransactionRow[];
  resolution: Resolution | null;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string }>(
      `SELECT status FROM ai_enhancement_job_items
       WHERE id = $1 AND job_id = $2 FOR UPDATE`,
      [input.item.id, input.jobId],
    );
    if (locked.rows[0]?.status !== "processing") {
      await client.query("ROLLBACK");
      return;
    }
    if (input.resolution && input.rows.length > 0) {
      const ids = input.rows.map((row) => row.id);
      const labelSource = input.resolution.source === "cache" ? "cache" : "propagated";
      await client.query(
        `UPDATE transactions
         SET category = $1, transaction_class = $2, recurrence_type = $3,
             recurrence_source = CASE WHEN $3 = 'recurring' THEN 'hint' ELSE 'none' END,
             label_source = $4, label_confidence = $5,
             label_reason = 'Resolved from saved merchant knowledge',
             ai_assisted = false
         WHERE user_id = $6 AND id = ANY($7::int[])
           AND user_corrected = false
           AND label_source NOT IN ('manual', 'propagated', 'ai')`,
        [
          input.resolution.category,
          input.resolution.transactionClass,
          input.resolution.recurrenceType,
          labelSource,
          input.resolution.labelConfidence.toFixed(2),
          input.userId,
          ids,
        ],
      );
    }
    await client.query(
      `UPDATE ai_enhancement_job_items
       SET status = 'skipped', internal_error_code = $2,
           lease_token = NULL, lease_expires_at = NULL,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1`,
      [input.item.id, input.resolution ? "FREE_EVIDENCE" : "NO_ELIGIBLE_TRANSACTIONS"],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function returnClaimToPending(input: {
  jobId: number;
  batchKey: string;
  leaseToken: string;
  budgetBlocked?: boolean;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE ai_enhancement_job_items
       SET status = 'pending', batch_key = NULL, lease_token = NULL,
           lease_expires_at = NULL, reservation_id = NULL,
           updated_at = clock_timestamp()
       WHERE job_id = $1 AND batch_key = $2 AND lease_token = $3
         AND status = 'processing' AND attempt_count = 0`,
      [input.jobId, input.batchKey, input.leaseToken],
    );
    await client.query(
      `UPDATE ai_enhancement_jobs SET status = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND status <> 'cancelled'`,
      [input.jobId, input.budgetBlocked ? "budget_blocked" : "queued"],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resetReleasedAuthorizedClaim(input: {
  jobId: number;
  batchKey: string;
  leaseToken: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reservation = await client.query<{ status: string }>(
      `SELECT status FROM ai_budget_reservations WHERE id = $1 FOR SHARE`,
      [input.batchKey],
    );
    if (reservation.rows[0]?.status !== "released") {
      throw new Error("Only a released authorization can be returned to pending");
    }
    await client.query(
      `UPDATE ai_enhancement_job_items
       SET status = 'pending', attempt_count = 0, batch_key = NULL,
           lease_token = NULL, lease_expires_at = NULL, reservation_id = NULL,
           updated_at = clock_timestamp()
       WHERE job_id = $1 AND batch_key = $2 AND lease_token = $3
         AND status = 'processing' AND attempt_count = 1
         AND reservation_id = $2`,
      [input.jobId, input.batchKey, input.leaseToken],
    );
    await client.query(
      `UPDATE ai_enhancement_jobs SET status = 'queued', updated_at = clock_timestamp()
       WHERE id = $1 AND status <> 'cancelled'`,
      [input.jobId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistProviderResults(input: {
  jobId: number;
  batchKey: string;
  leaseToken: string;
  expectedItemIds: number[];
  verdicts: EnhancementVerdict[];
}): Promise<void> {
  const verdicts = new Map(input.verdicts.map((verdict) => [verdict.itemId, verdict]));
  if (input.verdicts.some((verdict) => !input.expectedItemIds.includes(verdict.itemId))) {
    throw new Error("provider returned an item outside the authorized batch");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const items = await client.query<{ id: number }>(
      `SELECT id FROM ai_enhancement_job_items
       WHERE job_id = $1 AND batch_key = $2 AND lease_token = $3
         AND status = 'processing' FOR UPDATE`,
      [input.jobId, input.batchKey, input.leaseToken],
    );
    const liveIds = new Set(items.rows.map((row) => row.id));
    for (const itemId of input.expectedItemIds) {
      if (!liveIds.has(itemId)) throw new Error("enhancement batch claim became stale");
      const verdict = verdicts.get(itemId);
      if (!verdict) {
        await client.query(
          `UPDATE ai_enhancement_job_items
           SET status = 'failed', internal_error_code = 'PROVIDER_RESULT_MISSING',
               lease_token = NULL, lease_expires_at = NULL,
               completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = $1`,
          [itemId],
        );
        continue;
      }
      await client.query(
        `UPDATE ai_enhancement_job_items
         SET status = 'result_ready', result_category = $2,
             result_transaction_class = $3, result_recurrence_type = $4,
             result_confidence = $5, result_reason = $6,
             lease_token = NULL, lease_expires_at = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [
          itemId,
          verdict.category,
          verdict.transactionClass,
          verdict.recurrenceType,
          verdict.labelConfidence.toFixed(2),
          verdict.labelReason,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failAuthorizedClaim(input: {
  jobId: number;
  batchKey: string;
  errorCode: string;
}): Promise<void> {
  await pool.query(
    `UPDATE ai_enhancement_job_items
     SET status = 'failed', internal_error_code = $3,
         lease_token = NULL, lease_expires_at = NULL,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE job_id = $1 AND batch_key = $2 AND status = 'processing'`,
    [input.jobId, input.batchKey, input.errorCode],
  );
}

async function skipAuthorizedClaim(input: {
  jobId: number;
  batchKey: string;
  errorCode: string;
}): Promise<void> {
  await pool.query(
    `UPDATE ai_enhancement_job_items
     SET status = 'skipped', internal_error_code = $3,
         lease_token = NULL, lease_expires_at = NULL,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE job_id = $1 AND batch_key = $2 AND status = 'processing'`,
    [input.jobId, input.batchKey, input.errorCode],
  );
}

async function applyResultReady(userId: number, jobId: number): Promise<void> {
  const attribution = await loadJobAttribution(userId, jobId);
  const ready = await pool.query<{
    id: number;
    merchant_key: string;
    result_category: string;
    result_transaction_class: string;
    result_recurrence_type: string;
    result_confidence: string;
    result_reason: string;
  }>(
    `SELECT id, merchant_key, result_category, result_transaction_class,
            result_recurrence_type, result_confidence::text, result_reason
     FROM ai_enhancement_job_items
     WHERE job_id = $1 AND status = 'result_ready' ORDER BY id`,
    [jobId],
  );
  for (const item of ready.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lockedItem = await client.query<{ status: string }>(
        `SELECT status FROM ai_enhancement_job_items WHERE id = $1 FOR UPDATE`,
        [item.id],
      );
      if (lockedItem.rows[0]?.status !== "result_ready") {
        await client.query("ROLLBACK");
        continue;
      }
      const rule = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM merchant_rules WHERE user_id = $1 AND merchant_key = $2
         ) AS exists`,
        [userId, item.merchant_key],
      );
      const txResult = await client.query<TransactionRow>(
        `SELECT id, merchant, raw_description, amount::text, flow_type,
                transaction_class, category, label_source, user_corrected, ai_assisted
         FROM transactions WHERE user_id = $1 AND upload_id = $2 FOR UPDATE`,
        [userId, attribution.uploadId],
      );
      const matching = txResult.rows.filter(
        (row) => eligible(row) && enhancementMerchantKey(row.merchant) === item.merchant_key,
      );
      if (rule.rows[0]!.exists || matching.length === 0) {
        await client.query(
          `UPDATE ai_enhancement_job_items
           SET status = 'skipped', internal_error_code = 'OVERRIDDEN_BEFORE_FANOUT',
               completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = $1`,
          [item.id],
        );
        await client.query("COMMIT");
        continue;
      }
      for (const row of matching) {
        const directional = reconcileAiTransactionClassification({
          flowType: row.flow_type === "inflow" ? "inflow" : "outflow",
          currentClass: row.transaction_class,
          currentCategory: row.category,
          currentClassEvidence: "provisional",
          proposedClass: item.result_transaction_class,
          proposedCategory: item.result_category,
        });
        await client.query(
          `UPDATE transactions
           SET transaction_class = $2, category = $3, recurrence_type = $4,
               recurrence_source = CASE WHEN $4 = 'recurring' THEN 'hint' ELSE 'none' END,
               label_source = 'ai', label_confidence = $5, label_reason = $6,
               ai_assisted = true
           WHERE id = $1 AND user_id = $7 AND user_corrected = false
             AND label_source NOT IN ('manual', 'propagated', 'ai')`,
          [
            row.id,
            directional.transactionClass,
            directional.category,
            item.result_recurrence_type,
            item.result_confidence,
            item.result_reason,
            userId,
          ],
        );
      }
      if (Number(item.result_confidence) >= 0.7) {
        const sample = matching[0]!;
        const directional = reconcileAiTransactionClassification({
          flowType: sample.flow_type === "inflow" ? "inflow" : "outflow",
          currentClass: sample.transaction_class,
          currentCategory: sample.category,
          currentClassEvidence: "provisional",
          proposedClass: item.result_transaction_class,
          proposedCategory: item.result_category,
        });
        await client.query(
          `INSERT INTO merchant_classifications (
             user_id, merchant_key, category, transaction_class,
             recurrence_type, label_confidence, source, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'ai', clock_timestamp())
           ON CONFLICT (user_id, merchant_key) DO UPDATE SET
             category = EXCLUDED.category,
             transaction_class = EXCLUDED.transaction_class,
             recurrence_type = EXCLUDED.recurrence_type,
             label_confidence = EXCLUDED.label_confidence,
             source = 'ai', updated_at = clock_timestamp()
           WHERE merchant_classifications.source <> 'manual'`,
          [
            userId,
            item.merchant_key,
            directional.category,
            directional.transactionClass,
            item.result_recurrence_type,
            item.result_confidence,
          ],
        );
      }
      await client.query(
        `UPDATE ai_enhancement_job_items
         SET status = 'complete', completed_at = clock_timestamp(),
             updated_at = clock_timestamp() WHERE id = $1`,
        [item.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function processAiEnhancementBatch(
  input: ProcessAiEnhancementBatchInput,
): Promise<ProcessAiEnhancementBatchResult> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.jobId, "jobId");
  if (!input.providerEnabled) throw new Error("Paid AI provider requests are disabled");

  const attribution = await loadJobAttribution(input.userId, input.jobId);
  const claim = await claimAiEnhancementBatch({ userId: input.userId, jobId: input.jobId });
  for (const reservationId of claim.unknownReservationIds) {
    await reconcileAiBudgetReservation({
      reservationId,
      outcome: { type: "reserved_unknown", errorCode: "UNKNOWN_PROVIDER_OUTCOME" },
    });
  }
  if (claim.state === "terminal") {
    return {
      state: claim.job.status === "cancelled" ? "cancelled" : "complete",
      job: claim.job,
    };
  }
  if (claim.state === "busy") return { state: "busy", job: claim.job };
  if (claim.state === "result_ready") {
    await applyResultReady(input.userId, input.jobId);
    return { state: "processed", job: await finishJobRollup(input.userId, input.jobId) };
  }
  if (claim.state === "empty") {
    return { state: "complete", job: await finishJobRollup(input.userId, input.jobId) };
  }
  if (claim.state !== "claimed") {
    throw new Error("Enhancement claim entered an unsupported state");
  }

  let providerInputs = await freeEvidencePreflight({
    userId: input.userId,
    jobId: input.jobId,
    uploadId: attribution.uploadId,
    items: claim.items,
  });
  if (providerInputs.length === 0) {
    return { state: "complete", job: await finishJobRollup(input.userId, input.jobId) };
  }

  const holderKey = `enhancement-job:${input.jobId}:${claim.batchKey}`;
  const leaseProvider = input.leaseProvider ?? DEFAULT_LEASE_PROVIDER;
  let concurrencyLeaseId: string | null = null;
  let reserved = false;
  let attached = false;
  let providerStarted = false;
  try {
    try {
      await reserveAiBudget({
        reservationId: claim.batchKey,
        userId: input.userId,
        accountId: attribution.accountId,
        uploadId: attribution.uploadId,
        jobId: input.jobId,
        operation: "transaction_classification",
        model: AI_ENHANCEMENT_MODEL,
      });
      reserved = true;
    } catch (error) {
      if (error instanceof AiBudgetExceededError) {
        await returnClaimToPending({
          jobId: input.jobId,
          batchKey: claim.batchKey,
          leaseToken: claim.leaseToken,
          budgetBlocked: true,
        });
        return {
          state: "budget_blocked",
          job: await finishJobRollup(input.userId, input.jobId),
        };
      }
      throw error;
    }
    await attachAiEnhancementReservation({
      userId: input.userId,
      jobId: input.jobId,
      batchKey: claim.batchKey,
      leaseToken: claim.leaseToken,
      reservationId: claim.batchKey,
    });
    attached = true;

    // Deliberate second check immediately before the provider boundary. A user
    // correction saved while the reservation was being acquired still wins.
    providerInputs = await freeEvidencePreflight({
      userId: input.userId,
      jobId: input.jobId,
      uploadId: attribution.uploadId,
      items: claim.items.filter((item) =>
        providerInputs.some((candidate) => candidate.itemId === item.id),
      ),
    });
    if (providerInputs.length === 0) {
      await reconcileAiBudgetReservation({
        reservationId: claim.batchKey,
        outcome: { type: "released", errorCode: "RESOLVED_BEFORE_PROVIDER" },
      });
      return { state: "complete", job: await finishJobRollup(input.userId, input.jobId) };
    }

    await input.hooks?.beforeProvider?.();
    const currentJob = await getAiEnhancementJobForUser(input.userId, input.jobId);
    if (currentJob?.status === "cancelled") {
      await reconcileAiBudgetReservation({
        reservationId: claim.batchKey,
        outcome: { type: "released", errorCode: "CANCELLED_BEFORE_PROVIDER" },
      });
      await skipAuthorizedClaim({
        jobId: input.jobId,
        batchKey: claim.batchKey,
        errorCode: "CANCELLED_BEFORE_PROVIDER",
      });
      return { state: "cancelled", job: await finishJobRollup(input.userId, input.jobId) };
    }

    const concurrency = await leaseProvider.acquire({ holderKey });
    if (!concurrency.acquired || !concurrency.leaseId) {
      await reconcileAiBudgetReservation({
        reservationId: claim.batchKey,
        outcome: { type: "released", errorCode: "PROVIDER_CAPACITY_BUSY" },
      });
      await resetReleasedAuthorizedClaim({
        jobId: input.jobId,
        batchKey: claim.batchKey,
        leaseToken: claim.leaseToken,
      });
      return { state: "busy", job: await finishJobRollup(input.userId, input.jobId) };
    }
    concurrencyLeaseId = concurrency.leaseId;

    providerStarted = true;
    const result = await executeOpenAiStructuredRequest(providerRequest(providerInputs), {
      transport: input.transport,
      isEnabled: true,
      signal: input.signal,
    });
    await reconcileAiBudgetReservation({
      reservationId: claim.batchKey,
      outcome: {
        type: "actual",
        attemptStatus: "succeeded",
        providerRequestId: result.providerRequestId,
        latencyMs: result.latencyMs,
        usage: result.usage,
      },
    });
    await persistProviderResults({
      jobId: input.jobId,
      batchKey: claim.batchKey,
      leaseToken: claim.leaseToken,
      expectedItemIds: providerInputs.map((item) => item.itemId),
      verdicts: result.data,
    });
    await input.hooks?.afterResultsPersisted?.();
    await applyResultReady(input.userId, input.jobId);
    return { state: "processed", job: await finishJobRollup(input.userId, input.jobId) };
  } catch (error) {
    if (reserved && !attached) {
      await reconcileAiBudgetReservation({
        reservationId: claim.batchKey,
        outcome: { type: "released", errorCode: "AUTHORIZATION_NOT_ATTACHED" },
      });
    } else if (attached) {
      const safeRelease = !providerStarted || error instanceof ProviderInputTooLargeError;
      await reconcileAiBudgetReservation({
        reservationId: claim.batchKey,
        outcome: safeRelease
          ? { type: "released", errorCode: "PROVIDER_INPUT_REJECTED" }
          : { type: "reserved_unknown", errorCode: "PROVIDER_OUTCOME_UNKNOWN" },
      });
      if (safeRelease) {
        await resetReleasedAuthorizedClaim({
          jobId: input.jobId,
          batchKey: claim.batchKey,
          leaseToken: claim.leaseToken,
        });
      } else {
        await failAuthorizedClaim({
          jobId: input.jobId,
          batchKey: claim.batchKey,
          errorCode: "PROVIDER_OUTCOME_UNKNOWN",
        });
      }
    }
    throw error;
  } finally {
    if (concurrencyLeaseId) {
      await leaseProvider.release({ leaseId: concurrencyLeaseId, holderKey });
    }
  }
}
