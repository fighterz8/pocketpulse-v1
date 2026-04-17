import { beforeEach, describe, expect, it, vi } from "vitest";
import { reclassifyTransactions } from "./reclassify.js";

vi.mock("./storage.js", () => ({
  listAllTransactionsForExport: vi.fn(),
  bulkUpdateTransactions: vi.fn().mockResolvedValue(undefined),
  getMerchantRules: vi.fn().mockResolvedValue(new Map()),
  getUserCorrectionExamples: vi.fn().mockResolvedValue([]),
  getMerchantClassifications: vi.fn().mockResolvedValue(new Map()),
  batchUpsertMerchantClassifications: vi.fn().mockResolvedValue(undefined),
  recordCacheHits: vi.fn().mockResolvedValue(undefined),
}));

import {
  listAllTransactionsForExport,
  bulkUpdateTransactions,
  getMerchantClassifications,
} from "./storage.js";

const mockList = vi.mocked(listAllTransactionsForExport);
const mockBulkUpdate = vi.mocked(bulkUpdateTransactions);
const mockGetMerchantClassifications = vi.mocked(getMerchantClassifications);

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

describe("reclassifyTransactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reclassifies unsigned Netflix from income to entertainment", async () => {
    mockList.mockResolvedValue([makeTxn({})]);
    mockBulkUpdate.mockResolvedValue(undefined);

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
  });

  it("skips transactions with no changes needed", async () => {
    mockList.mockResolvedValue([
      makeTxn({
        id: 1,
        amount: "-15.99",
        flowType: "outflow",
        transactionClass: "expense",
        category: "entertainment",
        recurrenceType: "recurring",
      }),
    ]);

    const result = await reclassifyTransactions(1);

    expect(result.total).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.updated).toBe(0);
  });

  it("returns zero counts for empty transaction list", async () => {
    mockList.mockResolvedValue([]);

    const result = await reclassifyTransactions(1);

    expect(result.total).toBe(0);
    expect(result.updated).toBe(0);
  });

  it("applies cache hit and persists labelSource='cache' without calling AI", async () => {
    // Use a description the rules classifier cannot resolve (produces category="other").
    // classifyTransaction("ACME CONSULTING SERVICES 8473", -99) → merchant="Acme Consulting Services",
    // category="other", needsAi=true, recurrenceKey → "acme consulting services".
    mockList.mockResolvedValue([
      makeTxn({
        id: 42,
        merchant: "Acme Consulting Services",
        rawDescription: "ACME CONSULTING SERVICES 8473",
        category: "income",
        transactionClass: "income",
        flowType: "inflow",
        amount: "99.00",
        labelConfidence: "0.80",
        labelSource: "rule",
      }),
    ]);
    // Cache hit for the normalized key the classifier produces.
    mockGetMerchantClassifications.mockResolvedValue(
      new Map([
        [
          "acme consulting services",
          {
            merchantKey: "acme consulting services",
            category: "fees",
            transactionClass: "expense",
            recurrenceType: "one-time",
            labelConfidence: 0.92,
            source: "ai" as const,
          },
        ],
      ]),
    );

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
