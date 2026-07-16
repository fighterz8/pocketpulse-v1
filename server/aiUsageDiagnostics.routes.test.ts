import crypto from "node:crypto";
import session from "express-session";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runRouteIntegrationTests =
  Boolean(process.env.DATABASE_URL) &&
  process.env.POCKETPULSE_STORAGE_TESTS === "1";

describe.skipIf(!runRouteIntegrationTests)("AI usage diagnostic route", () => {
  let createApp: typeof import("./routes.js").createApp;
  const originalDevTools = process.env.POCKETPULSE_DEV_TOOLS;
  const originalDevEmails = process.env.POCKETPULSE_DEV_EMAILS;

  beforeAll(async () => {
    createApp = (await import("./routes.js")).createApp;
  });

  afterAll(() => {
    if (originalDevTools === undefined) delete process.env.POCKETPULSE_DEV_TOOLS;
    else process.env.POCKETPULSE_DEV_TOOLS = originalDevTools;
    if (originalDevEmails === undefined) delete process.env.POCKETPULSE_DEV_EMAILS;
    else process.env.POCKETPULSE_DEV_EMAILS = originalDevEmails;
  });

  function testApp() {
    return createApp({ sessionStore: new session.MemoryStore(), runStartupJobs: false });
  }

  async function registerUser(
    app: ReturnType<typeof testApp>,
    isDev: boolean,
  ): Promise<ReturnType<typeof request.agent>> {
    const agent = request.agent(app);
    const csrf = (await agent.get("/api/csrf-token")).body.token as string;
    const email = `usage-diagnostic-${crypto.randomUUID()}@example.com`;
    process.env.POCKETPULSE_DEV_TOOLS = "1";
    process.env.POCKETPULSE_DEV_EMAILS = isDev ? email : "";
    const registered = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({ email, password: "long-enough-pw", displayName: "Usage Dev" });
    expect(registered.status).toBe(201);
    return agent;
  }

  it("hides the endpoint from unauthenticated and non-dev callers", async () => {
    const app = testApp();
    expect((await request(app).get("/api/dev/ai-usage/summary")).status).toBe(404);
    const ordinary = await registerUser(app, false);
    const hidden = await ordinary.get("/api/dev/ai-usage/summary");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: "Not found" });
  });

  it("returns the aggregate-only report to an authenticated dev", async () => {
    const app = testApp();
    const dev = await registerUser(app, true);
    const response = await dev.get(
      "/api/dev/ai-usage/summary?from=2026-07-01&to=2026-07-31&operation=transaction_classification",
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      window: {
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-31T00:00:00.000Z",
      },
      filters: { operation: "transaction_classification" },
      summary: { requestCount: expect.any(Number) },
      breakdowns: {
        byUser: expect.any(Array),
        byFinancialAccount: expect.any(Array),
        byOperation: expect.any(Array),
        byDay: expect.any(Array),
        byMonth: expect.any(Array),
        byError: expect.any(Array),
      },
      budgets: expect.any(Array),
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /merchant|prompt|filename|providerRequestId|model/i,
    );
  });

  it("rejects malformed or over-wide filters without querying", async () => {
    const app = testApp();
    const dev = await registerUser(app, true);
    const malformed = await dev.get("/api/dev/ai-usage/summary?userId=1e3");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "userId must be a positive integer" });

    const tooWide = await dev.get(
      "/api/dev/ai-usage/summary?from=2024-01-01&to=2026-07-01",
    );
    expect(tooWide.status).toBe(400);
    expect(tooWide.body.error).toMatch(/366 days/i);
  });
});
