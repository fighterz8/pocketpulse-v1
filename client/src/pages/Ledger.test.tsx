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

  it("renders the danger zone", () => {
    renderLedger();
    expect(screen.getByText("Data Management")).toBeInTheDocument();
    expect(screen.getByText("Wipe Imported Data")).toBeInTheDocument();
    expect(screen.getByText("Reset Workspace")).toBeInTheDocument();
  });

  it("reveals the Export CSV tooltip when the button is focused", async () => {
    renderLedger();
    const exportBtn = await screen.findByTestId("btn-export-csv");
    fireEvent.focus(exportBtn);
    const content = await screen.findByTestId("hint-export-csv");
    expect(content).toHaveTextContent(/download/i);
    expect(content).toHaveTextContent(/csv/i);
  });
});
