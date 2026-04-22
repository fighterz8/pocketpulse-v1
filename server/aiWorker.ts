/**
 * Async AI classification worker.
 *
 * Runs as a fire-and-forget background task after the upload handler has
 * returned its HTTP response to the user. For one (userId, uploadId) the
 * worker:
 *
 *   1. Loads every transaction the pipeline flagged as wanting AI
 *      (aiAssisted=true AND labelSource != 'ai').
 *   2. Marks the upload `ai_status='processing'` and stamps `ai_started_at`.
 *   3. Processes the pool in chunks of WORKER_CHUNK_SIZE (25), calling the
 *      AI batch with a generous per-chunk timeout (~600s — the worker is
 *      not user-blocking).
 *   4. Updates each row in place with the AI verdict and writes successful
 *      results back to the merchant cache so future uploads of the same
 *      merchant are resolved synchronously.
 *   5. Bumps `ai_rows_done` after each chunk so status pollers see
 *      monotonic progress.
 *   6. On terminal completion sets `ai_status='complete'` and stamps
 *      `ai_completed_at`. On unrecoverable failure sets `ai_status='failed'`
 *      with `ai_error` populated.
 *
 * Concurrency: a per-uploadId in-flight set guards against double-spawning
 * (e.g. the upload handler firing the worker while the startup sweep also
 * picks up the same upload). The worker never throws — all errors are
 * captured and surfaced via `ai_status='failed'`.
 */

import {
  aiClassifyBatch,
  type AiClassificationInput,
  type AiClassificationResult,
} from "./ai-classifier.js";
import { recurrenceKey } from "./recurrenceDetector.js";
import {
  batchUpsertMerchantClassifications,
  bulkUpdateTransactions,
  countNeedsAiForUpload,
  getUserCorrectionExamples,
  incrementUploadAiRowsDone,
  listNeedsAiTransactionsForUpload,
  updateUploadAiStatus,
  type BulkTransactionUpdate,
} from "./storage.js";
import type { MerchantClassification } from "../shared/schema.js";

/** Rows per AI batch call. Matches the chunk size in ai-classifier.ts. */
const WORKER_CHUNK_SIZE = 25;
/** Per-chunk AI timeout — generous because the worker isn't user-blocking. */
const WORKER_AI_TIMEOUT_MS = 600_000;
/** Cache writeback floor — mirrors classifyPipeline default. */
const CACHE_WRITE_MIN_CONFIDENCE = 0.7;

/** Active uploads currently being processed by this server instance. */
const inFlight = new Set<number>();

/** Snapshot of in-flight worker IDs (testing helper). */
export function _activeWorkerCount(): number {
  return inFlight.size;
}

export type WorkerOutcome = {
  uploadId: number;
  status: "complete" | "failed" | "skipped";
  rowsProcessed: number;
  error?: string;
};

/**
 * Run the AI worker for a single upload. Awaitable for callers that want
 * to coordinate (tests, the startup sweep that fires sequentially) but
 * the upload handler invokes it as fire-and-forget.
 *
 * Always resolves — never throws. Failures are captured into
 * `ai_status='failed'` so the request side never has to handle errors.
 */
