/**
 * Shared classification pipeline: rules → user-rules → cache → AI → cache-writeback.
 *
 * This is the single source of truth for the multi-phase classification sequence
 * used by both the CSV upload handler (routes.ts) and the reclassify pass
 * (reclassify.ts). Neither caller contains classification logic — they only
 * supply inputs and consume outputs.
 *
 * Design constraints (non-negotiable):
 *   - No DB writes inside the pipeline. Callers own write operations.
 *   - User-rule and cache lookups happen inside (read-only, batched per call).
 *   - Cache writeback is fire-and-forget (.catch(() => undefined)); failures
 *     never propagate to the caller.
 *   - AI timeout and confidence thresholds are caller-supplied.
 */

import { classifyTransaction } from "./classifier.js";
import {
  aiClassifyBatch,
  type AiClassificationInput,
  type AiClassificationResult,
} from "./ai-classifier.js";
import {
  batchUpsertMerchantClassifications,
  getGlobalMerchantClassifications,
  getMerchantClassifications,
  getMerchantRules,
  getUserCorrectionExamples,
  recordCacheHits,
} from "./storage.js";
import { recurrenceKey } from "./recurrenceDetector.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type PipelineRow = {
  rawDescription: string;
  amount: number;
  /**
   * Upload-only: set to true when the CSV parser cannot determine amount
   * direction from column layout alone (positive single-column format).
   * Causes the row to be flagged for AI review regardless of rule confidence.
   */
  ambiguous?: boolean;
};

export type PipelineOutput = {
  merchant: string;
  /** Sign-normalised to match flowType (outflows are negative). */
  amount: number;
  flowType: "inflow" | "outflow";
  transactionClass: string;
  category: string;
  recurrenceType: string;
  recurrenceSource: string;
  /** "rule" | "user-rule" | "cache" | "ai" */
  labelSource: string;
  labelConfidence: number;
  labelReason: string;
  aiAssisted: boolean;
  fromCache: boolean;
  /**
   * True when this row would benefit from AI classification but didn't get
   * a definitive AI label this pass. Set by the rule pass and cleared as
   * later phases (user-rule, cache, global seed, AI) resolve the row.
   *
   * Callers use this to count rows the async AI worker still needs to
   * enhance. After a successful AI pass, this is false; after `skipAi:true`
   * or an AI timeout, the rows that wanted AI come back with `needsAi:true`.
   */
  needsAi: boolean;
};

export type PipelineOptions = {
  userId: number;
  /** Race timeout for the AI call in milliseconds. Upload=6000, reclassify=90000. */
  aiTimeoutMs: number;
  /** Rows below this confidence OR in "other" are sent to AI. Default 0.5. */
  aiConfidenceThreshold: number;
  /** AI results below this confidence are not written to cache. Default 0.7. */
  cacheWriteMinConfidence: number;
  /**
   * Whether to fetch and inject the user's past manual corrections as
   * few-shot examples into the AI prompt. Improves accuracy; adds one DB
   * read per pipeline call when AI is needed.
   * Defaults to true — reclassify always benefits; upload also benefits
   * from even a small set of examples.
   */
  includeUserExamplesInAi?: boolean;
  /**
   * When true, the pipeline runs Phase 1 (rules) → 1.5 (user rules) →
   * 1.7 (per-user cache) → 1.8 (global seed) ONLY. Phase 2 (AI) is
   * skipped entirely: aiClassifyBatch is never called and no AI cache
   * writeback occurs. Rows that would have gone to AI are returned with
   * `needsAi: true` and whatever labelSource the rule pass produced.
   *
   * The upload handler uses this to keep the request fast and defer AI
   * to a background worker. Reclassify never sets it.
   * Default: false.
   */
  skipAi?: boolean;
};

// ─── Internal ─────────────────────────────────────────────────────────────────

