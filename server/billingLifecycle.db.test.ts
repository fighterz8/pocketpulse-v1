import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { BillingConfig } from "./billingConfig.js";
import type {
  BillingProviderAdapter,
  NormalizedBillingWebhookEvent,
} from "./billingProvider.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

const config: Extract<BillingConfig, { enabled: true }> = {
  enabled: true,
  checkoutEnabled: true,
  provider: "stripe",
  stripeSecretKey: "sk_test_lifecycle",
  stripeWebhookSecret: "whsec_lifecycle",
  stripePlusPriceId: "price_plus",
  appBaseUrl: "https://sandbox.pocketpulse.test",
  trialDays: 7,
};

describeDatabase("billing lifecycle", () => {
  let pool: pg.Pool;
  let service: typeof import("./billingService.js");
  let entitlements: typeof import("./billingEntitlements.js");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    service = await import("./billingService.js");
    entitlements = await import("./billingEntitlements.js");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createUser(label: string) {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'Billing Lifecycle') RETURNING id`,
      [`${label}-${Date.now()}-${Math.random()}@example.test`],
    );
    return user.rows[0]!.id;
  }

  function subscriptionEvent(input: {
    id: string;
    userId: number;
    created: string;
    state: "trialing" | "active" | "past_due" | "expired";
    providerStatus?: string;
  }): NormalizedBillingWebhookEvent {
    const trialing = input.state === "trialing";
    return {
      provider: "stripe",
      id: input.id,
      type: "customer.subscription.updated",
      createdAt: new Date(input.created),
      objectUpdatedAt: new Date(input.created),
      objectId: `sub_lifecycle_${input.userId}`,
      userId: input.userId,
      externalCustomerId: `cus_lifecycle_${input.userId}`,
      mutation: {
        kind: "subscription",
        externalSubscriptionId: `sub_lifecycle_${input.userId}`,
        providerStatus: input.providerStatus ?? input.state,
        accessState: input.state,
        trialStartsAt: trialing ? new Date("2099-01-01T00:00:00Z") : null,
        trialEndsAt: trialing ? new Date("2099-01-08T00:00:00Z") : null,
        currentPeriodEndsAt:
          input.state === "active" ? new Date("2099-02-01T00:00:00Z") : null,
        cancelAtPeriodEnd: false,
      },
    };
  }

  it("applies trials and active payment, rejects stale/duplicate events, and revokes failures/refunds", async () => {
    const userId = await createUser("webhooks");
    const trial = subscriptionEvent({
      id: `evt-trial-${userId}`,
      userId,
      created: "2026-07-16T18:00:00Z",
      state: "trialing",
    });
    expect(
      await service.processBillingWebhook({ event: trial, rawBody: Buffer.from("trial") }),
    ).toEqual({ duplicate: false, outcome: "applied" });
    expect(await entitlements.getBillingEntitlement(userId)).toMatchObject({
      state: "trialing",
      trialAvailable: false,
      entitled: true,
    });
    expect(
      await service.processBillingWebhook({ event: trial, rawBody: Buffer.from("trial") }),
    ).toEqual({ duplicate: true, outcome: "duplicate" });

    const active = subscriptionEvent({
      id: `evt-active-${userId}`,
      userId,
      created: "2026-07-16T18:10:00Z",
      state: "active",
    });
    await service.processBillingWebhook({ event: active, rawBody: Buffer.from("active") });
    expect(await entitlements.getBillingEntitlement(userId)).toMatchObject({
      state: "active",
      entitled: true,
    });

    const staleFailure = subscriptionEvent({
      id: `evt-stale-${userId}`,
      userId,
      created: "2026-07-16T18:05:00Z",
      state: "past_due",
    });
    expect(
      await service.processBillingWebhook({
        event: staleFailure,
        rawBody: Buffer.from("stale"),
      }),
    ).toEqual({ duplicate: false, outcome: "ignored_stale" });
    expect((await entitlements.getBillingEntitlement(userId)).state).toBe("active");

    const newerObjectVersion = subscriptionEvent({
      id: `evt-newer-object-${userId}`,
      userId,
      created: "2026-07-16T18:05:00Z",
      state: "past_due",
    });
    newerObjectVersion.objectUpdatedAt = new Date("2026-07-16T18:15:00Z");
    expect(
      await service.processBillingWebhook({
        event: newerObjectVersion,
        rawBody: Buffer.from("newer-object"),
      }),
    ).toEqual({ duplicate: false, outcome: "applied" });
    expect((await entitlements.getBillingEntitlement(userId)).state).toBe("past_due");

    const failed = subscriptionEvent({
      id: `evt-failed-${userId}`,
      userId,
      created: "2026-07-16T18:20:00Z",
      state: "past_due",
    });
    await service.processBillingWebhook({ event: failed, rawBody: Buffer.from("failed") });
    expect(await entitlements.getBillingEntitlement(userId)).toMatchObject({
      state: "past_due",
      entitled: false,
    });

    const refunded = subscriptionEvent({
      id: `evt-refunded-${userId}`,
      userId,
      created: "2026-07-16T18:30:00Z",
      state: "expired",
      providerStatus: "refunded",
    });
    await service.processBillingWebhook({
      event: refunded,
      rawBody: Buffer.from("refunded"),
    });
    expect(await entitlements.getBillingEntitlement(userId)).toMatchObject({
      state: "expired",
      entitled: false,
    });

    const cancelled = subscriptionEvent({
      id: `evt-cancelled-${userId}`,
      userId,
      created: "2026-07-16T18:40:00Z",
      state: "expired",
      providerStatus: "canceled",
    });
    await service.processBillingWebhook({
      event: cancelled,
      rawBody: Buffer.from("cancelled"),
    });
    expect((await entitlements.getBillingEntitlement(userId)).state).toBe("expired");
  }, 30_000);

  it("never reassigns an existing provider customer or subscription", async () => {
    const ownerId = await createUser("mapping-owner");
    const attackerId = await createUser("mapping-attacker");
    const original = subscriptionEvent({
      id: `evt-owner-${ownerId}`,
      userId: ownerId,
      created: "2026-07-16T20:00:00Z",
      state: "active",
    });
    await service.processBillingWebhook({
      event: original,
      rawBody: Buffer.from("owner"),
    });

    const attemptedTransfer = subscriptionEvent({
      id: `evt-transfer-${ownerId}`,
      userId: attackerId,
      created: "2026-07-16T20:10:00Z",
      state: "active",
    });
    attemptedTransfer.objectId = original.objectId;
    attemptedTransfer.externalCustomerId = `cus_lifecycle_${attackerId}`;
    if (attemptedTransfer.mutation.kind === "subscription") {
      attemptedTransfer.mutation.externalSubscriptionId =
        `sub_lifecycle_${ownerId}`;
    }
    expect(
      await service.processBillingWebhook({
        event: attemptedTransfer,
        rawBody: Buffer.from("attempted-transfer"),
      }),
    ).toEqual({ duplicate: false, outcome: "ignored_unmapped" });
    expect(await entitlements.getBillingEntitlement(ownerId)).toMatchObject({
      state: "active",
      entitled: true,
    });
    expect(await entitlements.getBillingEntitlement(attackerId)).toMatchObject({
      state: "free",
      entitled: false,
    });
  }, 30_000);

  it("atomically reuses one unconsumed trial checkout across concurrent and replacement keys", async () => {
    const userId = await createUser("trial-race");
    const createCheckoutSession = vi.fn(async (request) => ({
      id: `cs_${request.idempotencyKey}`,
      url: `https://checkout.example/${request.idempotencyKey}`,
    }));
    const adapter = {
      provider: "stripe",
      createCheckoutSession,
      createPortalSession: vi.fn(),
      verifyAndNormalizeWebhook: vi.fn(),
    } satisfies BillingProviderAdapter;

    const attempts = await Promise.all([
      service.createHostedCheckout({
        userId,
        email: "race@example.test",
        idempotencyKey: "race-a",
        config,
        adapter,
      }),
      service.createHostedCheckout({
        userId,
        email: "race@example.test",
        idempotencyKey: "race-b",
        config,
        adapter,
      }),
    ]);
    expect(attempts.every((attempt) => attempt.trialIncluded)).toBe(true);
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(1);
    expect(createCheckoutSession).toHaveBeenCalledTimes(2);
    const trials = await pool.query(
      `SELECT user_id FROM billing_trials WHERE user_id = $1`,
      [userId],
    );
    expect(trials.rowCount).toBe(1);

    const replay = await service.createHostedCheckout({
      userId,
      email: "race@example.test",
      idempotencyKey: "replacement-tab-key",
      config,
      adapter,
    });
    expect(replay.trialIncluded).toBe(true);
    expect(replay.id).toBe(attempts[0]!.id);
  }, 30_000);

  it("removes private billing projections on account deletion but keeps minimized event receipts", async () => {
    const userId = await createUser("deletion");
    const event = subscriptionEvent({
      id: `evt-delete-${userId}`,
      userId,
      created: "2026-07-16T19:00:00Z",
      state: "active",
    });
    await service.processBillingWebhook({ event, rawBody: Buffer.from("delete") });
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const privateRows = await pool.query<{ total: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM billing_customers WHERE user_id = $1) +
         (SELECT COUNT(*) FROM billing_trials WHERE user_id = $1) +
         (SELECT COUNT(*) FROM billing_subscriptions WHERE user_id = $1)
       )::text AS total`,
      [userId],
    );
    expect(privateRows.rows[0]!.total).toBe("0");
    const receipt = await pool.query<{ user_id: number | null; payload_sha256: string }>(
      `SELECT user_id, payload_sha256 FROM billing_webhook_events
       WHERE external_event_id = $1`,
      [event.id],
    );
    expect(receipt.rows[0]?.user_id).toBeNull();
    expect(receipt.rows[0]?.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});
