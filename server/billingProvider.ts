import type { BillingAccessState } from "../shared/schema.js";

export type HostedCheckoutRequest = {
  userId: number;
  email: string;
  externalCustomerId: string | null;
  priceId: string;
  appBaseUrl: string;
  trialDays: number;
  includeTrial: boolean;
  idempotencyKey: string;
};

export type HostedSession = {
  id: string;
  url: string;
};

export type HostedPortalRequest = {
  externalCustomerId: string;
  appBaseUrl: string;
  idempotencyKey: string;
};

export type NormalizedBillingWebhookEvent = {
  provider: "stripe";
  id: string;
  type: string;
  createdAt: Date;
  objectUpdatedAt: Date | null;
  objectId: string | null;
  userId: number | null;
  externalCustomerId: string | null;
  mutation:
    | { kind: "customer" }
    | {
        kind: "subscription";
        externalSubscriptionId: string;
        providerStatus: string;
        accessState: BillingAccessState;
        trialStartsAt: Date | null;
        trialEndsAt: Date | null;
        currentPeriodEndsAt: Date | null;
        cancelAtPeriodEnd: boolean;
      }
    | { kind: "ignored" };
};

export interface BillingProviderAdapter {
  readonly provider: "stripe";
  createCheckoutSession(request: HostedCheckoutRequest): Promise<HostedSession>;
  createPortalSession(request: HostedPortalRequest): Promise<HostedSession>;
  verifyAndNormalizeWebhook(
    rawBody: Buffer,
    signature: string,
  ): Promise<NormalizedBillingWebhookEvent>;
}

export class BillingWebhookVerificationError extends Error {
  readonly code = "BILLING_WEBHOOK_VERIFICATION_FAILED" as const;
  constructor() {
    super("Billing webhook signature verification failed");
    this.name = "BillingWebhookVerificationError";
  }
}
