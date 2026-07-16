import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("AI enhancement job creation", () => {
  let pool: pg.Pool;
  let jobs: typeof import("./aiEnhancementJobs.js");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 24 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    jobs = await import("./aiEnhancementJobs.js");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createUpload(label: string) {
    const suffix = `${Date.now()}-${Math.random()}`;
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'Enhancement Job Test') RETURNING id`,
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
       VALUES ($1, $2, 'transactions.csv', 'complete') RETURNING id`,
      [userId, accountId],
    );
    return { userId, accountId, uploadId: upload.rows[0]!.id };
  }

  async function addUnresolved(
    owner: Awaited<ReturnType<typeof createUpload>>,
    merchants: string[],
  ) {
    for (let index = 0; index < merchants.length; index += 1) {
      await pool.query(
        `INSERT INTO transactions (
           user_id, upload_id, account_id, date, amount, merchant,
           raw_description, flow_type, transaction_class, category,
           label_source, ai_assisted, user_corrected
         ) VALUES ($1, $2, $3, '2026-07-01', '-12.00', $4, $4,
           'outflow', 'expense', 'other', 'rule', true, false)`,
        [owner.userId, owner.uploadId, owner.accountId, merchants[index]],
      );
    }
  }

  it("creates one idempotent job over unique normalized merchants", async () => {
    const owner = await createUpload("idempotent");
    await addUnresolved(owner, [
      "PYMT*NETFLIX.COM",
      "NETFLIX 8473923",
      "Mystery Merchant A",
    ]);

    const first = await jobs.createAiEnhancementJob({
      userId: owner.userId,
      uploadId: owner.uploadId,
      idempotencyKey: `upload-${owner.uploadId}`,
    });
    const second = await jobs.createAiEnhancementJob({
      userId: owner.userId,
      uploadId: owner.uploadId,
      idempotencyKey: `upload-${owner.uploadId}`,
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      uploadId: owner.uploadId,
      status: "queued",
      totalMerchants: 2,
      completedMerchants: 0,
      skippedMerchants: 0,
      failedMerchants: 0,
    });
    const items = await pool.query<{ merchant_key: string }>(
      `SELECT merchant_key FROM ai_enhancement_job_items
       WHERE job_id = $1 ORDER BY merchant_key`,
      [first.id],
    );
    expect(items.rows).toEqual([
      { merchant_key: "mystery merchant a" },
      { merchant_key: "netflix" },
    ]);
  });

  it("rejects reuse of an idempotency key for a different upload", async () => {
    const owner = await createUpload("mismatch");
    await addUnresolved(owner, ["First Mystery"]);
    const otherUpload = await pool.query<{ id: number }>(
      `INSERT INTO uploads (user_id, account_id, filename, status)
       VALUES ($1, $2, 'other.csv', 'complete') RETURNING id`,
      [owner.userId, owner.accountId],
    );
    await pool.query(
      `INSERT INTO transactions (
         user_id, upload_id, account_id, date, amount, merchant,
         raw_description, flow_type, transaction_class, category,
         label_source, ai_assisted, user_corrected
       ) VALUES ($1, $2, $3, '2026-07-01', '-12.00', 'Second Mystery',
         'Second Mystery', 'outflow', 'expense', 'other', 'rule', true, false)`,
      [owner.userId, otherUpload.rows[0]!.id, owner.accountId],
    );
    const key = `same-key-${owner.userId}`;
    await jobs.createAiEnhancementJob({
      userId: owner.userId,
      uploadId: owner.uploadId,
      idempotencyKey: key,
    });

    await expect(
      jobs.createAiEnhancementJob({
        userId: owner.userId,
        uploadId: otherUpload.rows[0]!.id,
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(jobs.AiEnhancementIdempotencyMismatchError);
  });

  it("allows only one active job per user under concurrent creation", async () => {
    const owner = await createUpload("active-job");
    await addUnresolved(owner, ["Concurrent Mystery"]);

    const attempts = await Promise.allSettled([
      jobs.createAiEnhancementJob({
        userId: owner.userId,
        uploadId: owner.uploadId,
        idempotencyKey: `active-a-${owner.userId}`,
      }),
      jobs.createAiEnhancementJob({
        userId: owner.userId,
        uploadId: owner.uploadId,
        idempotencyKey: `active-b-${owner.userId}`,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(jobs.AiEnhancementActiveJobError);
  });

  it("does not reveal or snapshot another user's upload", async () => {
    const owner = await createUpload("owner");
    const stranger = await createUpload("stranger");
    await addUnresolved(owner, ["Private Mystery"]);

    await expect(
      jobs.createAiEnhancementJob({
        userId: stranger.userId,
        uploadId: owner.uploadId,
        idempotencyKey: `cross-user-${stranger.userId}`,
      }),
    ).rejects.toBeInstanceOf(jobs.AiEnhancementUploadNotFoundError);
  });

  it("claims at most 25 unique merchants and permits only one live batch", async () => {
    const owner = await createUpload("batch-claim");
    await addUnresolved(
      owner,
      Array.from({ length: 30 }, (_, index) => `Unresolved Vendor code${index}x`),
    );
    const job = await jobs.createAiEnhancementJob({
      userId: owner.userId,
      uploadId: owner.uploadId,
      idempotencyKey: `batch-${owner.uploadId}`,
    });

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        jobs.claimAiEnhancementBatch({ userId: owner.userId, jobId: job.id }),
      ),
    );
    const claimed = attempts.filter((attempt) => attempt.state === "claimed");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.items).toHaveLength(25);
    expect(new Set(claimed[0]!.items.map((item) => item.merchantKey)).size).toBe(25);
    expect(attempts.filter((attempt) => attempt.state === "busy")).toHaveLength(7);

    const counts = await pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM ai_enhancement_job_items WHERE job_id = $1
       GROUP BY status ORDER BY status`,
      [job.id],
    );
    expect(counts.rows).toEqual([
      { status: "pending", count: "5" },
      { status: "processing", count: "25" },
    ]);
  });

  it("recovers a pre-authorization expired claim without consuming an attempt", async () => {
    const owner = await createUpload("claim-recovery");
    await addUnresolved(owner, ["Recoverable Vendor"]);
    const job = await jobs.createAiEnhancementJob({
      userId: owner.userId,
      uploadId: owner.uploadId,
      idempotencyKey: `recover-${owner.uploadId}`,
    });
    const first = await jobs.claimAiEnhancementBatch({
      userId: owner.userId,
      jobId: job.id,
    });
    expect(first.state).toBe("claimed");
    await pool.query(
      `UPDATE ai_enhancement_job_items
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE job_id = $1`,
      [job.id],
    );

    const recovered = await jobs.claimAiEnhancementBatch({
      userId: owner.userId,
      jobId: job.id,
    });
    expect(recovered.state).toBe("claimed");
    if (first.state === "claimed" && recovered.state === "claimed") {
      expect(recovered.leaseToken).not.toBe(first.leaseToken);
      expect(recovered.items[0]!.attemptCount).toBe(0);
    }
  });

  it("never reclaims an authorized attempt after its item lease expires", async () => {
    const owner = await createUpload("authorized-expiry");
    await addUnresolved(owner, ["Charged Once Vendor"]);
    const job = await jobs.createAiEnhancementJob({
      userId: owner.userId,
      uploadId: owner.uploadId,
      idempotencyKey: `authorized-${owner.uploadId}`,
    });
    const claim = await jobs.claimAiEnhancementBatch({
      userId: owner.userId,
      jobId: job.id,
    });
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") throw new Error("expected claimed batch");

    const accounting = await import("./aiAccounting.js");
    await accounting.reserveAiBudget({
      reservationId: claim.batchKey,
      userId: owner.userId,
      accountId: owner.accountId,
      uploadId: owner.uploadId,
      jobId: job.id,
      operation: "transaction_classification",
      model: "gpt-5-nano",
    });
    await jobs.attachAiEnhancementReservation({
      userId: owner.userId,
      jobId: job.id,
      batchKey: claim.batchKey,
      leaseToken: claim.leaseToken,
      reservationId: claim.batchKey,
    });
    await pool.query(
      `UPDATE ai_enhancement_job_items
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE job_id = $1`,
      [job.id],
    );

    const recovered = await jobs.claimAiEnhancementBatch({
      userId: owner.userId,
      jobId: job.id,
    });
    expect(recovered.state).toBe("empty");
    expect(recovered.unknownReservationIds).toEqual([claim.batchKey]);
    const item = await pool.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM ai_enhancement_job_items WHERE job_id = $1`,
      [job.id],
    );
    expect(item.rows[0]).toEqual({ status: "failed", attempt_count: 1 });
  });

  it("does not claim future work after cancellation", async () => {
    const owner = await createUpload("cancelled-claim");
    await addUnresolved(owner, ["Cancelled Vendor"]);
    const job = await jobs.createAiEnhancementJob({
      userId: owner.userId,
      uploadId: owner.uploadId,
      idempotencyKey: `cancelled-${owner.uploadId}`,
    });
    await jobs.cancelAiEnhancementJob({ userId: owner.userId, jobId: job.id });

    const claim = await jobs.claimAiEnhancementBatch({
      userId: owner.userId,
      jobId: job.id,
    });
    expect(claim.state).toBe("terminal");
    expect(claim.job.status).toBe("cancelled");
  });
});
