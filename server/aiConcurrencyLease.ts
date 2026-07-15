import { randomUUID } from "node:crypto";

import { pool } from "./db.js";

export type AcquireAiConcurrencyLeaseInput = {
  holderKey: string;
};

/** Fixed application semaphore; callers cannot raise capacity or shorten TTL. */
export const AI_PROVIDER_MAX_CONCURRENT = 2;
export const AI_PROVIDER_LEASE_TTL_MS = 50_000;

export type AcquireAiConcurrencyLeaseResult = {
  acquired: boolean;
  leaseId: string | null;
  expiresAt: Date | null;
  alreadyHeld: boolean;
};

function validateKey(value: string, field: string): void {
  if (value.trim() === "" || value.length > 160) {
    throw new RangeError(`${field} must be non-empty and at most 160 characters`);
  }
}

export async function acquireAiConcurrencyLease(
  input: AcquireAiConcurrencyLeaseInput,
): Promise<AcquireAiConcurrencyLeaseResult> {
  validateKey(input.holderKey, "holderKey");
  const leaseId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Table locking is deliberate: every Vercel instance serializes the short
    // delete/count/insert decision, making the semaphore globally atomic.
    await client.query("LOCK TABLE ai_concurrency_leases IN EXCLUSIVE MODE");
    const clock = await client.query<{ now: Date }>(
      `SELECT clock_timestamp() AS now`,
    );
    const now = clock.rows[0]!.now;
    const expiresAt = new Date(now.getTime() + AI_PROVIDER_LEASE_TTL_MS);
    await client.query(
      `DELETE FROM ai_concurrency_leases WHERE expires_at <= $1`,
      [now],
    );

    const existing = await client.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM ai_concurrency_leases WHERE holder_key = $1`,
      [input.holderKey],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      await client.query("COMMIT");
      return {
        acquired: false,
        leaseId: row.id,
        expiresAt: row.expires_at,
        alreadyHeld: true,
      };
    }

    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_concurrency_leases`,
    );
    if (Number(count.rows[0]!.count) >= AI_PROVIDER_MAX_CONCURRENT) {
      await client.query("COMMIT");
      return {
        acquired: false,
        leaseId: null,
        expiresAt: null,
        alreadyHeld: false,
      };
    }

    await client.query(
      `INSERT INTO ai_concurrency_leases
         (id, holder_key, acquired_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [leaseId, input.holderKey, now, expiresAt],
    );
    await client.query("COMMIT");
    return {
      acquired: true,
      leaseId,
      expiresAt,
      alreadyHeld: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseAiConcurrencyLease(input: {
  leaseId: string;
  holderKey: string;
}): Promise<boolean> {
  validateKey(input.leaseId, "leaseId");
  validateKey(input.holderKey, "holderKey");
  const result = await pool.query(
    `DELETE FROM ai_concurrency_leases
     WHERE id = $1 AND holder_key = $2
     RETURNING id`,
    [input.leaseId, input.holderKey],
  );
  return result.rows.length === 1;
}
