import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

export type AiUploadStatusEntry = {
  uploadId: number;
  filename: string;
  aiStatus: "pending" | "processing" | "complete" | "failed" | string;
  aiRowsPending: number;
  aiRowsDone: number;
  progress: number;
  aiStartedAt: string | null;
  aiCompletedAt: string | null;
  aiError: string | null;
};

type AiStatusResponse = { uploads: AiUploadStatusEntry[] };

export const aiEnhancementStatusKey = ["ai-enhancement-status"] as const;

const POLL_MS = 3000;

function isActive(s: string): boolean {
  return s === "pending" || s === "processing";
}

/**
 * Single source of truth for "is the async AI worker doing anything for
 * this user right now?". Both the header pulse badge and the Ledger
 * transactions query subscribe to this hook so they share one poll
 * instead of stacking duplicates.
 *
 * Polling toggles itself off the moment nothing is active (refetchInterval
 * returns false), which keeps the request volume at zero for users who
 * are not currently uploading.
 */
export function useAiEnhancementStatus() {
  const query = useQuery<AiStatusResponse>({
    queryKey: aiEnhancementStatusKey,
    queryFn: async () => {
      const res = await fetch("/api/uploads/ai-status");
      if (!res.ok) {
        // Throw rather than collapse to an empty list. react-query keeps
        // the prior successful `data` around on error, which is what we
        // want: a transient 5xx must NOT flip the refetchInterval off
        // and silently freeze the badge while the worker is still
        // chewing on rows in the background.
        throw new Error(`ai-status fetch failed: ${res.status}`);
      }
      return (await res.json()) as AiStatusResponse;
    },
    refetchInterval: (q) => {
      const data = q.state.data as AiStatusResponse | undefined;
      const anyActive = data?.uploads?.some((u) => isActive(u.aiStatus)) ?? false;
      return anyActive ? POLL_MS : false;
    },
    refetchOnWindowFocus: true,
    // Keep retrying through a flaky window — without this, a single
    // failure (which keeps prior data but suspends refetchInterval until
    // the next success) could leave the poll stuck for longer than the
    // user expects.
    retry: 3,
    retryDelay: 1500,
    staleTime: 0,
  });

  const uploads = query.data?.uploads ?? [];
  const activeUploads = uploads.filter((u) => isActive(u.aiStatus));
  const anyActive = activeUploads.length > 0;
  const totalPending = activeUploads.reduce((sum, u) => sum + (u.aiRowsPending || 0), 0);
  const totalDone = activeUploads.reduce((sum, u) => sum + (u.aiRowsDone || 0), 0);
  const overallProgress = totalPending > 0 ? Math.min(1, totalDone / totalPending) : 0;
  const remaining = Math.max(0, totalPending - totalDone);

  // Edge-trigger detector: true on the single tick where the active set
  // flips from non-empty to empty. Powers the badge's "AI enhancement
  // complete" toast without callers needing to remember prior state.
  const wasActiveRef = useRef(false);
  const [lastJustCompleted, setLastJustCompleted] = useState(false);
  const [lastJustFailed, setLastJustFailed] = useState<string | null>(null);

  useEffect(() => {
    if (anyActive) {
      wasActiveRef.current = true;
      if (lastJustCompleted) setLastJustCompleted(false);
      if (lastJustFailed) setLastJustFailed(null);
      return;
    }
    if (wasActiveRef.current) {
      wasActiveRef.current = false;
      // Decide which transition we just witnessed by inspecting recent
      // terminal entries. If anything in the recent window failed without
      // a completed sibling for the same upload, surface the error.
      const recentFail = uploads.find((u) => u.aiStatus === "failed" && u.aiError);
      if (recentFail) {
        setLastJustFailed(recentFail.aiError ?? "AI enhancement failed");
        const t = setTimeout(() => setLastJustFailed(null), 4000);
        return () => clearTimeout(t);
      }
      setLastJustCompleted(true);
      const t = setTimeout(() => setLastJustCompleted(false), 2000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyActive]);

  return {
    anyActive,
    activeCount: activeUploads.length,
    totalPending,
    totalDone,
    remaining,
    overallProgress,
    uploads: activeUploads,
    allRecentUploads: uploads,
    lastJustCompleted,
    lastJustFailed,
    isLoading: query.isPending,
  };
}
