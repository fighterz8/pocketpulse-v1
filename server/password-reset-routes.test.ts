/**
 * Password reset route tests.
 *
 * Mocks storage, db, auth, csrf, and the Resend client so we can exercise
 * the HTTP shape (anti-enumeration, atomic consume + update, rate-limit,
 * CSRF policy) without touching PostgreSQL or sending real email.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage.js")>();
  return {
    ...original,
    getUserByEmailForAuth: vi.fn(),
    issuePasswordResetToken: vi.fn(),
    consumePasswordResetTokenAndUpdatePassword: vi.fn(),
    deleteExpiredPasswordResetTokens: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./db.js", () => ({
  db: {},
  pool: {},
  ensureUserPreferences: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("new-bcrypt-hash"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  normalizeEmail: vi.fn((e: string) => e.toLowerCase().trim()),
}));

// Disable CSRF in tests so we can post without juggling cookies. The
// middleware is exposed as a vi.fn() spy (default impl: pass through)
// so one dedicated test can assert that POST /api/auth/forgot-password
// never invokes it (i.e. the route is exempt at the express layer).
vi.mock("./csrf.js", () => ({
  doubleCsrfProtection: vi.fn(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
  generateToken: () => "test-token",
  invalidCsrfTokenError: new Error("invalid csrf"),
}));

const sendMock = vi
  .fn()
  .mockResolvedValue({ data: { id: "msg_1" }, error: null });
vi.mock("./resend.js", () => ({
  assertResendSendSucceeded: (result: {
    data: { id: string } | null;
    error: { message: string } | null;
  }) => {
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("missing email data");
    return result.data;
  },
  formatFromEmail: (fromEmail: string) =>
    fromEmail.includes("<") ? fromEmail : `PocketPulse <${fromEmail}>`,
  getUncachableResendClient: vi.fn(async () => ({
    client: { emails: { send: sendMock } },
    fromEmail: "noreply@pocket-pulse.com",
  })),
}));

import session from "express-session";
import request from "supertest";
import {
  consumePasswordResetTokenAndUpdatePassword,
  deleteExpiredPasswordResetTokens,
  getUserByEmailForAuth,
  issuePasswordResetToken,
} from "./storage.js";
import { doubleCsrfProtection } from "./csrf.js";
import { createApp } from "./routes.js";

const mockedGetUser = vi.mocked(getUserByEmailForAuth);
const mockedIssue = vi.mocked(issuePasswordResetToken);
const mockedConsume = vi.mocked(consumePasswordResetTokenAndUpdatePassword);
const mockedCleanup = vi.mocked(deleteExpiredPasswordResetTokens);
const mockedCsrf = vi.mocked(doubleCsrfProtection);

function buildApp() {
  const store = new session.MemoryStore();
  return createApp({ sessionStore: store });
}

describe("POST /api/auth/forgot-password", () => {
  const ORIGINAL_PUBLIC_APP_URL = process.env.PUBLIC_APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedCleanup.mockResolvedValue(undefined);
    sendMock.mockClear();
    sendMock.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    delete process.env.PUBLIC_APP_URL;
  });

  afterEach(() => {
    if (ORIGINAL_PUBLIC_APP_URL === undefined) {
      delete process.env.PUBLIC_APP_URL;
    } else {
      process.env.PUBLIC_APP_URL = ORIGINAL_PUBLIC_APP_URL;
    }
  });

  it("returns generic ok when no email is provided (anti-enumeration)", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/auth/forgot-password").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedGetUser).not.toHaveBeenCalled();
    expect(mockedIssue).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns generic ok when the email does not match a user (anti-enumeration)", async () => {
    mockedGetUser.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "ghost@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedIssue).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("issues a token (invalidating older ones) and emails a <id>.<verifier> URL when the user exists", async () => {
    mockedGetUser.mockResolvedValueOnce({
      id: 42,
      email: "alice@example.com",
      passwordHash: "hash",
    });
    mockedIssue.mockResolvedValueOnce({
      id: 1,
      userId: 42,
      tokenHash: "stored-hash",
      expiresAt: new Date(),
      usedAt: null,
      createdAt: new Date(),
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "Alice@Example.com  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedIssue).toHaveBeenCalledTimes(1);
    const [userId, verifierHash, expiresAt] = mockedIssue.mock.calls[0]!;
    expect(userId).toBe(42);
    // SHA-256 hex is 64 chars — confirms we hashed the verifier before
    // storing.
    expect(typeof verifierHash).toBe("string");
    expect(verifierHash).toMatch(/^[a-f0-9]{64}$/);
    expect(expiresAt).toBeInstanceOf(Date);
    // ~30 minutes in the future.
    const deltaMin = (expiresAt.getTime() - Date.now()) / 60000;
    expect(deltaMin).toBeGreaterThan(28);
    expect(deltaMin).toBeLessThan(32);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArg = sendMock.mock.calls[0]![0] as {
      from: string;
      to: string;
      subject: string;
      html: string;
    };
    expect(sendArg.from).toBe("PocketPulse <noreply@pocket-pulse.com>");
    expect(sendArg.to).toBe("alice@example.com");
    expect(sendArg.subject).toMatch(/reset/i);
    // Token in URL must be the selector/verifier composite, not the
    // raw verifier alone, so the reset endpoint can locate the row by
    // primary key.
    const tokenMatch = sendArg.html.match(
      /reset-password\?token=([0-9]+)\.([a-f0-9]{64})/,
    );
    expect(tokenMatch, "URL must include <id>.<verifier>").not.toBeNull();
    expect(tokenMatch![1]).toBe(String(1)); // selector = issued row id
  });

  it("uses the canonical https://pocket-pulse.com origin when PUBLIC_APP_URL is unset (no Host-header fallback)", async () => {
    mockedGetUser.mockResolvedValueOnce({
      id: 11,
      email: "a@b.com",
      passwordHash: "h",
    });
    mockedIssue.mockResolvedValueOnce({
      id: 99,
      userId: 11,
      tokenHash: "x",
      expiresAt: new Date(),
      usedAt: null,
      createdAt: new Date(),
    });
    const app = buildApp();
    await request(app)
      .post("/api/auth/forgot-password")
      .set("Host", "evil.attacker.example")
      .send({ email: "a@b.com" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArg = sendMock.mock.calls[0]![0] as { html: string; text: string };
    expect(sendArg.html).toMatch(
      /https:\/\/pocket-pulse\.com\/reset-password\?token=99\./,
    );
    expect(sendArg.html).not.toMatch(/evil\.attacker/);
    expect(sendArg.text).not.toMatch(/evil\.attacker/);
  });

  it("uses PUBLIC_APP_URL when set", async () => {
    process.env.PUBLIC_APP_URL = "https://app.example.test/";
    mockedGetUser.mockResolvedValueOnce({
      id: 11,
      email: "a@b.com",
      passwordHash: "h",
    });
    mockedIssue.mockResolvedValueOnce({
      id: 99,
      userId: 11,
      tokenHash: "x",
      expiresAt: new Date(),
      usedAt: null,
      createdAt: new Date(),
    });
    const app = buildApp();
    await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "a@b.com" });
    const sendArg = sendMock.mock.calls[0]![0] as { html: string };
    expect(sendArg.html).toMatch(
      /https:\/\/app\.example\.test\/reset-password\?token=99\./,
    );
  });

  it("still returns ok if the email send fails (no info leak)", async () => {
    mockedGetUser.mockResolvedValueOnce({
      id: 7,
      email: "bob@example.com",
      passwordHash: "hash",
    });
    mockedIssue.mockResolvedValueOnce({
      id: 2,
      userId: 7,
      tokenHash: "x",
      expiresAt: new Date(),
      usedAt: null,
      createdAt: new Date(),
    });
    sendMock.mockRejectedValueOnce(new Error("resend down"));
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "bob@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("still returns ok when Resend resolves with an API error", async () => {
    mockedGetUser.mockResolvedValueOnce({
      id: 8,
      email: "carol@example.com",
      passwordHash: "hash",
    });
    mockedIssue.mockResolvedValueOnce({
      id: 3,
      userId: 8,
      tokenHash: "x",
      expiresAt: new Date(),
      usedAt: null,
      createdAt: new Date(),
    });
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { message: "Domain not verified" },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "carol@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("never invokes CSRF protection (the route is exempt)", async () => {
    // Each request that flows through the global CSRF mount calls this
    // spy. Forgot-password must NOT — that's the whole point of being
    // CSRF-exempt at the express layer.
    mockedGetUser.mockResolvedValueOnce(null);
    const app = buildApp();
    // Capture only the calls produced by *this* request.
    mockedCsrf.mockClear();
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "ghost@example.com" });
    expect(res.status).toBe(200);
    const csrfCallsForForgot = mockedCsrf.mock.calls.filter(
      (c) =>
        (c[0] as { method?: string; path?: string }).method === "POST" &&
        (c[0] as { method?: string; path?: string }).path ===
          "/api/auth/forgot-password",
    );
    expect(csrfCallsForForgot).toHaveLength(0);
  });

  it("DOES invoke CSRF protection for POST /api/auth/reset-password (companion)", async () => {
    // Counter-test: confirm the exemption is scoped to forgot-password
    // alone and the reset endpoint still runs through the middleware.
    mockedConsume.mockResolvedValueOnce(null);
    const app = buildApp();
    mockedCsrf.mockClear();
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "1.deadbeef", newPassword: "longenough" });
    const csrfCallsForReset = mockedCsrf.mock.calls.filter(
      (c) =>
        (c[0] as { method?: string; path?: string }).method === "POST" &&
        (c[0] as { method?: string; path?: string }).path ===
          "/api/auth/reset-password",
    );
    expect(csrfCallsForReset.length).toBeGreaterThan(0);
  });

  it("rate-limits at the 6th request from the same IP within the window", async () => {
    // Limiter is 5 / 15 min per IP. supertest opens an ephemeral server
    // and reuses 127.0.0.1, so all 6 requests share an IP key.
    mockedGetUser.mockResolvedValue(null);
    const app = buildApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: `t${i}@example.com` });
      statuses.push(res.status);
    }
    // First 5 succeed (anti-enumeration generic ok), 6th must be
    // rejected by the limiter.
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});

describe("POST /api/auth/reset-password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when token is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "longenough" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
    expect(mockedConsume).not.toHaveBeenCalled();
  });

  it("returns 400 when newPassword is too short", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "1.abc", newPassword: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/);
    expect(mockedConsume).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens (no dot, bad id, empty verifier) without hitting storage", async () => {
    const app = buildApp();
    for (const bad of ["nodothere", ".verifieronly", "5.", "abc.def", "0.x"]) {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: bad, newPassword: "longenough" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/expired or already been used/i);
    }
    expect(mockedConsume).not.toHaveBeenCalled();
  });

  it("returns 400 with a generic message when the token cannot be consumed", async () => {
    mockedConsume.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "1.deadbeef", newPassword: "longenough" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired or already been used/i);
  });

  it("parses <id>.<verifier> and forwards (tokenId, sha256(verifier), passwordHash) to storage", async () => {
    mockedConsume.mockResolvedValueOnce(null);
    const app = buildApp();
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "42.rawverifier", newPassword: "longenough" });
    expect(mockedConsume).toHaveBeenCalledTimes(1);
    const [tokenIdArg, hashArg, pwArg] = mockedConsume.mock.calls[0]!;
    expect(tokenIdArg).toBe(42);
    expect(hashArg).toMatch(/^[a-f0-9]{64}$/);
    // Pre-computed SHA-256 of "rawverifier"
    expect(hashArg).toBe(
      "800932813b755a2395e5837ecb8270cc816aff33cb1f07b193f3ebd4395d7213",
    );
    expect(pwArg).toBe("new-bcrypt-hash");
  });

  it("returns ok when the storage layer atomically consumes the token + rotates the password", async () => {
    mockedConsume.mockResolvedValueOnce({ userId: 7 });
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "7.validverifier", newPassword: "newlongpassword" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedConsume).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 500 (and never a 200) when the atomic transaction throws", async () => {
    mockedConsume.mockRejectedValueOnce(new Error("db down"));
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "7.validverifier", newPassword: "newlongpassword" });
    expect(res.status).toBe(500);
  });

  it("rate-limits at the 6th request from the same IP within the window", async () => {
    // Limiter is 5 / 15 min per IP, shared across both reset endpoints.
    mockedConsume.mockResolvedValue(null);
    const app = buildApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: `${i + 1}.deadbeef`, newPassword: "longenough" });
      statuses.push(res.status);
    }
    // First 5 are processed (and return 400 because consume returns null),
    // 6th must hit the limiter.
    expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
