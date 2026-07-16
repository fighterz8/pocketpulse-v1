import { createHash } from "node:crypto";
import type pg from "pg";

import type { BillingConfig } from "./billingConfig.js";
import type {
  BillingProviderAdapter,
  NormalizedBillingWebhookEvent,
} from "./billingProvider.js";
import { pool } from "./db.js";

export class BillingTrialAlreadyReservedError extends Error {
  readonly code = "BILLING_TRIAL_ALREADY_RESERVED" as const;
  constructor() {
    super("A Plus trial checkout is already reserved for this account");
    this.name = "BillingTrialAlreadyReservedError";
  }
}

export class BillingCustomerNotFoundError extends Error {
  readonly code = "BILLING_CUSTOMER_NOT_FOUND" as const;
  constructor() {
    super("No billing customer exists for this account");
    this.name = "BillingCustomerNotFoundError";
  }
}

function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new RangeError("Idempotency-Key must be 1-128 URL-safe characters");
  }
  return value;
}

export async function createHostedCheckout(input: {
  userId: number;
  email: string;
  idempotencyKey: string;
  config: Extract<BillingConfig, { enabled: true }>;
  adapter: BillingProviderAdapter;
}) {
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const customer = await pool.query<{ external_customer_id: string }>(
    `SELECT external_customer_id FROM billing_customers
     WHERE user_id = $1 AND provider = $2`,
    [input.userId, input.adapter.provider],
  );
  const reserved = await pool.query<{ user_id: number }>(
    `INSERT INTO billing_trials (user_id, provider, checkout_idempotency_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [input.userId, input.adapter.provider, idempotencyKey],
  );
  const existingReservation =
    reserved.rowCount === 1
      ? null
      : await pool.query<{
          checkout_idempotency_key: string | null;
          started_at: Date | null;
        }>(
          `SELECT checkout_idempotency_key, started_at
           FROM billing_trials WHERE user_id = $1`,
          [input.userId],
        );
  const reusableTrialKey =
    existingReservation?.rows[0]?.started_at === null
      ? existingReservation.rows[0].checkout_idempotency_key
      : null;
  const trialReservationKey =
    reserved.rowCount === 1 ? idempotencyKey : reusableTrialKey;
  const includeTrial = trialReservationKey !== null;
  const providerIdempotencyKey = trialReservationKey ?? idempotencyKey;

  try {
    const session = await input.adapter.createCheckoutSession({
      userId: input.userId,
      email: input.email,
      externalCustomerId: customer.rows[0]?.external_customer_id ?? null,
      priceId: input.config.stripePlusPriceId,
      appBaseUrl: input.config.appBaseUrl,
      trialDays: input.config.trialDays,
      includeTrial,
      idempotencyKey: `checkout:${input.userId}:${providerIdempotencyKey}`,
    });
    if (includeTrial) {
      await pool.query(
        `UPDATE billing_trials SET external_checkout_session_id = $2
         WHERE user_id = $1 AND checkout_idempotency_key = $3
           AND external_checkout_session_id IS NULL`,
        [input.userId, session.id, providerIdempotencyKey],
      );
    }
    return { ...session, trialIncluded: includeTrial };
  } catch (error) {
    if (includeTrial) {
      await pool.query(
         `DELETE FROM billing_trials
         WHERE user_id = $1 AND external_checkout_session_id IS NULL
           AND started_at IS NULL AND checkout_idempotency_key = $2`,
        [input.userId, providerIdempotencyKey],
      );
    }
    throw error;
  }
}

export async function createHostedPortal(input: {
  userId: number;
  idempotencyKey: string;
  config: Extract<BillingConfig, { enabled: true }>;
  adapter: BillingProviderAdapter;
}) {
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const customer = await pool.query<{ external_customer_id: string }>(
    `SELECT external_customer_id FROM billing_customers
     WHERE user_id = $1 AND provider = $2`,
    [input.userId, input.adapter.provider],
  );
  const externalCustomerId = customer.rows[0]?.external_customer_id;
  if (!externalCustomerId) throw new BillingCustomerNotFoundError();
  return input.adapter.createPortalSession({
    externalCustomerId,
    appBaseUrl: input.config.appBaseUrl,
    idempotencyKey: `portal:${input.userId}:${idempotencyKey}`,
  });
}

type ExistingSubscription = {
  user_id: number;
  external_customer_id: string | null;
  latest_provider_event_created_at: Date;
  latest_provider_object_updated_at: Date | null;
};

function isStale(
  existing: ExistingSubscription,
  event: NormalizedBillingWebhookEvent,
): boolean {
  if (
    existing.latest_provider_object_updated_at &&
    event.objectUpdatedAt
  ) {
    if (event.objectUpdatedAt < existing.latest_provider_object_updated_at) {
      return true;
    }
    if (event.objectUpdatedAt > existing.latest_provider_object_updated_at) {
      return false;
    }
  }
  return event.createdAt < existing.latest_provider_event_created_at;
}

async function resolveEventUser(
  client: pg.PoolClient,
  event: NormalizedBillingWebhookEvent,
  existing: ExistingSubscription | undefined,
): Promise<number | null> {
  if (existing) {
    if (event.userId && event.userId !== existing.user_id) return null;
    return existing.user_id;
  }
  if (event.userId) {
    const user = await client.query(`SELECT id FROM users WHERE id = $1`, [event.userId]);
    if (user.rowCount === 1) return event.userId;
  }
  if (event.externalCustomerId) {
    const customer = await client.query<{ user_id: number }>(
      `SELECT user_id FROM billing_customers
       WHERE provider = $1 AND external_customer_id = $2`,
      [event.provider, event.externalCustomerId],
    );
    return customer.rows[0]?.user_id ?? null;
  }
  return null;
}

async function ensureCustomerMapping(
  client: pg.PoolClient,
  input: {
    userId: number;
    provider: "stripe";
    externalCustomerId: string | null;
  },
): Promise<boolean> {
  if (!input.externalCustomerId) return true;
  const mappings = await client.query<{
    user_id: number;
    external_customer_id: string;
  }>(
    `SELECT user_id, external_customer_id FROM billing_customers
     WHERE provider = $1
       AND (user_id = $2 OR external_customer_id = $3)
     FOR UPDATE`,
    [input.provider, input.userId, input.externalCustomerId],
  );
  if (
    mappings.rows.some(
      (mapping) =>
        mapping.user_id !== input.userId ||
        mapping.external_customer_id !== input.externalCustomerId,
    )
  ) {
    return false;
  }
  await client.query(
    `INSERT INTO billing_customers (user_id, provider, external_customer_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, provider) DO UPDATE
     SET updated_at = clock_timestamp()`,
    [input.userId, input.provider, input.externalCustomerId],
  );
  return true;
}

export async function processBillingWebhook(input: {
  event: NormalizedBillingWebhookEvent;
  rawBody: Buffer;
}): Promise<{ duplicate: boolean; outcome: string }> {
  const { event } = input;
  const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const receipt = await client.query(
      `INSERT INTO billing_webhook_events (
         provider, external_event_id, event_type, external_object_id,
         payload_sha256, event_created_at, outcome
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ignored_unmapped')
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING id`,
      [
        event.provider,
        event.id,
        event.type,
        event.objectId,
        payloadSha256,
        event.createdAt,
      ],
    );
    if (receipt.rowCount === 0) {
      await client.query("COMMIT");
      return { duplicate: true, outcome: "duplicate" };
    }

    let outcome = "ignored_unmapped";
    let userId: number | null = null;
    if (event.mutation.kind === "customer") {
      userId = await resolveEventUser(client, event, undefined);
      if (userId && event.externalCustomerId) {
        const mapped = await ensureCustomerMapping(client, {
          userId,
          provider: event.provider,
          externalCustomerId: event.externalCustomerId,
        });
        if (mapped) outcome = "applied";
      }
    } else if (event.mutation.kind === "subscription") {
      const existingResult = await client.query<ExistingSubscription>(
        `SELECT user_id, external_customer_id,
                latest_provider_event_created_at,
                latest_provider_object_updated_at
         FROM billing_subscriptions
         WHERE provider = $1 AND external_subscription_id = $2
         FOR UPDATE`,
        [event.provider, event.mutation.externalSubscriptionId],
      );
      const existing = existingResult.rows[0];
      userId = await resolveEventUser(client, event, existing);
      if (existing && isStale(existing, event)) {
        outcome = "ignored_stale";
      } else if (userId) {
        const customerMappingSafe = await ensureCustomerMapping(client, {
          userId,
          provider: event.provider,
          externalCustomerId: event.externalCustomerId,
        });
        if (!customerMappingSafe) {
          userId = null;
        } else {
          await client.query(
            `UPDATE billing_subscriptions
           SET access_state = 'expired', updated_at = clock_timestamp()
           WHERE user_id = $1 AND plan_key = 'plus'
             AND NOT (provider = $2 AND external_subscription_id = $3)
             AND access_state IN ('trialing', 'active', 'past_due')`,
            [userId, event.provider, event.mutation.externalSubscriptionId],
          );
          await client.query(
            `INSERT INTO billing_subscriptions (
             user_id, provider, external_subscription_id, external_customer_id,
             provider_status, access_state, trial_starts_at, trial_ends_at,
             current_period_ends_at, cancel_at_period_end,
             latest_provider_event_id, latest_provider_event_created_at,
             latest_provider_object_updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (provider, external_subscription_id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             external_customer_id = COALESCE(EXCLUDED.external_customer_id,
               billing_subscriptions.external_customer_id),
             provider_status = EXCLUDED.provider_status,
             access_state = EXCLUDED.access_state,
             trial_starts_at = COALESCE(EXCLUDED.trial_starts_at,
               billing_subscriptions.trial_starts_at),
             trial_ends_at = COALESCE(EXCLUDED.trial_ends_at,
               billing_subscriptions.trial_ends_at),
             current_period_ends_at = COALESCE(EXCLUDED.current_period_ends_at,
               billing_subscriptions.current_period_ends_at),
             cancel_at_period_end = EXCLUDED.cancel_at_period_end,
             latest_provider_event_id = EXCLUDED.latest_provider_event_id,
             latest_provider_event_created_at = EXCLUDED.latest_provider_event_created_at,
             latest_provider_object_updated_at = COALESCE(
               EXCLUDED.latest_provider_object_updated_at,
               billing_subscriptions.latest_provider_object_updated_at),
             updated_at = clock_timestamp()`,
            [
              userId,
              event.provider,
              event.mutation.externalSubscriptionId,
              event.externalCustomerId ?? existing?.external_customer_id ?? null,
              event.mutation.providerStatus,
              event.mutation.accessState,
              event.mutation.trialStartsAt,
              event.mutation.trialEndsAt,
              event.mutation.currentPeriodEndsAt,
              event.mutation.cancelAtPeriodEnd,
              event.id,
              event.createdAt,
              event.objectUpdatedAt,
            ],
          );
          if (event.mutation.trialStartsAt && event.mutation.trialEndsAt) {
            await client.query(
              `INSERT INTO billing_trials (
               user_id, provider, started_at, ended_at
             ) VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET
               started_at = COALESCE(billing_trials.started_at, EXCLUDED.started_at),
               ended_at = GREATEST(billing_trials.ended_at, EXCLUDED.ended_at)`,
              [
                userId,
                event.provider,
                event.mutation.trialStartsAt,
                event.mutation.trialEndsAt,
              ],
            );
          }
          outcome = "applied";
        }
      }
    }

    await client.query(
      `UPDATE billing_webhook_events
       SET user_id = $3, outcome = $4, processed_at = clock_timestamp()
       WHERE provider = $1 AND external_event_id = $2`,
      [event.provider, event.id, userId, outcome],
    );
    await client.query("COMMIT");
    return { duplicate: false, outcome };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
