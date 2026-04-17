import { classifyTransaction } from "./classifier.js";
import { aiClassifyBatch, type AiClassificationInput, type AiClassificationResult } from "./ai-classifier.js";
import {
  batchUpsertMerchantClassifications,
  bulkUpdateTransactions,
  getMerchantClassifications,
  getMerchantRules,
  getUserCorrectionExamples,
  listAllTransactionsForExport,
  recordCacheHits,
  type BulkTransactionUpdate,
} from "./storage.js";
import { recurrenceKey } from "./recurrenceDetector.js";

export type ReclassifyResult = {
  total: number;
  updated: number;
  skippedUserCorrected: number;
  unchanged: number;
};

const AI_CONFIDENCE_THRESHOLD = 0.5;

type IntermediateRow = {
  txnIndex: number;
  txnId: number;
  rawDescription: string;
  merchant: string;
  amount: number;
  newAmount: string;
  effectiveFlowType: string;
  transactionClass: string;
  category: string;
  recurrenceType: string;
  labelConfidence: number;
  labelReason: string;
  needsAi: boolean;
  userRule: boolean;
  fromCache: boolean;
};

export async function reclassifyTransactions(
  userId: number,
): Promise<ReclassifyResult> {
  const allTxns = await listAllTransactionsForExport({ userId });

  const result: ReclassifyResult = {
    total: allTxns.length,
    updated: 0,
    skippedUserCorrected: 0,
    unchanged: 0,
  };

  // Phase 1: rules-based classification for all non-user-corrected transactions
  const intermediate: IntermediateRow[] = [];

  for (let i = 0; i < allTxns.length; i++) {
    const txn = allTxns[i]!;
    // Skip transactions that already reflect explicit intent:
    //   userCorrected=true            → manually edited by the user
    //   labelSource="propagated"      → auto-applied from a manual correction
    //   labelSource="recurring-transfer" → system-promoted recurring transfer;
    //     syncRecurringCandidates (called after reclassify) handles these
    if (
      txn.userCorrected ||
      txn.labelSource === "propagated" ||
      txn.labelSource === "recurring-transfer"
    ) {
      result.skippedUserCorrected++;
      continue;
    }

    try {
      const rawAmount = parseFloat(String(txn.amount));
      const classification = classifyTransaction(txn.rawDescription, rawAmount);

      const effectiveAmount =
        classification.flowType === "outflow" && rawAmount > 0
          ? -Math.abs(rawAmount)
          : classification.flowType === "inflow" && rawAmount < 0
            ? Math.abs(rawAmount)
            : rawAmount;

      intermediate.push({
        txnIndex: i,
        txnId: txn.id,
        rawDescription: txn.rawDescription,
        merchant: classification.merchant,
        amount: rawAmount,
        newAmount: effectiveAmount.toFixed(2),
        effectiveFlowType: classification.flowType,
        transactionClass: classification.transactionClass,
        category: classification.category,
        recurrenceType: classification.recurrenceType,
        labelConfidence: classification.labelConfidence,
        labelReason: classification.labelReason,
        needsAi:
          classification.aiAssisted ||
          classification.labelConfidence < AI_CONFIDENCE_THRESHOLD ||
          classification.category === "other",
        userRule: false,
        fromCache: false,
      });
    } catch {
      result.unchanged++;
    }
  }

  // Phase 1.5: apply user-specific merchant rules before AI enrichment.
  // Rows matched here are marked userRule=true and needsAi=false so they
  // are excluded from the AI candidate pool below.
  try {
    const userRules = await getMerchantRules(userId);
    if (userRules.size > 0) {
      for (const row of intermediate) {
        const key = recurrenceKey(row.merchant);
        const rule = key ? userRules.get(key) : undefined;
        if (rule) {
          if (rule.category) row.category = rule.category;
          if (rule.transactionClass) row.transactionClass = rule.transactionClass;
          if (rule.recurrenceType) row.recurrenceType = rule.recurrenceType;
          row.labelConfidence = 1.0;
          row.labelReason = `user rule: ${key}`;
          row.needsAi = false;
          row.userRule = true;
        }
      }
    }
  } catch {
    // Non-fatal — reclassify continues without user rules if load fails
  }

  // Phase 1.7: merchant classification cache — short-circuits AI for known merchants
  try {
    const keysNeedingAi = intermediate
      .filter((r) => r.needsAi && !r.userRule)
      .map((r) => recurrenceKey(r.merchant))
      .filter(Boolean) as string[];

    if (keysNeedingAi.length > 0) {
      const cacheHits = await getMerchantClassifications(userId, keysNeedingAi);
      const hitKeys: string[] = [];

      for (const row of intermediate) {
        if (!row.needsAi || row.userRule) continue;
        const key = recurrenceKey(row.merchant);
        if (!key) continue;
        const hit = cacheHits.get(key);
        if (!hit) continue;

        row.category = hit.category;
        row.transactionClass = hit.transactionClass;
        row.recurrenceType = hit.recurrenceType;
        row.labelConfidence = hit.labelConfidence;
        row.labelReason = `cache hit: ${key} (${hit.source})`;
        row.needsAi = false;
        row.fromCache = true;
        hitKeys.push(key);
      }

      if (hitKeys.length > 0) {
        recordCacheHits(userId, hitKeys).catch(() => undefined);
      }
    }
  } catch {
    // Non-fatal — fall through to AI pass if cache check fails
  }

  // Phase 2: AI fallback for low-confidence rows
  const aiCandidates: AiClassificationInput[] = [];
  const intermediateToAiIdx = new Map<number, number>(); // intermediate index → aiCandidates index

  for (let k = 0; k < intermediate.length; k++) {
    if (intermediate[k]!.needsAi) {
      const aiIdx = aiCandidates.length;
      intermediateToAiIdx.set(k, aiIdx);
      aiCandidates.push({
        index: aiIdx,
        merchant: intermediate[k]!.merchant,
        rawDescription: intermediate[k]!.rawDescription,
        amount: intermediate[k]!.amount,
        flowType: intermediate[k]!.effectiveFlowType as "inflow" | "outflow",
      });
    }
  }

  // Fetch user corrections to inject as few-shot examples into the AI prompt.
  // Errors here are non-fatal — fall through with an empty list.
  let userExamples: Awaited<ReturnType<typeof getUserCorrectionExamples>> = [];
  try {
    userExamples = await getUserCorrectionExamples(userId);
  } catch {
    // Non-fatal; AI will classify without correction context.
  }

  let aiResults: Map<number, AiClassificationResult> = new Map();
  try {
    const AI_TIMEOUT_MS = 90_000;
    const timeout = new Promise<Map<number, AiClassificationResult>>(
      (resolve) => setTimeout(() => resolve(new Map()), AI_TIMEOUT_MS),
    );
    aiResults = await Promise.race([aiClassifyBatch(aiCandidates, userExamples), timeout]);
  } catch {
    // AI unavailable — fall through with rules results
  }

  // Write AI results with confidence ≥ 0.70 back to the merchant cache.
  // Non-fatal; a write failure must never break the reclassify pass.
  if (aiResults.size > 0) {
    try {
      const cacheEntries = [];
      for (const [intermediateIdx, aiIdx] of intermediateToAiIdx) {
        const aiResult = aiResults.get(aiIdx);
        if (!aiResult || aiResult.labelConfidence < 0.7) continue;
        const row = intermediate[intermediateIdx];
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
        batchUpsertMerchantClassifications(userId, cacheEntries, 0.7).catch(() => undefined);
      }
    } catch {
      // Non-fatal
    }
  }

  // Phase 3: build final update list, merging AI results where available
  const updates: BulkTransactionUpdate[] = [];

  for (let k = 0; k < intermediate.length; k++) {
    const row = intermediate[k]!;
    const txn = allTxns[row.txnIndex]!;

    let { category, transactionClass, recurrenceType, labelConfidence, labelReason, effectiveFlowType, newAmount } = row;
    let aiAssisted = false;

    if (row.needsAi) {
      const aiIdx = intermediateToAiIdx.get(k);
      const aiResult = aiIdx !== undefined ? aiResults.get(aiIdx) : undefined;
      if (aiResult) {
        category = aiResult.category;
        transactionClass = aiResult.transactionClass;
        recurrenceType = aiResult.recurrenceType;
        labelConfidence = aiResult.labelConfidence;
        labelReason = aiResult.labelReason;
        aiAssisted = true;
      }
    }

    // Compute the final label source based on how the classification was resolved.
    const finalLabelSource = aiAssisted
      ? "ai"
      : row.userRule
        ? "user-rule"
        : row.fromCache
          ? "cache"
          : "rule";

    // Treat AI-applied metadata changes as "changed" even when category/class
    // stayed the same, so that aiAssisted=true / labelSource=ai / updated
    // confidence and reason are persisted to the DB.
    const finalChanged =
      newAmount !== String(txn.amount) ||
      effectiveFlowType !== txn.flowType ||
      transactionClass !== txn.transactionClass ||
      category !== txn.category ||
      (aiAssisted && !txn.aiAssisted) ||
      finalLabelSource !== txn.labelSource;

    if (!finalChanged) {
      result.unchanged++;
      continue;
    }

    updates.push({
      id: row.txnId,
      amount: newAmount,
      flowType: effectiveFlowType,
      transactionClass,
      category,
      recurrenceType,
      labelSource: finalLabelSource,
      labelConfidence: labelConfidence.toFixed(2),
      labelReason,
      aiAssisted,
    });
  }

  if (updates.length > 0) {
    await bulkUpdateTransactions(userId, updates);
  }

  result.updated = updates.length;
  return result;
}
