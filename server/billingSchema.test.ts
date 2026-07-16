import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  billingCustomers,
  billingSubscriptions,
  billingTrials,
  billingWebhookEvents,
} from "../shared/schema.js";

describe("billing schema contracts", () => {
  it("exports the provider-neutral billing tables", () => {
    expect(getTableConfig(billingCustomers).name).toBe("billing_customers");
    expect(getTableConfig(billingSubscriptions).name).toBe("billing_subscriptions");
    expect(getTableConfig(billingTrials).name).toBe("billing_trials");
    expect(getTableConfig(billingWebhookEvents).name).toBe("billing_webhook_events");
  });

  it("enforces one provider customer, one trial, and idempotent events", () => {
    const customers = getTableConfig(billingCustomers);
    const trials = getTableConfig(billingTrials);
    const events = getTableConfig(billingWebhookEvents);

    expect(
      customers.indexes.find(
        (index) => index.config.name === "billing_customers_user_provider_unique",
      )?.config.unique,
    ).toBe(true);
    expect(trials.primaryKeys).toHaveLength(0);
    expect(trials.columns.find((column) => column.name === "user_id")?.primary).toBe(
      true,
    );
    expect(
      events.indexes.find(
        (index) => index.config.name === "billing_webhook_events_provider_event_unique",
      )?.config.unique,
    ).toBe(true);
  });

  it("prevents multiple current Plus subscriptions for one user", () => {
    const subscriptions = getTableConfig(billingSubscriptions);
    const current = subscriptions.indexes.find(
      (index) =>
        index.config.name === "billing_subscriptions_one_current_plus_user_unique",
    );
    expect(current?.config.unique).toBe(true);
    expect(current?.config.where).toBeDefined();
  });
});
