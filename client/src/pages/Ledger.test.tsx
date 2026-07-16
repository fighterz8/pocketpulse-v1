import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

function mockFetch(url: string) {
  if (url === "/api/auth/me") {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          authenticated: true,
          user: { id: 1, email: "test@test.com", displayName: "Test" },
        }),
    });
  }
  if (url === "/api/accounts") {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          accounts: [
            { id: 1, userId: 1, label: "Checking", lastFour: "1234", accountType: "checking", createdAt: "", updatedAt: "" },
          ],
        }),
    });
  }
  if (url === "/api/uploads") {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ uploads: [] }),
    });
  }
  if (url === "/api/enhancement-jobs/active") {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ job: null }),
    });
  }
  if (typeof url === "string" && url.startsWith("/api/transactions")) {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          transactions: [
            {
              id: 1, userId: 1, uploadId: 1, accountId: 1,
              date: "2026-03-15", amount: "-42.50", merchant: "Coffee Shop",
              rawDescription: "SQ *COFFEE SHOP", flowType: "outflow",
              transactionClass: "expense", recurrenceType: "one-time",
              category: "dining", labelSource: "rule", labelConfidence: "0.80",
              labelReason: null, aiAssisted: false, userCorrected: false,
              excludedFromAnalysis: false, excludedReason: null,
              excludedAt: null, createdAt: "2026-03-15T12:00:00Z",
            },
          ],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
    });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/transactions");
  vi.stubGlobal("fetch", vi.fn(mockFetch));
});

import { TooltipProvider } from "../components/ui/tooltip";
import { Ledger } from "./Ledger";

function renderLedger() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <Ledger />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("Ledger page", () => {
  it("renders the page title", () => {
    renderLedger();
    expect(screen.getByText("Ledger")).toBeInTheDocument();
  });

  it("renders the search input", () => {
    renderLedger();
    expect(screen.getByPlaceholderText(/search merchant/i)).toBeInTheDocument();
  });

  it("renders transaction data after loading", async () => {
    renderLedger();
    await waitFor(() => {
      expect(screen.getByText("Coffee Shop")).toBeInTheDocument();
    });
  });

  it("displays formatted amount", async () => {
    renderLedger();
    await waitFor(() => {
      expect(screen.getByText("-$42.50")).toBeInTheDocument();
    });
  });

  it("displays category badge", async () => {
    renderLedger();
    await waitFor(() => {
      expect(screen.getByText("dining")).toBeInTheDocument();
    });
  });

  it("renders filter dropdowns", () => {
    renderLedger();
    expect(screen.getByText("All categories")).toBeInTheDocument();
    expect(screen.getByText("All classes")).toBeInTheDocument();
    expect(screen.getByText("All recurrence")).toBeInTheDocument();
  });

  it("renders advanced data management collapsed behind a summary", () => {
    renderLedger();
    expect(screen.getByText("Advanced data management")).toBeInTheDocument();
    expect(screen.getByText("Wipe Imported Data")).toBeInTheDocument();
    expect(screen.getByText("Reset Workspace")).toBeInTheDocument();
  });

  it("initializes the account filter from URL query params", async () => {
    window.history.replaceState({}, "", "/transactions?accountId=1&excluded=false");
    const fetchSpy = vi.fn(mockFetch);
    vi.stubGlobal("fetch", fetchSpy);

    renderLedger();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/transactions?page=1&limit=50&accountId=1"),
      );
    });
  });

  it("shows only the exact Leak Hunter transaction selection from the URL", async () => {
    window.history.replaceState({}, "", "/transactions?ids=13,12&source=leak-hunter");
    const fetchSpy = vi.fn(mockFetch);
    vi.stubGlobal("fetch", fetchSpy);

    renderLedger();

    expect(await screen.findByTestId("ledger-leak-filter")).toHaveTextContent(
      "Showing only 2 associated transactions",
    );
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("ids=13%2C12"),
      );
    });
  });

  it("reveals the Export CSV tooltip when the button is focused", async () => {
    renderLedger();
    const exportBtn = await screen.findByTestId("btn-export-csv");
    fireEvent.focus(exportBtn);
    const content = await screen.findByTestId("hint-export-csv");
    expect(content).toHaveTextContent(/download/i);
    expect(content).toHaveTextContent(/csv/i);
  });

  it("shows the latest import enhancement surface without legacy worker polling", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url === "/api/uploads") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            uploads: [
              { id: 9, userId: 1, accountId: 1, filename: "june.csv", rowCount: 5, status: "complete", errorMessage: null, uploadedAt: "2026-07-15T12:00:00Z" },
            ],
          }),
        });
      }
      if (url === "/api/enhancement-jobs/active") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ job: null }) });
      }
      if (url === "/api/uploads/9/enhancement") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            uploadId: 9,
            state: "blocked",
            unresolvedTransactionCount: 4,
            unresolvedMerchantCount: 2,
            blockedReason: "FEATURE_DISABLED",
          }),
        });
      }
      return mockFetch(url);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderLedger();

    expect(await screen.findByTestId("ledger-enhancement-surface")).toHaveTextContent("Latest import · june.csv");
    expect(await screen.findByRole("heading", { name: /2 merchants need review/i })).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([url]) => url === "/api/uploads/ai-status")).toBe(false);
  });

  it("prefers an older durable active job over the latest completed upload", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url === "/api/uploads") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            uploads: [
              { id: 9, userId: 1, accountId: 1, filename: "latest.csv", rowCount: 2, status: "complete", errorMessage: null, uploadedAt: "2026-07-15T12:00:00Z" },
              { id: 4, userId: 1, accountId: 1, filename: "active.csv", rowCount: 6, status: "complete", errorMessage: null, uploadedAt: "2026-07-14T12:00:00Z" },
            ],
          }),
        });
      }
      if (url === "/api/enhancement-jobs/active") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ job: { id: 77, uploadId: 4, status: "budget_blocked", totalMerchants: 3, completedMerchants: 1, skippedMerchants: 0, failedMerchants: 0, progress: 33 } }),
        });
      }
      if (url === "/api/uploads/4/enhancement") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ uploadId: 4, state: "active", activeJobId: 77, unresolvedTransactionCount: 2, unresolvedMerchantCount: 2, access: { state: "active", trialAvailable: false } }),
        });
      }
      if (url === "/api/enhancement-jobs/77") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ job: { id: 77, uploadId: 4, status: "budget_blocked", totalMerchants: 3, completedMerchants: 1, skippedMerchants: 0, failedMerchants: 0, progress: 33 } }),
        });
      }
      return mockFetch(url);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderLedger();

    expect(await screen.findByTestId("ledger-enhancement-surface")).toHaveTextContent("Active review · active.csv");
    expect(await screen.findByText("Monthly enhancement allowance reached")).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([url]) => url === "/api/uploads/9/enhancement")).toBe(false);
  });
});
