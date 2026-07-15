const MAX_TRANSACTION_FILTER_IDS = 250;

/**
 * Parse the shareable ledger `ids` query parameter.
 *
 * `undefined` means the filter was not supplied. `null` means it was supplied
 * but malformed, allowing routes to return a clear 400 instead of silently
 * broadening an exact Leak Hunter selection to the whole ledger.
 */
export function parseTransactionIdsParam(
  value: unknown,
): number[] | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) return null;

  const parts = value.split(",");
  if (parts.length > MAX_TRANSACTION_FILTER_IDS) return null;

  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids.length > 0 ? ids : null;
}
