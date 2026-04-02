import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../shared/schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set to use the database (Drizzle / PostgreSQL pool).",
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl });

/** Drizzle client — pass `schema` so relational queries & migrations stay aligned. */
export const db = drizzle(pool, { schema });

export { pool };

/**
 * Lazy fallback: ensure a `user_preferences` row exists for `userId`.
 * Uses `INSERT ... ON CONFLICT DO NOTHING` on the primary key so concurrent
 * first-use requests do not race (no check-then-insert gap).
 *
 * Prefer inserting `{ ...USER_PREFERENCE_DEFAULTS }` in the same transaction as `users`
 * at registration; see `shared/schema.ts` lifecycle notes.
 */
export async function ensureUserPreferences(userId: number): Promise<void> {
  await db
    .insert(schema.userPreferences)
    .values({
      userId,
      theme: schema.USER_PREFERENCE_DEFAULTS.theme,
      weekStartsOn: schema.USER_PREFERENCE_DEFAULTS.weekStartsOn,
      defaultCurrency: schema.USER_PREFERENCE_DEFAULTS.defaultCurrency,
    })
    .onConflictDoNothing({ target: schema.userPreferences.userId });
}