export async function runUploadAiWorker(
  userId: number,
  uploadId: number,
): Promise<WorkerOutcome> {
  if (inFlight.has(uploadId)) {
    return { uploadId, status: "skipped", rowsProcessed: 0, error: "already in flight" };
  }
  inFlight.add(uploadId);

  try {
    // Refresh the pool from the DB rather than trusting the caller's count;
    // the caller may have raced with another worker run, and this also keeps
    // restart-recovery (sweep) honest.
    const remaining = await countNeedsAiForUpload(uploadId);
    if (remaining === 0) {
      await updateUploadAiStatus(uploadId, {
        aiStatus: "complete",
        aiRowsPending: 0,
        aiRowsDone: 0,
        aiCompletedAt: new Date(),
        aiError: null,
      });
      return { uploadId, status: "complete", rowsProcessed: 0 };
    }

    // Bail early when AI is unavailable. We deliberately do not fall
    // through to aiClassifyBatch because that returns an empty Map on
    // missing key — leaving every row "in progress" forever from the
    // user's perspective. Fail fast with a clear message instead.
    if (!process.env.OPENAI_API_KEY) {
      await updateUploadAiStatus(uploadId, {
        aiStatus: "failed",
        aiRowsPending: remaining,
        aiCompletedAt: new Date(),
        aiError: "AI unavailable: OPENAI_API_KEY is not set",
      });
      return {
        uploadId,
        status: "failed",
        rowsProcessed: 0,
        error: "OPENAI_API_KEY is not set",
      };
    }

    await updateUploadAiStatus(uploadId, {
      aiStatus: "processing",
      aiRowsPending: remaining,
      aiRowsDone: 0,
      aiStartedAt: new Date(),
      aiCompletedAt: null,
      aiError: null,
    });

    const rows = await listNeedsAiTransactionsForUpload(userId, uploadId);
    if (rows.length === 0) {
      // Defensive: countNeedsAiForUpload is unscoped while the row fetch
      // is user-scoped. If they ever diverge (e.g. cross-user upload id)
      // we still end on a self-consistent terminal state — pending=0,
      // aiStatus=complete — instead of "complete with N pending".
      await updateUploadAiStatus(uploadId, {
        aiStatus: "complete",
        aiRowsPending: 0,
        aiCompletedAt: new Date(),
      });
      return { uploadId, status: "complete", rowsProcessed: 0 };
    }

    // User corrections become few-shot examples for the AI prompt.
    // Fetched once, reused across every chunk.
    let userExamples: Awaited<ReturnType<typeof getUserCorrectionExamples>> = [];
    try {
      userExamples = await getUserCorrectionExamples(userId);
    } catch {
      // Non-fatal — the AI runs without correction context.
    }

    // `processedRows` counts ROWS PERSISTED with labelSource='ai' — the
    // metric that backs ai_rows_done and the per-upload progress bar. We
    // deliberately do NOT count rows whose chunk timed out, returned no
    // AI verdict, or failed to write back: from the user's perspective
    // those rows still need AI even if we attempted them.
    let processedRows = 0;
    let chunksAttempted = 0;
    let chunksSucceeded = 0;
    let chunkPersistError = false;
    let lastError: string | null = null;

    for (let offset = 0; offset < rows.length; offset += WORKER_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + WORKER_CHUNK_SIZE);
      chunksAttempted++;

      const aiInputs: AiClassificationInput[] = chunk.map((row, i) => ({
        index: i,
        merchant: row.merchant,
        rawDescription: row.rawDescription,
        amount: parseFloat(String(row.amount)),
        flowType: row.flowType === "inflow" ? "inflow" : "outflow",
      }));

      let aiResults = new Map<number, AiClassificationResult>();
      try {
        const timeout = new Promise<Map<number, AiClassificationResult>>((resolve) =>
          setTimeout(() => resolve(new Map()), WORKER_AI_TIMEOUT_MS),
        );
        aiResults = await Promise.race([
          aiClassifyBatch(aiInputs, userExamples),
          timeout,
        ]);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Chunk threw — count as attempted, do NOT advance progress (rows
        // still need AI). If every chunk fails this way we surface a
        // terminal "failed" status at the end.
        continue;
      }

      if (aiResults.size === 0) {
        // AI was unavailable / timed out for this chunk. Same treatment as
        // a thrown error: don't advance progress; let the per-chunk soft
        // failure aggregate into a terminal failed status.
        continue;
      }

      const updates: BulkTransactionUpdate[] = [];
      const cacheEntries: MerchantClassification[] = [];

      for (let i = 0; i < chunk.length; i++) {
        const row = chunk[i]!;
        const aiResult = aiResults.get(i);
        if (!aiResult) continue;

        updates.push({
          id: row.id,
          amount: String(row.amount),
          flowType: row.flowType,
          transactionClass: aiResult.transactionClass,
          category: aiResult.category,
          recurrenceType: aiResult.recurrenceType,
          recurrenceSource: "none",
          labelSource: "ai",
          labelConfidence: Number(aiResult.labelConfidence).toFixed(2),
          labelReason: String(aiResult.labelReason ?? `AI classified as ${aiResult.category}`),
          aiAssisted: true,
        });

        // Stage merchant cache writeback for confident AI verdicts so the
        // next upload of the same merchant resolves synchronously.
        const key = recurrenceKey(row.merchant);
        if (key && aiResult.labelConfidence >= CACHE_WRITE_MIN_CONFIDENCE) {
          cacheEntries.push({
            merchantKey: key,
            category: aiResult.category,
            transactionClass: aiResult.transactionClass,
            recurrenceType: aiResult.recurrenceType,
            labelConfidence: Number(aiResult.labelConfidence),
            source: "ai",
          });
        }
      }

      if (updates.length === 0) {
        // AI returned a non-empty map but every entry was missing/invalid
        // — same effect as an empty result.
        continue;
      }

      let persisted = false;
      try {
        await bulkUpdateTransactions(userId, updates);
        persisted = true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        chunkPersistError = true;
      }

      if (!persisted) {
        // DB write failed — do NOT mark this chunk as succeeded and do
        // NOT advance ai_rows_done. The rows are still in the needs-AI
        // pool from the user's perspective.
        continue;
      }

      chunksSucceeded++;

      if (cacheEntries.length > 0) {
        // Fire-and-forget — cache write failures must never break the worker.
        batchUpsertMerchantClassifications(userId, cacheEntries).catch(
          () => undefined,
        );
      }

      // Advance progress by the number of rows actually persisted with
      // labelSource='ai'. Skipped rows (no AI verdict for that index)
      // remain in the needs-AI pool and will be retried on the next
      // reclassify or re-upload.
      await incrementUploadAiRowsDone(uploadId, updates.length);
      processedRows += updates.length;
    }

    // Two terminal failure modes both end as ai_status='failed':
    //   • Every chunk failed to produce/persist any AI promotion — we
    //     captured zero successes despite attempting work.
    //   • At least one chunk's DB writeback failed (chunkPersistError) —
    //     the upload's AI state is now partial/unreliable. Surface this
    //     instead of returning a misleading "complete" with aiError=null.
    if (chunksAttempted > 0 && (chunksSucceeded === 0 || chunkPersistError)) {
      await updateUploadAiStatus(uploadId, {
        aiStatus: "failed",
        aiCompletedAt: new Date(),
        aiError:
          lastError ??
          (chunksSucceeded === 0
            ? "AI classification returned no results for any chunk"
            : "AI classification partially failed: one or more chunks did not persist"),
      });
      return {
        uploadId,
        status: "failed",
        rowsProcessed: processedRows,
        error: lastError ?? "ai worker failure",
      };
    }

    // Reconcile pending=done at success. AI may return a partial map for
    // a chunk (e.g. 23 verdicts for 25 rows) — those un-verdicted rows
    // are still in the needs-AI pool and will be picked up by the next
    // reclassify, but for THIS upload we're done attempting them. Setting
    // aiRowsPending = processedRows guarantees pollers always see a
    // self-consistent terminal state (pending == done at complete).
    await updateUploadAiStatus(uploadId, {
      aiStatus: "complete",
      aiRowsPending: processedRows,
      aiCompletedAt: new Date(),
      aiError: null,
    });
    return { uploadId, status: "complete", rowsProcessed: processedRows };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await updateUploadAiStatus(uploadId, {
        aiStatus: "failed",
        aiCompletedAt: new Date(),
        aiError: message,
      });
    } catch {
      // Even the failure write failed — nothing more we can do.
    }
    return { uploadId, status: "failed", rowsProcessed: 0, error: message };
  } finally {
    inFlight.delete(uploadId);
  }
}
