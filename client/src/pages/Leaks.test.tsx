import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const MOCK_REPORT = {
  coverage: {
    startDate: "2025-01-01",
    endDate: "2026-01-31",
    asOfDate: "2026-01-31",
    totalTransactions: 84,
    accountCount: 1,
    coverageDays: 395,
    coverageQuality: "strong",
    freshness: "current",
    limitations: [],
  },
  summary: {
    activeCount: 1,
    inactiveCount: 1,
    priceCreepCount: 1,
    recentHabitCount: 0,
    estimatedActiveMonthly: 17.99,
    estimatedHistoricalTotal: 120,
  },
  sections: {
    activeLeaks: [
      {
        id: "active-spotify",
        merchantKey: "spotify",
        merchant: "Spotify",
        status: "active",
        kind: "subscription",
        firstSeen: "2025-01-15",
        lastSeen: "2026-01-15",
        expectedNextDate: "2026-02-14",
        cadence: "monthly",
        occurrences: 13,
        averageAmount: 14.99,
        latestAmount: 17.99,
        monthlyEquivalent: 17.99,
        historicalTotal: 194.87,
        priceChangePct: 20,
        confidence: "high",
        evidence: ["Monthly cadence detected across 13 charges."],
        ledgerQuery: { search: "spotify", transactionClass: "expense" },
      },
    ],
    stoppedLeaks: [
      {
        id: "stopped-gym",
        merchantKey: "old-gym",
        merchant: "Old Gym",
        status: "historical",
        kind: "subscription",
        firstSeen: "2025-01-05",
        lastSeen: "2025-05-05",
        cadence: "monthly",
        occurrences: 5,
        averageAmount: 24,
        latestAmount: 24,
        monthlyEquivalent: 24,
        historicalTotal: 120,
        confidence: "medium",
        evidence: ["No matching charge after May 2025."],
        ledgerQuery: { search: "old gym", transactionClass: "expense" },
      },
    ],
    priceCreep: [],
    recentHabits: [],
    needsReview: [],
  },
};

function makeMockFetch(report: unknown = MOCK_REPORT) {
  return vi.fn((url: string) => {
    if (url.startsWith("/api/leak-hunter/report")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(report) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/leaks");
  vi.stubGlobal("fetch", makeMockFetch());
});

import { Leaks } from "./Leaks";

function renderLeaks() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Leaks />
    </QueryClientProvider>,
  );
}

