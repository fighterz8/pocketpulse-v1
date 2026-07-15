import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("AI provider concurrency leases", () => {
  let pool: pg.Pool;
  let leases: typeof import("./aiConcurrencyLease.js");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    leases = await import("./aiConcurrencyLease.js");
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE ai_concurrency_leases");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enforces the fixed app-wide limit across concurrent acquisitions", async () => {
    expect(leases.AI_PROVIDER_MAX_CONCURRENT).toBe(2);
    expect(leases.AI_PROVIDER_LEASE_TTL_MS).toBeGreaterThan(40_000);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        leases.acquireAiConcurrencyLease({ holderKey: `holder-${index}` }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.acquired)).toHaveLength(2);
    expect(attempts.filter((attempt) => !attempt.acquired)).toHaveLength(8);
  });

  it("recovers expired leases using the database clock", async () => {
    await pool.query(
      `INSERT INTO ai_concurrency_leases (id, holder_key, acquired_at, expires_at)
       VALUES
         ('expired-a', 'expired-holder-a', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute'),
         ('expired-b', 'expired-holder-b', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute')`,
    );
    const recovered = await leases.acquireAiConcurrencyLease({
      holderKey: "recovered-holder",
    });
    expect(recovered).toMatchObject({ acquired: true, alreadyHeld: false });
    const rows = await pool.query<{ holder_key: string }>(
      "SELECT holder_key FROM ai_concurrency_leases ORDER BY holder_key",
    );
    expect(rows.rows).toEqual([{ holder_key: "recovered-holder" }]);
  });

  it("is idempotent for a live holder and requires its generated lease ID to release", async () => {
    const first = await leases.acquireAiConcurrencyLease({ holderKey: "same-holder" });
    const second = await leases.acquireAiConcurrencyLease({ holderKey: "same-holder" });
    expect(first).toMatchObject({ acquired: true, alreadyHeld: false });
    expect(second).toMatchObject({
      acquired: false,
      alreadyHeld: true,
      leaseId: first.leaseId,
    });

    expect(
      await leases.releaseAiConcurrencyLease({
        leaseId: "wrong-generation",
        holderKey: "same-holder",
      }),
    ).toBe(false);
    expect(
      await leases.releaseAiConcurrencyLease({
        leaseId: first.leaseId!,
        holderKey: "same-holder",
      }),
    ).toBe(true);
  });

  it("prevents a stale release from deleting a replacement lease", async () => {
    const first = await leases.acquireAiConcurrencyLease({ holderKey: "aba-holder" });
    await pool.query(
      `UPDATE ai_concurrency_leases SET expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [first.leaseId],
    );
    const replacement = await leases.acquireAiConcurrencyLease({
      holderKey: "aba-holder",
    });
    expect(replacement.leaseId).not.toBe(first.leaseId);
    expect(
      await leases.releaseAiConcurrencyLease({
        leaseId: first.leaseId!,
        holderKey: "aba-holder",
      }),
    ).toBe(false);
    const live = await pool.query<{ id: string }>(
      `SELECT id FROM ai_concurrency_leases WHERE holder_key = 'aba-holder'`,
    );
    expect(live.rows[0]!.id).toBe(replacement.leaseId);
  });
});
