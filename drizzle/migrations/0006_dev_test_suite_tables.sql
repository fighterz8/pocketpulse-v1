-- Phase 6: Dev Test Suite — classification samples
--
-- Stores per-user classification accuracy samples for the developer-only
-- Test Suite (gated by server dev-tools access + users.is_dev). Verdicts are
-- snapshotted from the classifier at sample creation time and never
-- mutate any production transaction rows.
--
-- Idempotent so it can be safely re-run on environments where the table
-- was created out-of-band via psql during development.

CREATE TABLE IF NOT EXISTS classification_samples (
  id                   serial PRIMARY KEY,
  user_id              integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  sample_size          integer NOT NULL,
  verdicts             json NOT NULL DEFAULT '[]'::json,
  category_accuracy    numeric(5, 4),
  class_accuracy       numeric(5, 4),
  recurrence_accuracy  numeric(5, 4),
  confirmed_count      integer NOT NULL DEFAULT 0,
  corrected_count      integer NOT NULL DEFAULT 0,
  skipped_count        integer NOT NULL DEFAULT 0
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'classification_samples'
      AND indexname  = 'classification_samples_user_id_idx'
  ) THEN
    CREATE INDEX classification_samples_user_id_idx
      ON classification_samples (user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'classification_samples'
      AND indexname  = 'classification_samples_completed_at_idx'
  ) THEN
    CREATE INDEX classification_samples_completed_at_idx
      ON classification_samples (completed_at);
  END IF;
END $$;
