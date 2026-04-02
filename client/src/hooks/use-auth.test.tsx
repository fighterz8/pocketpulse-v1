import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./use-auth";

const user = {
  id: 1,
  email: "u@example.com",
  displayName: "U",
  companyName: null as string | null,
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useAuth", () => {
  const fetchMock = vi.fn();
  let queryClient: QueryClient;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    fetchMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  it("logout posts to the server and refetches auth/me so the client becomes signed out", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user }))
      .mockResolvedValueOnce(
        jsonResponse({
          accounts: [
            {
              id: 10,
              userId: 1,
              label: "Cash",
              lastFour: null,
              accountType: null,
              createdAt: "2020-01-01T00:00:00.000Z",
              updatedAt: "2020-01-01T00:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await result.current.logout.mutateAsync();

    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(result.current.user).toBeNull();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
