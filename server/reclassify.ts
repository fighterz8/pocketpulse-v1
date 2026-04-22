import { classifyPipeline } from "./classifyPipeline.js";
import {
  bulkUpdateTransactions,
  listAllTransactionsForExport,
  type BulkTransactionUpdate,
} from "./storage.js";

export type ReclassifyResult = {
  total: number;
  updated: number;
  skippedUserCorrected: number;
  unchanged: number;
};

export async function reclassifyTransactions(
  userId: number,
): Promise<ReclassifyResult> {
  const allTxns = await listAllTransactionsForExport({ userId });

  // Skip transactions that already reflect explicit intent:
  //   userCorrected=true            → manually edited by the user
  //   labelSource="propagated"      → auto-applied from a manual correction
  //   labelSource="recurring-transfer" → system-promoted recurring transfer;
  //     syncRecurringCandidates (called after reclassify) handles these
  const eligibleTxns = allTxns.filter(
    (txn) =>
      !txn.userCorrected &&
      txn.labelSource !== "propagated" &&
      txn.labelSource !== "recurring-transfer",
  );

  const result: ReclassifyResult = {
    total: allTxns.length,
    updated: 0,
    skippedUserCorrected: allTxns.length - eligibleTxns.length,
    unchanged: 0,
  };

  if (eligibleTxns.length === 0) return result;

  // Run the shared classification pipeline on all eligible transactions.
  // 90-second AI timeout (background task, not user-blocking).
  // Always include user correction examples for few-shot AI accuracy.
  const outputs = await classifyPipeline(
    eligibleTxns.map((txn) => ({
      rawDescription: txn.rawDescription,
      amount: parseFloat(String(txn.amount)),
    })),
    {
      userId,
      aiTimeoutMs: 90_000,
      aiConfidenceThreshold: 0.5,
      cacheWriteMinConfidence: 0.7,
      includeUserExamplesInAi: true,
    },
  );

  // Diff each pipeline output against the existing DB row and collect updates.
  // Treat AI-applied metadata changes as "changed" even when category/class
  // stayed the same, so that aiAssisted=true / labelSource=ai / updated
  // confidence and reason are persisted to the DB.
  const updates: BulkTransactionUpdate[] = [];

  for (let i = 0; i < eligibleTxns.length; i++) {
    const txn = eligibleTxns[i]!;
    const out = outputs[i]!;

    const newAmount = out.amount.toFixed(2);

    // Data fields that represent a genuine classification change.
    const dataChanged =
      newAmount !== String(txn.amount) ||
      out.flowType !== txn.flowType ||
      out.transactionClass !== txn.transactionClass ||
      out.category !== txn.category ||
      out.recurrenceType !== txn.recurrenceType ||
      out.recurrenceSource !== txn.recurrenceSource;

    // A labelSource transition is only meaningful when the classification data
    // actually changed, or the pipeline newly produced an "ai" label this pass
    // (upgrading the row's provenance).
    //
    // Specifically: do NOT overwrite an existing "ai" label with a lower-signal
    // source ("cache" or "rule") when the category, class, recurrence, flow,
    // and amount are all identical. Two common paths cause these spurious
    // demotions:
    //   - "ai" → "cache": the AI result was written to the merchant cache at
    //     upload time; on the next reclassify pass the merchant hits the cache
    //     and returns labelSource="cache" — identical data, no real change.
    //   - "ai" → "rule": AI timed out during this reclassify pass and the
    //     structural rules returned the same classification — identical data,
    //     no real change.
    // In both cases the right behaviour is to leave the DB row untouched so
    // "ai" provenance is preserved across reclassify runs.
    const isAiDemotion =
      txn.labelSource === "ai" &&
      (out.labelSource === "cache" || out.labelSource === "rule") &&
      !dataChanged;

    const labelSourceChanged = out.labelSource !== txn.labelSource && !isAiDemotion;

    const finalChanged = dataChanged || (out.aiAssisted && !txn.aiAssisted) || labelSourceChanged;

    if (!finalChanged) {
      result.unchanged++;
      continue;
    }

    updates.push({
      id: txn.id,
      amount: newAmount,
      flowType: out.flowType,
      transactionClass: out.transactionClass,
      category: out.category,
      recurrenceType: out.recurrenceType,
      recurrenceSource: out.recurrenceSource,
      labelSource: out.labelSource,
      labelConfidence: out.labelConfidence.toFixed(2),
      labelReason: out.labelReason,
      aiAssisted: out.aiAssisted,
    });
  }

  if (updates.length > 0) {
    await bulkUpdateTransactions(userId, updates);
  }

  result.updated = updates.length;
  return result;
}
