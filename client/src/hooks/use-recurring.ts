import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export type ReviewStatus = "unreviewed" | "essential" | "leak" | "dismissed";

export type RecurringCandidate = {
  candidateKey: string;
  merchantKey: string;
  merchantDisplay: string;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  averageAmount: number;
  amountStdDev: number;
  monthlyEquivalent: number;
  annualEquivalent: number;
  confidence: number;
  reasonFlagged: string;
  transactionIds: number[];
  firstSeen: string;
  lastSeen: string;
  expectedNextDate: string;
  category: string;
  isActive: boolean;
  daysSinceExpected: number;
  reviewStatus: ReviewStatus;
  reviewNotes: string | null;
  /** Auto-labeled as essential by category (housing, utilities, insurance, etc.) */
  autoEssential: boolean;
};

export type CandidatesResponse = {
  candidates: RecurringCandidate[];
  summary: {
    total: number;
    unreviewed: number;
    essential: number;
    leak: number;
    dismissed: number;
    totalMonthlyEssential: number;
    totalMonthlyLeak: number;
    totalMonthlyUnreviewed: number;
    totalMonthlyActive: number;
  };
};

export function useRecurringCandidates() {
  return useQuery<CandidatesResponse>({
    queryKey: ["/api/recurring-candidates"],
    queryFn: async () => {
      const res = await fetch("/api/recurring-candidates", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch candidates");
      const data = await res.json();
      // Compute extra summary totals on the client
      const candidates: RecurringCandidate[] = data.candidates;
      data.summary.totalMonthlyEssential = candidates
        .filter((c) => c.reviewStatus === "essential" && c.isActive)
        .reduce((s, c) => s + c.monthlyEquivalent, 0);
      data.summary.totalMonthlyLeak = candidates
        .filter((c) => c.reviewStatus === "leak" && c.isActive)
        .reduce((s, c) => s + c.monthlyEquivalent, 0);
      data.summary.totalMonthlyUnreviewed = candidates
        .filter((c) => c.reviewStatus === "unreviewed" && c.isActive)
        .reduce((s, c) => s + c.monthlyEquivalent, 0);
      data.summary.totalMonthlyActive = candidates
        .filter((c) => c.isActive)
        .reduce((s, c) => s + c.monthlyEquivalent, 0);
      return data;
    },
    staleTime: 30_000, // 30s cache
  });
}

export function useReviewMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      candidateKey,
      status,
      notes,
    }: {
      candidateKey: string;
      status: ReviewStatus;
      notes?: string;
    }) => {
      // Must use apiFetch — the PATCH endpoint requires a CSRF token
      const res = await apiFetch(
        `/api/recurring-reviews/${encodeURIComponent(candidateKey)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status, notes }),
        },
      );
      if (!res.ok) throw new Error("Failed to submit review");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-candidates"] });
    },
  });
}

export function useSyncRecurringMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ recurringCount: number; oneTimeCount: number }> => {
      const res = await apiFetch("/api/recurring-candidates/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Sync failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-summary"] });
    },
  });
}
