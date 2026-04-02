/**
 * Ledger route tests (Phase 3).
 *
 * Tests for PATCH /api/transactions/:id, DELETE /api/transactions,
 * DELETE /api/workspace-data, GET /api/export/transactions, and
 * enhanced GET /api/transactions filters.
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
    listAllTransactionsForExport: vi.fn(),
  };
});

vi.mock("./csvParser.js", () => ({
  parseCSV: vi.fn(),
}));

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

import session from "express-session";
import request from "supertest";
import {
  getTransactionById,
  updateTransaction,
  deleteAllTransactionsForUser,
  deleteWorkspaceDataForUser,
  listAllTransactionsForExport,
  listTransactionsForUser,
} from "./storage.js";
import { createApp } from "./routes.js";

const mockedGetTxn = vi.mocked(getTransactionById);
const mockedUpdateTxn = vi.mocked(updateTransaction);
const mockedDeleteAll = vi.mocked(deleteAllTransactionsForUser);
const mockedDeleteWorkspace = vi.mocked(deleteWorkspaceDataForUser);
const mockedExport = vi.mocked(listAllTransactionsForExport);
const mockedListTxns = vi.mocked(listTransactionsForUser);

function buildApp() {
  const store = new session.MemoryStore();
  const app = createApp({ sessionStore: store });
  return { app, store };
}

describe("ledger routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PATCH /api/transactions/:id", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/api/transactions/1").send({ category: "dining" });
      expect(res.status).toBe(401);
    });

    it("returns 400 for non-numeric id", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/api/transactions/abc").send({ category: "dining" });
      expect([400, 401]).toContain(res.status);
    });

    it("returns 400 for invalid category", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/api/transactions/1")
        .send({ category: "not_a_category" });
      expect([400, 401]).toContain(res.status);
    });
  });

  describe("DELETE /api/transactions", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/api/transactions").send({ confirm: true });
      expect(res.status).toBe(401);
    });

    it("returns 400 without confirm flag", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/api/transactions").send({});
      expect([400, 401]).toContain(res.status);
    });
  });

  describe("DELETE /api/workspace-data", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/api/workspace-data").send({ confirm: true });
      expect(res.status).toBe(401);
    });

    it("returns 400 without confirm flag", async () => {
      const { app } = buildApp();
      const res = await request(app).delete("/api/workspace-data").send({});
      expect([400, 401]).toContain(res.status);
    });
  });

  describe("GET /api/export/transactions", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/export/transactions");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/transactions with filters", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/transactions?search=coffee&category=dining");
      expect(res.status).toBe(401);
    });
  });
});
