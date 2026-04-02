/**
 * Recurring route tests (Phase 4).
 *
 * Tests for GET /api/recurring-candidates, PATCH /api/recurring-reviews/:candidateKey,
 * and GET /api/recurring-reviews.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage.js")>();
  return {
    ...original,
    listAccountsForUser: vi.fn(),
    createUpload: vi.fn(),
    updateUploadStatus: vi.fn(),
    createTransactionBatch: vi.fn(),
    listUploadsForUser: vi.fn(),
    listTransactionsForUser: vi.fn(),
    getTransactionById: vi.fn(),
    updateTransaction: vi.fn(),
    deleteAllTransactionsForUser: vi.fn(),
    deleteWorkspaceDataForUser: vi.fn(),
    listAllTransactionsForExport: vi.fn().mockResolvedValue([]),
    upsertRecurringReview: vi.fn(),
    listRecurringReviewsForUser: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./db.js", () => ({
  db: {},
  pool: {},
  ensureUserPreferences: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  normalizeEmail: vi.fn((e: string) => e.toLowerCase().trim()),
}));

vi.mock("./csvParser.js", () => ({
  parseCSV: vi.fn(),
}));

import session from "express-session";
import request from "supertest";
import { createApp } from "./routes.js";

function buildApp() {
  const store = new session.MemoryStore();
  return { app: createApp({ sessionStore: store }), store };
}

describe("recurring routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/recurring-candidates", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/recurring-candidates");
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /api/recurring-reviews/:candidateKey", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/api/recurring-reviews/netflix%7C15.99")
        .send({ status: "leak" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/recurring-reviews", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/recurring-reviews");
      expect(res.status).toBe(401);
    });
  });
});
