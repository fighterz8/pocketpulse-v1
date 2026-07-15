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

  it("enforces the app-wide limit across concurrent acquisitions", async () => {
    const now = new Date();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        leases.acquireAiConcurrencyLease({
          leaseId: `lease-${index}`,
          holderKey: `holder-${index}`,
          maxConcurrent: 2,
          ttlMs: 45_000,
          now,
        }),
      ),
    );

    expect(attempts.filter((attempt) => attempt.acquired)).toHaveLength(2);
    expect(attempts.filter((attempt) => !attempt.acquired)).toHaveLength(8);
    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ai_concurrency_leases",
    );
    expect(count.rows[0]!.count).toBe("2");
  });

  it("recovers expired leases before enforcing the limit", async () => {
    const now = new Date();
    await leases.acquireAiConcurrencyLease({
      leaseId: "expired-a",
      holderKey: "expired-holder-a",
      maxConcurrent: 2,
      ttlMs: 1_000,
      now,
    });
    await leases.acquireAiConcurrencyLease({
      leaseId: "expired-b",
      holderKey: "expired-holder-b",
      maxConcurrent: 2,
      ttlMs: 1_000,
      now,
    });
    const blocked = await leases.acquireAiConcurrencyLease({
      leaseId: "blocked",
      holderKey: "blocked-holder",
      maxConcurrent: 2,
      ttlMs: 1_000,
      now,
    });
    expect(blocked.acquired).toBe(false);

    const recovered = await leases.acquireAiConcurrencyLease({
      leaseId: "recovered",
      holderKey: "recovered-holder",
      maxConcurrent: 2,
      ttlMs: 1_000,
      now: new Date(now.getTime() + 1_001),
    });
    expect(recovered).toMatchObject({ acquired: true, alreadyHeld: false });
    const rows = await pool.query<{ holder_key: string }>(
      "SELECT holder_key FROM ai_concurrency_leases ORDER BY holder_key",
    );
    expect(rows.rows).toEqual([{ holder_key: "recovered-holder" }]);
  });

  it("is idempotent for the same holder and requires both keys to release", async () => {
    const now = new Date();
    const first = await leases.acquireAiConcurrencyLease({
      leaseId: "same-lease",
      holderKey: "same-holder",
      maxConcurrent: 1,
      ttlMs: 45_000,
      now,
    });
    const second = await leases.acquireAiConcurrencyLease({
      leaseId: "same-lease",
      holderKey: "same-holder",
      maxConcurrent: 1,
      ttlMs: 45_000,
      now: new Date(now.getTime() + 10),
    });
    expect(first).toMatchObject({ acquired: true, alreadyHeld: false });
    expect(second).toMatchObject({ acquired: true, alreadyHeld: true });

    expect(
      await leases.releaseAiConcurrencyLease({
        leaseId: "wrong-lease",
        holderKey: "same-holder",
      }),
    ).toBe(false);
    expect(
      await leases.releaseAiConcurrencyLease({
        leaseId: "same-lease",
        holderKey: "same-holder",
      }),
    ).toBe(true);
  });
});
