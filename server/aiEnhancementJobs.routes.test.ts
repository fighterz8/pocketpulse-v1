import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import session from "express-session";
import pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const originalEnv = { ...process.env };

describeDatabase("AI enhancement job routes", () => {
  let pool: pg.Pool;
  let createApp: typeof import("./routes.js").createApp;

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

  function app() {
    return createApp({
      sessionStore: new session.MemoryStore(),
      runStartupJobs: false,
    });
  }

  async function register() {
    const agent = request.agent(app());
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
    });
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
});
