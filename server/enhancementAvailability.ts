import { recurrenceKey } from "./recurrenceDetector.js";

export type UnresolvedCounts = {
  unresolvedTransactionCount: number;
  unresolvedMerchantCount: number;
};

/**
 * Summarize unresolved transaction rows without exposing merchant content.
 * Merchant variants share the same canonical key so the count matches the
 * future merchant-level enhancement workflow instead of raw transaction rows.
 */
export function summarizeUnresolvedTransactions(
  rows: ReadonlyArray<{ merchant: string }>,
): UnresolvedCounts {
  const merchantKeys = new Set<string>();
  for (const row of rows) {
    const key = recurrenceKey(row.merchant);
    if (key) merchantKeys.add(key);
  }

  return {
    unresolvedTransactionCount: rows.length,
    unresolvedMerchantCount: merchantKeys.size,
  };
}
