-- Slice 8: durable explicit CSV-format assistance claims and negative cooldowns.

CREATE TABLE "csv_format_assistance_attempts" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "header_fingerprint" text NOT NULL,
  "attempt_id" text NOT NULL,
  "reservation_id" text,
  "status" text NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "retry_after" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "csv_format_assistance_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "csv_format_assistance_reservation_fk"
    FOREIGN KEY ("reservation_id") REFERENCES "ai_budget_reservations"("id") ON DELETE SET NULL,
  CONSTRAINT "csv_format_assistance_fingerprint_check"
    CHECK ("header_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "csv_format_assistance_attempt_id_check"
    CHECK (char_length("attempt_id") BETWEEN 1 AND 128),
  CONSTRAINT "csv_format_assistance_status_check"
    CHECK ("status" IN ('in_progress', 'failed')),
  CONSTRAINT "csv_format_assistance_failure_code_check"
    CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[A-Z0-9_]{1,64}$'),
  CONSTRAINT "csv_format_assistance_state_check"
    CHECK (
      ("status" = 'in_progress' AND "lease_expires_at" IS NOT NULL AND "retry_after" IS NULL AND "failure_code" IS NULL)
      OR
      ("status" = 'failed' AND "lease_expires_at" IS NULL AND "retry_after" IS NOT NULL AND "failure_code" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "csv_format_assistance_user_fp_unique"
  ON "csv_format_assistance_attempts" ("user_id", "header_fingerprint");
CREATE UNIQUE INDEX "csv_format_assistance_attempt_id_unique"
  ON "csv_format_assistance_attempts" ("attempt_id");
CREATE INDEX "csv_format_assistance_retry_after_idx"
  ON "csv_format_assistance_attempts" ("retry_after");
