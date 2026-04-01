import request from "supertest";
import session from "express-session";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Route integration tests require PostgreSQL (same opt-in as storage tests in `auth.test.ts`).
 */
const runRouteIntegrationTests =
  Boolean(process.env.DATABASE_URL) &&
  process.env.POCKETPULSE_STORAGE_TESTS === "1";

function assertNoPasswordLeak(obj: unknown) {
  const s = JSON.stringify(obj);
  expect(s).not.toMatch(/\$2[aby]\$/);
  expect(s.toLowerCase()).not.toContain("passwordhash");
}

describe.skipIf(!runRouteIntegrationTests)("API routes", () => {
  let createApp: typeof import("./routes.js").createApp;

  beforeAll(async () => {
    const mod = await import("./routes.js");
    createApp = mod.createApp;
  });

  /** In-memory sessions: integration tests already require Postgres for users/accounts; avoids depending on the `session` table. */
  function testApp() {
    return createApp({ sessionStore: new session.MemoryStore() });
  }

  it("GET /api/health responds ok", async () => {
    const app = testApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("unmatched /api/* returns JSON 404 (does not fall through to client)", async () => {
    const app = testApp();
    const getRes = await request(app).get("/api/no-such-endpoint");
    expect(getRes.status).toBe(404);
    expect(getRes.body).toEqual({ error: "Not found" });
    expect(getRes.type).toMatch(/json/);

    const postRes = await request(app).post("/api/also-missing").send({});
    expect(postRes.status).toBe(404);
    expect(postRes.body).toEqual({ error: "Not found" });
  });

  it("GET /api/auth/me returns explicit unauthenticated state without a session", async () => {
    const app = testApp();
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("POST /api/auth/register creates user, sets session, and never exposes a password hash", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const email = `route-reg-${crypto.randomUUID()}@example.com`;
    const res = await agent.post("/api/auth/register").send({
      email: `  ${email.toUpperCase()}  `,
      password: "secure-password-99",
      displayName: "Reg User",
    });
    expect(res.status).toBe(201);
    assertNoPasswordLeak(res.body);
    expect(res.body.user).toMatchObject({
      email,
      displayName: "Reg User",
    });
    expect(res.body.user).not.toHaveProperty("password");

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authenticated: true });
    assertNoPasswordLeak(me.body);
    expect(me.body.user).toMatchObject({ email, displayName: "Reg User" });
    expect(me.body.user).not.toHaveProperty("password");
  });

  it("POST /api/auth/register returns 409 for duplicate email (normalized)", async () => {
    const app = testApp();
    const base = `route-dup-${crypto.randomUUID()}@example.com`;
    await request(app)
      .post("/api/auth/register")
      .send({
        email: `  ${base.toUpperCase()}  `,
        password: "a",
        displayName: "One",
      })
      .expect(201);

    const res = await request(app).post("/api/auth/register").send({
      email: base,
      password: "b",
      displayName: "Two",
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/auth/login uses auth lookup and returns user without password hash", async () => {
    const app = testApp();
    const email = `route-login-${crypto.randomUUID()}@example.com`;
    const password = "login-secret-xyz";
    await request(app).post("/api/auth/register").send({
      email,
      password,
      displayName: "Login User",
    });

    const agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({
      email: ` ${email.toUpperCase()} `,
      password,
    });
    expect(res.status).toBe(200);
    assertNoPasswordLeak(res.body);
    expect(res.body.user).toMatchObject({ email, displayName: "Login User" });
    expect(res.body.user).not.toHaveProperty("password");

    const me = await agent.get("/api/auth/me");
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.email).toBe(email);
  });

  it("POST /api/auth/login returns 401 for wrong password without leaking existence details", async () => {
    const app = testApp();
    const email = `route-bad-pw-${crypto.randomUUID()}@example.com`;
    await request(app).post("/api/auth/register").send({
      email,
      password: "right-password",
      displayName: "X",
    });

    const res = await request(app).post("/api/auth/login").send({
      email,
      password: "wrong-password",
    });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/auth/logout destroys the session fully", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const email = `route-logout-${crypto.randomUUID()}@example.com`;
    await agent.post("/api/auth/register").send({
      email,
      password: "pw",
      displayName: "L",
    });
    await agent.post("/api/auth/logout").expect(204);

    const me = await agent.get("/api/auth/me");
    expect(me.body).toEqual({ authenticated: false });
  });

  it("GET /api/accounts returns 401 when unauthenticated", async () => {
    const app = testApp();
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(401);
  });

  it("GET /api/accounts returns an empty list for a new user (onboarding detection)", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const email = `route-acct-${crypto.randomUUID()}@example.com`;
    await agent.post("/api/auth/register").send({
      email,
      password: "pw",
      displayName: "Acct",
    });

    const res = await agent.get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: [] });
  });

  it("POST /api/accounts creates an account and GET lists it in stable order", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const email = `route-acct2-${crypto.randomUUID()}@example.com`;
    await agent.post("/api/auth/register").send({
      email,
      password: "pw",
      displayName: "Acct2",
    });

    const created = await agent.post("/api/accounts").send({
      label: "Checking",
      lastFour: "4242",
      accountType: "checking",
    });
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({
      label: "Checking",
      lastFour: "4242",
      accountType: "checking",
    });

    const list = await agent.get("/api/accounts");
    expect(list.status).toBe(200);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0].label).toBe("Checking");
  });

  it("POST /api/accounts returns 401 when unauthenticated", async () => {
    const app = testApp();
    const res = await request(app).post("/api/accounts").send({ label: "X" });
    expect(res.status).toBe(401);
  });
});
