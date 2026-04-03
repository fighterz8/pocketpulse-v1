/**
 * Background AI enrichment for freshly uploaded transactions.
 *
 * Called fire-and-forget after the upload response is sent to the client.
 * Queries low-confidence/uncategorised rows for a specific upload, calls
 * GPT-4o-mini, and persists the improved labels. Never throws — any error
 * is silently swallowed so it cannot affect the user-facing response.
 */
import { aiClassifyBatch, type AiClassificationInput } from "./ai-classifier.js";
import {
  listLowConfidenceTransactionsForUpload,
  bulkUpdateTransactions,
  type BulkTransactionUpdate,
} from "./storage.js";

export async function enrichUploadWithAi(
  userId: number,
  uploadId: number,
): Promise<void> {
  try {
    const rows = await listLowConfidenceTransactionsForUpload(userId, uploadId);
    if (rows.length === 0) return;

    const candidates: AiClassificationInput[] = rows.map((row, idx) => ({
      index: idx,
      merchant: row.merchant,
      rawDescription: row.rawDescription,
      amount: parseFloat(String(row.amount)),
      flowType: row.flowType as "inflow" | "outflow",
    }));

    const aiResults = await aiClassifyBatch(candidates);
    if (aiResults.size === 0) return;

    const updates: BulkTransactionUpdate[] = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx]!;
      const aiResult = aiResults.get(idx);
      if (!aiResult) continue;

      updates.push({
        id: row.id,
        amount: String(row.amount),
        flowType: row.flowType,
        transactionClass: aiResult.transactionClass,
        category: aiResult.category,
        recurrenceType: aiResult.recurrenceType,
        labelSource: "ai",
        labelConfidence: aiResult.labelConfidence.toFixed(2),
        labelReason: aiResult.labelReason,
        aiAssisted: true,
      });
    }

    if (updates.length > 0) {
      await bulkUpdateTransactions(userId, updates);
    }
  } catch {
    // Silently swallow — this is background enrichment, never surface to user
  }
}
