-- Slice 6: preserve trial inclusion across an idempotent checkout replay.

ALTER TABLE "billing_trials"
  ADD COLUMN "checkout_idempotency_key" text;

ALTER TABLE "billing_trials"
  ADD CONSTRAINT "billing_trials_idempotency_key_check"
  CHECK ("checkout_idempotency_key" IS NULL OR
    char_length("checkout_idempotency_key") BETWEEN 1 AND 128);
