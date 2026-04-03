import { classifyTransaction } from "./classifier.js";
import { aiClassifyBatch, type AiClassificationInput, type AiClassificationResult } from "./ai-classifier.js";
import { inferFlowType, normalizeMerchant } from "./transactionUtils.js";
import {
  listAllTransactionsForExport,
  bulkUpdateTransactions,
  type BulkTransactionUpdate,
} from "./storage.js";

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
    if (txn.userCorrected) {
      result.skippedUserCorrected++;
      continue;
    }

    try {
      const merchant = normalizeMerchant(txn.rawDescription);
      const rawAmount = parseFloat(String(txn.amount));
      const rawFlowType = inferFlowType(rawAmount);
      const classification = classifyTransaction(
        merchant || txn.rawDescription,
        rawAmount,
        rawFlowType,
      );

      const effectiveFlowType = classification.flowOverride ?? rawFlowType;
      const effectiveAmount =
        effectiveFlowType === "outflow" && rawAmount > 0
          ? -Math.abs(rawAmount)
          : rawAmount;

      intermediate.push({
        txnIndex: i,
        txnId: txn.id,
        rawDescription: txn.rawDescription,
        merchant: merchant || txn.rawDescription,
        amount: rawAmount,
        newAmount: effectiveAmount.toFixed(2),
        effectiveFlowType,
        transactionClass: classification.transactionClass,
        category: classification.category,
        recurrenceType: classification.recurrenceType,
        labelConfidence: classification.labelConfidence,
        labelReason: classification.labelReason,
        needsAi:
          classification.labelConfidence < AI_CONFIDENCE_THRESHOLD ||
          classification.category === "other",
      });
    } catch {
      result.unchanged++;
    }
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

  let aiResults: Map<number, AiClassificationResult> = new Map();
  try {
    aiResults = await aiClassifyBatch(aiCandidates);
  } catch {
    // AI unavailable — fall through with rules results
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

    // Compute the final label source based on whether AI applied.
    const finalLabelSource = aiAssisted ? "ai" : "rule";

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
