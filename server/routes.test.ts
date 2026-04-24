import request from "supertest";
import session from "express-session";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

  describe("idle timeout (requireAuth)", () => {
    it("a request within the 30-minute window succeeds and updates lastActivity", async () => {
      const baseTime = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);
      try {
        const app = testApp();
        const agent = request.agent(app);
        const csrf = await withCsrf(agent);
        const email = `idle-ok-${crypto.randomUUID()}@example.com`;
        await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
          email,
          password: "test-pw-99",
          displayName: "Idle Test",
        });

        // First protected request at t=0 — sets lastActivity to baseTime
        const first = await agent.get("/api/accounts");
        expect(first.status).toBe(200);

        // Second request at t=+29m — within the window, succeeds, and updates lastActivity to +29m
        nowSpy.mockReturnValue(baseTime + 29 * 60 * 1000);
        const second = await agent.get("/api/accounts");
        expect(second.status).toBe(200);

        // Third request at t=+58m — this is >30m after baseTime but <30m after the second request
        // updated lastActivity to +29m. Should succeed only if lastActivity was refreshed.
        nowSpy.mockReturnValue(baseTime + 58 * 60 * 1000);
        const third = await agent.get("/api/accounts");
        expect(third.status).toBe(200);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("a request more than 30 minutes after lastActivity returns 401 with session-expired message", async () => {
      const baseTime = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);
      try {
        const app = testApp();
        const agent = request.agent(app);
        const csrf = await withCsrf(agent);
        const email = `idle-expired-${crypto.randomUUID()}@example.com`;
        await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
          email,
          password: "test-pw-99",
          displayName: "Idle Expired",
        });

        // First protected request — sets lastActivity to baseTime
        const first = await agent.get("/api/accounts");
        expect(first.status).toBe(200);

        // Advance clock to 31 minutes later (past the idle window)
        nowSpy.mockReturnValue(baseTime + 31 * 60 * 1000);
        const expired = await agent.get("/api/accounts");
        expect(expired.status).toBe(401);
        expect(expired.body).toEqual({ error: "Session expired due to inactivity" });

        // After session destruction, any subsequent request should return the generic 401
        // (session is gone, so the user is now fully signed out — not just "expired")
        const subsequent = await agent.get("/api/accounts");
        expect(subsequent.status).toBe(401);
        expect(subsequent.body).toEqual({ error: "Unauthorized" });
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("rolling: true advances the session cookie Expires date on each authenticated request", async () => {
      const baseTime = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);
      try {
        const app = testApp();
        const agent = request.agent(app);
        const csrf = await withCsrf(agent);
        const email = `idle-rolling-${crypto.randomUUID()}@example.com`;
        await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
          email,
          password: "test-pw-99",
          displayName: "Rolling Test",
        });

        function extractSidExpiry(res: { headers: Record<string, unknown> }): Date | undefined {
          const raw = res.headers["set-cookie"];
          const cookies: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
          const sid = cookies.find((c) => c.split(";")[0].trim().startsWith("pocketpulse.sid="));
          if (!sid) return undefined;
          const expiresMatch = sid.match(/expires=([^;]+)/i);
          return expiresMatch ? new Date(expiresMatch[1]) : undefined;
        }

        // First authenticated request — cookie Expires should be set to ~7 days from baseTime
        const first = await agent.get("/api/accounts");
        expect(first.status).toBe(200);
        const firstExpiry = extractSidExpiry(first);
        expect(firstExpiry, "rolling: first request must set pocketpulse.sid with Expires").toBeDefined();

        // Second request one minute later — rolling should push Expires forward by one minute
        nowSpy.mockReturnValue(baseTime + 60 * 1000);
        const second = await agent.get("/api/accounts");
        expect(second.status).toBe(200);
        const secondExpiry = extractSidExpiry(second);
        expect(secondExpiry, "rolling: second request must re-send pocketpulse.sid with Expires").toBeDefined();

        // Expires on the second response must be later than on the first
        expect(secondExpiry!.getTime()).toBeGreaterThan(firstExpiry!.getTime());
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("cookie security attributes", () => {
    function findCookie(header: unknown, name: string): string | undefined {
      const cookies = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
      return (cookies as string[]).find((c) => c.split(";")[0].trim().startsWith(`${name}=`));
    }

    it("CSRF cookie has HttpOnly and SameSite=Strict", async () => {
      const app = testApp();
      const res = await request(app).get("/api/csrf-token");
      const cookie = findCookie(res.headers["set-cookie"], "pocketpulse.csrf");
      expect(cookie, "pocketpulse.csrf cookie must be present").toBeDefined();
      expect(cookie!.toLowerCase()).toContain("httponly");
      expect(cookie!.toLowerCase()).toContain("samesite=strict");
    });

    it("session cookie has HttpOnly and SameSite=Strict after login", async () => {
      const app = testApp();
      const regAgent = request.agent(app);
      const regCsrf = await withCsrf(regAgent);
      const email = `cookie-login-${crypto.randomUUID()}@example.com`;
      const password = "cookie-test-pw";
      await regAgent.post("/api/auth/register").set("X-CSRF-Token", regCsrf).send({
        email,
        password,
        displayName: "Cookie Test",
      });

      const agent = request.agent(app);
      const csrf = await withCsrf(agent);
      const res = await agent.post("/api/auth/login").set("X-CSRF-Token", csrf).send({ email, password });
      expect(res.status).toBe(200);

      const cookie = findCookie(res.headers["set-cookie"], "pocketpulse.sid");
      expect(cookie, "pocketpulse.sid cookie must be present after login").toBeDefined();
      expect(cookie!.toLowerCase()).toContain("httponly");
      expect(cookie!.toLowerCase()).toContain("samesite=strict");
    });

    it("session cookie has HttpOnly and SameSite=Strict after register", async () => {
      const app = testApp();
      const agent = request.agent(app);
      const csrf = await withCsrf(agent);
      const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
        email: `cookie-reg-${crypto.randomUUID()}@example.com`,
        password: "cookie-test-pw",
        displayName: "Cookie Reg",
      });
      expect(res.status).toBe(201);

      const cookie = findCookie(res.headers["set-cookie"], "pocketpulse.sid");
      expect(cookie, "pocketpulse.sid cookie must be present after register").toBeDefined();
      expect(cookie!.toLowerCase()).toContain("httponly");
      expect(cookie!.toLowerCase()).toContain("samesite=strict");
    });

    it("neither cookie carries Secure flag outside production", async () => {
      const app = testApp();
      const agent = request.agent(app);
      const csrf = await withCsrf(agent);
      const csrfCookie = findCookie(
        (await request(app).get("/api/csrf-token")).headers["set-cookie"],
        "pocketpulse.csrf",
      );
      expect(csrfCookie, "pocketpulse.csrf cookie must be present").toBeDefined();
      expect(csrfCookie!.toLowerCase()).not.toContain("; secure");

      const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
        email: `cookie-nosec-${crypto.randomUUID()}@example.com`,
        password: "cookie-test-pw",
        displayName: "No Secure",
      });
      const sidCookie = findCookie(res.headers["set-cookie"], "pocketpulse.sid");
      expect(sidCookie, "pocketpulse.sid cookie must be present after register").toBeDefined();
      expect(sidCookie!.toLowerCase()).not.toContain("; secure");
    });

    it("both cookies carry Secure flag in production environment", async () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origSecret = process.env.SESSION_SECRET;
      try {
        process.env.NODE_ENV = "production";
        process.env.SESSION_SECRET = "prod-test-secret-long-enough-123456";
        // Reset module cache so csrf.ts re-evaluates its module-level cookieOptions
        // with NODE_ENV=production before re-importing routes.
        vi.resetModules();
        const mod = await import("./routes.js");
        const prodApp = mod.createApp({ sessionStore: new session.MemoryStore() });

        const csrfRes = await request(prodApp).get("/api/csrf-token");
        const csrfCookie = findCookie(csrfRes.headers["set-cookie"], "pocketpulse.csrf");
        expect(csrfCookie, "CSRF cookie must be set in production").toBeDefined();
        expect(csrfCookie!.toLowerCase()).toContain("secure");

        const agent = request.agent(prodApp);
        const csrfToken = csrfRes.body.token as string;
        const regRes = await agent
          .post("/api/auth/register")
          .set("X-CSRF-Token", csrfToken)
          .set("Cookie", csrfRes.headers["set-cookie"] as string[])
          .send({
            email: `cookie-prod-${crypto.randomUUID()}@example.com`,
            password: "cookie-test-pw",
            displayName: "Prod Secure",
          });
        const sidCookie = findCookie(regRes.headers["set-cookie"], "pocketpulse.sid");
        expect(sidCookie, "session cookie must be set after register in production").toBeDefined();
        expect(sidCookie!.toLowerCase()).toContain("secure");
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origSecret !== undefined) {
          process.env.SESSION_SECRET = origSecret;
        } else {
          delete process.env.SESSION_SECRET;
        }
        // Restore original module state for subsequent tests.
        vi.resetModules();
      }
    });
  });
});
