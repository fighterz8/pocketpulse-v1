-- Slice 2: durable provider-cost accounting and budget controls.
-- No application path uses these tables until later slices explicitly opt in.

CREATE TABLE "ai_budget_reservations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "account_id" integer REFERENCES "accounts"("id") ON DELETE SET NULL,
  "upload_id" integer REFERENCES "uploads"("id") ON DELETE SET NULL,
  "job_id" integer,
  "operation" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "pricing_version" text NOT NULL,
  "reserved_cost_microusd" bigint NOT NULL,
  "final_cost_microusd" bigint,
  "status" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "reconciled_at" timestamptz,
  CONSTRAINT "ai_budget_reservations_operation_check"
    CHECK ("operation" IN ('transaction_classification', 'csv_format_detection')),
  CONSTRAINT "ai_budget_reservations_status_check"
    CHECK ("status" IN ('active', 'committed', 'reserved_unknown', 'released')),
  CONSTRAINT "ai_budget_reservations_cost_check"
    CHECK ("reserved_cost_microusd" >= 0 AND
      ("final_cost_microusd" IS NULL OR "final_cost_microusd" >= 0))
);

CREATE INDEX "ai_budget_reservations_user_id_idx"
  ON "ai_budget_reservations" ("user_id");
CREATE INDEX "ai_budget_reservations_account_id_idx"
  ON "ai_budget_reservations" ("account_id");
CREATE INDEX "ai_budget_reservations_upload_id_idx"
  ON "ai_budget_reservations" ("upload_id");

CREATE TABLE "ai_usage_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "reservation_id" text NOT NULL REFERENCES "ai_budget_reservations"("id") ON DELETE RESTRICT,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "account_id" integer REFERENCES "accounts"("id") ON DELETE SET NULL,
  "upload_id" integer REFERENCES "uploads"("id") ON DELETE SET NULL,
  "job_id" integer,
  "operation" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "pricing_version" text NOT NULL,
  "provider_request_id" text,
  "attempt_status" text NOT NULL,
  "latency_ms" integer,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "cached_input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "reasoning_tokens" integer DEFAULT 0 NOT NULL,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "reserved_cost_microusd" bigint NOT NULL,
  "final_cost_microusd" bigint NOT NULL,
  "usage_source" text NOT NULL,
  "error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_usage_events_operation_check"
    CHECK ("operation" IN ('transaction_classification', 'csv_format_detection')),
  CONSTRAINT "ai_usage_events_attempt_status_check"
    CHECK ("attempt_status" IN ('succeeded', 'failed', 'released', 'unknown')),
  CONSTRAINT "ai_usage_events_usage_source_check"
    CHECK ("usage_source" IN ('actual', 'estimated', 'reserved_unknown')),
  CONSTRAINT "ai_usage_events_token_check"
    CHECK (
      "input_tokens" >= 0 AND "cached_input_tokens" >= 0 AND
      "output_tokens" >= 0 AND "reasoning_tokens" >= 0 AND
      "total_tokens" >= 0 AND "cached_input_tokens" <= "input_tokens" AND
      "reasoning_tokens" <= "output_tokens" AND
      "total_tokens" = "input_tokens" + "output_tokens"
    ),
  CONSTRAINT "ai_usage_events_cost_check"
    CHECK ("reserved_cost_microusd" >= 0 AND "final_cost_microusd" >= 0)
);

CREATE UNIQUE INDEX "ai_usage_events_reservation_id_unique"
  ON "ai_usage_events" ("reservation_id");
CREATE UNIQUE INDEX "ai_usage_events_provider_request_unique"
  ON "ai_usage_events" ("provider", "provider_request_id")
  WHERE "provider_request_id" IS NOT NULL;
CREATE INDEX "ai_usage_events_user_id_idx" ON "ai_usage_events" ("user_id");
CREATE INDEX "ai_usage_events_account_id_idx" ON "ai_usage_events" ("account_id");
CREATE INDEX "ai_usage_events_upload_id_idx" ON "ai_usage_events" ("upload_id");
CREATE INDEX "ai_usage_events_created_at_idx" ON "ai_usage_events" ("created_at");

CREATE TABLE "ai_budget_buckets" (
  "id" serial PRIMARY KEY NOT NULL,
  "scope" text NOT NULL,
  "user_id" integer REFERENCES "users"("id") ON DELETE CASCADE,
  "period" text NOT NULL,
  "period_start" date NOT NULL,
  "configured_limit_microusd" bigint NOT NULL,
  "reserved_cost_microusd" bigint DEFAULT 0 NOT NULL,
  "committed_cost_microusd" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_budget_buckets_scope_check"
    CHECK (("scope" = 'app' AND "user_id" IS NULL) OR
      ("scope" = 'user' AND "user_id" IS NOT NULL)),
  CONSTRAINT "ai_budget_buckets_period_check"
    CHECK ("period" IN ('day', 'month')),
  CONSTRAINT "ai_budget_buckets_cost_check"
    CHECK ("configured_limit_microusd" >= 0 AND
      "reserved_cost_microusd" >= 0 AND "committed_cost_microusd" >= 0)
);

CREATE UNIQUE INDEX "ai_budget_buckets_app_period_unique"
  ON "ai_budget_buckets" ("period", "period_start") WHERE "scope" = 'app';
CREATE UNIQUE INDEX "ai_budget_buckets_user_period_unique"
  ON "ai_budget_buckets" ("user_id", "period", "period_start")
  WHERE "scope" = 'user';
CREATE INDEX "ai_budget_buckets_user_id_idx" ON "ai_budget_buckets" ("user_id");

CREATE TABLE "ai_concurrency_leases" (
  "id" text PRIMARY KEY NOT NULL,
  "holder_key" text NOT NULL,
  "acquired_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL
);

CREATE UNIQUE INDEX "ai_concurrency_leases_holder_key_unique"
  ON "ai_concurrency_leases" ("holder_key");
CREATE INDEX "ai_concurrency_leases_expires_at_idx"
  ON "ai_concurrency_leases" ("expires_at");

-- Finalized usage rows are append-only. Referential SET NULL updates are the
-- sole exception so deleting a user/account removes personal attribution while
-- preserving anonymous application spend totals.
CREATE OR REPLACE FUNCTION protect_ai_usage_event_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_usage_events rows are immutable';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['user_id', 'account_id', 'upload_id', 'job_id'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['user_id', 'account_id', 'upload_id', 'job_id'])
     OR NOT (NEW.user_id IS NOT DISTINCT FROM OLD.user_id OR NEW.user_id IS NULL)
     OR NOT (NEW.account_id IS NOT DISTINCT FROM OLD.account_id OR NEW.account_id IS NULL)
     OR NOT (NEW.upload_id IS NOT DISTINCT FROM OLD.upload_id OR NEW.upload_id IS NULL)
     OR NOT (NEW.job_id IS NOT DISTINCT FROM OLD.job_id OR NEW.job_id IS NULL)
  THEN
    RAISE EXCEPTION 'ai_usage_events rows are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_usage_events_immutable_update
  BEFORE UPDATE ON "ai_usage_events"
  FOR EACH ROW EXECUTE FUNCTION protect_ai_usage_event_immutability();

CREATE TRIGGER ai_usage_events_immutable_delete
  BEFORE DELETE ON "ai_usage_events"
  FOR EACH ROW EXECUTE FUNCTION protect_ai_usage_event_immutability();
