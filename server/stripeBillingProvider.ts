import Stripe from "stripe";

import type { BillingConfig } from "./billingConfig.js";
import type {
  BillingProviderAdapter,
  HostedCheckoutRequest,
  HostedPortalRequest,
  HostedSession,
  NormalizedBillingWebhookEvent,
} from "./billingProvider.js";
import { BillingWebhookVerificationError } from "./billingProvider.js";

type StripeClient = Pick<
  Stripe,
  "checkout" | "billingPortal" | "webhooks" | "invoices" | "charges"
>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringId(value: unknown): string | null {
  if (typeof value === "string") return value;
  const id = record(value).id;
  return typeof id === "string" ? id : null;
}

function unixDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000)
    : null;
}

function metadataUserId(object: Record<string, unknown>): number | null {
  const metadata = record(object.metadata);
  const value = metadata.pocketpulse_user_id;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function subscriptionFromInvoice(invoice: Record<string, unknown>): string | null {
  const direct = stringId(invoice.subscription);
  if (direct) return direct;
  const parent = record(invoice.parent);
  return stringId(record(parent.subscription_details).subscription);
}

function currentPeriodEnd(subscription: Record<string, unknown>): Date | null {
  const direct = unixDate(subscription.current_period_end);
  if (direct) return direct;
  const items = record(subscription.items).data;
  if (!Array.isArray(items)) return null;
  const timestamps = items
    .map((item) => record(item).current_period_end)
    .filter((value): value is number => typeof value === "number");
  return timestamps.length > 0 ? unixDate(Math.max(...timestamps)) : null;
}

function accessStateForSubscriptionStatus(
  status: string,
): "trialing" | "active" | "past_due" | "expired" {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  return "expired";
}

function requireHostedSession(session: { id: string; url?: string | null }): HostedSession {
  if (!session.url) throw new Error("Stripe did not return a hosted session URL");
  return { id: session.id, url: session.url };
}

export function createStripeBillingProvider(
  config: Extract<BillingConfig, { enabled: true }>,
  client: StripeClient = new Stripe(config.stripeSecretKey, {
    maxNetworkRetries: 2,
    timeout: 10_000,
  }),
): BillingProviderAdapter {
  async function invoiceForRefundObject(object: Record<string, unknown>) {
    let charge = object;
    if (!stringId(charge.invoice)) {
      const chargeId = stringId(object.charge);
      if (!chargeId) return null;
      charge = record(await client.charges.retrieve(chargeId));
    }
    const invoiceId = stringId(charge.invoice);
    return invoiceId ? record(await client.invoices.retrieve(invoiceId)) : null;
  }

  return {
    provider: "stripe",

    async createCheckoutSession(
      request: HostedCheckoutRequest,
    ): Promise<HostedSession> {
      const session = await client.checkout.sessions.create(
        {
          mode: "subscription",
          ...(request.externalCustomerId
            ? { customer: request.externalCustomerId }
            : { customer_email: request.email }),
          client_reference_id: String(request.userId),
          line_items: [{ price: request.priceId, quantity: 1 }],
          payment_method_collection: "if_required",
          metadata: { pocketpulse_user_id: String(request.userId) },
          subscription_data: {
            metadata: { pocketpulse_user_id: String(request.userId) },
            ...(request.includeTrial
              ? { trial_period_days: request.trialDays }
              : {}),
          },
          success_url: `${request.appBaseUrl}/upload?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${request.appBaseUrl}/upload?billing=cancelled`,
        },
        { idempotencyKey: request.idempotencyKey },
      );
      return requireHostedSession(session);
    },

    async createPortalSession(request: HostedPortalRequest): Promise<HostedSession> {
      const session = await client.billingPortal.sessions.create(
        {
          customer: request.externalCustomerId,
          return_url: `${request.appBaseUrl}/upload`,
        },
        { idempotencyKey: request.idempotencyKey },
      );
      return requireHostedSession(session);
    },

    async verifyAndNormalizeWebhook(
      rawBody: Buffer,
      signature: string,
    ): Promise<NormalizedBillingWebhookEvent> {
      let event: Stripe.Event;
      try {
        event = await client.webhooks.constructEventAsync(
          rawBody,
          signature,
          config.stripeWebhookSecret,
        );
      } catch (error) {
        if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
          throw new BillingWebhookVerificationError();
        }
        throw error;
      }
      const object = record(event.data.object);
      const base = {
        provider: "stripe" as const,
        id: event.id,
        type: event.type,
        createdAt: new Date(event.created * 1000),
        objectUpdatedAt: unixDate(object.updated),
        objectId: stringId(object),
        userId: metadataUserId(object),
        externalCustomerId: stringId(object.customer),
      };

      if (event.type === "checkout.session.completed") {
        return {
          ...base,
          userId:
            metadataUserId(object) ??
            (typeof object.client_reference_id === "string" &&
            /^\d+$/.test(object.client_reference_id)
              ? Number(object.client_reference_id)
              : null),
          mutation: { kind: "customer" },
        };
      }

      if (event.type.startsWith("customer.subscription.")) {
        const subscriptionId = stringId(object);
        if (!subscriptionId) return { ...base, mutation: { kind: "ignored" } };
        const providerStatus =
          typeof object.status === "string" ? object.status : "unknown";
        return {
          ...base,
          mutation: {
            kind: "subscription",
            externalSubscriptionId: subscriptionId,
            providerStatus,
            accessState:
              event.type === "customer.subscription.deleted"
                ? "expired"
                : accessStateForSubscriptionStatus(providerStatus),
            trialStartsAt: unixDate(object.trial_start),
            trialEndsAt: unixDate(object.trial_end),
            currentPeriodEndsAt: currentPeriodEnd(object),
            cancelAtPeriodEnd: object.cancel_at_period_end === true,
          },
        };
      }

      if (
        event.type === "invoice.paid" ||
        event.type === "invoice.payment_failed" ||
        event.type === "invoice.payment_action_required"
      ) {
        const subscriptionId = subscriptionFromInvoice(object);
        if (!subscriptionId) return { ...base, mutation: { kind: "ignored" } };
        const active = event.type === "invoice.paid";
        return {
          ...base,
          mutation: {
            kind: "subscription",
            externalSubscriptionId: subscriptionId,
            providerStatus: active ? "active" : "past_due",
            accessState: active ? "active" : "past_due",
            trialStartsAt: null,
            trialEndsAt: null,
            currentPeriodEndsAt: unixDate(object.period_end),
            cancelAtPeriodEnd: false,
          },
        };
      }

      if (event.type === "charge.refunded" || event.type === "refund.created") {
        const invoice = await invoiceForRefundObject(object);
        const subscriptionId = invoice ? subscriptionFromInvoice(invoice) : null;
        if (!subscriptionId) return { ...base, mutation: { kind: "ignored" } };
        return {
          ...base,
          externalCustomerId: base.externalCustomerId ?? stringId(invoice?.customer),
          mutation: {
            kind: "subscription",
            externalSubscriptionId: subscriptionId,
            providerStatus: "refunded",
            accessState: "expired",
            trialStartsAt: null,
            trialEndsAt: null,
            currentPeriodEndsAt: null,
            cancelAtPeriodEnd: false,
          },
        };
      }

      return { ...base, mutation: { kind: "ignored" } };
    },
  };
}
