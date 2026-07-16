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
      subscription.currentPeriodEndsAt &&
      subscription.currentPeriodEndsAt <= input.now
    ) {
      return { state: "expired", trialAvailable, entitled: false };
    }
    return {
      state: "active",
      trialAvailable,
      entitled: true,
      ...(subscription.currentPeriodEndsAt
        ? { expiresAt: subscription.currentPeriodEndsAt.toISOString() }
        : {}),
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
  trial_consumed: boolean;
  now: Date;
};

export async function getBillingEntitlementWithClient(
  client: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  userId: number,
): Promise<BillingEntitlement> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new RangeError("userId must be a positive safe integer");
  }
  const result = await client.query<EntitlementRow>(
    `SELECT subscription.access_state,
            subscription.trial_ends_at,
            subscription.current_period_ends_at,
            EXISTS (SELECT 1 FROM billing_trials t WHERE t.user_id = $1) AS trial_consumed,
            clock_timestamp() AS now
     FROM (SELECT 1) singleton
     LEFT JOIN LATERAL (
       SELECT access_state, trial_ends_at, current_period_ends_at
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
  const row = result.rows[0]!;
  return resolveBillingEntitlement({
    subscription: row.access_state
      ? {
          accessState: row.access_state,
          trialEndsAt: row.trial_ends_at,
          currentPeriodEndsAt: row.current_period_ends_at,
        }
      : null,
    trialConsumed: row.trial_consumed,
    now: row.now,
  });
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
