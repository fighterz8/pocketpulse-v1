import { classifyTransaction } from "./classifier.js";
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

  const updates: BulkTransactionUpdate[] = [];

  for (const txn of allTxns) {
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

      const newAmount = effectiveAmount.toFixed(2);
      const changed =
        newAmount !== String(txn.amount) ||
        effectiveFlowType !== txn.flowType ||
        classification.transactionClass !== txn.transactionClass ||
        classification.category !== txn.category;

      if (!changed) {
        result.unchanged++;
        continue;
      }

      updates.push({
        id: txn.id,
        amount: newAmount,
        flowType: effectiveFlowType,
        transactionClass: classification.transactionClass,
        category: classification.category,
        recurrenceType: classification.recurrenceType,
        labelSource: "rule",
        labelConfidence: classification.labelConfidence.toFixed(2),
        labelReason: classification.labelReason,
      });
    } catch {
      result.unchanged++;
    }
  }

  if (updates.length > 0) {
    await bulkUpdateTransactions(userId, updates);
  }

  result.updated = updates.length;
  return result;
}
