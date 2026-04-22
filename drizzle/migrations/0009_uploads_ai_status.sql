-- Async AI PR1: track per-upload AI classification progress so the upload
-- handler can return fast and a background worker can carry AI work to
-- completion. Adds five state columns to the uploads table:
--   ai_status            "none" | "pending" | "processing" | "complete" | "failed"
--   ai_rows_pending      count of rows still waiting on AI when the upload completes
--   ai_rows_done         count of rows the worker has already enhanced
--   ai_started_at        when the background worker first picked up the upload
--   ai_completed_at      when the worker finished (success or terminal failure)
--   ai_error             diagnostic message when ai_status='failed'
--
-- Backfill: every existing upload row has already gone through the
-- synchronous AI path (or doesn't need AI), so its work is complete.
-- Mark them all 'complete' so the new badge / status endpoints don't
-- treat historical uploads as still-active.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so the migration is safe to re-run.

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS ai_status text NOT NULL DEFAULT 'none';

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS ai_rows_pending integer NOT NULL DEFAULT 0;

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS ai_rows_done integer NOT NULL DEFAULT 0;

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS ai_started_at timestamptz;

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS ai_completed_at timestamptz;

ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS ai_error text;

-- Backfill existing rows. Only touch rows that still carry the column
-- default ('none') so re-running the migration after the worker has
-- written real values doesn't clobber live state.
UPDATE uploads
SET ai_status = 'complete'
WHERE ai_status = 'none';
