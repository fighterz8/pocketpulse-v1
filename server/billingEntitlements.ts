import type pg from "pg";

import { pool } from "./db.js";

export type BillingEntitlementState =
  | "free"
  | "trialing"
  | "active"
  | "past_due"
  | "expired";

export type BillingEntitlement = {
  state: BillingEntitlementState;
  trialAvailable: boolean;
  entitled: boolean;
  expiresAt?: string;
};

export type BillingSubscriptionProjection = {
  accessState: Exclude<BillingEntitlementState, "free">;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd?: boolean;
};

export type BillingAccountSummary = {
  access: BillingEntitlement;
  cancelAtPeriodEnd: boolean;
  customerExists: boolean;
  trialEndsAt?: string;
  currentPeriodEndsAt?: string;
};

export class PlusEntitlementRequiredError extends Error {
  readonly code = "PLUS_ENTITLEMENT_REQUIRED" as const;

  constructor(readonly entitlement: BillingEntitlement) {
    super("PocketPulse Plus is required for Transaction Enhancement");
    this.name = "PlusEntitlementRequiredError";
  }
}

export function resolveBillingEntitlement(input: {
  subscription: BillingSubscriptionProjection | null;
  trialConsumed: boolean;
  now: Date;
}): BillingEntitlement {
  const trialAvailable = !input.trialConsumed;
  const subscription = input.subscription;
  if (!subscription) {
    return { state: "free", trialAvailable, entitled: false };
  }

  if (subscription.accessState === "trialing") {
    if (subscription.trialEndsAt && subscription.trialEndsAt > input.now) {
      return {
        state: "trialing",
        trialAvailable: false,
        entitled: true,
        expiresAt: subscription.trialEndsAt.toISOString(),
      };
    }
    return { state: "expired", trialAvailable: false, entitled: false };
  }

  if (subscription.accessState === "active") {
    if (
      !subscription.currentPeriodEndsAt ||
      subscription.currentPeriodEndsAt <= input.now
    ) {
      return { state: "expired", trialAvailable, entitled: false };
    }
    return {
      state: "active",
      trialAvailable,
      entitled: true,
      expiresAt: subscription.currentPeriodEndsAt.toISOString(),
    };
  }

  return {
    state: subscription.accessState,
    trialAvailable,
    entitled: false,
  };
}

type EntitlementRow = {
  access_state: BillingSubscriptionProjection["accessState"] | null;
  trial_ends_at: Date | null;
  current_period_ends_at: Date | null;
  cancel_at_period_end: boolean | null;
  trial_consumed: boolean;
  customer_exists: boolean;
  now: Date;
};

export function resolveBillingAccountSummary(input: {
  subscription: BillingSubscriptionProjection | null;
  trialConsumed: boolean;
  customerExists: boolean;
  now: Date;
}): BillingAccountSummary {
  return {
    access: resolveBillingEntitlement(input),
    cancelAtPeriodEnd: input.subscription?.cancelAtPeriodEnd === true,
    customerExists: input.customerExists,
    ...(input.subscription?.trialEndsAt
      ? { trialEndsAt: input.subscription.trialEndsAt.toISOString() }
      : {}),
    ...(input.subscription?.currentPeriodEndsAt
      ? { currentPeriodEndsAt: input.subscription.currentPeriodEndsAt.toISOString() }
      : {}),
  };
}

async function readBillingAccountRow(
  client: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  userId: number,
): Promise<EntitlementRow> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new RangeError("userId must be a positive safe integer");
  }
  const result = await client.query<EntitlementRow>(
    `SELECT subscription.access_state,
            subscription.trial_ends_at,
            subscription.current_period_ends_at,
            subscription.cancel_at_period_end,
            EXISTS (SELECT 1 FROM billing_trials t WHERE t.user_id = $1) AS trial_consumed,
            EXISTS (SELECT 1 FROM billing_customers c WHERE c.user_id = $1) AS customer_exists,
            clock_timestamp() AS now
     FROM (SELECT 1) singleton
     LEFT JOIN LATERAL (
       SELECT access_state, trial_ends_at, current_period_ends_at, cancel_at_period_end
       FROM billing_subscriptions
       WHERE user_id = $1 AND plan_key = 'plus'
       ORDER BY
         CASE access_state
           WHEN 'trialing' THEN 1
           WHEN 'active' THEN 2
           WHEN 'past_due' THEN 3
           ELSE 4
         END,
         latest_provider_event_created_at DESC,
         id DESC
       LIMIT 1
     ) subscription ON true`,
    [userId],
  );
  return result.rows[0]!;
}

function subscriptionFromRow(row: EntitlementRow): BillingSubscriptionProjection | null {
  return row.access_state
    ? {
        accessState: row.access_state,
        trialEndsAt: row.trial_ends_at,
        currentPeriodEndsAt: row.current_period_ends_at,
        cancelAtPeriodEnd: row.cancel_at_period_end === true,
      }
    : null;
}

export async function getBillingEntitlementWithClient(
  client: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  userId: number,
): Promise<BillingEntitlement> {
  const row = await readBillingAccountRow(client, userId);
  return resolveBillingEntitlement({
    subscription: subscriptionFromRow(row),
    trialConsumed: row.trial_consumed,
    now: row.now,
  });
}

export async function getBillingAccountSummaryWithClient(
  client: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  userId: number,
): Promise<BillingAccountSummary> {
  const row = await readBillingAccountRow(client, userId);
  return resolveBillingAccountSummary({
    subscription: subscriptionFromRow(row),
    trialConsumed: row.trial_consumed,
    customerExists: row.customer_exists,
    now: row.now,
  });
}

export function getBillingAccountSummary(userId: number): Promise<BillingAccountSummary> {
  return getBillingAccountSummaryWithClient(pool, userId);
}

export function getBillingEntitlement(userId: number): Promise<BillingEntitlement> {
  return getBillingEntitlementWithClient(pool, userId);
}

export async function assertPlusEntitlement(
  userId: number,
  reader: (userId: number) => Promise<BillingEntitlement> = getBillingEntitlement,
): Promise<BillingEntitlement> {
  const entitlement = await reader(userId);
  if (!entitlement.entitled) {
    throw new PlusEntitlementRequiredError(entitlement);
  }
  return entitlement;
}
