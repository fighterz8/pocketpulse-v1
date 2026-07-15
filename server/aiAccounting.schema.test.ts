import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("AI accounting schema", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates the request ledger, reservation, budget, and lease tables", async () => {
    const result = await pool.query<{ name: string | null }>(`
      SELECT to_regclass(name)::text AS name
      FROM unnest(ARRAY[
        'ai_budget_reservations',
        'ai_usage_events',
        'ai_budget_buckets',
        'ai_concurrency_leases'
      ]) AS name
      ORDER BY name
    `);

    expect(result.rows.map((row) => row.name)).toEqual([
      "ai_budget_buckets",
      "ai_budget_reservations",
      "ai_concurrency_leases",
      "ai_usage_events",
    ]);
  });

  it("preserves anonymous spend while removing deleted-user attribution", async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'Budget Test') RETURNING id`,
      [`budget-${suffix}@example.test`],
    );
    const userId = user.rows[0]!.id;
    const account = await pool.query<{ id: number }>(
      `INSERT INTO accounts (user_id, label) VALUES ($1, 'Checking') RETURNING id`,
      [userId],
    );
    const accountId = account.rows[0]!.id;
    const upload = await pool.query<{ id: number }>(
      `INSERT INTO uploads (user_id, account_id, filename, status)
       VALUES ($1, $2, 'private.csv', 'complete') RETURNING id`,
      [userId, accountId],
    );
    const uploadId = upload.rows[0]!.id;
    const reservationId = `privacy-${suffix}`;
    const periodDate = `${2200 + Math.floor(Math.random() * 7000)}-09-01`;

    await pool.query(
      `INSERT INTO ai_budget_reservations (
         id, user_id, account_id, upload_id, operation, provider, model,
         pricing_version, reserved_cost_microusd, final_cost_microusd, status
       ) VALUES ($1, $2, $3, $4, 'transaction_classification', 'openai',
         'gpt-5-nano', 'openai-standard-2026-07-15', 200, 112, 'committed')`,
      [reservationId, userId, accountId, uploadId],
    );
    await pool.query(
      `INSERT INTO ai_usage_events (
         reservation_id, user_id, account_id, upload_id, operation, provider,
         model, pricing_version, provider_request_id, attempt_status,
         latency_ms, input_tokens, cached_input_tokens, output_tokens,
         reasoning_tokens, total_tokens, reserved_cost_microusd,
         final_cost_microusd, usage_source, request_started_at
       ) VALUES ($1, $2, $3, $4, 'transaction_classification', 'openai',
         'gpt-5-nano', 'openai-standard-2026-07-15', $5, 'succeeded',
         25, 1000, 400, 200, 75, 1200, 200, 112, 'actual', clock_timestamp())`,
      [reservationId, userId, accountId, uploadId, `req-${suffix}`],
    );
    await pool.query(
      `INSERT INTO ai_budget_buckets (
         scope, user_id, period, period_start, configured_limit_microusd,
         reserved_cost_microusd, committed_cost_microusd
       ) VALUES
         ('app', NULL, 'day', $2, 500000, 0, 112),
         ('user', $1, 'day', $2, 50000, 0, 112)`,
      [userId, periodDate],
    );

    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const event = await pool.query<{
      user_id: number | null;
      account_id: number | null;
      upload_id: number | null;
      final_cost_microusd: string;
    }>(
      `SELECT user_id, account_id, upload_id, final_cost_microusd
       FROM ai_usage_events WHERE reservation_id = $1`,
      [reservationId],
    );
    expect(event.rows[0]).toEqual({
      user_id: null,
      account_id: null,
      upload_id: null,
      final_cost_microusd: "112",
    });

    const buckets = await pool.query<{ scope: string }>(
      `SELECT scope FROM ai_budget_buckets
       WHERE period_start = $1 AND committed_cost_microusd = 112
       ORDER BY scope`,
      [periodDate],
    );
    expect(buckets.rows).toEqual([{ scope: "app" }]);
  });

  it("rejects mutation or deletion of finalized usage events", async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const reservationId = `immutable-${suffix}`;
    await pool.query(
      `INSERT INTO ai_budget_reservations (
         id, operation, provider, model, pricing_version,
         reserved_cost_microusd, final_cost_microusd, status
       ) VALUES ($1, 'csv_format_detection', 'openai', 'gpt-5-nano',
         'openai-standard-2026-07-15', 10, 0, 'released')`,
      [reservationId],
    );
    await pool.query(
      `INSERT INTO ai_usage_events (
         reservation_id, operation, provider, model, pricing_version,
         attempt_status, input_tokens, cached_input_tokens, output_tokens,
         reasoning_tokens, total_tokens, reserved_cost_microusd,
         final_cost_microusd, usage_source, request_started_at
       ) VALUES ($1, 'csv_format_detection', 'openai', 'gpt-5-nano',
         'openai-standard-2026-07-15', 'released', 0, 0, 0, 0, 0, 10, 0,
         'estimated', clock_timestamp())`,
      [reservationId],
    );

    await expect(
      pool.query(
        `UPDATE ai_usage_events SET final_cost_microusd = 1
         WHERE reservation_id = $1`,
        [reservationId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      pool.query(`DELETE FROM ai_usage_events WHERE reservation_id = $1`, [
        reservationId,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("rejects direct attribution erasure while permitting referential deletion", async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'Immutable Attribution') RETURNING id`,
      [`immutable-attribution-${suffix}@example.test`],
    );
    const userId = user.rows[0]!.id;
    const reservationId = `immutable-attribution-${suffix}`;
    await pool.query(
      `INSERT INTO ai_budget_reservations (
         id, user_id, operation, provider, model, pricing_version,
         reserved_cost_microusd, final_cost_microusd, status
       ) VALUES ($1, $2, 'csv_format_detection', 'openai', 'gpt-5-nano',
         'openai-standard-2026-07-15', 10, 0, 'released')`,
      [reservationId, userId],
    );
    await pool.query(
      `INSERT INTO ai_usage_events (
         reservation_id, user_id, operation, provider, model, pricing_version,
         attempt_status, reserved_cost_microusd, final_cost_microusd,
         usage_source, request_started_at
       ) VALUES ($1, $2, 'csv_format_detection', 'openai', 'gpt-5-nano',
         'openai-standard-2026-07-15', 'released', 10, 0, 'estimated',
         clock_timestamp())`,
      [reservationId, userId],
    );

    await expect(
      pool.query(`UPDATE ai_usage_events SET user_id = NULL WHERE reservation_id = $1`, [
        reservationId,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    const event = await pool.query<{ user_id: number | null }>(
      `SELECT user_id FROM ai_usage_events WHERE reservation_id = $1`,
      [reservationId],
    );
    expect(event.rows[0]!.user_id).toBeNull();
  });

  it("enforces non-negative budget accounting", async () => {
    await expect(
      pool.query(
        `INSERT INTO ai_budget_buckets (
           scope, period, period_start, configured_limit_microusd,
           reserved_cost_microusd, committed_cost_microusd
         ) VALUES ('app', 'month', DATE '2099-01-01', 500000, -1, 0)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
