/**
 * Async AI worker tests (Async AI PR2).
 *
 * Mock the storage layer and ai-classifier at the boundary so we can
 * assert the worker's state-machine transitions and chunked progress
 * without spinning up Postgres or hitting OpenAI. Real DB integration
 * is exercised end-to-end via routes.test.ts when
 * POCKETPULSE_STORAGE_TESTS=1.
 *
 * What is pinned:
 *   1. Empty pool → status flips straight to "complete".
 *   2. Missing OPENAI_API_KEY → status flips to "failed" with a clear
 *      error and the AI batch is never invoked.
 *   3. Happy path: status walks pending → processing → complete, every
 *      chunk yields a bulkUpdateTransactions call with labelSource="ai",
 *      and aiRowsDone is incremented per chunk.
 *   4. AI returning empty for every chunk → status flips to "failed".
 *   5. Concurrency guard: a second invocation while one is already in
 *      flight resolves immediately as "skipped".
 *   6. The worker never throws, even when the underlying storage call
 *      rejects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ai-classifier.js", () => ({
  aiClassifyBatch: vi.fn(),
}));

vi.mock("./storage.js", () => ({
  countNeedsAiForUpload: vi.fn(),
  listNeedsAiTransactionsForUpload: vi.fn(),
  bulkUpdateTransactions: vi.fn().mockResolvedValue(undefined),
  batchUpsertMerchantClassifications: vi.fn().mockResolvedValue(undefined),
  getUserCorrectionExamples: vi.fn().mockResolvedValue([]),
  updateUploadAiStatus: vi.fn().mockResolvedValue(null),
  incrementUploadAiRowsDone: vi.fn().mockResolvedValue(undefined),
}));

import { aiClassifyBatch } from "./ai-classifier.js";
import {
  bulkUpdateTransactions,
  countNeedsAiForUpload,
  incrementUploadAiRowsDone,
  listNeedsAiTransactionsForUpload,
  updateUploadAiStatus,
} from "./storage.js";
import { runUploadAiWorker } from "./aiWorker.js";

const mockedAi = vi.mocked(aiClassifyBatch);
const mockedCount = vi.mocked(countNeedsAiForUpload);
const mockedList = vi.mocked(listNeedsAiTransactionsForUpload);
const mockedBulkUpdate = vi.mocked(bulkUpdateTransactions);
const mockedUpdateStatus = vi.mocked(updateUploadAiStatus);
const mockedIncrement = vi.mocked(incrementUploadAiRowsDone);

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    merchant: "Netflix",
    rawDescription: "NETFLIX 800-555",
    amount: "-15.99",
    flowType: "outflow",
    category: "other",
    transactionClass: "expense",
    recurrenceType: "one-time",
    labelSource: "rule",
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof listNeedsAiTransactionsForUpload>>[number];
}

function makeAiResult(index: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    index,
    category: "entertainment",
    transactionClass: "expense",
    recurrenceType: "recurring",
    labelConfidence: 0.92,
    labelReason: "AI: streaming subscription",
    ...overrides,
  } as unknown as Parameters<typeof Map.prototype.set>[1];
}

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

describe("runUploadAiWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  });

  it("flips an empty pool straight to complete and never calls AI", async () => {
    mockedCount.mockResolvedValue(0);

    const out = await runUploadAiWorker(1, 100);

    expect(out.status).toBe("complete");
    expect(out.rowsProcessed).toBe(0);
    expect(mockedAi).not.toHaveBeenCalled();
    expect(mockedUpdateStatus).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ aiStatus: "complete", aiRowsPending: 0 }),
    );
  });

  it("marks the upload failed when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    mockedCount.mockResolvedValue(3);

    const out = await runUploadAiWorker(1, 200);

    expect(out.status).toBe("failed");
    expect(mockedAi).not.toHaveBeenCalled();
    const failedCall = mockedUpdateStatus.mock.calls.find(
      (c) => c[1].aiStatus === "failed",
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![1].aiError).toMatch(/OPENAI_API_KEY/);
  });

  it("walks pending → processing → complete and writes ai labels per chunk", async () => {
    mockedCount.mockResolvedValue(2);
    mockedList.mockResolvedValue([
      makeRow({ id: 11 }),
      makeRow({ id: 12, merchant: "Spotify" }),
    ]);
    mockedAi.mockResolvedValue(
      new Map([[0, makeAiResult(0)], [1, makeAiResult(1)]]) as never,
    );

    const out = await runUploadAiWorker(7, 300);

    expect(out.status).toBe("complete");
    expect(out.rowsProcessed).toBe(2);

    // Status transitions: processing first, then complete.
    const statuses = mockedUpdateStatus.mock.calls.map((c) => c[1].aiStatus);
    expect(statuses).toContain("processing");
    expect(statuses[statuses.length - 1]).toBe("complete");

    // Both rows promoted to labelSource="ai".
    expect(mockedBulkUpdate).toHaveBeenCalledTimes(1);
    const updates = mockedBulkUpdate.mock.calls[0]![1];
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ id: 11, labelSource: "ai", category: "entertainment" });
    expect(updates[1]).toMatchObject({ id: 12, labelSource: "ai" });

    // Progress counter advanced by chunk size.
    expect(mockedIncrement).toHaveBeenCalledWith(300, 2);
  });

  it("flips status to failed when every chunk returns no AI results", async () => {
    mockedCount.mockResolvedValue(1);
    mockedList.mockResolvedValue([makeRow()]);
    mockedAi.mockResolvedValue(new Map() as never);

    const out = await runUploadAiWorker(1, 400);

    expect(out.status).toBe("failed");
    expect(mockedBulkUpdate).not.toHaveBeenCalled();
    const failedCall = mockedUpdateStatus.mock.calls.find(
      (c) => c[1].aiStatus === "failed",
    );
    expect(failedCall).toBeDefined();
  });

  it("guards against double-spawn for the same uploadId", async () => {
    mockedCount.mockResolvedValue(1);
    mockedList.mockResolvedValue([makeRow()]);

    // Build the deferred up front so `resolveAi` is always defined even if
    // the second `runUploadAiWorker` call resolves before the first one
    // reaches `aiClassifyBatch`.
    let resolveAi!: (v: Map<number, unknown>) => void;
    const aiPromise = new Promise<Map<number, unknown>>((resolve) => {
      resolveAi = resolve;
    });
    mockedAi.mockReturnValue(aiPromise as never);

    const first = runUploadAiWorker(1, 500);
    // Second call lands while the first is still mid-flight (the in-flight
    // Set is populated synchronously before the first await suspends).
    const second = await runUploadAiWorker(1, 500);
    expect(second.status).toBe("skipped");

    resolveAi(new Map([[0, makeAiResult(0)]]));
    const firstResult = await first;
    expect(firstResult.status).toBe("complete");
  });

  it("captures internal errors as a failed status instead of throwing", async () => {
    mockedCount.mockRejectedValueOnce(new Error("boom"));

    const out = await runUploadAiWorker(1, 600);

    expect(out.status).toBe("failed");
    expect(out.error).toBe("boom");
    // Final status write must record the failure so pollers see it.
    const failedCall = mockedUpdateStatus.mock.calls.find(
      (c) => c[1].aiStatus === "failed",
    );
    expect(failedCall).toBeDefined();
  });
});
