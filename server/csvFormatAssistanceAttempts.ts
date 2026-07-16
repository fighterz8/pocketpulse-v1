import { randomUUID } from "node:crypto";

import type { CsvFormatSpec } from "../shared/schema.js";
import { pool } from "./db.js";

export const CSV_FORMAT_ATTEMPT_LEASE_MS = 60_000;
export const CSV_FORMAT_NEGATIVE_COOLDOWN_MS = 15 * 60_000;

export type ClaimCsvFormatAssistanceResult =
  | {
      state: "claimed";
      attemptId: string;
      leaseExpiresAt: Date;
      staleReservationId: string | null;
    }
  | { state: "busy"; retryAfter: Date }
  | { state: "cooldown"; retryAfter: Date; failureCode: string };

type AttemptRow = {
  attempt_id: string;
  reservation_id: string | null;
  status: "in_progress" | "failed";
  lease_expires_at: Date | null;
  retry_after: Date | null;
  failure_code: string | null;
};

function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function assertFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError("headerFingerprint must be a lowercase SHA-256 hex digest");
  }
}

function assertAttemptId(value: string): void {
  if (value.trim() === "" || value.length > 128) {
    throw new RangeError("attemptId must be non-empty and at most 128 characters");
  }
}

function assertFailureCode(value: string): void {
  if (!/^[A-Z0-9_]{1,64}$/.test(value)) {
    throw new RangeError("failureCode must be a bounded machine-readable identifier");
  }
}

