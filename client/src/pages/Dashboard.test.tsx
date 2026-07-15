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

const emptyLeakReport = {
  sections: {
    activeLeaks: [],
    recentHabits: [],
  },
};

/**
 * URL-aware fetch mock:
 * - /api/leak-hunter/report → empty canonical Leak Hunter report
 * - /api/dashboard/months → empty array (MonthSelector expects an array)
 * - everything else       → summaryData
 */
function makeSuccessFetch(
  summaryData: unknown,
  leakReport: unknown = emptyLeakReport,
) {
  return vi.fn((url: string) => {
    if ((url as string).startsWith("/api/leak-hunter/report")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(leakReport) });
    }
    if ((url as string).startsWith("/api/dashboard/months")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(summaryData) });
  });
}

beforeEach(() => {
  // Mark the first-visit welcome overlay as already seen by default so the
  // existing dashboard tests render as if the user has been here before.
  // Task #119 moved the WelcomeOverlay from AccountSetup into the Dashboard;
  // when it opens it marks every sibling element inert + aria-hidden, which
  // breaks accessibility-tree queries (getByRole / getByLabelText) for the
  // dashboard body. The overlay-specific tests below clear this flag
  // explicitly to verify the overlay's first-visit behaviour.
  window.localStorage.setItem("pp_welcome_seen", "1");
  window.history.replaceState({}, "", "/dashboard");
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
        if ((url as string).startsWith("/api/leak-hunter/report")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyLeakReport) });
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

  it("uses the canonical report for spending leaks and separates subscriptions", async () => {
    const fetchSpy = makeSuccessFetch(fullSummary, {
      sections: {
        activeLeaks: [
          { merchant: "Spotify", kind: "subscription", monthlyEquivalent: 17.99 },
        ],
        recentHabits: [
          { merchant: "Corner Coffee", kind: "habit", monthlyEquivalent: 42.5 },
          { merchant: "Cloud Storage", kind: "subscription", monthlyEquivalent: 9.99 },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderDashboard();

    expect(await screen.findByTestId("leak-count")).toHaveTextContent("1");
    expect(screen.getByText(/spending leak detected/i)).toBeInTheDocument();
    expect(screen.getByText(/~\$42\.50\/mo recent repeat spend/i)).toBeInTheDocument();
    expect(screen.getByText(/2 subscriptions? to review/i)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/leak-hunter/report");
  });

  it("uses the selected month end as the Leak Hunter snapshot date", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url === "/api/dashboard/months") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ month: "2026-02", transactionCount: 42 }]),
        });
      }
      if (url.startsWith("/api/leak-hunter/report")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyLeakReport) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fullSummary) });
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderDashboard();

    await screen.findByText("February 2026");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/leak-hunter/report?asOf=2026-02-28",
    );
  });

  it("shows the actual recurring expense total for the selected month", async () => {
    const februarySummary = {
      ...fullSummary,
      isAllTime: false,
      totals: { ...fullSummary.totals, recurringExpenses: 243.19 },
    };
    const fetchSpy = vi.fn((url: string) => {
      if (url === "/api/dashboard/months") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ month: "2026-02", transactionCount: 42 }]),
        });
      }
      if (url.startsWith("/api/leak-hunter/report")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyLeakReport) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(februarySummary) });
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderDashboard();

    expect(await screen.findByTestId("kpi-recurring-expenses")).toHaveTextContent("$243");
    expect(screen.getByText("Actual recurring charges · Feb 26")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/dashboard-summary?dateFrom=2026-02-01&dateTo=2026-02-28",
    );
  });

  it("opens the selected month's recurring expenses in the filtered ledger", async () => {
    const februarySummary = {
      ...fullSummary,
      isAllTime: false,
      totals: { ...fullSummary.totals, recurringExpenses: 243.19 },
    };
    const fetchSpy = vi.fn((url: string) => {
      if (url === "/api/dashboard/months") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ month: "2026-02", transactionCount: 42 }]),
        });
      }
      if (url.startsWith("/api/leak-hunter/report")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyLeakReport) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(februarySummary) });
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderDashboard();

    const recurringKpi = await screen.findByTestId("kpi-recurring-expenses");
    const recurringCard = recurringKpi.closest('[role="link"]');
    expect(recurringCard).not.toBeNull();

    fireEvent.click(recurringCard!);

    expect(window.location.search).toBe(
      "?excluded=false&dateFrom=2026-02-01&dateTo=2026-02-28&transactionClass=expense&recurrenceType=recurring",
    );
    expect(window.location.pathname).toBe("/transactions");
    expect(screen.queryByText(/recurring expenses · breakdown/i)).not.toBeInTheDocument();
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

  // ── Task #119: WelcomeOverlay was moved from AccountSetup to the Dashboard ─
  describe("first-visit welcome overlay", () => {
    it("shows the welcome overlay on first dashboard visit when pp_welcome_seen is unset", async () => {
      // Override the default beforeEach flag — this test simulates a brand-new
      // user who has never seen the overlay.
      window.localStorage.removeItem("pp_welcome_seen");
      vi.stubGlobal("fetch", makeSuccessFetch(fullSummary));
      renderDashboard();
      // Overlay mounts synchronously regardless of dashboard data state, so
      // it should be present before the dashboard data even resolves.
      expect(screen.getByTestId("welcome-overlay")).toBeInTheDocument();
      // The overlay's primary CTA is focused on mount.
      expect(screen.getByTestId("welcome-overlay-dismiss")).toBeInTheDocument();
      // After dismissing, the flag is persisted and the overlay disappears.
      fireEvent.click(screen.getByTestId("welcome-overlay-dismiss"));
      expect(screen.queryByTestId("welcome-overlay")).not.toBeInTheDocument();
      expect(window.localStorage.getItem("pp_welcome_seen")).toBe("1");
    });

    it("does NOT show the welcome overlay when pp_welcome_seen=1 is already set", () => {
      window.localStorage.setItem("pp_welcome_seen", "1");
      vi.stubGlobal("fetch", makeSuccessFetch(fullSummary));
      renderDashboard();
      expect(screen.queryByTestId("welcome-overlay")).not.toBeInTheDocument();
    });

    it("still mounts the overlay during the dashboard's loading state (so it appears immediately)", () => {
      window.localStorage.removeItem("pp_welcome_seen");
      // Pending fetch — Dashboard shows the loading state, but the overlay
      // sits outside DashboardImpl so it must still render.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      renderDashboard();
      expect(screen.getByText(/loading dashboard/i)).toBeInTheDocument();
      expect(screen.getByTestId("welcome-overlay")).toBeInTheDocument();
    });
  });
});
