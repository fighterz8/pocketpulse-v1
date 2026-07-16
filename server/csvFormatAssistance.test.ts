import { describe, expect, it, vi } from "vitest";

vi.mock("./db.js", () => ({ pool: {} }));

import { AiBudgetExceededError } from "./aiAccounting.js";
import {
  processCsvFormatAssistance,
  type CsvFormatAssistanceDependencies,
} from "./csvFormatAssistance.js";

const SPEC = {
  preambleRows: 0,
  hasHeader: true,
  dateColumn: 0,
  descriptionColumn: 1,
  amountColumn: 2,
  debitColumn: null,
  creditColumn: null,
  typeColumn: null,
  signConvention: "signed" as const,
};

const USAGE = {
  inputTokens: 120,
  cachedInputTokens: 20,
  uncachedInputTokens: 100,
  outputTokens: 80,
  reasoningOutputTokens: 10,
  totalTokens: 200,
};

function dependencies(
  overrides: Partial<CsvFormatAssistanceDependencies> = {},
): CsvFormatAssistanceDependencies {
  return {
    claim: vi.fn(async () => ({
      state: "claimed" as const,
      attemptId: "attempt-1",
      leaseExpiresAt: new Date("2026-07-16T20:01:00Z"),
      staleReservationId: null,
    })),
    attachReservation: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => true),
    failClaim: vi.fn(async () => new Date("2026-07-16T20:15:00Z")),
    completeClaim: vi.fn(async () => true),
    reserveBudget: vi.fn(async () => ({
      reservationId: "attempt-1",
      status: "active" as const,
      reservedCostMicrousd: 100,
      finalCostMicrousd: null,
    })),
    reconcileBudget: vi.fn(async () => ({
      reservationId: "attempt-1",
      status: "committed" as const,
      finalCostMicrousd: 10,
      usageEventId: 1,
      alreadyReconciled: false,
    })),
    acquireLease: vi.fn(async () => ({
      acquired: true,
      leaseId: "lease-1",
      expiresAt: new Date("2026-07-16T20:01:00Z"),
      alreadyHeld: false,
    })),
    renewLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => true),
    detect: vi.fn(async () => ({
      data: SPEC,
      provider: "openai" as const,
      providerRequestId: "req_csv_1",
      model: "gpt-5-nano",
      operation: "csv_format_detection" as const,
      latencyMs: 25,
      usage: USAGE,
      pricingVersion: "openai-standard-2026-07-15",
      costMicrousd: 10,
    })),
    ...overrides,
  };
}

function input(deps: CsvFormatAssistanceDependencies) {
  return {
    userId: 1,
    accountId: 2,
    uploadId: 3,
    headerFingerprint: "a".repeat(64),
    sampleRows: [["Date", "Description", "Amount"]],
    transport: vi.fn(async () => ({})),
    providerEnabled: true,
    acceptSpec: vi.fn(async () => true),
    dependencies: deps,
  };
}

describe("CSV format assistance orchestration", () => {
  it("reserves, acquires capacity, reconciles actual usage, and caches only an accepted spec", async () => {
    const deps = dependencies();
    const request = input(deps);
    const result = await processCsvFormatAssistance(request);

    expect(result).toEqual({ state: "resolved", spec: SPEC });
    expect(deps.reserveBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        accountId: 2,
        uploadId: 3,
        operation: "csv_format_detection",
        model: "gpt-5-nano",
      }),
    );
    expect(deps.detect).toHaveBeenCalledTimes(1);
    expect(deps.reconcileBudget).toHaveBeenCalledWith({
      reservationId: "attempt-1",
      outcome: expect.objectContaining({
        type: "actual",
        attemptStatus: "succeeded",
        providerRequestId: "req_csv_1",
        usage: USAGE,
      }),
    });
    expect(request.acceptSpec).toHaveBeenCalledWith(SPEC);
    expect(deps.completeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ spec: SPEC }),
    );
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("returns a persisted cooldown without reserving or calling the provider", async () => {
    const retryAfter = new Date("2026-07-16T20:15:00Z");
    const deps = dependencies({
      claim: vi.fn(async () => ({
        state: "cooldown" as const,
        retryAfter,
        failureCode: "FORMAT_NOT_RECOGNIZED",
      })),
    });
    const result = await processCsvFormatAssistance(input(deps));

    expect(result).toEqual({
      state: "cooldown",
      retryAfter,
      code: "FORMAT_NOT_RECOGNIZED",
    });
    expect(deps.reserveBudget).not.toHaveBeenCalled();
    expect(deps.detect).not.toHaveBeenCalled();
  });

  it("releases the claim and makes no provider call when budget is blocked", async () => {
    const deps = dependencies({
      reserveBudget: vi.fn(async () => {
        throw new AiBudgetExceededError("user", "day");
      }),
    });
    const result = await processCsvFormatAssistance(input(deps));

    expect(result).toEqual({ state: "budget_blocked" });
    expect(deps.releaseClaim).toHaveBeenCalledTimes(1);
    expect(deps.acquireLease).not.toHaveBeenCalled();
    expect(deps.detect).not.toHaveBeenCalled();
  });

  it("records a negative result after actual provider usage when the spec cannot parse", async () => {
    const deps = dependencies();
    const request = { ...input(deps), acceptSpec: vi.fn(async () => false) };
    const result = await processCsvFormatAssistance(request);

    expect(result).toEqual({
      state: "not_resolved",
      retryAfter: new Date("2026-07-16T20:15:00Z"),
    });
    expect(deps.reconcileBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({ type: "actual" }),
      }),
    );
    expect(deps.failClaim).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "FORMAT_NOT_RECOGNIZED" }),
    );
    expect(deps.completeClaim).not.toHaveBeenCalled();
  });

  it("conservatively accounts an unknown provider outcome and applies cooldown", async () => {
    const deps = dependencies({
      detect: vi.fn(async () => {
        throw new Error("transport failed after dispatch");
      }),
    });
    const result = await processCsvFormatAssistance(input(deps));

    expect(result).toEqual({
      state: "unavailable",
      retryAfter: new Date("2026-07-16T20:15:00Z"),
    });
    expect(deps.reconcileBudget).toHaveBeenCalledWith({
      reservationId: "attempt-1",
      outcome: {
        type: "reserved_unknown",
        errorCode: "FORMAT_PROVIDER_OUTCOME_UNKNOWN",
      },
    });
    expect(deps.failClaim).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "FORMAT_PROVIDER_UNAVAILABLE" }),
    );
    expect(deps.releaseLease).toHaveBeenCalledTimes(1);
  });
});
