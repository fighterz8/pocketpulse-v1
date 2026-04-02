import { useQuery } from "@tanstack/react-query";

export const dashboardSummaryQueryKey = ["/api/dashboard-summary"] as const;

export type DashboardSummary = {
  totals: {
    totalInflow: number;
    totalOutflow: number;
    netCashflow: number;
    transactionCount: number;
  };
  categoryBreakdown: Array<{
    category: string;
    total: number;
    count: number;
  }>;
  monthlyTrend: Array<{
    month: string;
    inflow: number;
    outflow: number;
    net: number;
  }>;
  recentTransactions: Array<{
    id: number;
    date: string;
    merchant: string;
    amount: string;
    category: string;
    transactionClass: string;
  }>;
  accountCount: number;
};

export function useDashboardSummary() {
  return useQuery<DashboardSummary>({
    queryKey: dashboardSummaryQueryKey,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch("/api/dashboard-summary");
      if (!res.ok) throw new Error("Failed to fetch dashboard");
      return res.json();
    },
  });
}
