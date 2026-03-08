import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision the database?");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

export async function ensureSchemaExtensions(): Promise<void> {
  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other',
      ADD COLUMN IF NOT EXISTS label_source text NOT NULL DEFAULT 'rule',
      ADD COLUMN IF NOT EXISTS label_confidence numeric(5, 2),
      ADD COLUMN IF NOT EXISTS label_reason text
  `);
}
