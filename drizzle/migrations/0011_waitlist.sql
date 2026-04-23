-- Create waitlist table to capture pre-launch email interest.
--
-- Stores one row per unique email address submitted on the Coming Soon page.
-- The unique constraint on `email` allows the POST /api/waitlist route to
-- return a successful response on duplicate submissions without exposing
-- whether the address was already registered.

CREATE TABLE IF NOT EXISTS "waitlist" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "waitlist_email_unique" UNIQUE("email")
);
