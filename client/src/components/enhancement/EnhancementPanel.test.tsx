import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCsrfToken } from "../../lib/api";
import { EnhancementPanel } from "./EnhancementPanel";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPanel(uploadId = 42) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <EnhancementPanel uploadId={uploadId} surface="ledger" />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

const freeAvailability = {
  uploadId: 42,
  state: "blocked",
  unresolvedTransactionCount: 5,
  unresolvedMerchantCount: 3,
  blockedReason: "FEATURE_DISABLED",
  access: { state: "free", trialAvailable: true },
};

const activeAccess = { state: "active", trialAvailable: false };

beforeEach(() => {
  clearCsrfToken();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EnhancementPanel", () => {
  it("keeps manual review useful and explains the Plus preview to free users", async () => {
    const fetchSpy = vi.fn(async () => json(freeAvailability));
    vi.stubGlobal("fetch", fetchSpy);

    renderPanel();

    const panel = await screen.findByTestId("enhancement-panel");
    expect(panel).toHaveTextContent("3 merchants need review");
    expect(panel).toHaveTextContent("PocketPulse Plus");
    expect(screen.getByRole("link", { name: "Compare Free and Plus" })).toHaveAttribute(
      "href",
      "/pricing",
    );
    expect(screen.getByRole("link", { name: /review manually/i })).toHaveAttribute(
      "href",
      "#ledger-transactions",
    );
    expect(screen.queryByRole("button", { name: /^enhance/i })).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const heading = screen.getByRole("heading", { name: /3 merchants need review/i });
    expect(panel).toHaveAttribute("aria-labelledby", heading.id);
  });

  it("starts one idempotent job and advances mocked batches monotonically", async () => {
    let batch = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/uploads/42/enhancement") {
        return json({ ...freeAvailability, state: "available", blockedReason: undefined, access: activeAccess });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/enhancement-jobs" && init?.method === "POST") {
        expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^enhancement-42-/);
        return json({
          job: {
            id: 91,
            uploadId: 42,
            status: "queued",
            totalMerchants: 3,
            completedMerchants: 0,
            skippedMerchants: 0,
            failedMerchants: 0,
            progress: 0,
          },
        }, 202);
      }
      if (url === "/api/enhancement-jobs/91/batches" && init?.method === "POST") {
        batch += 1;
        return batch === 1
          ? json({
              state: "processed",
              job: {
                id: 91,
                uploadId: 42,
                status: "processing",
                totalMerchants: 3,
                completedMerchants: 2,
                skippedMerchants: 0,
                failedMerchants: 0,
                progress: 66,
              },
            })
          : json({
              state: "complete",
              job: {
                id: 91,
                uploadId: 42,
                status: "complete",
                totalMerchants: 3,
                completedMerchants: 3,
                skippedMerchants: 0,
                failedMerchants: 0,
                progress: 100,
              },
            });
      }
      return json({ error: `Unhandled ${init?.method ?? "GET"} ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Enhance 3 merchants" }));

    expect(await screen.findByText("Enhancement complete")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(batch).toBe(2);
    expect(
      fetchSpy.mock.calls.filter(([input, init]) =>
        String(input) === "/api/enhancement-jobs" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("resumes an existing queued job without creating another job", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/uploads/42/enhancement") {
        return json({ ...freeAvailability, state: "active", activeJobId: 77, access: activeAccess });
      }
      if (url === "/api/enhancement-jobs/77") {
        return json({ job: { id: 77, uploadId: 42, status: "queued", totalMerchants: 3, completedMerchants: 0, skippedMerchants: 0, failedMerchants: 0, progress: 0 } });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/enhancement-jobs/77/batches" && init?.method === "POST") {
        return json({ state: "complete", job: { id: 77, uploadId: 42, status: "complete", totalMerchants: 3, completedMerchants: 3, skippedMerchants: 0, failedMerchants: 0, progress: 100 } });
      }
      return json({ error: `Unhandled ${init?.method ?? "GET"} ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderPanel();

    expect(await screen.findByText("Enhancement complete")).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([input]) => String(input) === "/api/enhancement-jobs")).toBe(false);
  });

  it("cancels future batches and announces the durable cancelled state", async () => {
    let cancelled = false;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/uploads/42/enhancement") {
        return json({ ...freeAvailability, state: "active", activeJobId: 55, access: activeAccess });
      }
      if (url === "/api/enhancement-jobs/55" && !init?.method) {
        return json({ job: { id: 55, uploadId: 42, status: "processing", totalMerchants: 3, completedMerchants: 1, skippedMerchants: 0, failedMerchants: 0, progress: 33 } });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/enhancement-jobs/55/batches" && init?.method === "POST") {
        return json({ state: "busy", job: { id: 55, uploadId: 42, status: "processing", totalMerchants: 3, completedMerchants: 1, skippedMerchants: 0, failedMerchants: 0, progress: 33 } });
      }
      if (url === "/api/enhancement-jobs/55" && init?.method === "PATCH") {
        cancelled = true;
        return json({ job: { id: 55, uploadId: 42, status: "cancelled", totalMerchants: 3, completedMerchants: 1, skippedMerchants: 0, failedMerchants: 0, progress: 33 } });
      }
      return json({ error: `Unhandled ${init?.method ?? "GET"} ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel enhancement" }));

    await waitFor(() => expect(cancelled).toBe(true));
    expect(await screen.findByText("Enhancement cancelled")).toBeInTheDocument();
    expect(screen.getByText(/imported transactions remain ready to review/i)).toBeInTheDocument();
  });

  it("uses plain language for budget-blocked and payment-recovery states", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/uploads/42/enhancement") {
        return json({ ...freeAvailability, state: "active", activeJobId: 18, access: { state: "past_due", trialAvailable: false } });
      }
      if (url === "/api/enhancement-jobs/18" && !init?.method) {
        return json({ job: { id: 18, uploadId: 42, status: "budget_blocked", totalMerchants: 3, completedMerchants: 1, skippedMerchants: 0, failedMerchants: 0, progress: 33 } });
      }
      return json({ error: `Unhandled GET ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderPanel();

    expect(await screen.findByText("Monthly enhancement allowance reached")).toBeInTheDocument();
    expect(screen.getByText(/plus access needs attention/i)).toBeInTheDocument();
    expect(screen.getByText(/manual review remains available/i)).toBeInTheDocument();
  });

  it("keeps partial results visible and routes the user back to manual review", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/uploads/42/enhancement") {
        return json({ ...freeAvailability, state: "active", activeJobId: 24, access: activeAccess });
      }
      if (url === "/api/enhancement-jobs/24") {
        return json({ job: { id: 24, uploadId: 42, status: "partial", totalMerchants: 3, completedMerchants: 2, skippedMerchants: 0, failedMerchants: 1, progress: 100 } });
      }
      return json({ error: `Unhandled GET ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderPanel();

    expect(await screen.findByText("Enhancement partially complete")).toBeInTheDocument();
    expect(screen.getByText("1 merchant could not be resolved.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /review manually below/i })).toHaveAttribute("href", "#ledger-transactions");
  });

  it("pauses after a recoverable batch failure and resumes only when requested", async () => {
    let batchAttempts = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/uploads/42/enhancement") {
        return json({ ...freeAvailability, state: "active", activeJobId: 31, access: activeAccess });
      }
      if (url === "/api/enhancement-jobs/31" && !init?.method) {
        return json({ job: { id: 31, uploadId: 42, status: "queued", totalMerchants: 3, completedMerchants: 0, skippedMerchants: 0, failedMerchants: 0, progress: 0 } });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/enhancement-jobs/31/batches" && init?.method === "POST") {
        batchAttempts += 1;
        if (batchAttempts === 1) return json({ error: "temporary failure" }, 503);
        return json({ state: "complete", job: { id: 31, uploadId: 42, status: "complete", totalMerchants: 3, completedMerchants: 3, skippedMerchants: 0, failedMerchants: 0, progress: 100 } });
      }
      return json({ error: `Unhandled ${init?.method ?? "GET"} ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("Enhancement paused");
    expect(batchAttempts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Resume enhancement" }));

    expect(await screen.findByText("Enhancement complete")).toBeInTheDocument();
    expect(batchAttempts).toBe(2);
  });

  it("does not refresh transaction data when a batch only skips already-resolved merchants", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/uploads/42/enhancement") {
        return json({ ...freeAvailability, state: "active", activeJobId: 44, access: activeAccess });
      }
      if (url === "/api/enhancement-jobs/44" && !init?.method) {
        return json({ job: { id: 44, uploadId: 42, status: "queued", totalMerchants: 1, completedMerchants: 0, skippedMerchants: 0, failedMerchants: 0, progress: 0 } });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/enhancement-jobs/44/batches" && init?.method === "POST") {
        return json({ state: "complete", job: { id: 44, uploadId: 42, status: "complete", totalMerchants: 1, completedMerchants: 0, skippedMerchants: 1, failedMerchants: 0, progress: 100 } });
      }
      return json({ error: `Unhandled ${init?.method ?? "GET"} ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { client } = renderPanel();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    expect(await screen.findByText("Enhancement complete")).toBeInTheDocument();
    expect(
      invalidateSpy.mock.calls.some(([filters]) =>
        JSON.stringify(filters?.queryKey) === JSON.stringify(["transactions"]),
      ),
    ).toBe(false);
  });
});
