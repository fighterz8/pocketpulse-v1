-- Create password_reset_tokens table for self-service password recovery.
--
-- Stores SHA-256 hashes of one-time reset tokens (never the raw token bytes)
-- so a database leak does not yield usable reset links. Each row carries a
-- short-lived `expires_at` (typically 30 min from issue) and a nullable
-- `used_at` that flips on first successful consumption to prevent replay.
--
-- Cascading on the user_id FK so deleting a user automatically cleans up
-- their outstanding reset tokens.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_unique"
  ON "password_reset_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx"
  ON "password_reset_tokens" ("user_id");
