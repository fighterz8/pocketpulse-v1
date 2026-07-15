import { pool } from "./db.js";

export type AcquireAiConcurrencyLeaseInput = {
  leaseId: string;
  holderKey: string;
  maxConcurrent: number;
  ttlMs: number;
  now?: Date;
};

export type AcquireAiConcurrencyLeaseResult = {
  acquired: boolean;
  leaseId: string | null;
  expiresAt: Date | null;
  alreadyHeld: boolean;
};

export class AiConcurrencyLeaseConflictError extends Error {
  readonly code = "AI_CONCURRENCY_LEASE_CONFLICT" as const;

  constructor() {
    super("AI concurrency lease identity conflicts with an existing holder");
    this.name = "AiConcurrencyLeaseConflictError";
  }
}

function validateKey(value: string, field: string): void {
  if (value.trim() === "" || value.length > 160) {
    throw new RangeError(`${field} must be non-empty and at most 160 characters`);
  }
}

function validateDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("now must be a valid Date");
  }
}

export async function acquireAiConcurrencyLease(
  input: AcquireAiConcurrencyLeaseInput,
): Promise<AcquireAiConcurrencyLeaseResult> {
  validateKey(input.leaseId, "leaseId");
  validateKey(input.holderKey, "holderKey");
  if (
    !Number.isSafeInteger(input.maxConcurrent) ||
    input.maxConcurrent < 1 ||
    input.maxConcurrent > 100
  ) {
    throw new RangeError("maxConcurrent must be an integer from 1 through 100");
  }
  if (
    !Number.isSafeInteger(input.ttlMs) ||
    input.ttlMs < 1 ||
    input.ttlMs > 300_000
  ) {
    throw new RangeError("ttlMs must be an integer from 1 through 300000");
  }
  const now = input.now ?? new Date();
  validateDate(now);
  const expiresAt = new Date(now.getTime() + input.ttlMs);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Table locking is deliberate: every Vercel instance serializes the short
    // delete/count/insert decision, making the semaphore globally atomic.
    await client.query("LOCK TABLE ai_concurrency_leases IN EXCLUSIVE MODE");
    await client.query(`DELETE FROM ai_concurrency_leases WHERE expires_at <= $1`, [
      now,
    ]);

    const existing = await client.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM ai_concurrency_leases WHERE holder_key = $1`,
      [input.holderKey],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      if (row.id !== input.leaseId) throw new AiConcurrencyLeaseConflictError();
      await client.query("COMMIT");
      return {
        acquired: true,
        leaseId: row.id,
        expiresAt: row.expires_at,
        alreadyHeld: true,
      };
    }

    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_concurrency_leases`,
    );
    if (Number(count.rows[0]!.count) >= input.maxConcurrent) {
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
      [input.leaseId, input.holderKey, now, expiresAt],
    );
    await client.query("COMMIT");
    return {
      acquired: true,
      leaseId: input.leaseId,
      expiresAt,
      alreadyHeld: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new AiConcurrencyLeaseConflictError();
    }
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
