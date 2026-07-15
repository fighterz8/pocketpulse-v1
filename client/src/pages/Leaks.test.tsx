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
  analysisWindow: {
    startDate: "2025-02-01",
    endDate: "2026-01-31",
    days: 365,
    totalTransactions: 72,
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
        transactions: [
          {
            id: 13,
            date: "2026-01-15",
            merchant: "SPOTIFY.COM",
            amount: 17.99,
            category: "entertainment",
          },
          {
            id: 12,
            date: "2025-12-15",
            merchant: "SPOTIFY USA",
            amount: 14.99,
            category: "entertainment",
          },
        ],
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
        transactions: [],
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
      expect(screen.getByTestId("leak-hunter-coverage")).toHaveTextContent(
        "Recent analysis",
      );
      expect(screen.getByTestId("leak-hunter-coverage")).toHaveTextContent(
        "72 transactions",
      );
      expect(screen.getByTestId("leak-hunter-summary")).toHaveTextContent(
        "Active subscriptions / mo",
      );
      expect(screen.getByTestId("leak-hunter-summary")).toHaveTextContent("$18");
    });
  });

  it("renders finding cards with evidence and ledger links", async () => {
    renderLeaks();
    expect(await screen.findByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText(/Monthly cadence detected/)).toBeInTheDocument();
    expect(screen.getAllByText("Subscription").length).toBeGreaterThan(0);
    expect(screen.getByText("2 associated transactions")).toBeInTheDocument();
    expect(screen.getByText("SPOTIFY USA")).toBeInTheDocument();
    expect(screen.getAllByText("$17.99").length).toBeGreaterThan(0);
    expect(screen.getByText("$215.88 per year if active")).toBeInTheDocument();
    expect(screen.getByTestId("link-ledger-spotify")).toHaveAttribute(
      "href",
      expect.stringContaining("ids=13%2C12"),
    );
    expect(screen.getByTestId("link-ledger-spotify")).toHaveAttribute(
      "href",
      expect.not.stringContaining("search=spotify"),
    );
  });

  it("places non-subscription spending leaks first and marks them as priority", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch({
        ...MOCK_REPORT,
        summary: {
          ...MOCK_REPORT.summary,
          recentHabitCount: 1,
        },
        sections: {
          ...MOCK_REPORT.sections,
          recentHabits: [
            {
              id: "habit-corner-coffee",
              merchantKey: "corner-coffee",
              merchant: "Corner Coffee",
              status: "active",
              kind: "habit",
              firstSeen: "2026-01-02",
              lastSeen: "2026-01-28",
              occurrences: 4,
              averageAmount: 8.45,
              latestAmount: 11,
              monthlyEquivalent: 33.8,
              historicalTotal: 33.8,
              confidence: "medium",
              evidence: ["Amounts varied across four similar coffee purchases."],
              transactions: [
                {
                  id: 20,
                  date: "2026-01-28",
                  merchant: "Corner Coffee",
                  amount: 11,
                  category: "coffee",
                },
              ],
              ledgerQuery: { merchant: "corner coffee" },
            },
          ],
        },
      }),
    );

    renderLeaks();

    expect(
      await screen.findByRole("heading", { level: 2, name: "Recent spending leaks" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Priority leak")).toBeInTheDocument();
    expect(screen.queryByText("Subscriptions to review")).not.toBeInTheDocument();
    expect(screen.getByTestId("leak-mode-active")).toHaveTextContent("Subscriptions");

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings[0]).toHaveTextContent("Recent spending leaks");
  });

  it("labels stopped findings with historical cost instead of active annual cost", async () => {
    renderLeaks();
    await screen.findByText("Spotify");
    fireEvent.click(screen.getByTestId("leak-mode-stopped"));
    expect(await screen.findByText("Old Gym")).toBeInTheDocument();
    expect(screen.getByText("$120.00 tracked historically")).toBeInTheDocument();
    expect(screen.queryByText("$288.00 per year if active")).not.toBeInTheDocument();
  });

  it("keeps the overview compact and shows one finding section at a time", async () => {
    renderLeaks();
    expect(await screen.findByText("Spotify")).toBeInTheDocument();
    expect(screen.queryByText("Old Gym")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getByTestId("leak-mode-full")).toHaveAttribute(
      "aria-label",
      "Overview, 2 findings",
    );
    expect(screen.getByTestId("leak-mode-active")).toHaveAttribute(
      "aria-label",
      "Subscriptions, 1 finding",
    );
    expect(screen.getByTestId("leak-mode-full")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByTestId("leak-mode-stopped"));
    await waitFor(() => {
      expect(screen.getByText("Old Gym")).toBeInTheDocument();
      expect(screen.queryByText("Spotify")).not.toBeInTheDocument();
      expect(screen.getByTestId("leak-mode-stopped")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("keeps uncertain recurring patterns out of active leak counts and savings language", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch({
        ...MOCK_REPORT,
        sections: {
          ...MOCK_REPORT.sections,
          needsReview: [
            {
              id: "review-unknown",
              merchantKey: "unknown-pattern",
              merchant: "Recurring pattern",
              status: "possibly_active",
              kind: "unknown",
              firstSeen: "2025-08-01",
              lastSeen: "2026-01-01",
              expectedNextDate: "2026-02-01",
              cadence: "monthly",
              occurrences: 6,
              averageAmount: 100,
              latestAmount: 100,
              monthlyEquivalent: 100,
              historicalTotal: 600,
              confidence: "medium",
              evidence: ["Recurring pattern needs classification."],
              ledgerQuery: { search: "unknown pattern", transactionClass: "expense" },
            },
          ],
        },
      }),
    );

    renderLeaks();

    expect(await screen.findByText("Spotify")).toBeInTheDocument();
    expect(screen.queryByText("Recurring pattern")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("leak-mode-needs_review"));
    expect(await screen.findByText("Recurring pattern")).toBeInTheDocument();
    expect(screen.getByText("$600.00 seen · not counted as a leak")).toBeInTheDocument();
    expect(screen.getByText(/not counted as leaks or savings/i)).toBeInTheDocument();
    expect(screen.getByTestId("leak-mode-full")).toHaveAttribute(
      "aria-label",
      "Overview, 3 findings",
    );
    expect(screen.getByTestId("leak-mode-active")).toHaveAttribute(
      "aria-label",
      "Subscriptions, 1 finding",
    );

    fireEvent.click(screen.getByTestId("leak-mode-active"));

    await waitFor(() => {
      expect(screen.getByText("Spotify")).toBeInTheDocument();
      expect(screen.queryByText("Recurring pattern")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { level: 2, name: "Needs review" }),
      ).not.toBeInTheDocument();
    });
  });

  it("paginates long finding groups instead of growing one endless page", async () => {
    const findings = Array.from({ length: 5 }, (_, index) => ({
      ...MOCK_REPORT.sections.activeLeaks[0],
      id: `active-service-${index + 1}`,
      merchantKey: `service-${index + 1}`,
      merchant: `Service ${index + 1}`,
      transactions: [
        {
          id: 100 + index,
          date: "2026-01-15",
          merchant: `Service ${index + 1}`,
          amount: 17.99,
          category: "software",
        },
      ],
    }));
    vi.stubGlobal(
      "fetch",
      makeMockFetch({
        ...MOCK_REPORT,
        summary: { ...MOCK_REPORT.summary, activeCount: 5 },
        sections: { ...MOCK_REPORT.sections, activeLeaks: findings },
      }),
    );

    renderLeaks();

    expect(
      await screen.findByRole("heading", { level: 3, name: "Service 1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Service 3" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: "Service 4" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByRole("heading", { level: 3, name: "Service 4" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: "Service 1" }),
    ).not.toBeInTheDocument();
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
