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

  it("reconciles app, user, financial-account, upload, and operation totals", async () => {
    const first = await createOwner("first");
    const second = await createOwner("second");
    const year = 2300 + Math.floor(Math.random() * 6000);
    const now = new Date(Date.UTC(year, 7, 12, 12));
    const from = new Date(Date.UTC(year, 7, 12));
    const to = new Date(Date.UTC(year, 7, 13));
    const limits = {
      userDayMicrousd: 10_000,
      userMonthMicrousd: 10_000,
      appDayMicrousd: 10_000,
      appMonthMicrousd: 10_000,
    };

    const actualReservation = `summary-actual-${first.userId}`;
    await accounting.reserveAiBudget({
      reservationId: actualReservation,
      ...first,
      operation: "transaction_classification",
      provider: "openai",
      model: "gpt-5-nano",
      pricingVersion: "openai-standard-2026-07-15",
      reservedCostMicrousd: 200,
      limits,
      now,
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
      now: new Date(now.getTime() + 1_000),
    });

    const unknownReservation = `summary-unknown-${second.userId}`;
    await accounting.reserveAiBudget({
      reservationId: unknownReservation,
      ...second,
      operation: "csv_format_detection",
      provider: "openai",
      model: "gpt-5-nano",
      pricingVersion: "openai-standard-2026-07-15",
      reservedCostMicrousd: 75,
      limits,
      now,
    });
    await accounting.reconcileAiBudgetReservation({
      reservationId: unknownReservation,
      outcome: { type: "reserved_unknown", errorCode: "PROVIDER_TIMEOUT" },
      now: new Date(now.getTime() + 2_000),
    });

    const app = await queries.getAiUsageSummary({ from, to });
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
      reservedCostMicrousd: 275,
      finalCostMicrousd: 187,
      actualCostMicrousd: 112,
      estimatedCostMicrousd: 0,
      reservedUnknownCostMicrousd: 75,
    });

    const byUser = await queries.getAiUsageSummary({
      from,
      to,
      userId: first.userId,
    });
    const byAccount = await queries.getAiUsageSummary({
      from,
      to,
      accountId: first.accountId,
    });
    const byUpload = await queries.getAiUsageSummary({
      from,
      to,
      uploadId: first.uploadId,
    });
    const byOperation = await queries.getAiUsageSummary({
      from,
      to,
      operation: "transaction_classification",
    });

    for (const summary of [byUser, byAccount, byUpload, byOperation]) {
      expect(summary.requestCount).toBe(1);
      expect(summary.finalCostMicrousd).toBe(112);
      expect(summary.totalTokens).toBe(1_200);
    }
  });

  it("rejects invalid date ranges before querying", async () => {
    const at = new Date("2099-01-01T00:00:00.000Z");
    await expect(queries.getAiUsageSummary({ from: at, to: at })).rejects.toThrow(
      /from must be before to/i,
    );
  });
});
