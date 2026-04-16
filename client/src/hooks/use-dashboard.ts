import { useQuery } from "@tanstack/react-query";

export const dashboardSummaryQueryKey = ["/api/dashboard-summary"] as const;
export const availableMonthsQueryKey = ["/api/dashboard/months"] as const;

export type MonthEntry = {
  month: string;
  transactionCount: number;
};

export type DashboardSummary = {
  isAllTime: boolean;
  totals: {
    totalInflow: number;
    totalOutflow: number;
    netCashflow: number;
    transactionCount: number;
    recurringIncome: number;
    recurringExpenses: number;
    oneTimeIncome: number;
    oneTimeExpenses: number;
    discretionarySpend: number;
    safeToSpend: number;
    utilitiesMonthly: number;
    softwareMonthly: number;
    utilitiesTotal: number;
    softwareTotal: number;
    periodDays: number;
  };
  expenseLeaks: {
    count: number;
    monthlyAmount: number;
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
  month?: string | null;
};

function monthToRange(month: string): { dateFrom: string; dateTo: string } {
  const [year, mo] = month.split("-").map(Number);
  const from = new Date(year, mo - 1, 1);
  const to = new Date(year, mo, 0);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

export function useAvailableMonths() {
  return useQuery<MonthEntry[]>({
    queryKey: availableMonthsQueryKey,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch("/api/dashboard/months");
      if (!res.ok) throw new Error("Failed to fetch available months");
      return res.json();
    },
  });
}

export function useDashboardSummary(filters?: DashboardFilters) {
  const range = filters?.month ? monthToRange(filters.month) : undefined;

  return useQuery<DashboardSummary>({
    queryKey: [...dashboardSummaryQueryKey, filters],
    staleTime: 60_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (range?.dateFrom) params.set("dateFrom", range.dateFrom);
      if (range?.dateTo) params.set("dateTo", range.dateTo);
      const qs = params.toString();
      const url = `/api/dashboard-summary${qs ? `?${qs}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch dashboard");
      return res.json();
    },
  });
}

export function formatMonthLabel(month: string): string {
  const [year, mo] = month.split("-").map(Number);
  const date = new Date(year, mo - 1, 1);
  return date.toLocaleString("en-US", { month: "short", year: "2-digit" });
}
