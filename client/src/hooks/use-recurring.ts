import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type ReviewStatus = "unreviewed" | "essential" | "leak" | "dismissed";

export type RecurringCandidate = {
  candidateKey: string;
  merchantKey: string;
  merchantDisplay: string;
  frequency: string;
  averageAmount: number;
  amountStdDev: number;
  confidence: number;
  reasonFlagged: string;
  transactionIds: number[];
  firstSeen: string;
  lastSeen: string;
  expectedNextDate: string;
  category: string;
  reviewStatus: ReviewStatus;
  reviewNotes: string | null;
};

export type CandidatesResponse = {
  candidates: RecurringCandidate[];
  summary: {
    total: number;
    unreviewed: number;
    essential: number;
    leak: number;
    dismissed: number;
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
      return res.json();
    },
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
      const res = await fetch(
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
      queryClient.invalidateQueries({
        queryKey: ["/api/recurring-candidates"],
      });
    },
  });
}
