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

export type DashboardFilters = {
  dateFrom?: string;
  dateTo?: string;
};

export function useDashboardSummary(filters?: DashboardFilters) {
  return useQuery<DashboardSummary>({
    queryKey: [...dashboardSummaryQueryKey, filters],
    staleTime: 60_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
      if (filters?.dateTo) params.set("dateTo", filters.dateTo);
      const qs = params.toString();
      const url = `/api/dashboard-summary${qs ? `?${qs}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch dashboard");
      return res.json();
    },
  });
}
