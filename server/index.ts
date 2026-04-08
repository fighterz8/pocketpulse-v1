import http from "node:http";

import { createApp } from "./routes.js";
import { pool } from "./db.js";

// ── One-time startup migration: strip old "|amount.toFixed(2)" suffix ──────
// Old candidateKey format: "merchantKey|15.99"
// New format: "merchantKey" (bare) or "merchantKey|1" (bucket index suffix)
//
// This preserves existing reviews by re-attaching them to the new key format.
// The regex matches a pipe followed by a decimal number at the end of the key.
// Housing keys like "__housing_3200" are unaffected (no pipe + decimal suffix).
//
// Two-step process:
//  1. Delete lower-priority duplicates (same user, same new key after stripping)
//     keeping the row with the highest id (most recently created/updated).
//  2. Update the surviving rows to the new key format.
try {
  await pool.query(`
    DELETE FROM recurring_reviews rr_old
    USING recurring_reviews rr_keep
    WHERE rr_old.user_id = rr_keep.user_id
      AND rr_old.candidate_key ~ '\\|\\d+\\.\\d{2}$'
      AND rr_keep.candidate_key ~ '\\|\\d+\\.\\d{2}$'
      AND regexp_replace(rr_old.candidate_key, '\\|\\d+\\.\\d{2}$', '')
        = regexp_replace(rr_keep.candidate_key, '\\|\\d+\\.\\d{2}$', '')
      AND rr_old.candidate_key <> rr_keep.candidate_key
      AND rr_old.id < rr_keep.id
  `);
  await pool.query(`
    UPDATE recurring_reviews
    SET candidate_key = regexp_replace(candidate_key, '\\|\\d+\\.\\d{2}$', '')
    WHERE candidate_key ~ '\\|\\d+\\.\\d{2}$'
  `);
  console.log("[startup] candidateKey migration complete");
} catch (err) {
  console.warn("[startup] candidateKey migration skipped:", err);
}

// ── Startup migration: transactions dedup unique index ────────────────────────
// Enforces that no two rows for the same user+account have an identical
// (date, amount, lower(trim(rawDescription))) fingerprint.  This is the
// DB-level guard that backs the onConflictDoNothing() call in
// createTransactionBatch and closes race-condition windows.
//
// Two-step: (1) purge any pre-existing duplicates keeping the lowest ID,
//           (2) create the functional unique index if it doesn't exist yet.
//
// The functional expression lower(trim(raw_description)) matches the JS
// fingerprint in server/storage.ts exactly so both sides agree on identity.
try {
  // Step 1: remove duplicate rows (those that would violate the new index).
  await pool.query(`
    DELETE FROM transactions
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id, account_id, date, amount,
                              lower(trim(raw_description))
                 ORDER BY id ASC
               ) AS rn
        FROM transactions
      ) ranked
      WHERE rn > 1
    )
  `);
  // Step 2: create the functional unique index (no-op if already present).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_dedup_idx
      ON transactions (user_id, account_id, date, amount,
                       lower(trim(raw_description)))
  `);
  console.log("[startup] transactions dedup index migration complete");
} catch (err) {
  console.warn("[startup] transactions dedup index migration skipped:", err);
}

const app = createApp();
const isProduction = process.env.NODE_ENV === "production";
/**
 * Dev: defaults to 5001 (API-only, Vite runs separately on 5000 and proxies /api here).
 * Prod: uses PORT from environment (Replit maps external 80 → 5000).
 */
const port = Number(process.env.PORT ?? (isProduction ? "5000" : "5001"));
const server = http.createServer(app);

if (isProduction) {
  const { setupStatic } = await import("./static.js");
  setupStatic(app);
} else if (!process.env.SKIP_VITE) {
  const { setupVite } = await import("./vite.js");
  await setupVite(app, server);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`server listening on ${port}`);
});
