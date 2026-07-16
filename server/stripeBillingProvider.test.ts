import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import type { BillingConfig } from "./billingConfig.js";
import { BillingWebhookVerificationError } from "./billingProvider.js";
import { createStripeBillingProvider } from "./stripeBillingProvider.js";

const config: Extract<BillingConfig, { enabled: true }> = {
  enabled: true,
  provider: "stripe",
  stripeSecretKey: "sk_test_adapter",
  stripeWebhookSecret: "whsec_adapter",
  stripePlusPriceId: "price_plus",
  appBaseUrl: "https://sandbox.pocketpulse.test",
  trialDays: 7,
};

function eventPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_subscription",
    object: "event",
    api_version: "2025-06-30.basil",
    created: 1_784_227_200,
    data: {
      object: {
        id: "sub_plus",
        object: "subscription",
        customer: "cus_owner",
        status: "trialing",
        trial_start: 1_784_227_200,
        trial_end: 1_784_832_000,
        cancel_at_period_end: false,
        metadata: { pocketpulse_user_id: "42" },
        items: { data: [{ current_period_end: 1_784_832_000 }] },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "customer.subscription.updated",
    ...overrides,
  };
}

describe("Stripe billing adapter", () => {
  it("creates a no-card-capable hosted trial checkout", async () => {
    const createCheckout = vi.fn(async () => ({
      id: "cs_test_trial",
      url: "https://checkout.stripe.test/cs_test_trial",
    }));
    const adapter = createStripeBillingProvider(config, {
      checkout: { sessions: { create: createCheckout } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: {},
      invoices: {},
      charges: {},
    } as never);

    const session = await adapter.createCheckoutSession({
      userId: 42,
      email: "owner@example.test",
      externalCustomerId: null,
      priceId: "price_plus",
      appBaseUrl: config.appBaseUrl,
      trialDays: 7,
      includeTrial: true,
      idempotencyKey: "checkout:42:attempt",
    });

    expect(session.url).toContain("checkout.stripe.test");
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer_email: "owner@example.test",
        payment_method_collection: "if_required",
        subscription_data: expect.objectContaining({ trial_period_days: 7 }),
      }),
      { idempotencyKey: "checkout:42:attempt" },
    );
  });

  it("creates a provider-hosted customer portal", async () => {
    const createPortal = vi.fn(async () => ({
      id: "bps_test",
      url: "https://billing.stripe.test/bps_test",
    }));
    const adapter = createStripeBillingProvider(config, {
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: createPortal } },
      webhooks: {},
      invoices: {},
      charges: {},
    } as never);

    await expect(
      adapter.createPortalSession({
        externalCustomerId: "cus_owner",
        appBaseUrl: config.appBaseUrl,
        idempotencyKey: "portal:42:attempt",
      }),
    ).resolves.toEqual({
      id: "bps_test",
      url: "https://billing.stripe.test/bps_test",
    });
    expect(createPortal).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_owner" }),
      { idempotencyKey: "portal:42:attempt" },
    );
  });

  it("verifies a real Stripe test signature and normalizes a trial", async () => {
    const stripe = new Stripe(config.stripeSecretKey);
    const payload = JSON.stringify(eventPayload());
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: config.stripeWebhookSecret,
    });
    const event = await createStripeBillingProvider(config).verifyAndNormalizeWebhook(
      Buffer.from(payload),
      signature,
    );

    expect(event).toMatchObject({
      provider: "stripe",
      id: "evt_subscription",
      userId: 42,
      externalCustomerId: "cus_owner",
      mutation: {
        kind: "subscription",
        externalSubscriptionId: "sub_plus",
        providerStatus: "trialing",
        accessState: "trialing",
        cancelAtPeriodEnd: false,
      },
    });
  });

  it("rejects an invalid signature before normalization", async () => {
    await expect(
      createStripeBillingProvider(config).verifyAndNormalizeWebhook(
        Buffer.from(JSON.stringify(eventPayload())),
        "t=1,v1=invalid",
      ),
    ).rejects.toBeInstanceOf(BillingWebhookVerificationError);
  });

  it("resolves a refunded subscription through its invoice", async () => {
    const adapter = createStripeBillingProvider(config, {
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: {
        constructEventAsync: vi.fn(async () => ({
          ...eventPayload(),
          id: "evt_refund",
          type: "charge.refunded",
          data: { object: { id: "ch_refund", invoice: "in_refund" } },
        })),
      },
      invoices: {
        retrieve: vi.fn(async () => ({
          id: "in_refund",
          customer: "cus_owner",
          parent: { subscription_details: { subscription: "sub_plus" } },
        })),
      },
      charges: { retrieve: vi.fn() },
    } as never);

    const event = await adapter.verifyAndNormalizeWebhook(
      Buffer.from("{}"),
      "test-signature",
    );
    expect(event.mutation).toEqual({
      kind: "subscription",
      externalSubscriptionId: "sub_plus",
      providerStatus: "refunded",
      accessState: "expired",
      trialStartsAt: null,
      trialEndsAt: null,
      currentPeriodEndsAt: null,
      cancelAtPeriodEnd: false,
    });
  });
});
