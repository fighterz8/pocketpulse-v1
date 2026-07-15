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
import { getBankCategoryHint } from "./bankCategory.js";
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
import { inferFlowType } from "./transactionUtils.js";
import {
  reconcileAiTransactionClassification,
  reconcileTransactionDirection,
} from "./transactionDirection.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type PipelineRow = {
  rawDescription: string;
  amount: number;
  /** Optional category supplied by the bank export. */
  sourceCategory?: string;
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
  classEvidence: "explicit" | "heuristic" | "provisional";
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

function applyDirectionalOverride(
  row: InternalRow,
  proposedClass: string,
  proposedCategory: string,
  trust: "user" | "machine" = "machine",
): void {
  // Explicit transfers are structural facts. A learned machine label from a
  // prior row may not turn Apple Cash / Venmo / account transfers into fees,
  // expenses, or income. Users can still deliberately override them.
  if (
    trust === "machine" &&
    row.classEvidence === "explicit" &&
    row.transactionClass === "transfer"
  ) {
    return;
  }

  let safeClass = proposedClass;
  let safeCategory = proposedCategory;
  if (
    trust === "machine" &&
    row.classEvidence === "explicit" &&
    row.transactionClass === "income"
  ) {
    safeClass = "income";
    safeCategory = "income";
  } else if (
    trust === "machine" &&
    row.classEvidence === "explicit" &&
    row.transactionClass === "refund"
  ) {
    safeClass = "refund";
    safeCategory = proposedCategory === "income" ? row.category : proposedCategory;
  }
  if (
    trust === "machine" &&
    row.flowType === "inflow" &&
    row.classEvidence === "provisional" &&
    proposedClass === "income"
  ) {
    safeClass = "refund";
    safeCategory = proposedCategory === "income" ? row.category : proposedCategory;
  }

  const reconciled = reconcileTransactionDirection({
    flowType: row.flowType,
    proposedClass: safeClass,
    proposedCategory: safeCategory,
    fallbackClass: row.transactionClass,
    fallbackCategory: row.category,
  });
  row.transactionClass = reconciled.transactionClass;
  row.category = reconciled.category;
  if (trust === "user") row.classEvidence = "explicit";
}

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
        classEvidence: "heuristic",
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

    // A parser-confirmed direction is structural truth. Merchant semantics may
    // choose direction only for genuinely ambiguous unsigned-amount rows.
    const flowType = row.ambiguous
      ? classification.flowType
      : inferFlowType(row.amount);

    // Normalise amount sign to match the resolved flowType.
    const effectiveAmount =
      flowType === "outflow" && row.amount > 0
        ? -Math.abs(row.amount)
        : flowType === "inflow" && row.amount < 0
          ? Math.abs(row.amount)
          : row.amount;
    const bankHint = getBankCategoryHint(row.sourceCategory);
    let proposedClass = classification.transactionClass;
    let proposedCategory = classification.category;
    let classEvidence: InternalRow["classEvidence"] =
      classification.classEvidence;
    let bankHintApplied = false;

    if (bankHint) {
      let bankClass = bankHint.transactionClass;

      // A positive credit carrying an expense category is normally a reversal
      // of that spending, not earnings. Preserve the bank's useful category
      // while expressing the class as a refund.
      if (flowType === "inflow" && bankClass === "expense") {
        bankClass = "refund";
      } else if (
        flowType === "outflow" &&
        (bankClass === "income" || bankClass === "refund")
      ) {
        bankClass = undefined;
      }

      // Explicit description semantics such as transfer/refund/payroll outrank
      // a generic spending category. Conversely, a bank's structural transfer
      // category may correct an expense rule (ATM withdrawal, card payment,
      // securities movement) that would otherwise double-count spending.
      const explicitNonExpenseClass =
        classification.classEvidence === "explicit" &&
        classification.transactionClass !== "expense";
      if (bankClass && !explicitNonExpenseClass) {
        proposedClass = bankClass;
        classEvidence = "explicit";
        bankHintApplied = true;
      }

      if (proposedClass === "transfer") {
        proposedCategory = "other";
      } else if (proposedClass === "income") {
        proposedCategory = "income";
      } else if (
        bankHint.category !== "other" &&
        (proposedCategory === "other" ||
          proposedClass === "refund" ||
          bankHint.confidence > classification.labelConfidence)
      ) {
        proposedCategory = bankHint.category;
        bankHintApplied = true;
      }
    }

    const unverifiedIncome =
      !(row.ambiguous ?? false) &&
      flowType === "inflow" &&
      proposedClass === "income" &&
      classEvidence === "heuristic";
    const directionalClassification = reconcileTransactionDirection({
      flowType,
      proposedClass: unverifiedIncome ? "refund" : proposedClass,
      proposedCategory: unverifiedIncome ? "other" : proposedCategory,
      fallbackClass: unverifiedIncome
        ? "refund"
        : flowType === "inflow" ? "income" : "expense",
      fallbackCategory: unverifiedIncome
        ? "other"
        : flowType === "inflow" ? "income" : "other",
    });

    // Union of both call-site needsAi conditions:
    //   - classification.aiAssisted: classifier flagged the row as uncertain
    //   - row.ambiguous: CSV parsing could not determine amount direction
    //   - labelConfidence < threshold OR category === "other"
    const categoryNeedsAi =
      directionalClassification.category === "other" &&
      directionalClassification.transactionClass !== "transfer";
    let aiAssisted =
      classification.aiAssisted ||
      (row.ambiguous ?? false) ||
      categoryNeedsAi;
    if (directionalClassification.transactionClass === "transfer") {
      aiAssisted = false;
    } else if (
      bankHintApplied &&
      directionalClassification.transactionClass === "income" &&
      directionalClassification.category === "income"
    ) {
      aiAssisted = false;
    }
    const needsAi =
      aiAssisted ||
      classification.labelConfidence < opts.aiConfidenceThreshold ||
      categoryNeedsAi;

    return {
      index,
      rawDescription: row.rawDescription,
      merchant: classification.merchant,
      amount: effectiveAmount,
      flowType,
      transactionClass: directionalClassification.transactionClass,
      classEvidence: unverifiedIncome ? "provisional" : classEvidence,
      category: directionalClassification.category,
      recurrenceType: classification.recurrenceType,
      recurrenceSource: classification.recurrenceSource,
      labelSource: classification.labelSource,
      labelConfidence: bankHintApplied
        ? Math.max(classification.labelConfidence, bankHint?.confidence ?? 0)
        : classification.labelConfidence,
      labelReason: bankHintApplied
        ? `bank category → ${directionalClassification.category}`
        : classification.labelReason,
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

        applyDirectionalOverride(
          row,
          rule.transactionClass ?? row.transactionClass,
          rule.category ?? row.category,
          "user",
        );
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

        applyDirectionalOverride(
          row,
          hit.transactionClass,
          hit.category,
          hit.source === "manual" ? "user" : "machine",
        );
        row.recurrenceType = hit.recurrenceType;
        row.recurrenceSource = "none";
        row.labelConfidence = hit.labelConfidence;
        row.labelReason = `cache hit: ${key} (${hit.source})`;
        row.labelSource = "cache";
        const categoryNeedsAi =
          row.category === "other" && row.transactionClass !== "transfer";
        row.aiAssisted = categoryNeedsAi;
        row.fromCache = true;
        // Cache hits resolve the row only when the cached category is
        // confident; "other" is the classifier's fallback for "we don't
        // know" — promote it to AI for a real answer instead of letting a
        // stale low-signal cache entry suppress AI for the rest of time.
        row.needsAi = categoryNeedsAi;
        hitKeys.push(key);
      }

      // Skip the hit-count bump in skipAi mode so the deferred-AI upload
      // path is fully read-only on the merchant cache. The async worker
      // will exercise the cache (and bump hit counts) when it runs.
      if (hitKeys.length > 0 && !opts.skipAi) {
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

          applyDirectionalOverride(row, hit.transactionClass, hit.category);
          row.recurrenceType = hit.recurrenceType;
          row.recurrenceSource = "none";
          row.labelConfidence = hit.labelConfidence;
          row.labelReason = `global seed hit: ${key}`;
          row.labelSource = "cache";
          const categoryNeedsAi =
            row.category === "other" && row.transactionClass !== "transfer";
          row.aiAssisted = categoryNeedsAi;
          row.fromCache = true;
          // Same logic as Phase 1.7: only suppress AI when the global seed
          // produced a real category. "other" still needs AI.
          row.needsAi = categoryNeedsAi;
          hitKeys.push(key);
        }

        // Promote global seed hits into the per-user cache for future fast lookups.
        // Suppressed in skipAi mode — the upload path stays fully read-only
        // on merchant_classifications; the async AI worker will perform any
        // cache writes (including this seed promotion) when it runs.
        if (hitKeys.length > 0 && !opts.skipAi) {
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
      const reconciled = reconcileAiTransactionClassification({
        flowType: row.flowType,
        currentClass: row.transactionClass,
        currentCategory: row.category,
        currentClassEvidence: row.classEvidence,
        proposedClass: aiResult.transactionClass,
        proposedCategory: aiResult.category,
      });
      row.transactionClass = reconciled.transactionClass;
      row.category = reconciled.category;
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
            category: row.category,
            transactionClass: row.transactionClass,
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
