import { useQuery } from "@tanstack/react-query";

export type LabelSourceBreakdown = {
  rule: number;
  ai: number;
  manual: number;
  propagated: number;
  recurringTransfer: number;
  other: number;
};

export type ConfidenceDistribution = {
  high: number;
  medium: number;
  low: number;
  unknown: number;
};

export type InconsistentMerchant = {
  merchant: string;
  categories: string[];
  occurrences: number;
};

export type AccuracyReport = {
  totalTransactions: number;
  labelSourceBreakdown: LabelSourceBreakdown;
  correctionRate: number;
  confidenceDistribution: ConfidenceDistribution;
  merchantConsistencyRate: number;
  inconsistentMerchants: InconsistentMerchant[];
  staleAiRate: number;
  staleAiCount: number;
  overallScore: number;
};

export const accuracyReportQueryKey = ["accuracy-report"] as const;

export function useAccuracyReport() {
  return useQuery<AccuracyReport>({
    queryKey: accuracyReportQueryKey,
    queryFn: async () => {
      const res = await fetch("/api/accuracy-report");
      if (!res.ok) throw new Error("Failed to load accuracy report");
      return res.json() as Promise<AccuracyReport>;
    },
    staleTime: 60_000,
  });
}
