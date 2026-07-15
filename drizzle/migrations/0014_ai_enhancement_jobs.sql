-- Slice 3: durable, explicitly user-initiated merchant enhancement jobs.
-- The feature remains disabled; this migration only establishes safe state.

CREATE TABLE "ai_enhancement_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "upload_id" integer NOT NULL REFERENCES "uploads"("id") ON DELETE CASCADE,
  "account_id" integer NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "total_merchants" integer DEFAULT 0 NOT NULL,
  "completed_merchants" integer DEFAULT 0 NOT NULL,
  "skipped_merchants" integer DEFAULT 0 NOT NULL,
  "failed_merchants" integer DEFAULT 0 NOT NULL,
  "estimated_max_cost_microusd" bigint DEFAULT 0 NOT NULL,
  "actual_cost_microusd" bigint DEFAULT 0 NOT NULL,
  "internal_error_code" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_enhancement_jobs_kind_check"
    CHECK ("kind" = 'transaction_classification'),
  CONSTRAINT "ai_enhancement_jobs_status_check"
    CHECK ("status" IN ('queued', 'processing', 'complete', 'partial', 'failed', 'cancelled', 'budget_blocked')),
  CONSTRAINT "ai_enhancement_jobs_idempotency_key_check"
    CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  CONSTRAINT "ai_enhancement_jobs_counts_check"
    CHECK (
      "total_merchants" >= 0 AND "completed_merchants" >= 0 AND
      "skipped_merchants" >= 0 AND "failed_merchants" >= 0 AND
      "completed_merchants" + "skipped_merchants" + "failed_merchants"
        <= "total_merchants"
    ),
  CONSTRAINT "ai_enhancement_jobs_cost_check"
    CHECK (
      "estimated_max_cost_microusd" >= 0 AND "actual_cost_microusd" >= 0 AND
      "actual_cost_microusd" <= "estimated_max_cost_microusd"
    )
);

CREATE UNIQUE INDEX "ai_enhancement_jobs_user_idempotency_unique"
  ON "ai_enhancement_jobs" ("user_id", "idempotency_key");
CREATE UNIQUE INDEX "ai_enhancement_jobs_one_active_user_unique"
  ON "ai_enhancement_jobs" ("user_id")
  WHERE "status" IN ('queued', 'processing', 'budget_blocked');
CREATE INDEX "ai_enhancement_jobs_user_id_idx"
  ON "ai_enhancement_jobs" ("user_id");
CREATE INDEX "ai_enhancement_jobs_upload_id_idx"
  ON "ai_enhancement_jobs" ("upload_id");
CREATE INDEX "ai_enhancement_jobs_status_idx"
  ON "ai_enhancement_jobs" ("status");

CREATE TABLE "ai_enhancement_job_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "job_id" integer NOT NULL REFERENCES "ai_enhancement_jobs"("id") ON DELETE CASCADE,
  "merchant_key" text NOT NULL,
  "representative_transaction_id" integer REFERENCES "transactions"("id") ON DELETE SET NULL,
  "status" text NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "batch_key" text,
  "lease_token" text,
  "lease_expires_at" timestamptz,
  "reservation_id" text REFERENCES "ai_budget_reservations"("id") ON DELETE RESTRICT,
  "result_category" text,
  "result_transaction_class" text,
  "result_recurrence_type" text,
  "result_confidence" numeric(5, 2),
  "result_reason" text,
  "internal_error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "ai_enhancement_job_items_status_check"
    CHECK ("status" IN ('pending', 'processing', 'result_ready', 'complete', 'skipped', 'failed')),
  CONSTRAINT "ai_enhancement_job_items_merchant_key_check"
    CHECK (char_length("merchant_key") BETWEEN 1 AND 240),
  CONSTRAINT "ai_enhancement_job_items_attempt_check"
    CHECK ("attempt_count" BETWEEN 0 AND 1),
  CONSTRAINT "ai_enhancement_job_items_processing_lease_check"
    CHECK (
      "status" <> 'processing' OR
      ("batch_key" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    ),
  CONSTRAINT "ai_enhancement_job_items_result_check"
    CHECK (
      "status" NOT IN ('result_ready', 'complete') OR
      ("result_category" IS NOT NULL AND "result_transaction_class" IS NOT NULL AND
       "result_recurrence_type" IS NOT NULL AND "result_confidence" IS NOT NULL AND
       "result_reason" IS NOT NULL)
    ),
  CONSTRAINT "ai_enhancement_job_items_confidence_check"
    CHECK ("result_confidence" IS NULL OR
      ("result_confidence" >= 0 AND "result_confidence" <= 1))
);

CREATE UNIQUE INDEX "ai_enhancement_job_items_job_merchant_unique"
  ON "ai_enhancement_job_items" ("job_id", "merchant_key");
CREATE INDEX "ai_enhancement_job_items_job_status_idx"
  ON "ai_enhancement_job_items" ("job_id", "status");
CREATE INDEX "ai_enhancement_job_items_lease_expiry_idx"
  ON "ai_enhancement_job_items" ("lease_expires_at");
CREATE INDEX "ai_enhancement_job_items_batch_key_idx"
  ON "ai_enhancement_job_items" ("batch_key");

ALTER TABLE "ai_budget_reservations"
  ADD CONSTRAINT "ai_budget_reservations_job_id_ai_enhancement_jobs_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "ai_enhancement_jobs"("id") ON DELETE SET NULL;
CREATE INDEX "ai_budget_reservations_job_id_idx"
  ON "ai_budget_reservations" ("job_id");

ALTER TABLE "ai_usage_events"
  ADD CONSTRAINT "ai_usage_events_job_id_ai_enhancement_jobs_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "ai_enhancement_jobs"("id") ON DELETE SET NULL;
CREATE INDEX "ai_usage_events_job_id_idx" ON "ai_usage_events" ("job_id");

-- Nested ON DELETE SET NULL actions may erase attribution, including job_id.
-- Direct updates remain prohibited by the immutable-ledger trigger.
CREATE OR REPLACE FUNCTION protect_ai_usage_event_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_usage_events rows are immutable';
  END IF;

  IF pg_trigger_depth() <= 1
     OR (to_jsonb(NEW) - ARRAY['user_id', 'account_id', 'upload_id', 'job_id'])
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
