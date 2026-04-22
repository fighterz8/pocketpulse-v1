-- Phase 7: Dev Test Suite — parser fidelity samples (PR2)
--
-- Adds the second sandboxed verdict table for the developer-only Test Suite
-- (gated by DEV_MODE_ENABLED + users.is_dev). Samples never mutate any
-- production transaction or upload rows.
--
-- Also backfills uploads.warning_count (default 0) so the parser-sample
-- creation step has a meaningful number to snapshot from older uploads.
--
-- Idempotent so it can be safely re-run on environments where it was
-- created out-of-band via psql during development.

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS warning_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS parser_samples (
  id                    serial PRIMARY KEY,
  user_id               integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id             integer REFERENCES uploads(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  sample_size           integer NOT NULL,
  date_accuracy         numeric(5, 4),
  description_accuracy  numeric(5, 4),
  amount_accuracy       numeric(5, 4),
  direction_accuracy    numeric(5, 4),
  upload_row_count      integer,
  upload_warning_count  integer,
  confirmed_count       integer NOT NULL DEFAULT 0,
  flagged_count         integer NOT NULL DEFAULT 0,
  verdicts              json NOT NULL DEFAULT '[]'::json
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'parser_samples'
      AND indexname  = 'parser_samples_user_id_idx'
  ) THEN
    CREATE INDEX parser_samples_user_id_idx ON parser_samples (user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'parser_samples'
      AND indexname  = 'parser_samples_upload_id_idx'
  ) THEN
    CREATE INDEX parser_samples_upload_id_idx ON parser_samples (upload_id);
  END IF;
END $$;
