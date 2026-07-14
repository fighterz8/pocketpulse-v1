import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage.js")>();
  return {
    ...original,
    createUser: vi.fn(),
    listAllTransactionsForExport: vi.fn(),
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

vi.mock("./csrf.js", () => ({
  doubleCsrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  generateToken: () => "test-token",
  invalidCsrfTokenError: new Error("invalid csrf"),
}));

vi.mock("./csvParser.js", () => ({
  parseCSV: vi.fn(),
}));

import session from "express-session";
import request from "supertest";
import { createUser, listAllTransactionsForExport } from "./storage.js";
import { createApp } from "./routes.js";

const mockedCreateUser = vi.mocked(createUser);
const mockedExport = vi.mocked(listAllTransactionsForExport);

function buildApp() {
  return createApp({ sessionStore: new session.MemoryStore() });
}

function expense(
  id: number,
  date: string,
  amount: number,
  merchant: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    userId: 1,
    uploadId: 1,
    accountId: 10,
    date,
    amount: amount.toFixed(2),
    merchant,
    rawDescription: merchant,
    flowType: "outflow",
    transactionClass: "expense",
    recurrenceType: "one-time",
    recurrenceSource: "none",
    category: "software",
    labelSource: "rule",
    labelConfidence: "0.90",
    labelReason: null,
    aiAssisted: false,
    userCorrected: false,
    excludedFromAnalysis: false,
    excludedReason: null,
    excludedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function authenticatedAgent(app: ReturnType<typeof createApp>) {
  mockedCreateUser.mockResolvedValueOnce({
    id: 1,
    email: "leak-hunter@example.com",
    displayName: "Leak Hunter Tester",
    companyName: null,
    isDev: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  const agent = request.agent(app);
  const csrf = (await agent.get("/api/csrf-token")).body.token as string;
  const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({
    email: "leak-hunter@example.com",
    password: "long-enough-pw",
    displayName: "Leak Hunter Tester",
  });
  expect(res.status).toBe(201);
  return agent;
}

describe("leak hunter report route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without a session", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/leak-hunter/report");

    expect(res.status).toBe(401);
    expect(mockedExport).not.toHaveBeenCalled();
  });

  it("validates mode, accountId, and asOf query params before reading rows", async () => {
    const app = buildApp();
    const agent = await authenticatedAgent(app);

    const invalidMode = await agent.get("/api/leak-hunter/report?mode=bad");
    expect(invalidMode.status).toBe(400);
    expect(invalidMode.body).toEqual({ error: "Invalid leak hunter mode" });

    const invalidAccount = await agent.get("/api/leak-hunter/report?accountId=abc");
    expect(invalidAccount.status).toBe(400);
    expect(invalidAccount.body).toEqual({ error: "Invalid accountId" });

    const malformedAccount = await agent.get(
      "/api/leak-hunter/report?accountId=10abc",
    );
    expect(malformedAccount.status).toBe(400);
    expect(malformedAccount.body).toEqual({ error: "Invalid accountId" });

    const invalidAsOf = await agent.get("/api/leak-hunter/report?asOf=06-01-2026");
    expect(invalidAsOf.status).toBe(400);
    expect(invalidAsOf.body).toEqual({ error: "asOf must use YYYY-MM-DD format" });

    const impossibleAsOf = await agent.get(
      "/api/leak-hunter/report?asOf=2026-02-30",
    );
    expect(impossibleAsOf.status).toBe(400);
    expect(impossibleAsOf.body).toEqual({
      error: "asOf must use YYYY-MM-DD format",
    });

    expect(mockedExport).not.toHaveBeenCalled();
  });

  it("passes account filtering to storage and returns selected-account coverage", async () => {
    const app = buildApp();
    const agent = await authenticatedAgent(app);
    mockedExport.mockResolvedValueOnce([
      expense(1, "2026-05-01", 10, "Short Window"),
      expense(2, "2026-05-20", 10, "Short Window"),
    ]);

    const res = await agent.get(
      "/api/leak-hunter/report?mode=active&accountId=10&asOf=2026-06-01",
    );

    expect(res.status).toBe(200);
    expect(mockedExport).toHaveBeenCalledWith({
      userId: 1,
      accountId: 10,
      excluded: "false",
    });
    expect(res.body.coverage).toMatchObject({
      asOfDate: "2026-06-01",
      totalTransactions: 2,
      accountCount: 1,
      coverageQuality: "limited",
    });
    expect(res.body.coverage.limitations).toContain(
      "This only reflects the selected account.",
    );
  });

  it("returns active, stopped, and price-creep histories in the report envelope", async () => {
    const app = buildApp();
    const agent = await authenticatedAgent(app);
    mockedExport.mockResolvedValueOnce([
      expense(1, "2026-01-01", 10, "OpenAI"),
      expense(2, "2026-02-01", 10, "OpenAI"),
      expense(3, "2026-03-01", 10, "OpenAI"),
      expense(4, "2026-04-01", 10, "OpenAI"),
      expense(5, "2025-09-10", 25, "Old SaaS"),
      expense(6, "2025-10-10", 25, "Old SaaS"),
      expense(7, "2025-11-10", 25, "Old SaaS"),
      expense(8, "2026-01-15", 12, "Cloud Storage"),
      expense(9, "2026-02-15", 12, "Cloud Storage"),
      expense(10, "2026-03-15", 18, "Cloud Storage"),
    ]);

    const res = await agent.get("/api/leak-hunter/report?asOf=2026-04-20");

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      activeCount: 2,
      inactiveCount: 1,
      priceCreepCount: 1,
    });
    expect(res.body.sections.activeLeaks.map((finding: { merchant: string }) => finding.merchant))
      .toEqual(["Cloud Storage", "OpenAI"]);
    expect(res.body.sections.stoppedLeaks[0]).toMatchObject({
      merchant: "Old SaaS",
      status: "inactive",
    });
    expect(res.body.sections.priceCreep[0]).toMatchObject({
      merchant: "Cloud Storage",
      kind: "price_creep",
      priceChangePct: 50,
    });
    expect(res.body.coverage).toMatchObject({
      asOfDate: "2026-04-20",
      coverageQuality: "strong",
    });
  });
});
