import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCsrfToken } from "../../lib/api";
import { useUploads } from "../../hooks/use-uploads";
import { BrandPulse } from "./BrandPulse";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function UploadProbe() {
  const { upload } = useUploads();
  const result = upload.data?.results[0];

  return (
    <>
      <button
        type="button"
        onClick={() => {
          const file = new File(
            ["date,description,amount\n2026-06-01,Mystery,-12"],
            "mystery.csv",
            { type: "text/csv" },
          );
          upload.mutate({
            files: [file],
            metadata: { "mystery.csv": { accountId: 7 } },
          });
        }}
      >
        Import locally
      </button>
      {result && (
        <p data-testid="unresolved-counts">
          {result.unresolvedTransactionCount} transactions ·{" "}
          {result.unresolvedMerchantCount} merchants
        </p>
      )}
    </>
  );
}

describe("zero-call upload UI flow", () => {
  beforeEach(() => {
    clearCsrfToken();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/csrf-token") return json({ token: "test-token" });
        if (url === "/api/uploads/ai-status") return json({ uploads: [] });
        if (url === "/api/uploads") return json({ uploads: [] });
        if (url === "/api/upload" && init?.method === "POST") {
          return json(
            {
              results: [
                {
                  filename: "mystery.csv",
                  uploadId: 555,
                  status: "complete",
                  rowCount: 3,
                  unresolvedTransactionCount: 3,
                  unresolvedMerchantCount: 2,
                },
              ],
            },
            201,
          );
        }
        return json({ error: `Unhandled request: ${url}` }, 500);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imports successfully without entering automatic enhancement state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <BrandPulse gradId="slice-zero-gradient" />
        <UploadProbe />
      </QueryClientProvider>,
    );

    screen.getByRole("button", { name: "Import locally" }).click();

    expect(await screen.findByTestId("unresolved-counts")).toHaveTextContent(
      "3 transactions · 2 merchants",
    );
    await waitFor(() => {
      expect(screen.queryByTestId("ai-pulse-badge")).not.toBeInTheDocument();
    });

    const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(calls).toContain("/api/upload");
    expect(calls).not.toContain("/api/transactions/reclassify");

    queryClient.clear();
  });
});
