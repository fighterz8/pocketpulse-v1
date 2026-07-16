-- Slice 5: remember which application-budget thresholds have already emitted.
-- Period buckets make the deduplication durable across serverless instances.

ALTER TABLE "ai_budget_buckets"
  ADD COLUMN "alerted_through_percent" smallint DEFAULT 0 NOT NULL;

ALTER TABLE "ai_budget_buckets"
  ADD CONSTRAINT "ai_budget_buckets_alert_level_check"
  CHECK ("alerted_through_percent" IN (0, 50, 80, 100));
