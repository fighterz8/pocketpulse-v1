import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("AI budget accounting", () => {
  let pool: pg.Pool;
  let accounting: typeof import("./aiAccounting.js");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 36 });
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

  function reservationInput(
    reservationId: string,
    userId: number,
    operation: "transaction_classification" | "csv_format_detection" =
      "transaction_classification",
  ) {
    return {
      reservationId,
      userId,
      operation,
      model: "gpt-5-nano",
    } as const;
  }

  it("atomically prevents concurrent reservations from overspending", async () => {
    const userId = await createUser("concurrent");
    const attempts = await Promise.allSettled(
      Array.from({ length: 28 }, (_, index) =>
        accounting.reserveAiBudget(
          reservationInput(`concurrent-${userId}-${index}`, userId),
        ),
      ),
    );

    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(27);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      accounting.AiBudgetExceededError,
    );

    const buckets = await pool.query<{ reserved: string }>(
      `SELECT reserved_cost_microusd AS reserved
       FROM ai_budget_buckets
       WHERE scope = 'user' AND user_id = $1
       ORDER BY period`,
      [userId],
    );
    expect(buckets.rows).toEqual([{ reserved: "48600" }, { reserved: "48600" }]);
  });

  it("rolls every scope back when one scope rejects", async () => {
    const userId = await createUser("rollback");
    await pool.query(
      `INSERT INTO ai_budget_buckets (
         scope, user_id, period, period_start, configured_limit_microusd,
         reserved_cost_microusd, committed_cost_microusd
       ) VALUES ('user', $1, 'day', CURRENT_DATE, 50000, 49000, 0)`,
      [userId],
    );

    await expect(
      accounting.reserveAiBudget(reservationInput(`rollback-${userId}`, userId)),
    ).rejects.toBeInstanceOf(accounting.AiBudgetExceededError);

    const reservation = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_budget_reservations WHERE user_id = $1`,
      [userId],
    );
    const buckets = await pool.query<{ period: string; reserved: string }>(
      `SELECT period, reserved_cost_microusd AS reserved
       FROM ai_budget_buckets WHERE scope = 'user' AND user_id = $1`,
      [userId],
    );
    expect(reservation.rows[0]!.count).toBe("0");
    expect(buckets.rows).toEqual([{ period: "day", reserved: "49000" }]);
  });

  it("fails closed for unknown pricing before creating a reservation", async () => {
    const userId = await createUser("unknown-model");
    const reservationId = `unknown-model-${userId}`;
    await expect(
      accounting.reserveAiBudget({
        ...reservationInput(reservationId, userId),
        model: "future-unpriced-model",
      }),
    ).rejects.toThrow(/no reviewed pricing/i);
    const row = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_budget_reservations WHERE id = $1`,
      [reservationId],
    );
    expect(row.rows[0]!.count).toBe("0");
  });

  it("authorizes a reservation ID only once", async () => {
    const userId = await createUser("single-use");
    const reservationId = `single-use-${userId}`;
    await accounting.reserveAiBudget(reservationInput(reservationId, userId));
    await expect(
      accounting.reserveAiBudget(reservationInput(reservationId, userId)),
    ).rejects.toBeInstanceOf(accounting.AiReservationAlreadyExistsError);

    const bucket = await pool.query<{ reserved: string }>(
      `SELECT reserved_cost_microusd AS reserved FROM ai_budget_buckets
       WHERE scope = 'user' AND user_id = $1 AND period = 'day'`,
      [userId],
    );
    expect(bucket.rows[0]!.reserved).toBe("1800");
  });

  it("uses the database clock rather than a caller-supplied timestamp", async () => {
    const userId = await createUser("clock");
    const reservationId = `clock-${userId}`;
    await accounting.reserveAiBudget({
      ...reservationInput(reservationId, userId),
      now: new Date("1999-01-01T00:00:00Z"),
    } as Parameters<typeof accounting.reserveAiBudget>[0]);
    const row = await pool.query<{ recent: boolean }>(
      `SELECT created_at > clock_timestamp() - interval '1 minute' AS recent
       FROM ai_budget_reservations WHERE id = $1`,
      [reservationId],
    );
    expect(row.rows[0]!.recent).toBe(true);
  });

  it("rejects account and upload attribution that does not belong to the user", async () => {
    const userId = await createUser("owner");
    const otherUserId = await createUser("other-owner");
    const otherAccount = await pool.query<{ id: number }>(
      `INSERT INTO accounts (user_id, label) VALUES ($1, 'Other') RETURNING id`,
      [otherUserId],
    );

    await expect(
      accounting.reserveAiBudget({
        ...reservationInput(`wrong-account-${userId}`, userId),
        accountId: otherAccount.rows[0]!.id,
      }),
    ).rejects.toBeInstanceOf(accounting.AiAttributionMismatchError);

    const inconsistentUpload = await pool.query<{ id: number }>(
      `INSERT INTO uploads (user_id, account_id, filename, status)
       VALUES ($1, $2, 'inconsistent.csv', 'complete') RETURNING id`,
      [userId, otherAccount.rows[0]!.id],
    );
    await expect(
      accounting.reserveAiBudget({
        ...reservationInput(`wrong-upload-${userId}`, userId),
        uploadId: inconsistentUpload.rows[0]!.id,
      }),
    ).rejects.toBeInstanceOf(accounting.AiAttributionMismatchError);

    const otherUpload = await pool.query<{ id: number }>(
      `INSERT INTO uploads (user_id, account_id, filename, status)
       VALUES ($1, $2, 'other-owner.csv', 'complete') RETURNING id`,
      [otherUserId, otherAccount.rows[0]!.id],
    );
    const otherJob = await pool.query<{ id: number }>(
      `INSERT INTO ai_enhancement_jobs (
         user_id, upload_id, account_id, kind, status, idempotency_key,
         total_merchants, estimated_max_cost_microusd
       ) VALUES ($1, $2, $3, 'transaction_classification', 'complete', $4, 0, 1800)
       RETURNING id`,
      [
        otherUserId,
        otherUpload.rows[0]!.id,
        otherAccount.rows[0]!.id,
        `other-job-${otherUserId}`,
      ],
    );
    await expect(
      accounting.reserveAiBudget({
        ...reservationInput(`wrong-job-${userId}`, userId),
        jobId: otherJob.rows[0]!.id,
      }),
    ).rejects.toBeInstanceOf(accounting.AiAttributionMismatchError);
  });

  it("reconciles valid actual usage exactly and only once", async () => {
    const userId = await createUser("actual");
    const reservationId = `actual-${userId}`;
    const reservation = await accounting.reserveAiBudget(
      reservationInput(reservationId, userId),
    );
    expect(reservation.reservedCostMicrousd).toBe(1800);

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
    });
    const second = await accounting.reconcileAiBudgetReservation({
      reservationId,
      outcome: { type: "reserved_unknown", errorCode: "SHOULD_NOT_REPLACE" },
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
       WHERE scope = 'user' AND user_id = $1 ORDER BY period`,
      [userId],
    );
    expect(buckets.rows).toEqual([
      { reserved: "0", committed: "112" },
      { reserved: "0", committed: "112" },
    ]);
  });

  it("rejects internally inconsistent usage without mutating the reservation", async () => {
    const userId = await createUser("invalid-usage");
    const reservationId = `invalid-usage-${userId}`;
    await accounting.reserveAiBudget(reservationInput(reservationId, userId));

    await expect(
      accounting.reconcileAiBudgetReservation({
        reservationId,
        outcome: {
          type: "actual",
          attemptStatus: "succeeded",
          usage: {
            inputTokens: 1_000_000,
            cachedInputTokens: 0,
            uncachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 1_000_000,
          },
        },
      }),
    ).rejects.toThrow(/uncached input tokens/i);

    const row = await pool.query<{ status: string; events: string }>(
      `SELECT r.status,
              (SELECT COUNT(*) FROM ai_usage_events e WHERE e.reservation_id = r.id)::text AS events
       FROM ai_budget_reservations r WHERE r.id = $1`,
      [reservationId],
    );
    expect(row.rows[0]).toEqual({ status: "active", events: "0" });
  });

  it("rejects provider usage above the reserved operation ceiling", async () => {
    const userId = await createUser("over-ceiling");
    const reservationId = `over-ceiling-${userId}`;
    await accounting.reserveAiBudget(reservationInput(reservationId, userId));
    await expect(
      accounting.reconcileAiBudgetReservation({
        reservationId,
        outcome: {
          type: "actual",
          attemptStatus: "succeeded",
          usage: {
            inputTokens: 20_001,
            cachedInputTokens: 0,
            uncachedInputTokens: 20_001,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 20_001,
          },
        },
      }),
    ).rejects.toBeInstanceOf(accounting.AiAccountingInvariantError);
  });

  it("conservatively commits the full reservation when billing is unknown", async () => {
    const userId = await createUser("unknown");
    const reservationId = `unknown-${userId}`;
    const reservation = await accounting.reserveAiBudget(
      reservationInput(reservationId, userId, "csv_format_detection"),
    );
    expect(reservation.reservedCostMicrousd).toBe(440);

    const result = await accounting.reconcileAiBudgetReservation({
      reservationId,
      outcome: { type: "reserved_unknown", errorCode: "PROVIDER_TIMEOUT" },
    });
    expect(result).toMatchObject({
      status: "reserved_unknown",
      finalCostMicrousd: 440,
    });
  });

  it("emits each structured app-budget threshold once per period bucket", async () => {
    const userId = await createUser("budget-alerts");
    const originalAppBuckets = await pool.query<{
      period: "day" | "month";
      reserved: string;
      committed: string;
      alerted: number;
    }>(
      `SELECT period, reserved_cost_microusd::text AS reserved,
              committed_cost_microusd::text AS committed,
              alerted_through_percent AS alerted
       FROM ai_budget_buckets
       WHERE scope = 'app' AND period_start IN (
         CURRENT_DATE, date_trunc('month', CURRENT_DATE)::date
       )`,
    );
    await pool.query(
      `INSERT INTO ai_budget_buckets (
         scope, user_id, period, period_start, configured_limit_microusd,
         reserved_cost_microusd, committed_cost_microusd,
         alerted_through_percent
       ) VALUES
         ('app', NULL, 'day', CURRENT_DATE, 500000, 0, 0, 0),
         ('app', NULL, 'month', date_trunc('month', CURRENT_DATE)::date,
           5000000, 0, 0, 0)
       ON CONFLICT (period, period_start) WHERE scope = 'app'
       DO UPDATE SET reserved_cost_microusd = 0, committed_cost_microusd = 0,
         alerted_through_percent = 0`,
    );

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setAppReserved = async (day: number, month: number, level: number) => {
      await pool.query(
        `UPDATE ai_budget_buckets
         SET reserved_cost_microusd = CASE period
           WHEN 'day' THEN $1::bigint ELSE $2::bigint END,
           committed_cost_microusd = 0,
           alerted_through_percent = $3::smallint
         WHERE scope = 'app' AND period_start IN (CURRENT_DATE, date_trunc('month', CURRENT_DATE)::date)`,
        [day, month, level],
      );
    };
    const parsedWarnings = () =>
      warning.mock.calls.map(([message]) => JSON.parse(String(message)));

    try {
      await setAppReserved(248_500, 2_499_000, 0);
      await accounting.reserveAiBudget(
        reservationInput(`budget-alert-50-${userId}`, userId),
      );
      expect(parsedWarnings()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "ai_budget_threshold",
            scope: "app",
            thresholdPercent: 50,
            period: "day",
          }),
          expect.objectContaining({
            event: "ai_budget_threshold",
            scope: "app",
            thresholdPercent: 50,
            period: "month",
          }),
        ]),
      );
      warning.mockClear();

      await accounting.reserveAiBudget(
        reservationInput(`budget-alert-no-repeat-${userId}`, userId),
      );
      expect(warning).not.toHaveBeenCalled();

      await setAppReserved(398_200, 3_998_200, 50);
      await accounting.reserveAiBudget(
        reservationInput(`budget-alert-80-${userId}`, userId),
      );
      expect(parsedWarnings().map((entry) => entry.thresholdPercent)).toEqual([80, 80]);
      warning.mockClear();

      await setAppReserved(498_200, 4_998_200, 80);
      await accounting.reserveAiBudget(
        reservationInput(`budget-alert-100-${userId}`, userId),
      );
      expect(parsedWarnings().map((entry) => entry.thresholdPercent)).toEqual([100, 100]);
      warning.mockClear();

      await pool.query(
        `UPDATE ai_budget_buckets
         SET reserved_cost_microusd = CASE period
           WHEN 'day' THEN 300000::bigint ELSE 4999000::bigint END,
           committed_cost_microusd = 0,
           alerted_through_percent = CASE period
             WHEN 'day' THEN 50::smallint ELSE 80::smallint END
         WHERE scope = 'app' AND period_start IN (CURRENT_DATE, date_trunc('month', CURRENT_DATE)::date)`,
      );
      await expect(
        accounting.reserveAiBudget(
          reservationInput(`budget-alert-blocked-${userId}`, userId),
        ),
      ).rejects.toMatchObject({ scope: "app", period: "month" });
      expect(parsedWarnings()).toEqual([
        expect.objectContaining({
          event: "ai_budget_threshold",
          scope: "app",
          period: "month",
          thresholdPercent: 100,
          blocksNewReservations: true,
        }),
      ]);
      warning.mockClear();
      await expect(
        accounting.reserveAiBudget(
          reservationInput(`budget-alert-blocked-repeat-${userId}`, userId),
        ),
      ).rejects.toMatchObject({ scope: "app", period: "month" });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      for (const period of ["day", "month"] as const) {
        const original = originalAppBuckets.rows.find((row) => row.period === period);
        if (original) {
          await pool.query(
            `UPDATE ai_budget_buckets
             SET reserved_cost_microusd = $1, committed_cost_microusd = $2,
                 alerted_through_percent = $3
             WHERE scope = 'app' AND period = $4
               AND period_start = CASE WHEN $4 = 'day' THEN CURRENT_DATE
                 ELSE date_trunc('month', CURRENT_DATE)::date END`,
            [original.reserved, original.committed, original.alerted, period],
          );
        } else {
          await pool.query(
            `DELETE FROM ai_budget_buckets
             WHERE scope = 'app' AND period = $1
               AND period_start = CASE WHEN $1 = 'day' THEN CURRENT_DATE
                 ELSE date_trunc('month', CURRENT_DATE)::date END`,
            [period],
          );
        }
      }
    }
  });
});
