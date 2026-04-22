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

  beforeAll(async () => {
    const mod = await import("./routes.js");
    createApp = mod.createApp;
  });

  afterAll(() => {
    if (origTeamIds === undefined) delete process.env.DEV_TEAM_USER_IDS;
    else process.env.DEV_TEAM_USER_IDS = origTeamIds;
  });

  function testApp() {
    return createApp({ sessionStore: new session.MemoryStore() });
  }

  async function csrfToken(agent: ReturnType<typeof request.agent>) {
    const res = await agent.get("/api/csrf-token");
    return res.body.token as string;
  }

  /** Register a new user; pass isDev=true to flip the dev flag at creation time. */
  async function registerUser(
    app: ReturnType<typeof testApp>,
    opts: { isDev: boolean },
  ): Promise<{ agent: ReturnType<typeof request.agent>; userId: number; csrf: string }> {
    const agent = request.agent(app);
    const csrf = await csrfToken(agent);
    const email = `dev-suite-${crypto.randomUUID()}@example.com`;
    const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "long-enough-pw",
      displayName: "Dev Suite Tester",
      isDev: opts.isDev,
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
    expect(res.body.users[0]).toMatchObject({ userId, classification: null, parser: null });
  });

  // ── Parser fidelity sampler (PR2) ───────────────────────────────────────

  /**
   * Seed an upload row with status="complete" (what the live upload route
   * writes) plus N transactions tied to it, so the parser sampler can pick
   * from a single upload. Returns the uploadId for explicit-id tests.
   */
  async function seedUploadAndTransactions(
    agent: ReturnType<typeof request.agent>,
    csrf: string,
    userId: number,
    n: number,
    warningCount = 0,
  ): Promise<{ uploadId: number; accountId: number }> {
    const created = await agent.post("/api/accounts").set("X-CSRF-Token", csrf).send({
      label: "Parser Test Account",
      lastFour: "0001",
      accountType: "checking",
    });
    expect(created.status).toBe(201);
    const accountId = created.body.account.id as number;

    const { db } = await import("./db.js");
    const { transactions, uploads } = await import("../shared/schema.js");

    const [upload] = await db
      .insert(uploads)
      .values({
        userId, accountId,
        filename: "parser-seed.csv",
        rowCount: n,
        warningCount,
        status: "complete",
      })
      .returning({ id: uploads.id });
    const uploadId = upload!.id;

    const rows = Array.from({ length: n }, (_, i) => {
      const day = String(((i % 27) + 1)).padStart(2, "0");
      return {
        userId,
        accountId,
        uploadId,
        date: `2025-05-${day}`,
        rawDescription: `STARBUCKS PARSER #${i + 1}`,
        merchant: "Starbucks",
        amount: String(-(5 + i).toFixed(2)),
        flowType: "outflow",
        category: "coffee",
        transactionClass: "expense",
        recurrenceType: "one-time",
        labelSource: "rule" as const,
        labelConfidence: "0.90",
      };
    });
    await db.insert(transactions).values(rows);
    return { uploadId, accountId };
  }

  it("parser-samples returns 404 when isDev=false", async () => {
    const app = testApp();
    const { agent } = await registerUser(app, { isDev: false });
    const res = await agent.get("/api/dev/parser-samples");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("parser-samples POST 400s when the user has no uploads", async () => {
    const app = testApp();
    const { agent, csrf } = await registerUser(app, { isDev: true });
    const res = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/upload/i);
  });

  it("parser-samples POST 400s when explicit uploadId belongs to another user", async () => {
    const app = testApp();
    const { agent: ownerAgent, csrf: ownerCsrf, userId: ownerId } =
      await registerUser(app, { isDev: true });
    const { uploadId } = await seedUploadAndTransactions(ownerAgent, ownerCsrf, ownerId, 5);

    const { agent, csrf } = await registerUser(app, { isDev: true });
    const res = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 5, uploadId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/upload/i);
  });

  it("parser-samples GET :id returns uploadDate; verdicts reflect aiAssisted as ambiguous", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    const { uploadId } = await seedUploadAndTransactions(agent, csrf, userId, 10);
    // Mark a couple of seeded transactions as ai-assisted so we can verify the
    // ambiguous flag flows through to the snapshot.
    const { db } = await import("./db.js");
    const { transactions } = await import("../shared/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(transactions)
      .set({ aiAssisted: true })
      .where(eq(transactions.uploadId, uploadId));

    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 5 });
    expect(create.status).toBe(201);
    expect(create.body.uploadDate).toEqual(expect.any(String));
    expect(Date.parse(create.body.uploadDate)).not.toBeNaN();
    expect(
      (create.body.verdicts as Array<{ parsedAmbiguous: boolean }>).every((v) => v.parsedAmbiguous),
    ).toBe(true);

    const fetched = await agent.get(`/api/dev/parser-samples/${create.body.sampleId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.sample.uploadDate).toEqual(create.body.uploadDate);
    expect(
      (fetched.body.sample.verdicts as Array<{ parsedAmbiguous: boolean }>).some((v) => v.parsedAmbiguous),
    ).toBe(true);
  });

  it("supports the full parser create → list → fetch → submit flow", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    const { uploadId } = await seedUploadAndTransactions(agent, csrf, userId, 25, 3);

    // POST — create
    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 20 });
    expect(create.status).toBe(201);
    expect(create.body.sampleId).toEqual(expect.any(Number));
    expect(create.body.uploadId).toBe(uploadId);
    expect(create.body.uploadRowCount).toBe(25);
    expect(create.body.uploadWarningCount).toBe(3);
    expect(Array.isArray(create.body.verdicts)).toBe(true);
    const sampleId = create.body.sampleId as number;
    const sampleSize = create.body.sampleSize as number;
    const verdictsSnapshot = create.body.verdicts as Array<{
      transactionId: number; rawAmount: string; parsedFlowType: string;
    }>;
    // Spec §6: reconstructed raw amount is the *absolute* value — no sign
    // leak from flowType — so reviewers can independently judge direction.
    expect(verdictsSnapshot[0].rawAmount.startsWith("-")).toBe(false);
    expect(parseFloat(verdictsSnapshot[0].rawAmount)).toBeGreaterThan(0);
    expect(verdictsSnapshot[0].parsedFlowType).toBe("outflow");

    // GET list
    const list = await agent.get("/api/dev/parser-samples");
    expect(list.status).toBe(200);
    expect((list.body.samples as Array<{ id: number }>).map((s) => s.id)).toContain(sampleId);

    // GET :id
    const fetched = await agent.get(`/api/dev/parser-samples/${sampleId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.sample.id).toBe(sampleId);
    expect(fetched.body.sample.completedAt).toBeNull();
    expect(fetched.body.sample.uploadRowCount).toBe(25);
    expect(fetched.body.sample.uploadWarningCount).toBe(3);

    // PATCH — submit verdicts: most "ok", one with wrong-amount, one skipped.
    const verdicts = verdictsSnapshot.map((v, i) => {
      if (i === 0) {
        return {
          transactionId: v.transactionId, skipped: false,
          dateVerdict: "ok", descriptionVerdict: "ok",
          amountVerdict: "wrong-amount", directionVerdict: "ok",
          notes: "off by a penny",
        };
      }
      if (i === 1) {
        return {
          transactionId: v.transactionId, skipped: true,
          dateVerdict: "ok", descriptionVerdict: "ok",
          amountVerdict: "ok", directionVerdict: "ok",
          notes: null,
        };
      }
      return {
        transactionId: v.transactionId, skipped: false,
        dateVerdict: "ok", descriptionVerdict: "ok",
        amountVerdict: "ok", directionVerdict: "ok",
        notes: null,
      };
    });
    const submit = await agent
      .patch(`/api/dev/parser-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(submit.status).toBe(200);
    expect(submit.body.sample.completedAt).not.toBeNull();
    // 1 skipped → non-skipped denominator = sampleSize - 1
    const denom = sampleSize - 1;
    // 1 wrong-amount → amountAccuracy = (denom - 1) / denom
    expect(submit.body.sample.amountAccuracy).toBeCloseTo((denom - 1) / denom, 4);
    expect(submit.body.sample.dateAccuracy).toBe(1);
    expect(submit.body.sample.directionAccuracy).toBe(1);
    expect(submit.body.sample.confirmedCount).toBe(sampleSize - 2);
    expect(submit.body.sample.flaggedCount).toBe(1);
    // Notes survive the round trip on the flagged row.
    const stored = submit.body.sample.verdicts as Array<{ transactionId: number; notes: string | null }>;
    expect(stored.find((v) => v.transactionId === verdictsSnapshot[0].transactionId)?.notes)
      .toBe("off by a penny");

    // PATCH again — already submitted → 409
    const second = await agent
      .patch(`/api/dev/parser-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(second.status).toBe(409);
  });

  it("parser-samples PATCH rejects fewer than 80% verdicts", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedUploadAndTransactions(agent, csrf, userId, 20);
    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    expect(create.status).toBe(201);
    const tooFew = (create.body.verdicts as Array<{ transactionId: number }>)
      .slice(0, 1)
      .map((v) => ({
        transactionId: v.transactionId, skipped: false,
        dateVerdict: "ok", descriptionVerdict: "ok",
        amountVerdict: "ok", directionVerdict: "ok", notes: null,
      }));
    const submit = await agent
      .patch(`/api/dev/parser-samples/${create.body.sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts: tooFew });
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/at least/i);
  });

  it("parser-samples POST 400s when explicit uploadId points to a non-complete upload", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    // Create a successful upload + transactions so the most-recent fallback would
    // otherwise succeed; we want to prove the explicit-ID branch independently
    // rejects the failed upload below.
    await seedUploadAndTransactions(agent, csrf, userId, 5);

    const created = await agent.post("/api/accounts").set("X-CSRF-Token", csrf).send({
      label: "Failed Upload Account",
      lastFour: "0099",
      accountType: "checking",
    });
    const accountId = created.body.account.id as number;
    const { db } = await import("./db.js");
    const { uploads } = await import("../shared/schema.js");
    const [failed] = await db
      .insert(uploads)
      .values({ userId, accountId, filename: "broken.csv", rowCount: 0, status: "failed" })
      .returning({ id: uploads.id });

    const res = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 5, uploadId: failed!.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/upload/i);
  });

  it("parser-samples PATCH merges partial verdicts: omitted rows keep defaults", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedUploadAndTransactions(agent, csrf, userId, 25);
    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 20 });
    const sampleId = create.body.sampleId as number;
    const sampleSize = create.body.sampleSize as number;
    const snapshot = create.body.verdicts as Array<{ transactionId: number }>;

    // Submit only the first 16 rows (80% threshold) — flag exactly one with
    // wrong-amount, leave the remaining 4 omitted from the payload.
    const partial = snapshot.slice(0, 16).map((v, i) => ({
      transactionId: v.transactionId, skipped: false,
      dateVerdict: "ok", descriptionVerdict: "ok",
      amountVerdict: i === 0 ? "wrong-amount" : "ok",
      directionVerdict: "ok", notes: null,
    }));
    const submit = await agent
      .patch(`/api/dev/parser-samples/${sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts: partial });
    expect(submit.status).toBe(200);

    const stored = submit.body.sample.verdicts as Array<{ transactionId: number; dateVerdict: string; amountVerdict: string }>;
    // Persisted set must equal sampleSize — omitted rows weren't dropped.
    expect(stored.length).toBe(sampleSize);
    // Omitted rows keep the default ("ok" / not-skipped) snapshot.
    const omittedIds = snapshot.slice(16).map((v) => v.transactionId);
    for (const id of omittedIds) {
      const row = stored.find((s) => s.transactionId === id);
      expect(row?.dateVerdict).toBe("ok");
      expect(row?.amountVerdict).toBe("ok");
    }
    // Counts reflect the full merged set: 1 flagged, sampleSize-1 confirmed.
    expect(submit.body.sample.flaggedCount).toBe(1);
    expect(submit.body.sample.confirmedCount).toBe(sampleSize - 1);
  });

  it("parser-samples PATCH rejects unknown transactionId (anti-tamper)", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedUploadAndTransactions(agent, csrf, userId, 20);
    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    const verdicts = (create.body.verdicts as Array<{ transactionId: number }>)
      .map((v) => ({
        transactionId: v.transactionId, skipped: false,
        dateVerdict: "ok", descriptionVerdict: "ok",
        amountVerdict: "ok", directionVerdict: "ok", notes: null,
      }));
    verdicts.push({
      transactionId: 99_999_999, skipped: false,
      dateVerdict: "ok", descriptionVerdict: "ok",
      amountVerdict: "ok", directionVerdict: "ok", notes: null,
    });
    const submit = await agent
      .patch(`/api/dev/parser-samples/${create.body.sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/Unknown transactionId/);
  });

  it("parser-samples PATCH rejects duplicate transactionId in payload", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedUploadAndTransactions(agent, csrf, userId, 20);
    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    const snapshot = create.body.verdicts as Array<{ transactionId: number }>;
    const verdicts = snapshot.map((v) => ({
      transactionId: v.transactionId, skipped: false,
      dateVerdict: "ok", descriptionVerdict: "ok",
      amountVerdict: "ok", directionVerdict: "ok", notes: null,
    }));
    // Duplicate the first row's verdict.
    verdicts.push({ ...verdicts[0]! });
    const submit = await agent
      .patch(`/api/dev/parser-samples/${create.body.sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/duplicate/i);
  });

  it("parser-samples PATCH rejects invalid enum values", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedUploadAndTransactions(agent, csrf, userId, 20);
    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    const verdicts = (create.body.verdicts as Array<{ transactionId: number }>)
      .map((v, i) => ({
        transactionId: v.transactionId, skipped: false,
        dateVerdict: "ok", descriptionVerdict: "ok",
        // Inject one bad value
        amountVerdict: i === 0 ? "totally-bogus" : "ok",
        directionVerdict: "ok", notes: null,
      }));
    const submit = await agent
      .patch(`/api/dev/parser-samples/${create.body.sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/Invalid amountVerdict/i);
  });

  it("team-summary surfaces the latest completed parser sample", async () => {
    const app = testApp();
    const { agent, csrf, userId } = await registerUser(app, { isDev: true });
    await seedUploadAndTransactions(agent, csrf, userId, 20, 1);
    const create = await agent
      .post("/api/dev/parser-samples")
      .set("X-CSRF-Token", csrf)
      .send({ sampleSize: 15 });
    const verdicts = (create.body.verdicts as Array<{ transactionId: number }>)
      .map((v) => ({
        transactionId: v.transactionId, skipped: false,
        dateVerdict: "ok", descriptionVerdict: "ok",
        amountVerdict: "ok", directionVerdict: "ok", notes: null,
      }));
    const submit = await agent
      .patch(`/api/dev/parser-samples/${create.body.sampleId}`)
      .set("X-CSRF-Token", csrf)
      .send({ verdicts });
    expect(submit.status).toBe(200);

    process.env.DEV_TEAM_USER_IDS = String(userId);
    const team = await agent.get("/api/dev/team-summary");
    expect(team.status).toBe(200);
    expect(team.body.users[0].parser).toMatchObject({
      sampleId: create.body.sampleId,
      sampleSize: 15,
      dateAccuracy: 1,
      uploadWarningCount: 1,
    });
  });
});
