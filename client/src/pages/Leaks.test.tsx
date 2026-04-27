import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const MOCK_MONTHS = [{ month: "2026-01", transactionCount: 5 }];

const MOCK_LEAK = {
  merchant: "Starbucks",
  merchantKey: "starbucks",
  merchantFilter: "starbucks",
  dominantCategory: "coffee",
  categoryBreakdown: [{ category: "coffee", total: 24.0, count: 4 }],
  bucket: "micro_spend",
  label: "Frequent micro-purchases",
  monthlyAmount: 8.0,
  occurrences: 4,
  firstDate: "2025-12-01",
  lastDate: "2026-01-22",
  confidence: "High",
  averageAmount: 6.0,
  recentSpend: 24.0,
  dailyAverage: 0.8,
  transactionClass: "expense",
  isSubscriptionLike: false,
};

function makeMockFetch(leaks: unknown[] = [MOCK_LEAK]) {
  return vi.fn((url: string) => {
    if (url === "/api/dashboard/months") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MONTHS) });
    }
    if (url.startsWith("/api/leaks")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(leaks) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", makeMockFetch());
});

import { TooltipProvider } from "../components/ui/tooltip";
import { Leaks } from "./Leaks";

function renderLeaks() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <Leaks />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("Leaks page", () => {
  it("renders the page title", () => {
    renderLeaks();
    expect(screen.getByText("Leak Detection")).toBeInTheDocument();
  });

  it("renders a leak card after loading", async () => {
    renderLeaks();
    await waitFor(() => {
      expect(screen.getByText("Starbucks")).toBeInTheDocument();
    });
  });

  it("shows summary line with count and flagged total", async () => {
    renderLeaks();
    await waitFor(() => {
      const summary = document.querySelector("[data-testid='leaks-summary-inline']");
      expect(summary).toBeInTheDocument();
      expect(summary!.textContent).toMatch(/1 leak/);
      expect(summary!.textContent).toMatch(/\$24\.00 flagged/);
    });
  });

  it("shows empty state when no leaks returned", async () => {
    vi.stubGlobal("fetch", makeMockFetch([]));
    renderLeaks();
    await waitFor(() => {
      expect(document.querySelector("[data-testid='leaks-empty']")).toBeInTheDocument();
    });
  });

  it("reveals the bucket tooltip when the bucket label is focused", async () => {
    renderLeaks();
    // Wait for the leak card to appear, then grab the explicit trigger.
    const trigger = await screen.findByTestId("bucket-trigger-starbucks");
    fireEvent.focus(trigger);
    const content = await screen.findByTestId("hint-bucket-starbucks");
    expect(content).toHaveTextContent(/micro-spend/i);
  });

  it("shows error state when leak fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/dashboard/months") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MONTHS) });
        }
        if (url.startsWith("/api/leaks")) {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }),
    );
    renderLeaks();
    await waitFor(() => {
      expect(document.querySelector("[data-testid='leaks-error']")).toBeInTheDocument();
    });
  });
});
