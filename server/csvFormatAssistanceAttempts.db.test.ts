import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("CSV format assistance attempts", () => {
  let pool: pg.Pool;
  let attempts: typeof import("./csvFormatAssistanceAttempts.js");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    attempts = await import("./csvFormatAssistanceAttempts.js");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createUser(label: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'CSV Assistance Test') RETURNING id`,
      [`${label}-${Date.now()}-${Math.random()}@example.test`],
    );
    return result.rows[0]!.id;
  }

  function fingerprint(seed: string): string {
    return seed.padEnd(64, "a").slice(0, 64);
  }

  it("allows only one live claim for the same user and fingerprint", async () => {
    const userId = await createUser("single-claim");
    const headerFingerprint = fingerprint("1");
    const [first, second] = await Promise.all([
      attempts.claimCsvFormatAssistance({ userId, headerFingerprint }),
      attempts.claimCsvFormatAssistance({ userId, headerFingerprint }),
    ]);
    const states = [first.state, second.state].sort();
    expect(states).toEqual(["busy", "claimed"]);
  });

  it("persists a bounded negative-result cooldown without CSV content", async () => {
    const userId = await createUser("cooldown");
    const headerFingerprint = fingerprint("2");
    const claim = await attempts.claimCsvFormatAssistance({
      userId,
      headerFingerprint,
    });
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") return;
    const retryAfter = await attempts.failCsvFormatAssistanceClaim({
      userId,
      headerFingerprint,
      attemptId: claim.attemptId,
      failureCode: "FORMAT_NOT_RECOGNIZED",
    });
    expect(retryAfter?.getTime()).toBeGreaterThan(Date.now());
    const blocked = await attempts.claimCsvFormatAssistance({
      userId,
      headerFingerprint,
    });
    expect(blocked).toMatchObject({
      state: "cooldown",
      failureCode: "FORMAT_NOT_RECOGNIZED",
    });
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'csv_format_assistance_attempts'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(["filename", "content", "sample", "provider_output"]),
    );
  });

  it("returns an attached stale reservation when an expired claim is replaced", async () => {
    const userId = await createUser("stale");
    const headerFingerprint = fingerprint("3");
    const first = await attempts.claimCsvFormatAssistance({ userId, headerFingerprint });
    expect(first.state).toBe("claimed");
    if (first.state !== "claimed") return;
    await pool.query(
      `INSERT INTO ai_budget_reservations (
         id, user_id, operation, provider, model, pricing_version,
         reserved_cost_microusd, status, created_at
       ) VALUES ($1, $2, 'csv_format_detection', 'openai', 'gpt-5-nano',
         'openai-standard-2026-07-15', 100, 'active', clock_timestamp())`,
      [first.attemptId, userId],
    );
    expect(
      await attempts.attachCsvFormatReservation({
        userId,
        headerFingerprint,
        attemptId: first.attemptId,
        reservationId: first.attemptId,
      }),
    ).toBe(true);
    await pool.query(
      `UPDATE csv_format_assistance_attempts
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE user_id = $1 AND header_fingerprint = $2`,
      [userId, headerFingerprint],
    );
    const replacement = await attempts.claimCsvFormatAssistance({
      userId,
      headerFingerprint,
    });
    expect(replacement).toMatchObject({
      state: "claimed",
      staleReservationId: first.attemptId,
    });
  });

  it("atomically promotes a successful spec to the user-scoped cache", async () => {
    const userId = await createUser("success");
    const otherUserId = await createUser("success-other");
    const headerFingerprint = fingerprint("4");
    const claim = await attempts.claimCsvFormatAssistance({ userId, headerFingerprint });
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") return;
    expect(
      await attempts.completeCsvFormatAssistanceClaim({
        userId,
        headerFingerprint,
        attemptId: claim.attemptId,
        spec: {
          preambleRows: 0,
          hasHeader: true,
          dateColumn: 0,
          descriptionColumn: 1,
          amountColumn: 2,
          debitColumn: null,
          creditColumn: null,
          typeColumn: null,
          signConvention: "signed",
        },
      }),
    ).toBe(true);
    const cached = await pool.query<{ user_id: number }>(
      `SELECT user_id FROM csv_format_specs WHERE header_fingerprint = $1`,
      [headerFingerprint],
    );
    expect(cached.rows).toEqual([{ user_id: userId }]);
    expect(cached.rows.some((row) => row.user_id === otherUserId)).toBe(false);
    const active = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM csv_format_assistance_attempts
       WHERE user_id = $1 AND header_fingerprint = $2`,
      [userId, headerFingerprint],
    );
    expect(active.rows[0]!.count).toBe("0");
  });
});
