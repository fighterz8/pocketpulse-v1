import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("AI usage aggregate queries", () => {
  let pool: pg.Pool;
  let accounting: typeof import("./aiAccounting.js");
  let queries: typeof import("./aiUsageQueries.js");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    accounting = await import("./aiAccounting.js");
    queries = await import("./aiUsageQueries.js");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createOwner(label: string) {
    const suffix = `${Date.now()}-${Math.random()}`;
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'Usage Owner') RETURNING id`,
      [`${label}-${suffix}@example.test`],
    );
    const userId = user.rows[0]!.id;
    const account = await pool.query<{ id: number }>(
      `INSERT INTO accounts (user_id, label) VALUES ($1, 'Checking') RETURNING id`,
      [userId],
    );
    const accountId = account.rows[0]!.id;
    const upload = await pool.query<{ id: number }>(
      `INSERT INTO uploads (user_id, account_id, filename, status)
       VALUES ($1, $2, 'usage.csv', 'complete') RETURNING id`,
      [userId, accountId],
    );
    return { userId, accountId, uploadId: upload.rows[0]!.id };
  }

  async function createJob(owner: Awaited<ReturnType<typeof createOwner>>) {
    const job = await pool.query<{ id: number }>(
      `INSERT INTO ai_enhancement_jobs (
         user_id, upload_id, account_id, kind, status, idempotency_key,
         total_merchants, estimated_max_cost_microusd
       ) VALUES ($1, $2, $3, 'transaction_classification', 'complete', $4, 0, 5000)
       RETURNING id`,
      [owner.userId, owner.uploadId, owner.accountId, `usage-${owner.uploadId}-${Math.random()}`],
    );
    return job.rows[0]!.id;
  }

  it("reconciles app, user, financial-account, upload, and operation totals", async () => {
    const first = await createOwner("first");
    const jobId = await createJob(first);
    const clock = await pool.query<{ now: Date }>(
      `SELECT clock_timestamp() AS now`,
    );
    const now = clock.rows[0]!.now;
    const from = new Date(now.getTime() - 60_000);
    const to = new Date(now.getTime() + 60_000);

    const actualReservation = `summary-actual-${first.userId}`;
    await accounting.reserveAiBudget({
      reservationId: actualReservation,
      ...first,
      jobId,
      operation: "transaction_classification",
      model: "gpt-5-nano",
    });
    await accounting.reconcileAiBudgetReservation({
      reservationId: actualReservation,
      outcome: {
        type: "actual",
        attemptStatus: "succeeded",
        providerRequestId: `req-${actualReservation}`,
        latencyMs: 25,
        usage: {
          inputTokens: 1_000,
          cachedInputTokens: 400,
          uncachedInputTokens: 600,
          outputTokens: 200,
          reasoningOutputTokens: 75,
          totalTokens: 1_200,
        },
      },
    });

    const unknownReservation = `summary-unknown-${first.userId}`;
    await accounting.reserveAiBudget({
      reservationId: unknownReservation,
      ...first,
      jobId,
      operation: "transaction_classification",
      model: "gpt-5-nano",
    });
    await accounting.reconcileAiBudgetReservation({
      reservationId: unknownReservation,
      outcome: { type: "reserved_unknown", errorCode: "PROVIDER_TIMEOUT" },
    });

    const app = await queries.getAiUsageSummary({ from, to, jobId });
    expect(app).toEqual({
      requestCount: 2,
      succeededCount: 1,
      failedCount: 0,
      releasedCount: 0,
      unknownCount: 1,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningTokens: 75,
      totalTokens: 1_200,
      reservedCostMicrousd: 3600,
      finalCostMicrousd: 1912,
      actualCostMicrousd: 112,
      estimatedCostMicrousd: 0,
      reservedUnknownCostMicrousd: 1800,
    });

    const byUser = await queries.getAiUsageSummary({
      from,
      to,
      userId: first.userId,
      jobId,
    });
    const byAccount = await queries.getAiUsageSummary({
      from,
      to,
      accountId: first.accountId,
      jobId,
    });
    const byUpload = await queries.getAiUsageSummary({
      from,
      to,
      uploadId: first.uploadId,
      jobId,
    });
    const byOperation = await queries.getAiUsageSummary({
      from,
      to,
      operation: "transaction_classification",
      jobId,
    });

    for (const summary of [byUser, byAccount, byUpload]) {
      expect(summary.requestCount).toBe(2);
      expect(summary.finalCostMicrousd).toBe(1912);
      expect(summary.totalTokens).toBe(1_200);
    }
    expect(byOperation.requestCount).toBe(2);
    expect(byOperation.finalCostMicrousd).toBe(1912);
    expect(byOperation.totalTokens).toBe(1_200);
  });

  it("attributes time windows to request start rather than later reconciliation", async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const owner = await createOwner("request-time");
    const jobId = await createJob(owner);
    const reservationId = `request-time-${suffix}`;
    const requestStartedAt = new Date("2098-06-30T23:59:59.000Z");
    const finalizedAt = new Date("2098-07-01T00:00:01.000Z");
    await pool.query(
      `INSERT INTO ai_budget_reservations (
         id, job_id, operation, provider, model, pricing_version,
         reserved_cost_microusd, final_cost_microusd, status, created_at,
         reconciled_at
       ) VALUES ($1, $4, 'transaction_classification', 'openai', 'gpt-5-nano',
         'openai-standard-2026-07-15', 440, 0, 'released', $2, $3)`,
      [reservationId, requestStartedAt, finalizedAt, jobId],
    );
    await pool.query(
      `INSERT INTO ai_usage_events (
         reservation_id, job_id, operation, provider, model, pricing_version,
         attempt_status, input_tokens, cached_input_tokens, output_tokens,
         reasoning_tokens, total_tokens, reserved_cost_microusd,
         final_cost_microusd, usage_source, request_started_at, created_at
       ) VALUES ($1, $4, 'transaction_classification', 'openai', 'gpt-5-nano',
         'openai-standard-2026-07-15', 'released', 0, 0, 0, 0, 0, 440, 0,
         'estimated', $2, $3)`,
      [reservationId, requestStartedAt, finalizedAt, jobId],
    );

    const june = await queries.getAiUsageSummary({
      from: new Date("2098-06-01T00:00:00.000Z"),
      to: new Date("2098-07-01T00:00:00.000Z"),
      jobId,
    });
    const july = await queries.getAiUsageSummary({
      from: new Date("2098-07-01T00:00:00.000Z"),
      to: new Date("2098-08-01T00:00:00.000Z"),
      jobId,
    });
    expect(june.requestCount).toBe(1);
    expect(july.requestCount).toBe(0);
  });

  it("rejects invalid date ranges before querying", async () => {
    const at = new Date("2099-01-01T00:00:00.000Z");
    await expect(queries.getAiUsageSummary({ from: at, to: at })).rejects.toThrow(
      /from must be before to/i,
    );
  });
});
