import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import session from "express-session";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { BillingConfig } from "./billingConfig.js";
import {
  BillingWebhookVerificationError,
  type BillingProviderAdapter,
  type NormalizedBillingWebhookEvent,
} from "./billingProvider.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const config: Extract<BillingConfig, { enabled: true }> = {
  enabled: true,
  checkoutEnabled: true,
  provider: "stripe",
  stripeSecretKey: "sk_test_routes",
  stripeWebhookSecret: "whsec_routes",
  stripePlusPriceId: "price_plus",
  appBaseUrl: "https://sandbox.pocketpulse.test",
  trialDays: 7,
};

describeDatabase("billing routes", () => {
  let pool: pg.Pool;
  let createApp: typeof import("./routes.js").createApp;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    createApp = (await import("./routes.js")).createApp;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("uses hosted surfaces and applies only signed raw webhook projections", async () => {
    let currentEvent: NormalizedBillingWebhookEvent | null = null;
    const capturedRawBodies: Buffer[] = [];
    const createCheckoutSession = vi.fn(async (input) => ({
      id: `cs_${input.userId}`,
      url: `https://checkout.stripe.test/cs_${input.userId}`,
    }));
    const createPortalSession = vi.fn(async (input) => ({
      id: `bps_${input.externalCustomerId}`,
      url: `https://billing.stripe.test/${input.externalCustomerId}`,
    }));
    const verifyAndNormalizeWebhook = vi.fn(async (raw: Buffer, signature: string) => {
      capturedRawBodies.push(raw);
      if (signature === "invalid") throw new BillingWebhookVerificationError();
      if (!currentEvent) throw new Error("test event is not configured");
      return currentEvent;
    });
    const adapter = {
      provider: "stripe",
      createCheckoutSession,
      createPortalSession,
      verifyAndNormalizeWebhook,
    } satisfies BillingProviderAdapter;
    const closedCheckoutApp = createApp({
      sessionStore: new session.MemoryStore(),
      runStartupJobs: false,
      billingConfig: { ...config, checkoutEnabled: false },
      billingProvider: adapter,
    });
    const closedPublicPlan = await request(closedCheckoutApp).get("/api/billing/plan");
    expect(closedPublicPlan.status).toBe(200);
    expect(closedPublicPlan.body.checkoutAvailable).toBe(false);

    const app = createApp({
      sessionStore: new session.MemoryStore(),
      runStartupJobs: false,
      billingConfig: config,
      billingProvider: adapter,
    });
    const publicPlan = await request(app).get("/api/billing/plan");
    expect(publicPlan.status).toBe(200);
    expect(publicPlan.body).toEqual({
      plan: {
        key: "plus",
        name: "PocketPulse Plus",
        monthlyPriceCents: 500,
        currency: "USD",
        interval: "month",
        trialDays: 7,
      },
      checkoutAvailable: true,
    });
    const agent = request.agent(app);
    const csrf = (await agent.get("/api/csrf-token")).body.token as string;
    const email = `billing-route-${Date.now()}-${Math.random()}@example.test`;
    const registered = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        email,
        password: "secure-password-99",
        displayName: "Billing Route",
      });
    expect(registered.status).toBe(201);
    const user = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    const userId = user.rows[0]!.id;

    const checkout = await agent
      .post("/api/billing/checkout")
      .set("X-CSRF-Token", csrf)
      .set("Idempotency-Key", "route-checkout")
      .send({});
    expect(checkout.status).toBe(201);
    expect(checkout.body).toEqual({
      checkoutUrl: `https://checkout.stripe.test/cs_${userId}`,
      trialIncluded: true,
    });
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId, includeTrial: true }),
    );

    config.checkoutEnabled = false;
    const gatedEntitlement = await agent.get("/api/billing/entitlement");
    expect(gatedEntitlement.body.actions.canStartCheckout).toBe(false);
    const gatedCheckout = await agent
      .post("/api/billing/checkout")
      .set("X-CSRF-Token", csrf)
      .set("Idempotency-Key", "route-checkout-gated")
      .send({});
    expect(gatedCheckout.status).toBe(503);
    expect(gatedCheckout.body.code).toBe("BILLING_DISABLED");
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    config.checkoutEnabled = true;

    const portalBeforeCustomer = await agent
      .post("/api/billing/portal")
      .set("X-CSRF-Token", csrf)
      .set("Idempotency-Key", "route-portal-before")
      .send({});
    expect(portalBeforeCustomer.status).toBe(409);
    expect(portalBeforeCustomer.body.code).toBe("BILLING_CUSTOMER_NOT_FOUND");

    currentEvent = {
      provider: "stripe",
      id: `evt-checkout-${userId}`,
      type: "checkout.session.completed",
      createdAt: new Date("2026-07-16T20:00:00Z"),
      objectUpdatedAt: null,
      objectId: `cs_${userId}`,
      userId,
      externalCustomerId: `cus_${userId}`,
      mutation: { kind: "customer" },
    };
    const customerPayload = JSON.stringify({ exact: "raw-customer-payload" });
    const customerWebhook = await request(app)
      .post("/api/billing/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid")
      .send(customerPayload);
    expect(customerWebhook.status).toBe(200);
    expect(customerWebhook.body).toEqual({ received: true, duplicate: false });
    expect(capturedRawBodies.at(-1)?.toString("utf8")).toBe(customerPayload);

    const portal = await agent
      .post("/api/billing/portal")
      .set("X-CSRF-Token", csrf)
      .set("Idempotency-Key", "route-portal")
      .send({});
    expect(portal.status).toBe(201);
    expect(portal.body.portalUrl).toContain("billing.stripe.test");
    expect(createPortalSession).toHaveBeenCalledWith(
      expect.objectContaining({ externalCustomerId: `cus_${userId}` }),
    );

    currentEvent = {
      provider: "stripe",
      id: `evt-active-${userId}`,
      type: "customer.subscription.updated",
      createdAt: new Date("2026-07-16T20:01:00Z"),
      objectUpdatedAt: new Date("2026-07-16T20:01:00Z"),
      objectId: `sub_${userId}`,
      userId,
      externalCustomerId: `cus_${userId}`,
      mutation: {
        kind: "subscription",
        externalSubscriptionId: `sub_${userId}`,
        providerStatus: "active",
        accessState: "active",
        trialStartsAt: null,
        trialEndsAt: null,
        currentPeriodEndsAt: new Date("2099-01-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
      },
    };
    const activePayload = JSON.stringify({ event: "active" });
    const activeWebhook = await request(app)
      .post("/api/billing/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid")
      .send(activePayload);
    expect(activeWebhook.status).toBe(200);
    const duplicate = await request(app)
      .post("/api/billing/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid")
      .send(activePayload);
    expect(duplicate.body).toEqual({ received: true, duplicate: true });
    const entitlement = await agent.get("/api/billing/entitlement");
    expect(entitlement.status).toBe(200);
    expect(entitlement.body.plan).toMatchObject({
      key: "plus",
      monthlyPriceCents: 500,
      trialDays: 7,
    });
    expect(entitlement.body.access).toMatchObject({
      state: "active",
      trialAvailable: false,
    });
    expect(entitlement.body.subscription).toMatchObject({
      cancelAtPeriodEnd: false,
      currentPeriodEndsAt: "2099-01-01T00:00:00.000Z",
    });
    expect(entitlement.body.actions).toEqual({
      canStartCheckout: false,
      canManageBilling: true,
    });

    const invalid = await request(app)
      .post("/api/billing/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "invalid")
      .send("{}");
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("BILLING_WEBHOOK_VERIFICATION_FAILED");
  }, 30_000);
});
