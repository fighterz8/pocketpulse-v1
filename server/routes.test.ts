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

  async function withCsrf(agent: ReturnType<typeof request.agent>) {
    const res = await agent.get("/api/csrf-token");
    return res.body.token as string;
  }

  it("throws if SESSION_SECRET is missing in production", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origSecret = process.env.SESSION_SECRET;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.SESSION_SECRET;
      expect(() => createApp()).toThrow(/SESSION_SECRET/i);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origSecret !== undefined) {
        process.env.SESSION_SECRET = origSecret;
      } else {
        delete process.env.SESSION_SECRET;
      }
    }
  });

  it("GET /api/health responds ok", async () => {
    const app = testApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("responses include security headers from helmet", async () => {
    const app = testApp();
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("unmatched /api/* returns JSON 404 (does not fall through to client)", async () => {
    const app = testApp();
    const getRes = await request(app).get("/api/no-such-endpoint");
    expect(getRes.status).toBe(404);
    expect(getRes.body).toEqual({ error: "Not found" });
    expect(getRes.type).toMatch(/json/);

    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const postRes = await agent.post("/api/also-missing").set("X-CSRF-Token", csrf).send({});
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
    const csrf = await withCsrf(agent);
    const email = `route-reg-${crypto.randomUUID()}@example.com`;
    const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
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
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const base = `route-dup-${crypto.randomUUID()}@example.com`;
    await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        email: `  ${base.toUpperCase()}  `,
        password: "password-one",
        displayName: "One",
      })
      .expect(201);

    const agent2 = request.agent(app);
    const csrf2 = await withCsrf(agent2);
    const res = await agent2.post("/api/auth/register").set("X-CSRF-Token", csrf2).send({
      email: base,
      password: "password-two",
      displayName: "Two",
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "An account with this email already exists",
    });
  });

  it("POST /api/auth/register rejects passwords shorter than 8 characters", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const email = `val-pw-${crypto.randomUUID()}@example.com`;
    const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "short",
      displayName: "Test",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
    expect(res.body.error).toMatch(/8/);
  });

  it("POST /api/auth/register rejects invalid email format", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email: "not-an-email",
      password: "long-enough-pw",
      displayName: "Test",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("POST /api/auth/register accepts valid 8+ char password", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const email = `val-ok-${crypto.randomUUID()}@example.com`;
    const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "exactly8",
      displayName: "Test",
    });
    expect(res.status).toBe(201);
  });

  it("POST /api/auth/login uses auth lookup and returns user without password hash", async () => {
    const app = testApp();
    const regAgent = request.agent(app);
    const regCsrf = await withCsrf(regAgent);
    const email = `route-login-${crypto.randomUUID()}@example.com`;
    const password = "login-secret-xyz";
    await regAgent.post("/api/auth/register").set("X-CSRF-Token", regCsrf).send({
      email,
      password,
      displayName: "Login User",
    });

    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const res = await agent.post("/api/auth/login").set("X-CSRF-Token", csrf).send({
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
    const regAgent = request.agent(app);
    const regCsrf = await withCsrf(regAgent);
    const email = `route-bad-pw-${crypto.randomUUID()}@example.com`;
    await regAgent.post("/api/auth/register").set("X-CSRF-Token", regCsrf).send({
      email,
      password: "right-password",
      displayName: "X",
    });

    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const res = await agent.post("/api/auth/login").set("X-CSRF-Token", csrf).send({
      email,
      password: "wrong-password",
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid email or password" });
  });

  it("login endpoint returns 429 after too many failed attempts", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const email = `rate-${crypto.randomUUID()}@example.com`;

    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await agent
        .post("/api/auth/login")
        .set("X-CSRF-Token", csrf)
        .send({ email, password: "wrong-password-here" });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it("POST /api/auth/login returns the same safe error for unknown email as for wrong password", async () => {
    const app = testApp();
    const agent1 = request.agent(app);
    const csrf1 = await withCsrf(agent1);
    const email = `route-no-user-${crypto.randomUUID()}@example.com`;
    const unknown = await agent1.post("/api/auth/login").set("X-CSRF-Token", csrf1).send({
      email,
      password: "any-password",
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: "Invalid email or password" });

    const agent2 = request.agent(app);
    const csrf2 = await withCsrf(agent2);
    const registered = `route-known-${crypto.randomUUID()}@example.com`;
    await agent2.post("/api/auth/register").set("X-CSRF-Token", csrf2).send({
      email: registered,
      password: "secret-pw",
      displayName: "Y",
    });
    const agent3 = request.agent(app);
    const csrf3 = await withCsrf(agent3);
    const wrongPw = await agent3.post("/api/auth/login").set("X-CSRF-Token", csrf3).send({
      email: registered,
      password: "wrong",
    });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body).toEqual(unknown.body);
  });

  it("POST /api/auth/logout destroys the session fully", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const email = `route-logout-${crypto.randomUUID()}@example.com`;
    await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "test-pw-99",
      displayName: "L",
    });
    const logoutRes = await agent.post("/api/auth/logout").set("X-CSRF-Token", csrf).expect(204);
    expect(logoutRes.headers["set-cookie"]).toBeDefined();

    const me = await agent.get("/api/auth/me");
    expect(me.body).toEqual({ authenticated: false });

    const accounts = await agent.get("/api/accounts");
    expect(accounts.status).toBe(401);
    expect(accounts.body).toEqual({ error: "Unauthorized" });
  });

  it("GET /api/accounts returns 401 when unauthenticated", async () => {
    const app = testApp();
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("GET /api/accounts returns an empty list for a new user (onboarding detection)", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const email = `route-acct-${crypto.randomUUID()}@example.com`;
    await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "test-pw-99",
      displayName: "Acct",
    });

    const res = await agent.get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: [] });
  });

  it("POST /api/accounts creates an account and GET lists it in stable order", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const email = `route-acct2-${crypto.randomUUID()}@example.com`;
    await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
      email,
      password: "test-pw-99",
      displayName: "Acct2",
    });

    const created = await agent.post("/api/accounts").set("X-CSRF-Token", csrf).send({
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
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const res = await agent.post("/api/accounts").set("X-CSRF-Token", csrf).send({ label: "X" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("mutating requests without CSRF token return 403", async () => {
    const app = testApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "a@b.com", password: "12345678" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  it("mutating requests with valid CSRF token succeed", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);

    const email = `csrf-${crypto.randomUUID()}@example.com`;
    const res = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        email,
        password: "secure-password",
        displayName: "CSRF Test",
      });
    expect(res.status).toBe(201);
  });
});