describe("Leaks page", () => {
  it("renders the Leak Hunter title", () => {
    renderLeaks();
    expect(screen.getByText("Leak Hunter")).toBeInTheDocument();
  });

  it("renders coverage and summary from the report", async () => {
    renderLeaks();
    await waitFor(() => {
      expect(screen.getByTestId("leak-hunter-coverage")).toHaveTextContent(
        "Strong coverage",
      );
      expect(screen.getByTestId("leak-hunter-coverage")).toHaveTextContent(
        "annual renewals",
      );
      expect(screen.getByTestId("leak-hunter-summary")).toHaveTextContent(
        "Active monthly",
      );
      expect(screen.getByTestId("leak-hunter-summary")).toHaveTextContent("$18");
    });
  });

  it("renders finding cards with evidence and ledger links", async () => {
    renderLeaks();
    expect(await screen.findByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText(/Monthly cadence detected/)).toBeInTheDocument();
    expect(screen.getByText("$215.88 per year if active")).toBeInTheDocument();
    expect(screen.getByTestId("link-ledger-spotify")).toHaveAttribute(
      "href",
      expect.stringContaining("search=spotify"),
    );
  });

  it("labels stopped findings with historical cost instead of active annual cost", async () => {
    renderLeaks();
    expect(await screen.findByText("Old Gym")).toBeInTheDocument();
    expect(screen.getByText("$120.00 tracked historically")).toBeInTheDocument();
    expect(screen.queryByText("$288.00 per year if active")).not.toBeInTheDocument();
  });

  it("filters sections when a mode is selected", async () => {
    renderLeaks();
    expect(await screen.findByText("Old Gym")).toBeInTheDocument();
    expect(screen.getByTestId("leak-mode-full")).toHaveAttribute(
      "aria-label",
      "Full hunt, 2 findings",
    );
    expect(screen.getByTestId("leak-mode-active")).toHaveAttribute(
      "aria-label",
      "Active, 1 finding",
    );
    expect(screen.getByTestId("leak-mode-full")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByTestId("leak-mode-active"));
    await waitFor(() => {
      expect(screen.queryByText("Old Gym")).not.toBeInTheDocument();
      expect(screen.getByText("Spotify")).toBeInTheDocument();
      expect(screen.getByTestId("leak-mode-active")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("preserves report query filters and writes selected mode to the URL", async () => {
    window.history.replaceState(
      {},
      "",
      "/leaks?mode=stopped&accountId=10&asOf=2026-01-31",
    );
    const fetchSpy = makeMockFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderLeaks();

    expect(await screen.findByText("Old Gym")).toBeInTheDocument();
    expect(screen.getByTestId("link-ledger-old-gym")).toHaveAttribute(
      "href",
      expect.stringContaining("accountId=10"),
    );
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/leak-hunter/report?mode=stopped&accountId=10&asOf=2026-01-31",
      );
    });

    fireEvent.click(screen.getByTestId("leak-mode-price_creep"));

    await waitFor(() => {
      expect(window.location.search).toBe(
        "?mode=price_creep&accountId=10&asOf=2026-01-31",
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/leak-hunter/report?mode=price_creep&accountId=10&asOf=2026-01-31",
      );
    });
  });

  it("shows empty state when the selected mode has no findings", async () => {
    renderLeaks();
    await screen.findByText("Spotify");
    fireEvent.click(screen.getByTestId("leak-mode-recent_habits"));
    await waitFor(() => {
      expect(screen.getByTestId("leaks-empty")).toBeInTheDocument();
      expect(screen.getByTestId("leaks-empty")).toHaveTextContent(
        "No repeat recent habits found",
      );
      expect(screen.getByRole("link", { name: "Upload more history" })).toHaveAttribute(
        "href",
        "/upload",
      );
    });
  });

  it("gives stronger upload guidance for limited coverage", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch({
        ...MOCK_REPORT,
        coverage: {
          ...MOCK_REPORT.coverage,
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          coverageDays: 31,
          coverageQuality: "limited",
        },
        summary: {
          activeCount: 0,
          inactiveCount: 0,
          priceCreepCount: 0,
          recentHabitCount: 0,
          estimatedActiveMonthly: 0,
          estimatedHistoricalTotal: 0,
        },
        sections: {
          activeLeaks: [],
          stoppedLeaks: [],
          priceCreep: [],
          recentHabits: [],
          needsReview: [],
        },
      }),
    );
    renderLeaks();
    await waitFor(() => {
      expect(screen.getByTestId("leaks-empty")).toHaveTextContent(
        "This upload is too short for a confident hit",
      );
      expect(screen.getByTestId("leak-hunter-coverage")).toHaveTextContent(
        "Short history can catch obvious repeats",
      );
      expect(screen.getByTestId("leaks-empty")).toHaveTextContent("90 days");
      expect(screen.getByTestId("leaks-empty")).toHaveTextContent("12 months");
    });
  });

  it("surfaces selected-account and short-history limitations", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch({
        ...MOCK_REPORT,
        coverage: {
          ...MOCK_REPORT.coverage,
          startDate: "2026-01-01",
          endDate: "2026-01-20",
          coverageDays: 20,
          coverageQuality: "limited",
          limitations: [
            "This only reflects the selected account.",
            "Less than 90 days of history can miss monthly subscriptions and stopped leaks.",
          ],
        },
      }),
    );

    renderLeaks();

    const limitations = await screen.findByRole("list", {
      name: "Leak Hunter coverage limitations",
    });
    expect(limitations).toHaveTextContent("selected account");
    expect(limitations).toHaveTextContent("Less than 90 days");
  });

  it("warns when the uploaded history is stale", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch({
        ...MOCK_REPORT,
        coverage: {
          ...MOCK_REPORT.coverage,
          endDate: "2025-11-15",
          asOfDate: "2025-11-15",
          freshness: "stale",
        },
      }),
    );

    renderLeaks();

    expect(await screen.findByTestId("leak-hunter-freshness-warning")).toHaveTextContent(
      "active leaks may already have changed",
    );
  });

  it("explains when an as-of report excludes later imported transactions", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch({
        ...MOCK_REPORT,
        coverage: {
          ...MOCK_REPORT.coverage,
          endDate: "2026-04-30",
          asOfDate: "2026-01-31",
        },
      }),
    );

    renderLeaks();

    expect(await screen.findByTestId("leak-hunter-as-of-note")).toHaveTextContent(
      "Later imported transactions through Apr 30, 2026 stay visible in coverage",
    );
    expect(screen.getByTestId("leak-hunter-as-of-note")).toHaveTextContent(
      "findings stop at Jan 31, 2026",
    );
  });

  it("shows error state when the report fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.startsWith("/api/leak-hunter/report")) {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
    renderLeaks();
    await waitFor(() => {
      expect(document.querySelector("[data-testid='leaks-error']")).toBeInTheDocument();
    });
  });
});
