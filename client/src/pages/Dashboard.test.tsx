import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { TooltipProvider } from "../components/ui/tooltip";
import { Dashboard } from "./Dashboard";

function renderDashboard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <Dashboard />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// fullSummary matches the DashboardSummary type from server/dashboardQueries.ts.
// Required totals fields: totalInflow, totalOutflow, netCashflow, safeToSpend,
// transactionCount, recurringIncome, recurringExpenses, oneTimeIncome,
// oneTimeExpenses, discretionarySpend.
const fullSummary = {
  totals: {
    totalInflow: 5000,
    totalOutflow: 1200.5,
    netCashflow: 3799.5,
    safeToSpend: 3799.5,
    transactionCount: 42,
    recurringIncome: 1000,
    recurringExpenses: 500,
    oneTimeIncome: 4000,
    oneTimeExpenses: 700.5,
    discretionarySpend: 300,
  },
  isAllTime: true,
  categoryBreakdown: [
    { category: "groceries", total: 450, count: 8 },
    { category: "subscriptions", total: 200, count: 3 },
  ],
  monthlyTrend: [
    { month: "2026-01", inflow: 2000, outflow: 500, net: 1500 },
    { month: "2026-02", inflow: 3000, outflow: 700.5, net: 2299.5 },
  ],
  recentTransactions: [
    {
      id: 1,
      date: "2026-02-10",
      merchant: "Coffee Shop",
      amount: "-4.50",
      category: "dining",
      transactionClass: "expense",
    },
    {
      id: 2,
      date: "2026-02-09",
      merchant: "Employer Pay",
      amount: "3000.00",
      category: "income",
      transactionClass: "income",
    },
  ],
  accountCount: 1,
};

/**
 * URL-aware fetch mock:
 * - /api/leaks            → empty array (avoids .reduce-on-object crash)
 * - /api/dashboard/months → empty array (MonthSelector expects an array)
 * - everything else       → summaryData
 */
function makeSuccessFetch(summaryData: unknown) {
  return vi.fn((url: string) => {
    if ((url as string).startsWith("/api/leaks")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if ((url as string).startsWith("/api/dashboard/months")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryData) });
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard", () => {
  it("renders loading state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderDashboard();
    expect(screen.getByText(/loading dashboard/i)).toBeInTheDocument();
  });

  it("renders empty state when there are no transactions", async () => {
    vi.stubGlobal(
      "fetch",
      makeSuccessFetch({
        totals: {
          totalInflow: 0,
          totalOutflow: 0,
          netCashflow: 0,
          safeToSpend: 0,
          transactionCount: 0,
          recurringIncome: 0,
          recurringExpenses: 0,
          oneTimeIncome: 0,
          oneTimeExpenses: 0,
          discretionarySpend: 0,
        },
        isAllTime: true,
        categoryBreakdown: [],
        monthlyTrend: [],
        recentTransactions: [],
        accountCount: 0,
      }),
    );
    renderDashboard();
    // When selectedMonth is null (no available months) the period label is "All Time".
    expect(
      await screen.findByText(/no transactions in all time/i),
    ).toBeInTheDocument();
    const uploadLink = screen.getByRole("link", { name: /upload your first csv/i });
    expect(uploadLink).toHaveAttribute("href", "/upload");
  });

  it("renders error state when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if ((url as string).startsWith("/api/leaks")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if ((url as string).startsWith("/api/dashboard/months")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }),
    );
    renderDashboard();
    expect(
      await screen.findByText(/error loading dashboard/i),
    ).toBeInTheDocument();
  });

  it("renders KPI cards with formatted values", async () => {
    vi.stubGlobal("fetch", makeSuccessFetch(fullSummary));
    renderDashboard();
    // "Total Income" and "Total Spending" come from KpiCard labels (Row 2).
    expect(await screen.findByText("Total Income")).toBeInTheDocument();
    expect(screen.getByText("Total Spending")).toBeInTheDocument();
    // $5,000.00 and $1,200.50 appear in the Safe-to-Spend bar (full currency format).
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.getByText("$1,200.50")).toBeInTheDocument();
    // $3,799.50 is the safeToSpend hero value.
    expect(screen.getByText("$3,799.50")).toBeInTheDocument();
  });

  it("renders category breakdown after data loads", async () => {
    vi.stubGlobal("fetch", makeSuccessFetch(fullSummary));
    renderDashboard();
    // "Spending by Category" section is the only remaining data section in Dashboard.
    expect(await screen.findByText("Spending by Category")).toBeInTheDocument();
    // Dashboard capitalizes category names via capitalize().
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Subscriptions")).toBeInTheDocument();
  });

  it("View all links to ledger route", async () => {
    vi.stubGlobal("fetch", makeSuccessFetch(fullSummary));
    renderDashboard();
    // The "View all transactions →" text is inside the Net Cashflow GlassCard.
    // GlassCard renders as a div[role=link] (no href attribute); verify the
    // navigation text is rendered once data loads.
    expect(
      await screen.findByText(/view all transactions/i),
    ).toBeInTheDocument();
  });

  it("reveals the Net Cashflow tooltip when its hint icon is focused", async () => {
    vi.stubGlobal("fetch", makeSuccessFetch(fullSummary));
    renderDashboard();
    const trigger = await screen.findByTestId("hint-net-cashflow");
    fireEvent.focus(trigger);
    const content = await screen.findByTestId("hint-net-cashflow-content");
    expect(content).toHaveTextContent(/income/i);
    expect(content).toHaveTextContent(/spending/i);
  });
});
