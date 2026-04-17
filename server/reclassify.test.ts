import { beforeEach, describe, expect, it, vi } from "vitest";
import { reclassifyTransactions } from "./reclassify.js";
import type { PipelineOutput } from "./classifyPipeline.js";

// Mock classifyPipeline at the boundary — reclassify.ts owns the diff/update
// logic; the pipeline itself is tested separately in classifyPipeline.test.ts.
vi.mock("./classifyPipeline.js", () => ({
  classifyPipeline: vi.fn(),
}));

vi.mock("./storage.js", () => ({
  listAllTransactionsForExport: vi.fn(),
  bulkUpdateTransactions: vi.fn().mockResolvedValue(undefined),
}));

import { classifyPipeline } from "./classifyPipeline.js";
import {
  listAllTransactionsForExport,
  bulkUpdateTransactions,
} from "./storage.js";

const mockPipeline = vi.mocked(classifyPipeline);
const mockList = vi.mocked(listAllTransactionsForExport);
const mockBulkUpdate = vi.mocked(bulkUpdateTransactions);

function makeTxn(overrides: Record<string, unknown>) {
  return {
    id: 1,
    userId: 1,
    uploadId: 1,
    accountId: 1,
    date: "2026-01-15",
    amount: "15.99",
    merchant: "NETFLIX INC",
    rawDescription: "NETFLIX INC",
    flowType: "inflow",
    transactionClass: "income",
    category: "income",
    recurrenceType: "one-time",
    recurrenceSource: "none",
    labelSource: "rule",
    labelConfidence: "0.80",
    labelReason: "inflow",
    aiAssisted: false,
    userCorrected: false,
    excludedFromAnalysis: false,
    excludedReason: null,
    excludedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makePipelineOut(overrides: Partial<PipelineOutput> = {}): PipelineOutput {
  return {
    merchant: "Netflix Inc",
    amount: -15.99,
    flowType: "outflow",
    transactionClass: "expense",
    category: "entertainment",
    recurrenceType: "recurring",
    recurrenceSource: "hint",
    labelSource: "rule",
    labelConfidence: 0.90,
    labelReason: "classifier match",
    aiAssisted: false,
    fromCache: false,
    ...overrides,
  };
}

describe("reclassifyTransactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkUpdate.mockResolvedValue(undefined);
  });

  it("reclassifies a transaction when the pipeline returns different values", async () => {
    mockList.mockResolvedValue([makeTxn({})]);
    mockPipeline.mockResolvedValue([makePipelineOut()]);

    const result = await reclassifyTransactions(1);

    expect(result.total).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skippedUserCorrected).toBe(0);

    const calls = mockBulkUpdate.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe(1);
    const updates = calls[0]![1];
    expect(updates[0]).toMatchObject({
      id: 1,
      category: "entertainment",
      transactionClass: "expense",
      flowType: "outflow",
      amount: "-15.99",
    });
  });

  it("skips user-corrected transactions", async () => {
    mockList.mockResolvedValue([makeTxn({ id: 1, userCorrected: true })]);

    const result = await reclassifyTransactions(1);

    expect(result.total).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skippedUserCorrected).toBe(1);
    expect(mockBulkUpdate).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it("skips transactions with no changes needed", async () => {
    const txn = makeTxn({
      id: 1,
      amount: "-15.99",
      flowType: "outflow",
      transactionClass: "expense",
      category: "entertainment",
      recurrenceType: "recurring",
      recurrenceSource: "hint",
      labelSource: "rule",
      labelConfidence: "0.90",
      aiAssisted: false,
    });
    mockList.mockResolvedValue([txn]);
    mockPipeline.mockResolvedValue([
      makePipelineOut({
        amount: -15.99,
        flowType: "outflow",
        transactionClass: "expense",
        category: "entertainment",
        recurrenceType: "recurring",
        recurrenceSource: "hint",
        labelSource: "rule",
        labelConfidence: 0.90,
        aiAssisted: false,
      }),
    ]);

    const result = await reclassifyTransactions(1);

    expect(result.total).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.updated).toBe(0);
    expect(mockBulkUpdate).not.toHaveBeenCalled();
  });

  it("returns zero counts for empty transaction list", async () => {
    mockList.mockResolvedValue([]);

    const result = await reclassifyTransactions(1);

    expect(result.total).toBe(0);
    expect(result.updated).toBe(0);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it("applies cache hit and persists labelSource='cache' without calling AI", async () => {
    mockList.mockResolvedValue([
      makeTxn({
        id: 42,
        merchant: "Acme Consulting Services",
        rawDescription: "ACME CONSULTING SERVICES 8473",
        category: "income",
        transactionClass: "income",
        flowType: "inflow",
        amount: "99.00",
        labelSource: "rule",
      }),
    ]);
    mockPipeline.mockResolvedValue([
      makePipelineOut({
        merchant: "Acme Consulting Services",
        amount: -99.00,
        flowType: "outflow",
        transactionClass: "expense",
        category: "fees",
        recurrenceType: "one-time",
        recurrenceSource: "none",
        labelSource: "cache",
        labelConfidence: 0.92,
        labelReason: "cache hit: acme consulting services (ai)",
        aiAssisted: false,
        fromCache: true,
      }),
    ]);

    const result = await reclassifyTransactions(1);

    expect(result.updated).toBe(1);
    const updates = mockBulkUpdate.mock.calls[0]![1];
    expect(updates[0]).toMatchObject({
      id: 42,
      category: "fees",
      transactionClass: "expense",
      labelSource: "cache",
      aiAssisted: false,
    });
  });
});
