/**
 * Password reset route tests.
 *
 * Mocks storage, db, auth, csrf, and the Resend client so we can exercise
 * the HTTP shape (anti-enumeration, atomic consume + update, etc.)
 * without touching PostgreSQL or sending real email.
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

// Disable CSRF so tests can post without juggling cookies.
vi.mock("./csrf.js", () => ({
  doubleCsrfProtection: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  generateToken: () => "test-token",
  invalidCsrfTokenError: new Error("invalid csrf"),
}));

const sendMock = vi.fn().mockResolvedValue({ id: "msg_1" });
vi.mock("./resend.js", () => ({
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
import { createApp } from "./routes.js";

const mockedGetUser = vi.mocked(getUserByEmailForAuth);
const mockedIssue = vi.mocked(issuePasswordResetToken);
const mockedConsume = vi.mocked(consumePasswordResetTokenAndUpdatePassword);
const mockedCleanup = vi.mocked(deleteExpiredPasswordResetTokens);

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
    sendMock.mockResolvedValue({ id: "msg_1" });
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

  it("issues a token (invalidating older ones) and sends email when the user exists", async () => {
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
    const [userId, tokenHash, expiresAt] = mockedIssue.mock.calls[0]!;
    expect(userId).toBe(42);
    // SHA-256 hex is 64 chars — confirms we hashed before storing.
    expect(typeof tokenHash).toBe("string");
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
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
    expect(sendArg.html).toMatch(/reset-password\?token=/);
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
      /https:\/\/pocket-pulse\.com\/reset-password\?token=/,
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
      /https:\/\/app\.example\.test\/reset-password\?token=/,
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
      .send({ token: "abc", newPassword: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/);
    expect(mockedConsume).not.toHaveBeenCalled();
  });

  it("returns 400 with a generic message when the token cannot be consumed", async () => {
    mockedConsume.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "deadbeef", newPassword: "longenough" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired or already been used/i);
  });

  it("hashes the token (SHA-256 hex) before passing it to the storage layer", async () => {
    mockedConsume.mockResolvedValueOnce(null);
    const app = buildApp();
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "rawtoken", newPassword: "longenough" });
    expect(mockedConsume).toHaveBeenCalledTimes(1);
    const [hashArg, pwArg] = mockedConsume.mock.calls[0]!;
    expect(hashArg).toMatch(/^[a-f0-9]{64}$/);
    // Pre-computed SHA-256 of "rawtoken"
    expect(hashArg).toBe(
      "3c2154bddfc9b3642ef800176f4b927f1275dd9880ed595a3875e0c5714d7cee",
    );
    expect(pwArg).toBe("new-bcrypt-hash");
  });

  it("returns ok when the storage layer atomically consumes the token + rotates the password", async () => {
    mockedConsume.mockResolvedValueOnce({ userId: 7 });
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "validtoken", newPassword: "newlongpassword" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedConsume).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 500 (and never a 200) when the atomic transaction throws", async () => {
    mockedConsume.mockRejectedValueOnce(new Error("db down"));
    const app = buildApp();
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "validtoken", newPassword: "newlongpassword" });
    expect(res.status).toBe(500);
  });
});
