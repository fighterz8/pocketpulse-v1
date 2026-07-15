import session from "express-session";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineOutput } from "./classifyPipeline.js";

vi.mock("./storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage.js")>();
  return {
    ...original,
    createUser: vi.fn(async (input) => ({
      id: 42,
      email: String(input.email).toLowerCase().trim(),
      displayName: input.displayName,
      companyName: input.companyName ?? null,
      isDev: input.isDev ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    getUserById: vi.fn(async () => ({
      id: 42,
      email: "slice-zero@example.com",
      displayName: "Slice Zero",
      companyName: null,
      isDev: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    listAccountsForUser: vi.fn(async () => [
      { id: 7, userId: 42, label: "Checking", lastFour: "1234" },
    ]),
    createUpload: vi.fn(async () => ({ id: 555 })),
    updateUploadStatus: vi.fn(async () => undefined),
    updateUploadAiStatus: vi.fn(async () => undefined),
    createTransactionBatch: vi.fn(async () => ({
      insertedCount: 3,
      previouslyImported: 0,
      intraBatchDuplicates: 0,
      insertedUnresolvedTransactions: [
        { merchant: "SQ * NORTH STAR CAFE 0182" },
        { merchant: "North Star Cafe #9921" },
        { merchant: "MYSTERY CLOUD LLC" },
      ],
    })),
    getFormatSpec: vi.fn(async () => null),
    saveFormatSpec: vi.fn(async () => undefined),
    listNeedsAiTransactionsForUpload: vi.fn(async () => [
      { merchant: "SQ * NORTH STAR CAFE 0182" },
      { merchant: "North Star Cafe #9921" },
      { merchant: "MYSTERY CLOUD LLC" },
    ]),
    listAllTransactionsForExport: vi.fn(async () => []),
    listActiveAiUploadsForUser: vi.fn(async () => [
      {
        id: 555,
        filename: "mystery.csv",
        aiStatus: "pending",
        aiRowsPending: 3,
        aiRowsDone: 0,
        aiStartedAt: null,
        aiCompletedAt: null,
        aiError: null,
      },
    ]),
  };
});

vi.mock("./csvParser.js", () => ({
  parseCSV: vi.fn(async () => ({
    ok: true,
    rows: [
      { date: "2026-06-01", description: "NORTH STAR 0182", amount: -12 },
      { date: "2026-06-02", description: "NORTH STAR 9921", amount: -14 },
      { date: "2026-06-03", description: "MYSTERY CLOUD", amount: -9 },
    ],
    warnings: [],
    detectedSpec: {
      hasHeader: false,
      columns: {},
      dateFormat: "YYYY-MM-DD",
    },
  })),
}));

vi.mock("./csvFormatDetector.js", () => ({
  detectCsvFormat: vi.fn(async () => null),
}));

vi.mock("./classifyPipeline.js", () => ({
  classifyPipeline: vi.fn(async () => [
    unresolved("SQ * NORTH STAR CAFE 0182", -12),
    unresolved("North Star Cafe #9921", -14),
    unresolved("MYSTERY CLOUD LLC", -9),
  ]),
}));

vi.mock("./aiWorker.js", () => ({
  runUploadAiWorker: vi.fn(async () => ({
    uploadId: 555,
    status: "complete",
    rowsProcessed: 3,
  })),
}));

vi.mock("./reclassify.js", () => ({
  reclassifyTransactions: vi.fn(async () => ({
    total: 3,
    updated: 3,
    skippedUserCorrected: 0,
    unchanged: 0,
  })),
}));

vi.mock("./recurrenceDetector.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./recurrenceDetector.js")>();
  return {
    ...original,
    detectRecurringCandidates: vi.fn(() => []),
    collectRecurringTransactionIds: vi.fn(() => new Set<number>()),
    collectRecurringEvidenceTransactionIds: vi.fn(() => new Set<number>()),
  };
});

vi.mock("./db.js", () => {
  const chain = {
    set: () => chain,
    where: () => Promise.resolve([]),
  };
  return {
    db: { update: () => chain },
    pool: {},
    ensureUserPreferences: vi.fn(),
  };
});

vi.mock("./auth.js", () => ({
  hashPassword: vi.fn(async () => "hashed"),
  verifyPassword: vi.fn(async () => true),
  normalizeEmail: vi.fn((email: string) => email.toLowerCase().trim()),
}));

vi.mock("./csrf.js", () => ({
  doubleCsrfProtection: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  generateToken: () => "test-token",
  invalidCsrfTokenError: new Error("invalid csrf"),
}));

import { runUploadAiWorker } from "./aiWorker.js";
import { detectCsvFormat } from "./csvFormatDetector.js";
import { reclassifyTransactions } from "./reclassify.js";
import { createApp } from "./routes.js";
import {
  createTransactionBatch,
  getUserById,
  listNeedsAiTransactionsForUpload,
  updateUploadAiStatus,
} from "./storage.js";

const ORIGINAL_ENV = { ...process.env };

function unresolved(
  merchant: string,
  amount: number,
  options?: { legacyAiAssisted?: boolean },
): PipelineOutput {
  return {
    merchant,
    amount,
    flowType: "outflow",
    transactionClass: "expense",
    recurrenceType: "one-time",
    recurrenceSource: "none",
    category: "other",
    labelSource: "rule",
    labelConfidence: 0.4,
    labelReason: "unresolved test merchant",
    aiAssisted: options?.legacyAiAssisted ?? true,
    fromCache: false,
    needsAi: true,
  };
}

function buildApp() {
  return createApp({
    sessionStore: new session.MemoryStore(),
    runStartupJobs: false,
  });
}

async function authenticatedAgent(email = "slice-zero@example.com") {
  const agent = request.agent(buildApp());
  const response = await agent.post("/api/auth/register").send({
    email,
    password: "long-enough-password",
    displayName: "Slice Zero",
  });
  expect(response.status).toBe(201);
  return agent;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: "present-but-unused" };
  delete process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED;
  delete process.env.POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED;
  delete process.env.POCKETPULSE_FULL_RECLASSIFY_ENABLED;
  delete process.env.POCKETPULSE_DEV_TOOLS;
  delete process.env.POCKETPULSE_DEV_EMAILS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("enhancement hardening Slice 0 routes", () => {
  it("imports locally, reports unresolved merchants, and makes zero paid calls", async () => {
    vi.mocked(listNeedsAiTransactionsForUpload).mockRejectedValueOnce(
      new Error("post-insert recount unavailable"),
    );
    const agent = await authenticatedAgent();
    const response = await agent
      .post("/api/upload")
      .field("metadata", JSON.stringify({ "mystery.csv": { accountId: 7 } }))
      .attach(
        "files",
        Buffer.from("date,description,amount\n2026-06-01,Mystery,-12"),
        "mystery.csv",
      );

    expect(response.status).toBe(201);
    expect(response.body.results[0]).toMatchObject({
      status: "complete",
      unresolvedTransactionCount: 3,
      unresolvedMerchantCount: 2,
    });
    expect(detectCsvFormat).not.toHaveBeenCalled();
    expect(runUploadAiWorker).not.toHaveBeenCalled();
    expect(listNeedsAiTransactionsForUpload).not.toHaveBeenCalled();
    expect(updateUploadAiStatus).toHaveBeenCalledWith(
      555,
      expect.objectContaining({
        aiStatus: "none",
        aiRowsPending: 0,
        aiRowsDone: 0,
      }),
    );
  });

  it("persists the pipeline needsAi decision instead of the legacy aiAssisted value", async () => {
    const { classifyPipeline } = await import("./classifyPipeline.js");
    vi.mocked(classifyPipeline).mockResolvedValueOnce([
      unresolved("CLASSIFIER ERROR MERCHANT", -12, {
        legacyAiAssisted: false,
      }),
      unresolved("North Star Cafe #9921", -14),
      unresolved("MYSTERY CLOUD LLC", -9),
    ]);
    const agent = await authenticatedAgent();

    const response = await agent
      .post("/api/upload")
      .field("metadata", JSON.stringify({ "mystery.csv": { accountId: 7 } }))
      .attach(
        "files",
        Buffer.from("date,description,amount\n2026-06-01,Mystery,-12"),
        "mystery.csv",
      );

    expect(response.status).toBe(201);
    expect(createTransactionBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          merchant: "CLASSIFIER ERROR MERCHANT",
          aiAssisted: true,
        }),
      ]),
      expect.any(Set),
    );
  });

  it("keeps CSV format assistance behind its separate explicit flag", async () => {
    process.env.POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED = "true";
    const agent = await authenticatedAgent();

    const response = await agent
      .post("/api/upload")
      .field("metadata", JSON.stringify({ "mystery.csv": { accountId: 7 } }))
      .attach(
        "files",
        Buffer.from("date,description,amount\n2026-06-01,Mystery,-12"),
        "mystery.csv",
      );

    expect(response.status).toBe(201);
    expect(detectCsvFormat).toHaveBeenCalledTimes(1);
    expect(runUploadAiWorker).not.toHaveBeenCalled();
  });

  it("fails closed before provider work when a paid flag is invalid", async () => {
    process.env.POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED = "yes";
    const agent = await authenticatedAgent();

    const response = await agent
      .post("/api/upload")
      .field("metadata", JSON.stringify({ "mystery.csv": { accountId: 7 } }))
      .attach("files", Buffer.from("invalid"), "mystery.csv");

    expect(response.status).toBe(500);
    expect(detectCsvFormat).not.toHaveBeenCalled();
    expect(runUploadAiWorker).not.toHaveBeenCalled();
  });

  it("does not re-kick a legacy pending upload during status browsing", async () => {
    const agent = await authenticatedAgent();

    const response = await agent.get("/api/uploads/ai-status");

    expect(response.status).toBe(200);
    expect(runUploadAiWorker).not.toHaveBeenCalled();
    expect(response.body.uploads[0]).toMatchObject({
      uploadId: 555,
      aiStatus: "none",
    });
  });

  it("hides full-history reclassification by default", async () => {
    const agent = await authenticatedAgent();

    const response = await agent.post("/api/transactions/reclassify");

    expect(response.status).toBe(404);
    expect(reclassifyTransactions).not.toHaveBeenCalled();
  });

  it("requires both the explicit flag and dev authorization for reclassification", async () => {
    process.env.POCKETPULSE_FULL_RECLASSIFY_ENABLED = "true";
    process.env.POCKETPULSE_DEV_TOOLS = "1";
    process.env.POCKETPULSE_DEV_EMAILS = "dev-slice-zero@example.com";
    vi.mocked(getUserById)
      .mockResolvedValueOnce({
        id: 42,
        email: "ordinary@example.com",
        displayName: "Ordinary",
        companyName: null,
        isDev: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 42,
        email: "dev-slice-zero@example.com",
        displayName: "Dev",
        companyName: null,
        isDev: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const ordinary = await authenticatedAgent("ordinary@example.com");
    expect(
      (await ordinary.post("/api/transactions/reclassify")).status,
    ).toBe(404);

    const dev = await authenticatedAgent("dev-slice-zero@example.com");
    const response = await dev.post("/api/transactions/reclassify");

    expect(response.status).toBe(200);
    expect(reclassifyTransactions).toHaveBeenCalledWith(42);
  });
});
