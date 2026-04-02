import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockCandidatesResponse = {
  candidates: [
    {
      candidateKey: "netflix|15.99",
      merchantKey: "netflix",
      merchantDisplay: "Netflix",
      frequency: "monthly",
      averageAmount: 15.99,
      amountStdDev: 0,
      confidence: 0.82,
      reasonFlagged: "3 charges of ~$15.99 detected monthly at a consistent amount",
      transactionIds: [1, 2, 3],
      firstSeen: "2026-01-15",
      lastSeen: "2026-03-15",
      expectedNextDate: "2026-04-14",
      category: "subscriptions",
      reviewStatus: "unreviewed",
      reviewNotes: null,
    },
  ],
  summary: {
    total: 1,
    unreviewed: 1,
    essential: 0,
    leak: 0,
    dismissed: 0,
  },
};

function mockFetch(url: string) {
  if (url === "/api/recurring-candidates") {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(mockCandidatesResponse),
    });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(mockFetch));
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
  it("renders the page title", () => {
    renderLeaks();
    expect(screen.getByText("Recurring Leak Review")).toBeInTheDocument();
  });

  it("renders filter tabs", async () => {
    renderLeaks();
    await waitFor(() => {
      const tabs = document.querySelectorAll(".leaks-tab");
      expect(tabs.length).toBe(5);
      const tabLabels = Array.from(tabs).map((t) => t.textContent);
      expect(tabLabels).toEqual(["All", "Unreviewed", "Essential", "Leaks", "Dismissed"]);
    });
  });

  it("renders candidate cards after loading", async () => {
    renderLeaks();
    await waitFor(() => {
      expect(screen.getByText("Netflix")).toBeInTheDocument();
    });
  });

  it("shows confidence badge", async () => {
    renderLeaks();
    await waitFor(() => {
      expect(screen.getByText("High confidence")).toBeInTheDocument();
    });
  });

  it("displays summary bar", async () => {
    renderLeaks();
    await waitFor(() => {
      const summaryItems = document.querySelectorAll(".leaks-summary-item");
      expect(summaryItems.length).toBe(5);
      expect(screen.getByText("Total")).toBeInTheDocument();
    });
  });

  it("shows action buttons on candidate card", async () => {
    renderLeaks();
    await waitFor(() => {
      const actionBtns = document.querySelectorAll(".leaks-action-btn");
      expect(actionBtns.length).toBe(3);
      const labels = Array.from(actionBtns).map((b) => b.textContent);
      expect(labels).toEqual(["Essential", "Leak", "Dismiss"]);
    });
  });

  it("shows empty state when no candidates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/recurring-candidates") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                candidates: [],
                summary: { total: 0, unreviewed: 0, essential: 0, leak: 0, dismissed: 0 },
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    renderLeaks();
    await waitFor(() => {
      expect(screen.getByText(/no recurring patterns/i)).toBeInTheDocument();
    });
  });
});
