import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { OpenAiChatTransport } from "./openaiProvider.js";
import type { AiEnhancementLeaseProvider } from "./aiEnhancementProcessor.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("AI enhancement batch processor", () => {
  let pool: pg.Pool;
  let jobs: typeof import("./aiEnhancementJobs.js");
  let processor: typeof import("./aiEnhancementProcessor.js");
  const availableLeases: AiEnhancementLeaseProvider = {
    acquire: vi.fn(async () => ({
      acquired: true,
      leaseId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 50_000),
      alreadyHeld: false,
    })),
    release: vi.fn(async () => true),
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 24 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    jobs = await import("./aiEnhancementJobs.js");
    processor = await import("./aiEnhancementProcessor.js");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function fixture(label: string, merchants: string[]) {
    const suffix = `${Date.now()}-${Math.random()}`;
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, 'hash', 'Processor Test') RETURNING id`,
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
    const uploadId = upload.rows[0]!.id;
    for (const merchant of merchants) {
      await pool.query(
        `INSERT INTO transactions (
           user_id, upload_id, account_id, date, amount, merchant,
           raw_description, flow_type, transaction_class, category,
           label_source, ai_assisted, user_corrected
         ) VALUES ($1, $2, $3, '2026-07-01', '-12.00', $4, $4,
           'outflow', 'expense', 'other', 'rule', true, false)`,
        [userId, uploadId, accountId, merchant],
      );
    }
    const job = await jobs.createAiEnhancementJob({
      userId,
      uploadId,
      idempotencyKey: `processor-${uploadId}`,
    });
    return { userId, accountId, uploadId, job };
  }

  function successfulTransport(): OpenAiChatTransport {
    return vi.fn(async (body) => {
      const userMessage = JSON.parse(body.messages[1]!.content) as {
        transactions: Array<{ itemId: number }>;
      };
      return {
        _request_id: `req_processor_${Date.now()}_${Math.random()}`,
        choices: [
          {
            finish_reason: "stop",
            message: {
              refusal: null,
              content: JSON.stringify({
                results: userMessage.transactions.map(({ itemId }) => ({
                  itemId,
                  category: "software",
                  transactionClass: "expense",
                  recurrenceType: "recurring",
                  labelConfidence: 0.94,
                  labelReason: "Known monthly software subscription",
                })),
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens: 45,
          completion_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 165,
        },
      };
    });
  }

  async function processWhenAvailable(
    input: Parameters<typeof processor.processAiEnhancementBatch>[0],
  ) {
    return processor.processAiEnhancementBatch({
      ...input,
      leaseProvider: input.leaseProvider ?? availableLeases,
    });
  }

  it("uses a newly saved manual rule without authorizing a provider request", async () => {
    const owner = await fixture("manual-preflight", ["Mystery Utility"]);
    await pool.query(
      `INSERT INTO merchant_rules
         (user_id, merchant_key, category, transaction_class, recurrence_type)
       VALUES ($1, 'mystery utility', 'utilities', 'expense', 'recurring')`,
      [owner.userId],
    );
    const transport = vi.fn(async () => {
      throw new Error("provider must not be called");
    });

    const result = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });

    expect(transport).not.toHaveBeenCalled();
    expect(result.job).toMatchObject({ status: "complete", skippedMerchants: 1 });
    const transaction = await pool.query<{
      category: string;
      recurrence_type: string;
      label_source: string;
    }>(
      `SELECT category, recurrence_type, label_source FROM transactions
       WHERE upload_id = $1`,
      [owner.uploadId],
    );
    expect(transaction.rows[0]).toEqual({
      category: "utilities",
      recurrence_type: "recurring",
      label_source: "propagated",
    });
    expect(
      Number(
        (await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ai_usage_events WHERE job_id = $1`,
          [owner.job.id],
        )).rows[0]!.count,
      ),
    ).toBe(0);
  });

  it("does not let a low-signal other cache entry suppress enhancement", async () => {
    const owner = await fixture("other-cache", ["Still Unknown Merchant"]);
    await pool.query(
      `INSERT INTO merchant_classifications (
         user_id, merchant_key, category, transaction_class,
         recurrence_type, label_confidence, source
       ) VALUES ($1, 'still unknown merchant', 'other', 'expense', 'one-time', 0.40, 'ai')`,
      [owner.userId],
    );
    const transport = successfulTransport();

    const result = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });

    expect(result.job.status).toBe("complete");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale preflight lease before reserving or calling the provider", async () => {
    const owner = await fixture("stale-preflight", ["Stale Preflight Merchant"]);
    await pool.query(
      `INSERT INTO merchant_rules
         (user_id, merchant_key, category, transaction_class, recurrence_type)
       VALUES ($1, 'stale preflight merchant', 'utilities', 'expense', 'recurring')`,
      [owner.userId],
    );
    const transport = successfulTransport();

    await expect(
      processWhenAvailable({
        userId: owner.userId,
        jobId: owner.job.id,
        transport,
        providerEnabled: true,
        hooks: {
          afterClaim: async () => {
            await pool.query(
              `UPDATE ai_enhancement_job_items SET lease_token = $2
               WHERE job_id = $1 AND status = 'processing'`,
              [owner.job.id, crypto.randomUUID()],
            );
          },
        },
      }),
    ).rejects.toBeInstanceOf(jobs.AiEnhancementClaimStaleError);
    expect(transport).not.toHaveBeenCalled();
    const reservations = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_budget_reservations WHERE job_id = $1`,
      [owner.job.id],
    );
    expect(reservations.rows[0]!.count).toBe("0");
  });

  it("pays once per unique merchant, fans out, caches, and attributes usage", async () => {
    const owner = await fixture("paid-fanout", [
      "Unknown Cloud Service",
      "Unknown Cloud Service 839201",
    ]);
    const transport = successfulTransport();

    const result = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.job).toMatchObject({ status: "complete", completedMerchants: 1 });
    const transactions = await pool.query<{
      category: string;
      recurrence_type: string;
      label_source: string;
    }>(
      `SELECT category, recurrence_type, label_source FROM transactions
       WHERE upload_id = $1 ORDER BY id`,
      [owner.uploadId],
    );
    expect(transactions.rows).toEqual([
      { category: "software", recurrence_type: "recurring", label_source: "ai" },
      { category: "software", recurrence_type: "recurring", label_source: "ai" },
    ]);
    const usage = await pool.query<{
      user_id: number;
      account_id: number;
      upload_id: number;
      job_id: number;
      total_tokens: number;
    }>(
      `SELECT user_id, account_id, upload_id, job_id, total_tokens
       FROM ai_usage_events WHERE job_id = $1`,
      [owner.job.id],
    );
    expect(usage.rows).toEqual([
      {
        user_id: owner.userId,
        account_id: owner.accountId,
        upload_id: owner.uploadId,
        job_id: owner.job.id,
        total_tokens: 165,
      },
    ]);
    const cache = await pool.query<{ source: string }>(
      `SELECT source FROM merchant_classifications
       WHERE user_id = $1 AND merchant_key = 'unknown cloud service'`,
      [owner.userId],
    );
    expect(cache.rows).toEqual([{ source: "ai" }]);
  });

  it("resumes result fan-out after a crash without a second provider call", async () => {
    const owner = await fixture("result-recovery", ["Recover After Result"]);
    const transport = successfulTransport();

    await expect(
      processWhenAvailable({
        userId: owner.userId,
        jobId: owner.job.id,
        transport,
        providerEnabled: true,
        hooks: { afterResultsPersisted: () => { throw new Error("simulated crash"); } },
      }),
    ).rejects.toThrow("simulated crash");

    const recovered = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(recovered.job.status).toBe("complete");
    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ai_usage_events WHERE job_id = $1`,
      [owner.job.id],
    );
    expect(events.rows[0]!.count).toBe("1");
  });

  it("records a partial job when the provider omits one authorized merchant", async () => {
    const owner = await fixture("partial-result", ["First Partial Vendor", "Second Partial Vendor"]);
    const transport: OpenAiChatTransport = vi.fn(async (body) => {
      const message = JSON.parse(body.messages[1]!.content) as {
        transactions: Array<{ itemId: number }>;
      };
      return {
        _request_id: `req_partial_${Date.now()}_${Math.random()}`,
        choices: [{
          finish_reason: "stop",
          message: {
            refusal: null,
            content: JSON.stringify({
              results: [{
                itemId: message.transactions[0]!.itemId,
                category: "software",
                transactionClass: "expense",
                recurrenceType: "recurring",
                labelConfidence: 0.9,
                labelReason: "Recognized software charge",
              }],
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      };
    });

    const result = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });

    expect(result.job).toMatchObject({
      status: "partial",
      completedMerchants: 1,
      failedMerchants: 1,
    });
  });

  it("honors cancellation immediately before send and releases the reservation", async () => {
    const owner = await fixture("cancel-before-send", ["Cancel Before Provider"]);
    const transport = successfulTransport();

    const result = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
      hooks: {
        beforeProvider: async () => {
          await jobs.cancelAiEnhancementJob({
            userId: owner.userId,
            jobId: owner.job.id,
          });
        },
      },
    });

    expect(result.state).toBe("cancelled");
    expect(transport).not.toHaveBeenCalled();
    const reservation = await pool.query<{ status: string; final_cost_microusd: string }>(
      `SELECT status, final_cost_microusd::text FROM ai_budget_reservations
       WHERE job_id = $1`,
      [owner.job.id],
    );
    expect(reservation.rows).toEqual([{ status: "released", final_cost_microusd: "0" }]);
  });

  it("releases authorization and restores the claim when global capacity is busy", async () => {
    const owner = await fixture("capacity-busy", ["Wait For Capacity"]);
    const busyLeases: AiEnhancementLeaseProvider = {
      acquire: vi.fn(async () => ({
        acquired: false,
        leaseId: null,
        expiresAt: null,
        alreadyHeld: false,
      })),
      release: vi.fn(async () => false),
    };
    const transport = successfulTransport();
    const result = await processor.processAiEnhancementBatch({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
      leaseProvider: busyLeases,
    });
    expect(result.state).toBe("busy");
    expect(transport).not.toHaveBeenCalled();
    const item = await pool.query<{
      status: string;
      attempt_count: number;
      reservation_id: string | null;
    }>(
      `SELECT status, attempt_count, reservation_id
         FROM ai_enhancement_job_items WHERE job_id = $1`,
      [owner.job.id],
    );
    expect(item.rows[0]).toEqual({
      status: "pending",
      attempt_count: 0,
      reservation_id: null,
    });
    const reservation = await pool.query<{ status: string }>(
      `SELECT status FROM ai_budget_reservations WHERE job_id = $1`,
      [owner.job.id],
    );
    expect(reservation.rows).toEqual([{ status: "released" }]);
  });

  it("treats a thrown provider outcome as spent and never retries it", async () => {
    const owner = await fixture("provider-unknown", ["Unknown Provider Outcome"]);
    const transport: OpenAiChatTransport = vi.fn(async () => {
      throw new Error("socket closed after request send");
    });

    await expect(
      processWhenAvailable({
        userId: owner.userId,
        jobId: owner.job.id,
        transport,
        providerEnabled: true,
      }),
    ).rejects.toThrow("socket closed");
    const recovered = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(recovered.job.status).toBe("failed");
    const reservation = await pool.query<{
      status: string;
      final_cost_microusd: string;
      reserved_cost_microusd: string;
    }>(
      `SELECT status, final_cost_microusd::text, reserved_cost_microusd::text
       FROM ai_budget_reservations WHERE job_id = $1`,
      [owner.job.id],
    );
    expect(reservation.rows[0]!.status).toBe("reserved_unknown");
    expect(reservation.rows[0]!.final_cost_microusd).toBe(
      reservation.rows[0]!.reserved_cost_microusd,
    );
  });

  it("advances counters monotonically across bounded 25-merchant batches", async () => {
    const owner = await fixture(
      "multi-batch",
      Array.from({ length: 30 }, (_, index) => `Batch Merchant code${index}x`),
    );
    const transport = successfulTransport();

    const first = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });
    expect(first.job).toMatchObject({
      status: "queued",
      completedMerchants: 25,
      failedMerchants: 0,
    });
    const second = await processWhenAvailable({
      userId: owner.userId,
      jobId: owner.job.id,
      transport,
      providerEnabled: true,
    });
    expect(second.job).toMatchObject({
      status: "complete",
      completedMerchants: 30,
      failedMerchants: 0,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(second.job.actualCostMicrousd).toBeGreaterThanOrEqual(
      first.job.actualCostMicrousd,
    );
  });
});
