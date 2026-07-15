export const AI_WORKER_RUNTIME_BUDGET_MS = 4 * 60 * 1000;
export const AI_PROCESSING_STALE_AFTER_MS = 6 * 60 * 1000;

export type AiLifecycleEntry = {
  aiStatus: string;
  aiStartedAt?: Date | string | null;
};

/**
 * A Vercel background function cannot run forever. Once a processing row is
 * older than the worker budget plus a small persistence buffer, no live worker
 * can still be trusted to own it and the status must become terminal.
 */
export function isStaleAiProcessing(
  entry: AiLifecycleEntry,
  nowMs = Date.now(),
): boolean {
  if (entry.aiStatus !== "processing") return false;
  if (!entry.aiStartedAt) return true;
  const startedAt = new Date(entry.aiStartedAt).getTime();
  return (
    !Number.isFinite(startedAt) ||
    nowMs - startedAt >= AI_PROCESSING_STALE_AFTER_MS
  );
}

/** Keep provider/configuration plumbing out of the daily product surface. */
export function publicEnhancementError(error: string | null | undefined): string {
  const normalized = error?.toLowerCase() ?? "";
  if (
    normalized.includes("runtime") ||
    normalized.includes("timed out") ||
    normalized.includes("interrupted") ||
    normalized.includes("restart")
  ) {
    return "Enhancement stopped before it finished. Your imported transactions are ready; try again later.";
  }
  return "Enhancement is temporarily unavailable. Your imported transactions are still ready to review.";
}
