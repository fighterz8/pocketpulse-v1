import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Pricing } from "./Pricing";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPricing() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Pricing />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Pricing", () => {
  it("compares one useful free plan with optional Plus while checkout is closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      plan: {
        key: "plus",
        name: "PocketPulse Plus",
        monthlyPriceCents: 500,
        currency: "USD",
        interval: "month",
        trialDays: 7,
      },
      checkoutAvailable: false,
    })));
    const { container } = renderPricing();

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(await screen.findByRole("heading", { name: "PocketPulse Free" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "PocketPulse Plus" })).toBeInTheDocument();
    expect(screen.getByText("$0")).toBeInTheDocument();
    expect(screen.getByText("$5")).toBeInTheDocument();
    expect(screen.getByText(/checkout is not open yet/i)).toBeInTheDocument();
    expect(screen.getByText(/importing never requires Plus/i)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /free/i })[0]).toHaveAttribute("href", "/auth");
  });

  it("shows honest recurring billing disclosure when checkout is available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      plan: {
        key: "plus",
        name: "PocketPulse Plus",
        monthlyPriceCents: 800,
        currency: "USD",
        interval: "month",
        trialDays: 14,
      },
      checkoutAvailable: true,
    })));
    renderPricing();

    expect(await screen.findByText(/14-day trial/i)).toHaveTextContent(
      "renews automatically at $8 per month until cancelled",
    );
    expect(screen.getByRole("link", { name: "Start in Account" })).toHaveAttribute(
      "href",
      "/account",
    );
  });
});
