import crypto from "node:crypto";
import session from "express-session";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Endpoint-level integration tests for /api/dev/* (Dev Test Suite, PR1).
 * Same opt-in as the rest of the route tests: requires Postgres + the
 * POCKETPULSE_STORAGE_TESTS=1 env flag.
 */
const runRouteIntegrationTests =
  Boolean(process.env.DATABASE_URL) &&
  process.env.POCKETPULSE_STORAGE_TESTS === "1";

describe.skipIf(!runRouteIntegrationTests)("Dev Test Suite routes (/api/dev/*)", () => {
  let createApp: typeof import("./routes.js").createApp;

  // Each test seeds its own user; this keeps DEV_TEAM_USER_IDS predictable too.
  const origTeamIds = process.env.DEV_TEAM_USER_IDS;
  const origDevTools = process.env.POCKETPULSE_DEV_TOOLS;
  const origDevEmails = process.env.POCKETPULSE_DEV_EMAILS;

  beforeAll(async () => {
    const mod = await import("./routes.js");
    createApp = mod.createApp;
  });

  afterAll(() => {
    if (origTeamIds === undefined) delete process.env.DEV_TEAM_USER_IDS;
    else process.env.DEV_TEAM_USER_IDS = origTeamIds;
    if (origDevTools === undefined) delete process.env.POCKETPULSE_DEV_TOOLS;
    else process.env.POCKETPULSE_DEV_TOOLS = origDevTools;
    if (origDevEmails === undefined) delete process.env.POCKETPULSE_DEV_EMAILS;
    else process.env.POCKETPULSE_DEV_EMAILS = origDevEmails;
  });

  function testApp() {
    return createApp({ sessionStore: new session.MemoryStore() });
  }

  async function csrfToken(agent: ReturnType<typeof request.agent>) {
    const res = await agent.get("/api/csrf-token");
    return res.body.token as string;
  }

  /** Register a new user; pass isDev=true to include the email in the dev allowlist. */
  async function registerUser(
    app: ReturnType<typeof testApp>,
    opts: { isDev: boolean },
  ): Promise<{ agent: ReturnType<typeof request.agent>; userId: number; csrf: string }> {
    const agent = request.agent(app);
    const csrf = await csrfToken(agent);
    const email = `dev-suite-${crypto.randomUUID()}@example.com`;
    process.env.POCKETPULSE_DEV_TOOLS = "1";
    process.env.POCKETPULSE_DEV_EMAILS = opts.isDev ? email : "";
    const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "long-enough-pw",
      displayName: "Dev Suite Tester",
    });
    expect(res.status).toBe(201);
    return { agent, userId: res.body.user.id as number, csrf };
  }

  /**
   * Seed transactions directly via the storage layer so the sampler has rows
   * with the eligible label sources (rule|cache|ai|user-rule). Going through
   * the CSV upload pipeline here would couple this test to the parser; we
   * only need rows that pass the sampler's WHERE clause.
   */
  async function seedTransactions(
    agent: ReturnType<typeof request.agent>,
    csrf: string,
    userId: number,
    n: number,
  ): Promise<void> {
    const created = await agent.post("/api/accounts").set("X-CSRF-Token", csrf).send({
      label: "Sampler Test Account",
      lastFour: "0000",
      accountType: "checking",
    });
    expect(created.status).toBe(201);
    const accountId = created.body.account.id as number;

    const { db } = await import("./db.js");
    const { transactions, uploads } = await import("../shared/schema.js");

    // Seed a placeholder upload row to satisfy the transactions.upload_id FK.
    const [upload] = await db
      .insert(uploads)
      .values({ userId, accountId, filename: "test-seed.csv", rowCount: n, status: "completed" })
      .returning({ id: uploads.id });
    const uploadId = upload!.id;

    const rows = Array.from({ length: n }, (_, i) => {
      const day = String(((i % 27) + 1)).padStart(2, "0");
      return {
        userId,
        accountId,
        uploadId,
        date: `2025-04-${day}`,
        rawDescription: `STARBUCKS STORE #${i + 1}`,
        merchant: "Starbucks",
        amount: String(-(5 + i).toFixed(2)),
        flowType: "expense",
        category: "coffee",
        transactionClass: "expense",
        recurrenceType: "one-time",
        labelSource: "rule" as const,
        labelConfidence: "0.90",
      };
    });
    await db.insert(transactions).values(rows);
  }

  // ── 404 gating ──────────────────────────────────────────────────────────

  it("returns 404 when the caller has no session", async () => {
    const app = testApp();
    const list = await request(app).get("/api/dev/classification-samples");
    expect(list.status).toBe(404);
    expect(list.body).toEqual({ error: "Not found" });

    const team = await request(app).get("/api/dev/team-summary");
    expect(team.status).toBe(404);
  });

  it("returns 404 when the caller is logged in but isDev=false", async () => {
    const app = testApp();
    const { agent } = await registerUser(app, { isDev: false });
    const list = await agent.get("/api/dev/classification-samples");
    expect(list.status).toBe(404);
    expect(list.body).toEqual({ error: "Not found" });
  });

  // ── Classification sampler happy path ───────────────────────────────────

  it("rejects sample creation with 400 when the user has no eligible transactions", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    const res = await agent
      .post("/api/dev/classification-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no eligible transactions/i);
  });

  it("supports the full create → list → fetch → submit flow", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedTransactions(agent, csrf, userId, 30);

    // POST — create sample
    const create = await agent
      .post("/api/dev/classification-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 20 });
    expect(create.status).toBe(201);
    expect(create.body.sampleId).toEqual(expect.any(Number));
    expect(Array.isArray(create.body.transactions)).toBe(true);
    expect(create.body.transactions.length).toBeGreaterThan(0);
    const sampleId = create.body.sampleId as number;
    const sampleSize = create.body.sampleSize as number;
    const txns = create.body.transactions as Array<{
      id: number;
      date: string;
      rawDescription: string;
      amount: number;
    }>;

    // GET list — sample appears
    const list = await agent.get("/api/dev/classification-samples");
    expect(list.status).toBe(200);
    expect((list.body.samples as Array<{ id: number }>).map((s) => s.id)).toContain(sampleId);

    // GET :id — server re-hydrates Ledger context
    const fetched = await agent.get(`/api/dev/classification-samples/${sampleId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.sample.id).toBe(sampleId);
    expect(fetched.body.sample.completedAt).toBeNull();
    expect(Array.isArray(fetched.body.transactions)).toBe(true);
    expect(fetched.body.transactions.length).toBe(sampleSize);
    // Hydration check: at least the description survived the round trip.
    expect(fetched.body.transactions[0].rawDescription).toEqual(expect.any(String));

    // PATCH — submit verdicts (all confirmed) for the full sample
    const verdicts = txns.map((t) => ({ transactionId: t.id, verdict: "confirmed" }));
    const submit = await agent
      .patch(`/api/dev/classification-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(submit.status).toBe(200);
    expect(submit.body.sample.completedAt).not.toBeNull();
    expect(submit.body.sample.confirmedCount).toBe(sampleSize);
    expect(submit.body.sample.correctedCount).toBe(0);
    // All confirmed → category accuracy must be 1.0.
    expect(submit.body.sample.categoryAccuracy).toBe(1);

    // PATCH again — already submitted → 409
    const second = await agent
      .patch(`/api/dev/classification-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(second.status).toBe(409);
  });

  it("rejects PATCH with fewer than 80% verdicts", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedTransactions(agent, csrf, userId, 20);

    const create = await agent
      .post("/api/dev/classification-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    expect(create.status).toBe(201);
    const txns = create.body.transactions as Array<{ id: number }>;
    const tooFew = txns.slice(0, 1).map((t) => ({ transactionId: t.id, verdict: "confirmed" }));

    const submit = await agent
      .patch(`/api/dev/classification-samples/${create.body.sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts: tooFew });
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/at least/i);
  });

  it("rejects unknown transactionId (anti-tamper) on PATCH", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedTransactions(agent, csrf, userId, 20);
    const create = await agent
      .post("/api/dev/classification-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    const txns = create.body.transactions as Array<{ id: number }>;
    const bogus = txns.map((t) => ({ transactionId: t.id, verdict: "confirmed" }));
    bogus.push({ transactionId: 99_999_999, verdict: "confirmed" });
    const submit = await agent
      .patch(`/api/dev/classification-samples/${create.body.sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts: bogus });
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/Unknown transactionId/);
  });

  // ── DELETE /classification-samples/:id ──────────────────────────────────

  it("deletes an in-progress sample owned by the caller", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedTransactions(agent, csrf, userId, 20);
    const create = await agent
      .post("/api/dev/classification-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    expect(create.status).toBe(201);
    const sampleId = create.body.sampleId as number;

    const del = await agent
      .delete(`/api/dev/classification-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, id: sampleId });

    // Subsequent GET returns 404 (the dev-suite-default opaque not-found).
    const after = await agent.get(`/api/dev/classification-samples/${sampleId}`);
    expect(after.status).toBe(404);
  });

  it("deletes a completed sample owned by the caller", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedTransactions(agent, csrf, userId, 20);
    const create = await agent
      .post("/api/dev/classification-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    const sampleId = create.body.sampleId as number;
    const txns = create.body.transactions as Array<{ id: number }>;
    const allConfirmed = txns.map((t) => ({ transactionId: t.id, verdict: "confirmed" }));
    const submit = await agent
      .patch(`/api/dev/classification-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts: allConfirmed });
    expect(submit.status).toBe(200);

    const del = await agent
      .delete(`/api/dev/classification-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });

  it("returns 404 when deleting a sample owned by another user", async () => {
    const app = testApp();
    const owner = await registerUser(app, { isDev: true });
    const intruder = await registerUser(app, { isDev: true });
    await seedTransactions(owner.agent, owner.csrf, owner.userId, 20);
    const create = await owner.agent
      .post("/api/dev/classification-samples")
      .set("X-CSRF-Token", owner.csrf)
      .send({ sampleSize: 15 });
    const sampleId = create.body.sampleId as number;

    const del = await intruder.agent
      .delete(`/api/dev/classification-samples/${sampleId}`)
      .set("X-CSRF-Token", intruder.csrf);
    expect(del.status).toBe(404);

    // Owner can still see their sample.
    const stillThere = await owner.agent.get(`/api/dev/classification-samples/${sampleId}`);
    expect(stillThere.status).toBe(200);
  });

  it("returns 404 when DELETE id does not exist", async () => {
    const app = testApp();
    const { agent, csrf } = await registerUser(app, { isDev: true });
    const del = await agent
      .delete("/api/dev/classification-samples/9999999")
      .set("X-CSRF-Token", csrf);
    expect(del.status).toBe(404);
  });

  // ── Team summary ────────────────────────────────────────────────────────

  it("team-summary returns 400 with a helpful error when DEV_TEAM_USER_IDS is unset", async () => {
    delete process.env.DEV_TEAM_USER_IDS;
    const app = testApp();
    const { agent } = await registerUser(app, { isDev: true });
    const res = await agent.get("/api/dev/team-summary");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DEV_TEAM_USER_IDS/);
  });

  it("team-summary returns 200 + per-user rows when DEV_TEAM_USER_IDS is set", async () => {
    const app = testApp();
    const { agent, userId } = await registerUser(app, { isDev: true });
    process.env.DEV_TEAM_USER_IDS = String(userId);
    const res = await agent.get("/api/dev/team-summary");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users[0]).toMatchObject({ userId, classification: null });
    expect(res.body.users[0]).not.toHaveProperty("parser");
  });

});
