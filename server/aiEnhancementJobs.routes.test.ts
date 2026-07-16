import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import session from "express-session";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenAiChatTransport } from "./openaiProvider.js";
import type { AiEnhancementLeaseProvider } from "./aiEnhancementProcessor.js";
import type { BillingEntitlement } from "./billingEntitlements.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const originalEnv = { ...process.env };

describeDatabase("AI enhancement job routes", () => {
  let pool: pg.Pool;
  let createApp: typeof import("./routes.js").createApp;
  const availableLeases: AiEnhancementLeaseProvider = {
    acquire: vi.fn(async () => ({
      acquired: true,
      leaseId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 50_000),
      alreadyHeld: false,
    })),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => true),
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle/migrations" });
    createApp = (await import("./routes.js")).createApp;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    await pool?.end();
  });

  const activeEntitlement: BillingEntitlement = {
    state: "active",
    trialAvailable: false,
    entitled: true,
  };

  function app(
    enhancementTransport?: OpenAiChatTransport,
    billingEntitlementReader: (userId: number) => Promise<BillingEntitlement> =
      async () => activeEntitlement,
  ) {
    return createApp({
      sessionStore: new session.MemoryStore(),
      runStartupJobs: false,
      enhancementTransport,
      enhancementLeaseProvider: availableLeases,
      billingEntitlementReader,
    });
  }

  async function register(
    enhancementTransport?: OpenAiChatTransport,
    billingEntitlementReader?: (userId: number) => Promise<BillingEntitlement>,
  ) {
    const agent = request.agent(app(enhancementTransport, billingEntitlementReader));
    const csrf = (await agent.get("/api/csrf-token")).body.token as string;
    const email = `enhancement-route-${crypto.randomUUID()}@example.test`;
    const registration = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        email,
        password: "secure-password-99",
        displayName: "Enhancement Route Test",
      });
    expect(registration.status).toBe(201);
    const user = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    return { agent, csrf, userId: user.rows[0]!.id };
  }

  async function createUpload(userId: number) {
    const account = await pool.query<{ id: number }>(
      `INSERT INTO accounts (user_id, label) VALUES ($1, 'Checking') RETURNING id`,
      [userId],
    );
    const accountId = account.rows[0]!.id;
    const upload = await pool.query<{ id: number }>(
      `INSERT INTO uploads (user_id, account_id, filename, status)
       VALUES ($1, $2, 'unresolved.csv', 'complete') RETURNING id`,
      [userId, accountId],
    );
    const uploadId = upload.rows[0]!.id;
    for (const merchant of ["PYMT*NETFLIX.COM", "NETFLIX 8473923", "Mystery Vendor"]) {
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
    return { uploadId, accountId };
  }

  it("requires authentication without leaking upload or job existence", async () => {
    const application = app();
    expect(
      (await request(application).get("/api/uploads/123/enhancement")).status,
    ).toBe(401);
    expect(
      (await request(application).get("/api/enhancement-jobs/123")).status,
    ).toBe(401);
  });

  it("reports unresolved merchant availability without starting paid work", async () => {
    const actor = await register();
    const upload = await createUpload(actor.userId);
    delete process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED;
    process.env.OPENAI_API_KEY = "configured-but-unused";

    const response = await actor.agent.get(
      `/api/uploads/${upload.uploadId}/enhancement`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      uploadId: upload.uploadId,
      state: "blocked",
      unresolvedTransactionCount: 3,
      unresolvedMerchantCount: 2,
      blockedReason: "FEATURE_DISABLED",
      access: { state: "free", trialAvailable: true },
    });
  });

  it("projects Free access without reading billing tables when billing is disabled", async () => {
    const billingReader = vi.fn(async (): Promise<BillingEntitlement> => {
      throw new Error("disabled billing must not read optional tables");
    });
    const application = createApp({
      sessionStore: new session.MemoryStore(),
      runStartupJobs: false,
      billingConfig: { enabled: false },
      billingEntitlementReader: billingReader,
    });
    const agent = request.agent(application);
    const csrf = (await agent.get("/api/csrf-token")).body.token as string;
    const email = `enhancement-disabled-billing-${crypto.randomUUID()}@example.test`;
    expect((await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        email,
        password: "secure-password-99",
        displayName: "Disabled Billing Enhancement Test",
      })).status).toBe(201);
    const user = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    const upload = await createUpload(user.rows[0]!.id);
    delete process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED;
    delete process.env.OPENAI_API_KEY;

    const response = await agent.get(
      `/api/uploads/${upload.uploadId}/enhancement`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      uploadId: upload.uploadId,
      state: "blocked",
      blockedReason: "FEATURE_DISABLED",
      access: { state: "free", trialAvailable: true },
    });
    expect(billingReader).not.toHaveBeenCalled();
  });

  it("denies job creation to a free user without creating provider work", async () => {
    const free = vi.fn(async (): Promise<BillingEntitlement> => ({
      state: "free",
      trialAvailable: true,
      entitled: false,
    }));
    const actor = await register(undefined, free);
    const upload = await createUpload(actor.userId);
    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "true";
    process.env.OPENAI_API_KEY = "configured-but-unused";

    const response = await actor.agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", actor.csrf)
      .set("Idempotency-Key", `free-${upload.uploadId}`)
      .send({ uploadId: upload.uploadId });

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({
      code: "PLUS_REQUIRED",
      access: { state: "free", trialAvailable: true },
    });
    expect(free).toHaveBeenCalledWith(actor.userId);
    const jobs = await pool.query(
      `SELECT id FROM ai_enhancement_jobs WHERE user_id = $1`,
      [actor.userId],
    );
    expect(jobs.rowCount).toBe(0);
  });

  it("creates, reads, and idempotently cancels an owned job", async () => {
    const actor = await register();
    const stranger = await register();
    const upload = await createUpload(actor.userId);
    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "true";
    process.env.OPENAI_API_KEY = "configured-but-not-called";
    const key = `route-${upload.uploadId}`;

    const created = await actor.agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", actor.csrf)
      .set("Idempotency-Key", key)
      .send({ uploadId: upload.uploadId });
    expect(created.status).toBe(202);
    expect(created.body.job).toMatchObject({
      uploadId: upload.uploadId,
      status: "queued",
      totalMerchants: 2,
    });
    const jobId = created.body.job.id as number;

    const active = await actor.agent.get("/api/enhancement-jobs/active");
    expect(active.status).toBe(200);
    expect(active.body.job).toMatchObject({ id: jobId, uploadId: upload.uploadId });
    const strangerActive = await stranger.agent.get("/api/enhancement-jobs/active");
    expect(strangerActive.status).toBe(200);
    expect(strangerActive.body.job).toBeNull();

    const replay = await actor.agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", actor.csrf)
      .set("Idempotency-Key", key)
      .send({ uploadId: upload.uploadId });
    expect(replay.status).toBe(202);
    expect(replay.body.job.id).toBe(jobId);

    expect((await actor.agent.get(`/api/enhancement-jobs/${jobId}`)).status).toBe(200);
    expect((await stranger.agent.get(`/api/enhancement-jobs/${jobId}`)).status).toBe(404);

    const cancelled = await actor.agent
      .patch(`/api/enhancement-jobs/${jobId}`)
      .set("X-CSRF-Token", actor.csrf)
      .send({ status: "cancelled" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.job.status).toBe("cancelled");

    const replayCancel = await actor.agent
      .patch(`/api/enhancement-jobs/${jobId}`)
      .set("X-CSRF-Token", actor.csrf)
      .send({ status: "cancelled" });
    expect(replayCancel.status).toBe(200);
    expect(replayCancel.body.job.status).toBe("cancelled");
    const afterCancel = await actor.agent.get("/api/enhancement-jobs/active");
    expect(afterCancel.status).toBe(200);
    expect(afterCancel.body.job).toBeNull();
  });

  it("requires CSRF and a valid idempotency key for job creation", async () => {
    const actor = await register();
    const upload = await createUpload(actor.userId);
    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "true";
    process.env.OPENAI_API_KEY = "configured-but-not-called";

    const noCsrf = await actor.agent
      .post("/api/enhancement-jobs")
      .set("Idempotency-Key", `route-${upload.uploadId}`)
      .send({ uploadId: upload.uploadId });
    expect(noCsrf.status).toBe(403);

    const noKey = await actor.agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", actor.csrf)
      .send({ uploadId: upload.uploadId });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("keeps job creation blocked when the feature flag is disabled", async () => {
    const actor = await register();
    const upload = await createUpload(actor.userId);
    delete process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED;
    process.env.OPENAI_API_KEY = "configured-but-unused";

    const response = await actor.agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", actor.csrf)
      .set("Idempotency-Key", `disabled-${upload.uploadId}`)
      .send({ uploadId: upload.uploadId });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("FEATURE_DISABLED");
  });

  it("processes one authenticated batch through the injected bounded transport", async () => {
    const transport: OpenAiChatTransport = vi.fn(async (body) => {
      const input = JSON.parse(body.messages[1]!.content) as {
        transactions: Array<{ itemId: number }>;
      };
      return {
        _request_id: `req_route_${crypto.randomUUID()}`,
        choices: [{
          finish_reason: "stop",
          message: {
            refusal: null,
            content: JSON.stringify({
              results: input.transactions.map(({ itemId }) => ({
                itemId,
                category: "software",
                transactionClass: "expense",
                recurrenceType: "recurring",
                labelConfidence: 0.92,
                labelReason: "Recognized recurring software charge",
              })),
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      };
    });
    const application = createApp({
      sessionStore: new session.MemoryStore(),
      runStartupJobs: false,
      enhancementTransport: transport,
      enhancementLeaseProvider: availableLeases,
      billingEntitlementReader: async () => activeEntitlement,
    });
    const agent = request.agent(application);
    const csrf = (await agent.get("/api/csrf-token")).body.token as string;
    const email = `enhancement-batch-${crypto.randomUUID()}@example.test`;
    expect((await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "secure-password-99",
      displayName: "Enhancement Batch Route",
    })).status).toBe(201);
    const user = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
    const upload = await createUpload(user.rows[0]!.id);
    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "true";
    process.env.OPENAI_API_KEY = "configured-but-mocked";
    const created = await agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", csrf)
      .set("Idempotency-Key", `batch-route-${upload.uploadId}`)
      .send({ uploadId: upload.uploadId });

    let processed: request.Response | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      processed = await agent
        .post(`/api/enhancement-jobs/${created.body.job.id}/batches`)
        .set("X-CSRF-Token", csrf)
        .send({});
      if (processed.body.state !== "busy") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(processed?.status).toBe(200);
    expect(processed?.body.job.status).toBe("complete");
    expect(transport).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("keeps batch processing owner-isolated and fail-closed when disabled", async () => {
    const transport: OpenAiChatTransport = vi.fn(async () => {
      throw new Error("provider must not be called");
    });
    const actor = await register(transport);
    const stranger = await register(transport);
    const upload = await createUpload(actor.userId);
    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "true";
    process.env.OPENAI_API_KEY = "configured-but-mocked";
    const created = await actor.agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", actor.csrf)
      .set("Idempotency-Key", `isolation-route-${upload.uploadId}`)
      .send({ uploadId: upload.uploadId });
    const jobId = created.body.job.id as number;

    const crossUser = await stranger.agent
      .post(`/api/enhancement-jobs/${jobId}/batches`)
      .set("X-CSRF-Token", stranger.csrf)
      .send({});
    expect(crossUser.status).toBe(404);

    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "false";
    const disabled = await actor.agent
      .post(`/api/enhancement-jobs/${jobId}/batches`)
      .set("X-CSRF-Token", actor.csrf)
      .send({});
    expect(disabled.status).toBe(503);
    expect(disabled.body.code).toBe("FEATURE_DISABLED");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rechecks entitlement before every batch and blocks after revocation", async () => {
    const transport: OpenAiChatTransport = vi.fn(async () => {
      throw new Error("provider must not be called after entitlement revocation");
    });
    let entitlement = activeEntitlement;
    const actor = await register(transport, async () => entitlement);
    const upload = await createUpload(actor.userId);
    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "true";
    process.env.OPENAI_API_KEY = "configured-but-mocked";
    const created = await actor.agent
      .post("/api/enhancement-jobs")
      .set("X-CSRF-Token", actor.csrf)
      .set("Idempotency-Key", `revoked-${upload.uploadId}`)
      .send({ uploadId: upload.uploadId });
    expect(created.status).toBe(202);

    entitlement = {
      state: "past_due",
      trialAvailable: false,
      entitled: false,
    };
    const blocked = await actor.agent
      .post(`/api/enhancement-jobs/${created.body.job.id}/batches`)
      .set("X-CSRF-Token", actor.csrf)
      .send({});

    expect(blocked.status).toBe(402);
    expect(blocked.body).toMatchObject({
      code: "PLUS_REQUIRED",
      access: { state: "past_due" },
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
