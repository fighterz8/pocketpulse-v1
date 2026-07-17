import pg from "pg";

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

  const migrations = await client.query<{ total: number }>(
    `SELECT COUNT(*)::integer AS total FROM drizzle.__drizzle_migrations`,
  );
  const migrationCount = migrations.rows[0]?.total ?? 0;
  if (migrationCount < 19) {
    throw new Error(`expected at least 19 applied migrations; found ${migrationCount}`);
  }

  console.log(
    JSON.stringify({
      status: "ok",
      releaseTables: expectedTables.length,
      releaseColumns: expectedColumns.length,
      appliedMigrations: migrationCount,
    }),
  );
} finally {
  await client.end();
}
