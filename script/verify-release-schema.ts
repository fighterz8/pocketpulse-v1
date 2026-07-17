import pg from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to verify the release schema");
}

const expectedTables = [
  "ai_budget_reservations",
  "ai_usage_events",
  "ai_budget_buckets",
  "ai_concurrency_leases",
  "ai_enhancement_jobs",
  "ai_enhancement_job_items",
  "billing_customers",
  "billing_trials",
  "billing_subscriptions",
  "billing_webhook_events",
  "csv_format_assistance_attempts",
] as const;

const expectedColumns = [
  ["ai_budget_buckets", "alerted_through_percent"],
  ["billing_trials", "checkout_idempotency_key"],
] as const;

const releaseMigrationFiles = [
  "0013_ai_usage_accounting.sql",
  "0014_ai_enhancement_jobs.sql",
  "0015_ai_budget_alert_levels.sql",
  "0016_billing_entitlements.sql",
  "0017_billing_checkout_idempotency.sql",
  "0018_csv_format_assistance_attempts.sql",
] as const;

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [expectedTables],
  );
  const presentTables = new Set(tables.rows.map((row) => row.table_name));
  const missingTables = expectedTables.filter((table) => !presentTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`missing release tables: ${missingTables.join(", ")}`);
  }

  for (const [table, column] of expectedColumns) {
    const result = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS present`,
      [table, column],
    );
    if (result.rows[0]?.present !== true) {
      throw new Error(`missing release column: ${table}.${column}`);
    }
  }

  const expectedMigrationHashes = await Promise.all(
    releaseMigrationFiles.map(async (filename) => {
      const migrationUrl = new URL(`../drizzle/migrations/${filename}`, import.meta.url);
      const migration = await readFile(fileURLToPath(migrationUrl));
      return createHash("sha256").update(migration).digest("hex");
    }),
  );
  const migrations = await client.query<{ hash: string }>(
    `SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])`,
    [expectedMigrationHashes],
  );
  const appliedReleaseHashes = new Set(migrations.rows.map((row) => row.hash));
  const missingMigrations = releaseMigrationFiles.filter(
    (_, index) => !appliedReleaseHashes.has(expectedMigrationHashes[index]),
  );
  if (missingMigrations.length > 0) {
    throw new Error(`missing release migrations: ${missingMigrations.join(", ")}`);
  }

  console.log(
    JSON.stringify({
      status: "ok",
      releaseTables: expectedTables.length,
      releaseColumns: expectedColumns.length,
      appliedReleaseMigrations: releaseMigrationFiles.length,
    }),
  );
} finally {
  await client.end();
}
