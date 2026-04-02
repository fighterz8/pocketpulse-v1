import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock fetch for auth/accounts
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
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(mockFetch));
});

import { Upload } from "./Upload";

function renderUpload() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Upload />
    </QueryClientProvider>,
  );
}

describe("Upload page", () => {
  it("renders the page title", () => {
    renderUpload();
    expect(screen.getByText("Upload Statements")).toBeInTheDocument();
  });

  it("renders the drop zone", () => {
    renderUpload();
    expect(screen.getByTestId("upload-dropzone")).toBeInTheDocument();
  });

  it("shows drop zone text", () => {
    renderUpload();
    expect(
      screen.getByText(/drop csv files here/i),
    ).toBeInTheDocument();
  });

  it("has a hidden file input", () => {
    renderUpload();
    const input = document.querySelector('input[type="file"]');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("accept", ".csv");
  });
});
