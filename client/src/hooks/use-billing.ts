import { useMutation, useQuery } from "@tanstack/react-query";

import { apiFetch, readJsonError } from "../lib/api";

export type PlusPlan = {
  key: "plus";
  name: "PocketPulse Plus";
  monthlyPriceCents: number;
  currency: "USD";
  interval: "month";
  trialDays: number;
};

export type PlusPlanResponse = {
  plan: PlusPlan;
  checkoutAvailable: boolean;
};

export type BillingAccessState =
  | "free"
  | "trialing"
  | "active"
  | "past_due"
  | "expired";

export type BillingAccountResponse = {
  plan: PlusPlan;
  access: {
    state: BillingAccessState;
    trialAvailable: boolean;
    expiresAt?: string;
  };
  subscription: {
    cancelAtPeriodEnd: boolean;
    trialEndsAt?: string;
    currentPeriodEndsAt?: string;
  };
  actions: {
    canStartCheckout: boolean;
    canManageBilling: boolean;
  };
};

async function readJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error(await readJsonError(response));
  return response.json() as Promise<T>;
}

export function usePlusPlan() {
  return useQuery({
    queryKey: ["billing", "plan"],
    queryFn: () => readJson<PlusPlanResponse>("/api/billing/plan"),
    staleTime: 5 * 60_000,
  });
}

export function useBillingAccount() {
  return useQuery({
    queryKey: ["billing", "account"],
    queryFn: () => readJson<BillingAccountResponse>("/api/billing/entitlement"),
  });
}

type HostedBillingKind = "checkout" | "portal";

function actionStorageKey(kind: HostedBillingKind): string {
  return `pp_billing_${kind}_idempotency`;
}

function actionKey(kind: HostedBillingKind): string {
  const storageKey = actionStorageKey(kind);
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, created);
  return created;
}

function requireHostedBillingUrl(
  value: unknown,
  kind: HostedBillingKind,
): string {
  if (typeof value !== "string") throw new Error("Billing page URL is missing");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Billing page URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Billing page URL must use HTTPS");
  }
  const expectedHostname =
    kind === "checkout" ? "checkout.stripe.com" : "billing.stripe.com";
  if (
    parsed.hostname !== expectedHostname ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error("Billing page URL is not a trusted Stripe destination");
  }
  return parsed.toString();
}

async function createHostedBillingPage(kind: HostedBillingKind): Promise<string> {
  const response = await apiFetch(`/api/billing/${kind}`, {
    method: "POST",
    headers: { "Idempotency-Key": actionKey(kind) },
  });
  if (!response.ok) throw new Error(await readJsonError(response));
  const body = (await response.json()) as {
    checkoutUrl?: unknown;
    portalUrl?: unknown;
  };
  const url = requireHostedBillingUrl(
    kind === "checkout" ? body.checkoutUrl : body.portalUrl,
    kind,
  );
  if (kind === "portal") {
    window.sessionStorage.removeItem(actionStorageKey(kind));
  }
  return url;
}

export function useHostedBillingPages() {
  const checkout = useMutation({
    mutationFn: () => createHostedBillingPage("checkout"),
  });
  const portal = useMutation({
    mutationFn: () => createHostedBillingPage("portal"),
  });
  return { checkout, portal };
}