type InternalRow = {
  index: number;
  rawDescription: string;
  merchant: string;
  amount: number;
  flowType: "inflow" | "outflow";
  transactionClass: string;
  category: string;
  recurrenceType: string;
  recurrenceSource: string;
  labelSource: string;
  labelConfidence: number;
  labelReason: string;
  aiAssisted: boolean;
  fromCache: boolean;
  /**
   * True when this row still needs AI classification.
   * Set to false once user-rule or cache resolves it.
   */
  needsAi: boolean;
};

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Runs the full classification pipeline for a batch of rows.
 * Input order is preserved; exactly one PipelineOutput is returned per PipelineRow.
 * Never throws — errors in AI or cache are non-fatal and fall back gracefully.
 */
export async function classifyPipeline(
  rows: PipelineRow[],
  opts: PipelineOptions,
): Promise<PipelineOutput[]> {
  if (rows.length === 0) return [];

  // ── Phase 1: rules-based classification (sync, always succeeds) ────────────
  const internal: InternalRow[] = rows.map((row, index) => {
    let classification;
    try {
      classification = classifyTransaction(row.rawDescription, row.amount);
    } catch {
      // Classifier should never throw, but guard defensively.
      return {
        index,
        rawDescription: row.rawDescription,
        merchant: row.rawDescription.slice(0, 60),
        amount: row.amount,
        flowType: row.amount >= 0 ? "inflow" : "outflow",
        transactionClass: "expense",
        category: "other",
        recurrenceType: "one-time",
        recurrenceSource: "none",
        labelSource: "rule",
        labelConfidence: 0,
        labelReason: "classifier error",
        aiAssisted: false,
        fromCache: false,
        needsAi: true,
      } satisfies InternalRow;
    }

    // Normalise amount sign to match the resolved flowType.
    const effectiveAmount =
      classification.flowType === "outflow" && row.amount > 0
        ? -Math.abs(row.amount)
        : classification.flowType === "inflow" && row.amount < 0
          ? Math.abs(row.amount)
          : row.amount;

    // Union of both call-site needsAi conditions:
    //   - classification.aiAssisted: classifier flagged the row as uncertain
    //   - row.ambiguous: CSV parsing could not determine amount direction
    //   - labelConfidence < threshold OR category === "other"
    const aiAssisted = classification.aiAssisted || (row.ambiguous ?? false);
    const needsAi =
      aiAssisted ||
      classification.labelConfidence < opts.aiConfidenceThreshold ||
      classification.category === "other";

    return {
      index,
      rawDescription: row.rawDescription,
      merchant: classification.merchant,
      amount: effectiveAmount,
      flowType: classification.flowType,
      transactionClass: classification.transactionClass,
      category: classification.category,
      recurrenceType: classification.recurrenceType,
      recurrenceSource: classification.recurrenceSource,
      labelSource: classification.labelSource,
      labelConfidence: classification.labelConfidence,
      labelReason: classification.labelReason,
      aiAssisted,
      fromCache: false,
      needsAi,
    };
  });

  // ── Phase 1.5: user-specific merchant rules ────────────────────────────────
  try {
    const userRules = await getMerchantRules(opts.userId);
    if (userRules.size > 0) {
      for (const row of internal) {
        const key = recurrenceKey(row.merchant);
        const rule = key ? userRules.get(key) : undefined;
        if (!rule) continue;

        if (rule.category) row.category = rule.category;
        if (rule.transactionClass) row.transactionClass = rule.transactionClass;
        // Mirror the established policy: only reset recurrenceSource when the
        // rule explicitly overrides recurrenceType; otherwise preserve the
        // classifier-derived hint so provenance is not discarded.
        if (rule.recurrenceType) {
          row.recurrenceType = rule.recurrenceType;
          row.recurrenceSource = "none";
        }
        row.labelSource = "user-rule";
        row.labelConfidence = 1.0;
        row.labelReason = `user rule: ${key}`;
        row.aiAssisted = false;
        row.needsAi = false;
      }
    }
  } catch {
    // Non-fatal — classification continues without user rules if the load fails.
  }

  // ── Phase 1.7: merchant classification cache ───────────────────────────────
  // Runs for ALL rows except those already resolved by per-user rules, so that
  // cached user corrections can override even high-confidence structural matches.
  // Resolution order: user-rules (1.5) → per-user cache (1.7) → global seed (1.8) → AI.
  try {
    const cacheEligible = internal.filter((r) => r.labelSource !== "user-rule");
    const keysNeedingCache = cacheEligible
      .map((r) => recurrenceKey(r.merchant))
      .filter(Boolean) as string[];

    if (keysNeedingCache.length > 0) {
      const cacheHits = await getMerchantClassifications(opts.userId, keysNeedingCache);
      const hitKeys: string[] = [];

      for (const row of cacheEligible) {
        if (row.labelSource === "user-rule") continue;
        const key = recurrenceKey(row.merchant);
        if (!key) continue;
        const hit = cacheHits.get(key);
        if (!hit) continue;

        row.category = hit.category;
        row.transactionClass = hit.transactionClass;
        row.recurrenceType = hit.recurrenceType;
        row.recurrenceSource = "none";
        row.labelConfidence = hit.labelConfidence;
        row.labelReason = `cache hit: ${key} (${hit.source})`;
        row.labelSource = "cache";
        row.aiAssisted = false;
        row.fromCache = true;
        // Cache hits resolve the row only when the cached category is
        // confident; "other" is the classifier's fallback for "we don't
        // know" — promote it to AI for a real answer instead of letting a
        // stale low-signal cache entry suppress AI for the rest of time.
        row.needsAi = hit.category === "other";
        hitKeys.push(key);
      }

      if (hitKeys.length > 0) {
        recordCacheHits(opts.userId, hitKeys).catch(() => undefined);
      }
    }
  } catch {
    // Non-fatal — fall through to AI pass if cache check fails.
  }

  // ── Phase 1.8: global seed lookup ─────────────────────────────────────────
  // Runs for ALL rows not resolved by user-rules or per-user cache, so that
  // global seed entries can override even high-confidence structural keyword matches.
  // Required resolution order: user-rules (1.5) → per-user cache (1.7) → global seed (1.8) → structural → AI.
  const globalEligible = internal.filter(
    (r) => r.labelSource !== "user-rule" && r.labelSource !== "cache",
  );
  if (globalEligible.length > 0) {
    try {
      const globalKeys = globalEligible
        .map((r) => recurrenceKey(r.merchant))
        .filter(Boolean) as string[];

      if (globalKeys.length > 0) {
        const globalHits = await getGlobalMerchantClassifications(globalKeys);
        const hitKeys: string[] = [];

        for (const row of globalEligible) {
          const key = recurrenceKey(row.merchant);
          if (!key) continue;
          const hit = globalHits.get(key);
          if (!hit) continue;

          row.category = hit.category;
          row.transactionClass = hit.transactionClass;
          row.recurrenceType = hit.recurrenceType;
          row.recurrenceSource = "none";
          row.labelConfidence = hit.labelConfidence;
          row.labelReason = `global seed hit: ${key}`;
          row.labelSource = "cache";
          row.aiAssisted = false;
          row.fromCache = true;
          // Same logic as Phase 1.7: only suppress AI when the global seed
          // produced a real category. "other" still needs AI.
          row.needsAi = hit.category === "other";
          hitKeys.push(key);
        }

        // Promote global seed hits into the per-user cache for future fast lookups.
        if (hitKeys.length > 0) {
          const toCache = hitKeys
            .map((k) => globalHits.get(k))
            .filter(Boolean) as import("../shared/schema.js").MerchantClassification[];
          batchUpsertMerchantClassifications(opts.userId, toCache).catch(() => undefined);
        }
      }
    } catch {
      // Non-fatal — continue to AI pass.
    }
  }

  // ── Phase 2: AI fallback for low-confidence / uncertain rows ──────────────
  // Skipped when the caller opts into deferred AI (upload path uses this so
  // the request returns fast; a background worker picks up `needsAi` rows).
  if (opts.skipAi) {
    return internal.map((row) => ({
      merchant: row.merchant,
      amount: row.amount,
      flowType: row.flowType,
      transactionClass: row.transactionClass,
      category: row.category,
      recurrenceType: row.recurrenceType,
      recurrenceSource: row.recurrenceSource,
      labelSource: row.labelSource,
      labelConfidence: row.labelConfidence,
      labelReason: row.labelReason,
      aiAssisted: row.aiAssisted,
      fromCache: row.fromCache,
      needsAi: row.needsAi,
    }));
  }

  const aiCandidates: AiClassificationInput[] = [];
  const internalToAiIdx = new Map<number, number>();

  for (let i = 0; i < internal.length; i++) {
    const row = internal[i]!;
    if (!row.needsAi) continue;
    const aiIdx = aiCandidates.length;
    internalToAiIdx.set(i, aiIdx);
    aiCandidates.push({
      index: aiIdx,
      merchant: row.merchant,
      rawDescription: row.rawDescription,
      amount: row.amount,
      flowType: row.flowType,
    });
  }

  if (aiCandidates.length > 0) {
    // Optionally inject user corrections as few-shot examples.
    let userExamples: Awaited<ReturnType<typeof getUserCorrectionExamples>> = [];
    if (opts.includeUserExamplesInAi !== false) {
      try {
        userExamples = await getUserCorrectionExamples(opts.userId);
      } catch {
        // Non-fatal; AI runs without correction context.
      }
    }

    let aiResults: Map<number, AiClassificationResult> = new Map();
    try {
      const timeout = new Promise<Map<number, AiClassificationResult>>((resolve) =>
        setTimeout(() => resolve(new Map()), opts.aiTimeoutMs),
      );
      aiResults = await Promise.race([aiClassifyBatch(aiCandidates, userExamples), timeout]);
    } catch {
      // AI unavailable — fall through with rules-based results.
    }

    // Apply AI results to internal rows.
    for (const [internalIdx, aiIdx] of internalToAiIdx) {
      const aiResult = aiResults.get(aiIdx);
      if (!aiResult) continue;
      const row = internal[internalIdx]!;
      row.category = aiResult.category;
      row.transactionClass = aiResult.transactionClass;
      row.recurrenceType = aiResult.recurrenceType;
      row.recurrenceSource = "none";
      row.labelConfidence = aiResult.labelConfidence;
      row.labelReason = aiResult.labelReason;
      row.labelSource = "ai";
      row.aiAssisted = true;
      row.needsAi = false;
    }

    // Write qualifying AI results back to the merchant cache (fire-and-forget).
    if (aiResults.size > 0) {
      try {
        const cacheEntries = [];
        for (const [internalIdx, aiIdx] of internalToAiIdx) {
          const aiResult = aiResults.get(aiIdx);
          if (!aiResult || aiResult.labelConfidence < opts.cacheWriteMinConfidence) continue;
          const row = internal[internalIdx];
          if (!row) continue;
          const key = recurrenceKey(row.merchant);
          if (!key) continue;
          cacheEntries.push({
            merchantKey: key,
            category: aiResult.category,
            transactionClass: aiResult.transactionClass,
            recurrenceType: aiResult.recurrenceType,
            labelConfidence: aiResult.labelConfidence,
            source: "ai" as const,
          });
        }
        if (cacheEntries.length > 0) {
          batchUpsertMerchantClassifications(
            opts.userId,
            cacheEntries,
            opts.cacheWriteMinConfidence,
          ).catch(() => undefined);
        }
      } catch {
        // Non-fatal.
      }
    }
  }

  // ── Return outputs (preserving input order) ────────────────────────────────
  return internal.map((row) => ({
    merchant: row.merchant,
    amount: row.amount,
    flowType: row.flowType,
    transactionClass: row.transactionClass,
    category: row.category,
    recurrenceType: row.recurrenceType,
    recurrenceSource: row.recurrenceSource,
    labelSource: row.labelSource,
    labelConfidence: row.labelConfidence,
    labelReason: row.labelReason,
    aiAssisted: row.aiAssisted,
    fromCache: row.fromCache,
    needsAi: row.needsAi,
  }));
}
