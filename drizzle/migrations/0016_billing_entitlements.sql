-- Slice 6: provider-neutral Plus entitlements and webhook idempotency.

CREATE TABLE "billing_customers" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_customer_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_customers_provider_check" CHECK ("provider" = 'stripe')
);
CREATE UNIQUE INDEX "billing_customers_user_provider_unique" ON "billing_customers" ("user_id", "provider");
CREATE UNIQUE INDEX "billing_customers_provider_external_unique" ON "billing_customers" ("provider", "external_customer_id");

CREATE TABLE "billing_trials" (
  "user_id" integer PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_checkout_session_id" text,
  "reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  CONSTRAINT "billing_trials_provider_check" CHECK ("provider" = 'stripe'),
  CONSTRAINT "billing_trials_timestamps_check" CHECK ("ended_at" IS NULL OR ("started_at" IS NOT NULL AND "ended_at" >= "started_at"))
);
CREATE UNIQUE INDEX "billing_trials_provider_checkout_unique" ON "billing_trials" ("provider", "external_checkout_session_id") WHERE "external_checkout_session_id" IS NOT NULL;

CREATE TABLE "billing_subscriptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_subscription_id" text NOT NULL,
  "external_customer_id" text,
  "plan_key" text DEFAULT 'plus' NOT NULL,
  "provider_status" text NOT NULL,
  "access_state" text NOT NULL,
  "trial_starts_at" timestamp with time zone,
  "trial_ends_at" timestamp with time zone,
  "current_period_ends_at" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "latest_provider_event_id" text NOT NULL,
  "latest_provider_event_created_at" timestamp with time zone NOT NULL,
  "latest_provider_object_updated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_subscriptions_provider_check" CHECK ("provider" = 'stripe'),
  CONSTRAINT "billing_subscriptions_plan_check" CHECK ("plan_key" = 'plus'),
  CONSTRAINT "billing_subscriptions_access_state_check" CHECK ("access_state" IN ('trialing', 'active', 'past_due', 'expired')),
  CONSTRAINT "billing_subscriptions_trial_timestamps_check" CHECK ("trial_ends_at" IS NULL OR ("trial_starts_at" IS NOT NULL AND "trial_ends_at" >= "trial_starts_at"))
);
CREATE UNIQUE INDEX "billing_subscriptions_provider_external_unique" ON "billing_subscriptions" ("provider", "external_subscription_id");
CREATE UNIQUE INDEX "billing_subscriptions_one_current_plus_user_unique" ON "billing_subscriptions" ("user_id", "plan_key") WHERE "access_state" IN ('trialing', 'active', 'past_due');
CREATE INDEX "billing_subscriptions_user_id_idx" ON "billing_subscriptions" ("user_id");

CREATE TABLE "billing_webhook_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "external_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "external_object_id" text,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "payload_sha256" text NOT NULL,
  "event_created_at" timestamp with time zone NOT NULL,
  "outcome" text NOT NULL,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_webhook_events_provider_check" CHECK ("provider" = 'stripe'),
  CONSTRAINT "billing_webhook_events_payload_hash_check" CHECK (char_length("payload_sha256") = 64),
  CONSTRAINT "billing_webhook_events_outcome_check" CHECK ("outcome" IN ('applied', 'ignored_stale', 'ignored_unmapped'))
);
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_unique" ON "billing_webhook_events" ("provider", "external_event_id");
CREATE INDEX "billing_webhook_events_user_id_idx" ON "billing_webhook_events" ("user_id");
CREATE INDEX "billing_webhook_events_created_at_idx" ON "billing_webhook_events" ("event_created_at");
