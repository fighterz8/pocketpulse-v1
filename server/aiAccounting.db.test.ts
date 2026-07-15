import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("AI budget accounting", () => {
  let pool: pg.Pool;
  let accounting: typeof import("./aiAccounting.js");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    accounting = await import("./aiAccounting.js");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createUser(label: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'AI Budget Test') RETURNING id`,
      [`${label}-${Date.now()}-${Math.random()}@example.test`],
    );
    return result.rows[0]!.id;
  }

  function uniqueAccountingDate(): Date {
    const year = 2200 + Math.floor(Math.random() * 7000);
    const month = Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 25);
    return new Date(Date.UTC(year, month, day, 12));
  }

  function periodStarts(now: Date): [string, string] {
    const iso = now.toISOString();
    return [iso.slice(0, 10), `${iso.slice(0, 7)}-01`];
  }

  it("atomically prevents concurrent reservations from overspending", async () => {
    const userId = await createUser("concurrent");
    const now = uniqueAccountingDate();
    const limits = {
      userDayMicrousd: 100,
      userMonthMicrousd: 100,
      appDayMicrousd: 100,
      appMonthMicrousd: 100,
    };

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        accounting.reserveAiBudget({
          reservationId: `concurrent-${userId}-${index}`,
          userId,
          operation: "transaction_classification",
          provider: "openai",
          model: "gpt-5-nano",
          pricingVersion: "openai-standard-2026-07-15",
          reservedCostMicrousd: 20,
          limits,
          now,
        }),
      ),
    );

    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
        accounting.AiBudgetExceededError,
      );
    }

    const buckets = await pool.query<{
      reserved: string;
      committed: string;
    }>(
      `SELECT reserved_cost_microusd AS reserved,
              committed_cost_microusd AS committed
       FROM ai_budget_buckets
       WHERE period_start = ANY($1::date[])
         AND (scope = 'app' OR user_id = $2)
       ORDER BY scope, period`,
      [periodStarts(now), userId],
    );
    expect(buckets.rows).toHaveLength(4);
    expect(buckets.rows).toEqual(
      Array.from({ length: 4 }, () => ({ reserved: "100", committed: "0" })),
    );
  });

  it("rolls every scope back when any budget scope rejects", async () => {
    const userId = await createUser("rollback");

    const now = uniqueAccountingDate();
    await expect(
      accounting.reserveAiBudget({
        reservationId: `rollback-${userId}`,
        userId,
        operation: "transaction_classification",
        provider: "openai",
        model: "gpt-5-nano",
        pricingVersion: "openai-standard-2026-07-15",
        reservedCostMicrousd: 20,
        limits: {
          userDayMicrousd: 10,
          userMonthMicrousd: 10,
          appDayMicrousd: 1_000,
          appMonthMicrousd: 1_000,
        },
        now,
      }),
    ).rejects.toBeInstanceOf(accounting.AiBudgetExceededError);

    const result = await pool.query<{ reserved: string }>(
      `SELECT COALESCE(SUM(reserved_cost_microusd), 0)::text AS reserved
       FROM ai_budget_buckets
       WHERE period_start = ANY($1::date[])
         AND (scope = 'app' OR user_id = $2)`,
      [periodStarts(now), userId],
    );
    expect(result.rows[0]!.reserved).toBe("0");
  });

  it("rejects financial-account attribution owned by another user", async () => {
    const userId = await createUser("owner");
    const otherUserId = await createUser("other-owner");
    const account = await pool.query<{ id: number }>(
      `INSERT INTO accounts (user_id, label) VALUES ($1, 'Other Account') RETURNING id`,
      [otherUserId],
    );

    await expect(
      accounting.reserveAiBudget({
        reservationId: `wrong-owner-${userId}`,
        userId,
        accountId: account.rows[0]!.id,
        operation: "transaction_classification",
        provider: "openai",
        model: "gpt-5-nano",
        pricingVersion: "openai-standard-2026-07-15",
        reservedCostMicrousd: 20,
        limits: {
          userDayMicrousd: 100,
          userMonthMicrousd: 100,
          appDayMicrousd: 100,
          appMonthMicrousd: 100,
        },
        now: uniqueAccountingDate(),
      }),
    ).rejects.toBeInstanceOf(accounting.AiAttributionMismatchError);
  });

  it("reconciles actual usage exactly and is idempotent", async () => {
    const userId = await createUser("actual");
    const reservationId = `actual-${userId}`;
    const now = uniqueAccountingDate();
    const limits = {
      userDayMicrousd: 1_000,
      userMonthMicrousd: 1_000,
      appDayMicrousd: 1_000,
      appMonthMicrousd: 1_000,
    };
    await accounting.reserveAiBudget({
      reservationId,
      userId,
      operation: "transaction_classification",
      provider: "openai",
      model: "gpt-5-nano",
      pricingVersion: "openai-standard-2026-07-15",
      reservedCostMicrousd: 200,
      limits,
      now,
    });

    const first = await accounting.reconcileAiBudgetReservation({
      reservationId,
      outcome: {
        type: "actual",
        attemptStatus: "succeeded",
        providerRequestId: `req-${reservationId}`,
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
    const second = await accounting.reconcileAiBudgetReservation({
      reservationId,
      outcome: { type: "reserved_unknown", errorCode: "SHOULD_NOT_REPLACE" },
      now: new Date(now.getTime() + 2_000),
    });

    expect(first).toMatchObject({
      status: "committed",
      finalCostMicrousd: 112,
      alreadyReconciled: false,
    });
    expect(second).toMatchObject({
      status: "committed",
      finalCostMicrousd: 112,
      alreadyReconciled: true,
    });

    const buckets = await pool.query<{ reserved: string; committed: string }>(
      `SELECT reserved_cost_microusd AS reserved,
              committed_cost_microusd AS committed
       FROM ai_budget_buckets
       WHERE period_start = ANY($1::date[])
         AND (scope = 'app' OR user_id = $2)
       ORDER BY scope, period`,
      [periodStarts(now), userId],
    );
    expect(buckets.rows).toEqual(
      Array.from({ length: 4 }, () => ({ reserved: "0", committed: "112" })),
    );
    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_usage_events
       WHERE reservation_id = $1`,
      [reservationId],
    );
    expect(events.rows[0]!.count).toBe("1");
  });

  it("conservatively commits the full reservation when billing is unknown", async () => {
    const userId = await createUser("unknown");
    const reservationId = `unknown-${userId}`;
    const now = uniqueAccountingDate();
    await accounting.reserveAiBudget({
      reservationId,
      userId,
      operation: "csv_format_detection",
      provider: "openai",
      model: "gpt-5-nano",
      pricingVersion: "openai-standard-2026-07-15",
      reservedCostMicrousd: 75,
      limits: {
        userDayMicrousd: 500,
        userMonthMicrousd: 500,
        appDayMicrousd: 500,
        appMonthMicrousd: 500,
      },
      now,
    });

    const result = await accounting.reconcileAiBudgetReservation({
      reservationId,
      outcome: { type: "reserved_unknown", errorCode: "PROVIDER_TIMEOUT" },
      now: new Date(now.getTime() + 60_000),
    });

    expect(result).toMatchObject({
      status: "reserved_unknown",
      finalCostMicrousd: 75,
    });
    const event = await pool.query<{
      source: string;
      final_cost: string;
      error_code: string;
    }>(
      `SELECT usage_source AS source, final_cost_microusd AS final_cost,
              error_code
       FROM ai_usage_events WHERE reservation_id = $1`,
      [reservationId],
    );
    expect(event.rows[0]).toEqual({
      source: "reserved_unknown",
      final_cost: "75",
      error_code: "PROVIDER_TIMEOUT",
    });
  });
});
