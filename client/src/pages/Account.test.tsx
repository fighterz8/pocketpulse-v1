import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearCsrfToken } from "../lib/api";
import { Account } from "./Account";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const base = {
  plan: {
    key: "plus",
    name: "PocketPulse Plus",
    monthlyPriceCents: 500,
    currency: "USD",
    interval: "month",
    trialDays: 7,
  },
  access: { state: "free", trialAvailable: true },
  subscription: { cancelAtPeriodEnd: false },
  actions: { canStartCheckout: false, canManageBilling: false },
};

function renderAccount(redirectToHostedPage = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return {
    redirectToHostedPage,
    ...render(
      <QueryClientProvider client={client}>
        <Account redirectToHostedPage={redirectToHostedPage} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  clearCsrfToken();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Account billing UX", () => {
  it("keeps the free plan useful when checkout is disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(base)));
    renderAccount();

    expect(await screen.findByText("You are using PocketPulse Free")).toBeInTheDocument();
    expect(screen.getByText("$0")).toBeInTheDocument();
    expect(screen.getByText("current plan")).toBeInTheDocument();
    expect(screen.getByText(/checkout is not open yet/i)).toBeInTheDocument();
    expect(screen.getByText(/dashboard, ledger, and manual corrections/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
  });

  it("discloses trial conversion before opening hosted checkout", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/billing/entitlement") {
        return json({ ...base, actions: { canStartCheckout: true, canManageBilling: false } });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/billing/checkout" && init?.method === "POST") {
        expect(new Headers(init.headers).get("Idempotency-Key")).toBeTruthy();
        return json({ checkoutUrl: "https://checkout.stripe.com/session" }, 201);
      }
      return json({ error: `Unhandled ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const view = renderAccount();

    expect(await screen.findByText(/renews automatically at \$5 per month/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start 7-day trial" }));

    await waitFor(() =>
      expect(view.redirectToHostedPage).toHaveBeenCalledWith(
        "https://checkout.stripe.com/session",
      ),
    );
    expect(window.sessionStorage.getItem("pp_billing_checkout_idempotency")).toBeTruthy();
  });

  it("does not promise renewal after a trial was already cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ...base,
      access: { state: "trialing", trialAvailable: false },
      subscription: {
        cancelAtPeriodEnd: true,
        trialEndsAt: "2026-07-23T00:00:00.000Z",
      },
      actions: { canStartCheckout: false, canManageBilling: true },
    })));
    renderAccount();

    expect(await screen.findByText("Your Plus trial will not renew")).toBeInTheDocument();
    expect(screen.getByText(/trial access remains through July 23, 2026/i)).toBeInTheDocument();
    expect(screen.queryByText(/renews at/i)).not.toBeInTheDocument();
  });

  it("distinguishes renewal from cancellation at period end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ...base,
      access: {
        state: "active",
        trialAvailable: false,
        expiresAt: "2026-08-16T00:00:00.000Z",
      },
      subscription: {
        cancelAtPeriodEnd: true,
        currentPeriodEndsAt: "2026-08-16T00:00:00.000Z",
      },
      actions: { canStartCheckout: false, canManageBilling: true },
    })));
    renderAccount();

    expect(await screen.findByText("Plus will not renew")).toBeInTheDocument();
    expect(screen.getByText(/available through August 16, 2026/i)).toBeInTheDocument();
    expect(screen.queryByText(/subscription renews/i)).not.toBeInTheDocument();
  });

  it("routes payment recovery through the hosted billing portal", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/billing/entitlement") return json({
        ...base,
        access: { state: "past_due", trialAvailable: false },
        actions: { canStartCheckout: false, canManageBilling: true },
      });
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/billing/portal" && init?.method === "POST") {
        return json({ portalUrl: "https://billing.stripe.com/session" }, 201);
      }
      return json({ error: `Unhandled ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const view = renderAccount();

    expect(await screen.findByText("Your Plus payment needs attention")).toBeInTheDocument();
    expect(screen.getByText(/imports, dashboards, ledger/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
    await waitFor(() =>
      expect(view.redirectToHostedPage).toHaveBeenCalledWith(
        "https://billing.stripe.com/session",
      ),
    );
    expect(window.sessionStorage.getItem("pp_billing_portal_idempotency")).toBeNull();
  });

  it("rejects a non-HTTPS hosted billing URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/billing/entitlement") {
        return json({ ...base, actions: { canStartCheckout: true, canManageBilling: false } });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/billing/checkout" && init?.method === "POST") {
        return json({ checkoutUrl: "http://unsafe.example/session" }, 201);
      }
      return json({ error: `Unhandled ${url}` }, 500);
    }));
    const view = renderAccount();

    fireEvent.click(await screen.findByRole("button", { name: "Start 7-day trial" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("must use HTTPS");
    expect(view.redirectToHostedPage).not.toHaveBeenCalled();
  });

  it("rejects an HTTPS redirect outside Stripe's hosted billing domains", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/billing/entitlement") {
        return json({ ...base, actions: { canStartCheckout: true, canManageBilling: false } });
      }
      if (url === "/api/csrf-token") return json({ token: "csrf" });
      if (url === "/api/billing/checkout" && init?.method === "POST") {
        return json({ checkoutUrl: "https://checkout.stripe.com.attacker.test/session" }, 201);
      }
      return json({ error: `Unhandled ${url}` }, 500);
    }));
    const view = renderAccount();

    fireEvent.click(await screen.findByRole("button", { name: "Start 7-day trial" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a trusted Stripe destination");
    expect(view.redirectToHostedPage).not.toHaveBeenCalled();
  });
});