export async function claimCsvFormatAssistance(input: {
  userId: number;
  headerFingerprint: string;
}): Promise<ClaimCsvFormatAssistanceResult> {
  assertPositiveId(input.userId, "userId");
  assertFingerprint(input.headerFingerprint);
  const attemptId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const clock = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const now = clock.rows[0]!.now;
    const leaseExpiresAt = new Date(now.getTime() + CSV_FORMAT_ATTEMPT_LEASE_MS);
    const inserted = await client.query(
      `INSERT INTO csv_format_assistance_attempts (
         user_id, header_fingerprint, attempt_id, status, lease_expires_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'in_progress', $4, $5, $5)
       ON CONFLICT (user_id, header_fingerprint) DO NOTHING
       RETURNING id`,
      [input.userId, input.headerFingerprint, attemptId, leaseExpiresAt, now],
    );
    if (inserted.rows.length === 1) {
      await client.query("COMMIT");
      return {
        state: "claimed",
        attemptId,
        leaseExpiresAt,
        staleReservationId: null,
      };
    }

    const selected = await client.query<AttemptRow>(
      `SELECT attempt_id, reservation_id, status, lease_expires_at,
              retry_after, failure_code
       FROM csv_format_assistance_attempts
       WHERE user_id = $1 AND header_fingerprint = $2
       FOR UPDATE`,
      [input.userId, input.headerFingerprint],
    );
    const existing = selected.rows[0];
    if (!existing) throw new Error("CSV format assistance claim disappeared");
    if (
      existing.status === "in_progress" &&
      existing.lease_expires_at &&
      existing.lease_expires_at > now
    ) {
      await client.query("COMMIT");
      return { state: "busy", retryAfter: existing.lease_expires_at };
    }
    if (
      existing.status === "failed" &&
      existing.retry_after &&
      existing.retry_after > now
    ) {
      await client.query("COMMIT");
      return {
        state: "cooldown",
        retryAfter: existing.retry_after,
        failureCode: existing.failure_code ?? "FORMAT_NOT_RECOGNIZED",
      };
    }

    const staleReservationId =
      existing.status === "in_progress" ? existing.reservation_id : null;
    await client.query(
      `UPDATE csv_format_assistance_attempts
       SET attempt_id = $3, reservation_id = NULL, status = 'in_progress',
           lease_expires_at = $4, retry_after = NULL, failure_code = NULL,
           updated_at = $5
       WHERE user_id = $1 AND header_fingerprint = $2`,
      [input.userId, input.headerFingerprint, attemptId, leaseExpiresAt, now],
    );
    await client.query("COMMIT");
    return {
      state: "claimed",
      attemptId,
      leaseExpiresAt,
      staleReservationId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function attachCsvFormatReservation(input: {
  userId: number;
  headerFingerprint: string;
  attemptId: string;
  reservationId: string;
}): Promise<boolean> {
  assertPositiveId(input.userId, "userId");
  assertFingerprint(input.headerFingerprint);
  assertAttemptId(input.attemptId);
  assertAttemptId(input.reservationId);
  const result = await pool.query(
    `UPDATE csv_format_assistance_attempts
     SET reservation_id = $4, updated_at = clock_timestamp()
     WHERE user_id = $1 AND header_fingerprint = $2 AND attempt_id = $3
       AND status = 'in_progress' AND lease_expires_at > clock_timestamp()
     RETURNING id`,
    [input.userId, input.headerFingerprint, input.attemptId, input.reservationId],
  );
  return result.rows.length === 1;
}

export async function releaseCsvFormatAssistanceClaim(input: {
  userId: number;
  headerFingerprint: string;
  attemptId: string;
}): Promise<boolean> {
  assertPositiveId(input.userId, "userId");
  assertFingerprint(input.headerFingerprint);
  assertAttemptId(input.attemptId);
  const result = await pool.query(
    `DELETE FROM csv_format_assistance_attempts
     WHERE user_id = $1 AND header_fingerprint = $2 AND attempt_id = $3
     RETURNING id`,
    [input.userId, input.headerFingerprint, input.attemptId],
  );
  return result.rows.length === 1;
}

export async function failCsvFormatAssistanceClaim(input: {
  userId: number;
  headerFingerprint: string;
  attemptId: string;
  failureCode: string;
}): Promise<Date | null> {
  assertPositiveId(input.userId, "userId");
  assertFingerprint(input.headerFingerprint);
  assertAttemptId(input.attemptId);
  assertFailureCode(input.failureCode);
  const result = await pool.query<{ retry_after: Date }>(
    `UPDATE csv_format_assistance_attempts
     SET status = 'failed', lease_expires_at = NULL,
         retry_after = clock_timestamp() + ($5::integer * interval '1 millisecond'),
         failure_code = $4, updated_at = clock_timestamp()
     WHERE user_id = $1 AND header_fingerprint = $2 AND attempt_id = $3
       AND status = 'in_progress'
     RETURNING retry_after`,
    [
      input.userId,
      input.headerFingerprint,
      input.attemptId,
      input.failureCode,
      CSV_FORMAT_NEGATIVE_COOLDOWN_MS,
    ],
  );
  return result.rows[0]?.retry_after ?? null;
}

export async function completeCsvFormatAssistanceClaim(input: {
  userId: number;
  headerFingerprint: string;
  attemptId: string;
  spec: CsvFormatSpec;
}): Promise<boolean> {
  assertPositiveId(input.userId, "userId");
  assertFingerprint(input.headerFingerprint);
  assertAttemptId(input.attemptId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `SELECT id FROM csv_format_assistance_attempts
       WHERE user_id = $1 AND header_fingerprint = $2 AND attempt_id = $3
         AND status = 'in_progress'
       FOR UPDATE`,
      [input.userId, input.headerFingerprint, input.attemptId],
    );
    if (claimed.rows.length === 0) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `INSERT INTO csv_format_specs (user_id, header_fingerprint, spec, source)
       VALUES ($1, $2, $3::json, 'ai')
       ON CONFLICT (user_id, header_fingerprint)
       DO UPDATE SET spec = EXCLUDED.spec, source = 'ai'`,
      [input.userId, input.headerFingerprint, JSON.stringify(input.spec)],
    );
    await client.query(
      `DELETE FROM csv_format_assistance_attempts
       WHERE user_id = $1 AND header_fingerprint = $2 AND attempt_id = $3`,
      [input.userId, input.headerFingerprint, input.attemptId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
