import type { CsvFormatSpec } from "../shared/schema.js";
import {
  AiBudgetExceededError,
  reconcileAiBudgetReservation,
  reserveAiBudget,
} from "./aiAccounting.js";
import {
  acquireAiConcurrencyLease,
  releaseAiConcurrencyLease,
  renewAiConcurrencyLease,
} from "./aiConcurrencyLease.js";
import {
  attachCsvFormatReservation,
  claimCsvFormatAssistance,
  completeCsvFormatAssistanceClaim,
  failCsvFormatAssistanceClaim,
  releaseCsvFormatAssistanceClaim,
} from "./csvFormatAssistanceAttempts.js";
import { detectCsvFormat } from "./csvFormatDetector.js";
import {
  ProviderDisabledError,
  ProviderInputTooLargeError,
  type OpenAiChatTransport,
  type OpenAiStructuredResult,
} from "./openaiProvider.js";

export type CsvFormatAssistanceResult =
  | { state: "resolved"; spec: CsvFormatSpec }
  | { state: "cooldown"; retryAfter: Date; code: string }
  | { state: "busy"; retryAfter?: Date }
  | { state: "budget_blocked" }
  | { state: "not_resolved"; retryAfter: Date | null }
  | { state: "unavailable"; retryAfter: Date | null };

export type CsvFormatAssistanceDependencies = {
  claim: typeof claimCsvFormatAssistance;
  attachReservation: typeof attachCsvFormatReservation;
  releaseClaim: typeof releaseCsvFormatAssistanceClaim;
  failClaim: typeof failCsvFormatAssistanceClaim;
  completeClaim: typeof completeCsvFormatAssistanceClaim;
  reserveBudget: typeof reserveAiBudget;
  reconcileBudget: typeof reconcileAiBudgetReservation;
  acquireLease: typeof acquireAiConcurrencyLease;
  renewLease: typeof renewAiConcurrencyLease;
  releaseLease: typeof releaseAiConcurrencyLease;
  detect: typeof detectCsvFormat;
};

const DEFAULT_DEPENDENCIES: CsvFormatAssistanceDependencies = {
  claim: claimCsvFormatAssistance,
  attachReservation: attachCsvFormatReservation,
  releaseClaim: releaseCsvFormatAssistanceClaim,
  failClaim: failCsvFormatAssistanceClaim,
  completeClaim: completeCsvFormatAssistanceClaim,
  reserveBudget: reserveAiBudget,
  reconcileBudget: reconcileAiBudgetReservation,
  acquireLease: acquireAiConcurrencyLease,
  renewLease: renewAiConcurrencyLease,
  releaseLease: releaseAiConcurrencyLease,
  detect: detectCsvFormat,
};

function assertPositiveId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function assertFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError("headerFingerprint must be a lowercase SHA-256 hex digest");
  }
}

export async function processCsvFormatAssistance(input: {
  userId: number;
  accountId: number;
  uploadId: number;
  headerFingerprint: string;
  sampleRows: string[][];
  transport: OpenAiChatTransport;
  providerEnabled: boolean;
  acceptSpec: (spec: CsvFormatSpec) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  model?: string;
  dependencies?: CsvFormatAssistanceDependencies;
}): Promise<CsvFormatAssistanceResult> {
  assertPositiveId(input.userId, "userId");
  assertPositiveId(input.accountId, "accountId");
  assertPositiveId(input.uploadId, "uploadId");
  assertFingerprint(input.headerFingerprint);
  if (!input.providerEnabled) throw new ProviderDisabledError();
  if (input.sampleRows.length === 0) {
    return { state: "unavailable", retryAfter: null };
  }

  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const claim = await dependencies.claim({
    userId: input.userId,
    headerFingerprint: input.headerFingerprint,
  });
  if (claim.state === "busy") {
    return { state: "busy", retryAfter: claim.retryAfter };
  }
  if (claim.state === "cooldown") {
    return {
      state: "cooldown",
      retryAfter: claim.retryAfter,
      code: claim.failureCode,
    };
  }

  const attemptId = claim.attemptId;
  const model =
    input.model ?? process.env.OPENAI_CSV_FORMAT_MODEL ?? "gpt-5-nano";
  const holderKey = `csv-format:${attemptId}`;
  let reservationCreated = false;
  let reservationAttached = false;
  let reservationReconciled = false;
  let providerStarted = false;
  let concurrencyLeaseId: string | null = null;

  try {
    if (claim.staleReservationId) {
      await dependencies.reconcileBudget({
        reservationId: claim.staleReservationId,
        outcome: {
          type: "reserved_unknown",
          errorCode: "STALE_FORMAT_PROVIDER_OUTCOME",
        },
      });
    }

    try {
      await dependencies.reserveBudget({
        reservationId: attemptId,
        userId: input.userId,
        accountId: input.accountId,
        uploadId: input.uploadId,
        operation: "csv_format_detection",
        model,
      });
      reservationCreated = true;
    } catch (error) {
      await dependencies.releaseClaim({
        userId: input.userId,
        headerFingerprint: input.headerFingerprint,
        attemptId,
      });
      if (error instanceof AiBudgetExceededError) {
        return { state: "budget_blocked" };
      }
      throw error;
    }

    reservationAttached = await dependencies.attachReservation({
      userId: input.userId,
      headerFingerprint: input.headerFingerprint,
      attemptId,
      reservationId: attemptId,
    });
    if (!reservationAttached) {
      await dependencies.reconcileBudget({
        reservationId: attemptId,
        outcome: { type: "released", errorCode: "FORMAT_AUTHORIZATION_STALE" },
      });
      reservationReconciled = true;
      return { state: "busy" };
    }

    const concurrency = await dependencies.acquireLease({ holderKey });
    if (!concurrency.acquired || !concurrency.leaseId) {
      await dependencies.reconcileBudget({
        reservationId: attemptId,
        outcome: { type: "released", errorCode: "FORMAT_CAPACITY_BUSY" },
      });
      reservationReconciled = true;
      await dependencies.releaseClaim({
        userId: input.userId,
        headerFingerprint: input.headerFingerprint,
        attemptId,
      });
      return {
        state: "busy",
        ...(concurrency.expiresAt ? { retryAfter: concurrency.expiresAt } : {}),
      };
    }
    concurrencyLeaseId = concurrency.leaseId;
    const renewed = await dependencies.renewLease({
      leaseId: concurrencyLeaseId,
      holderKey,
    });
    if (!renewed) {
      await dependencies.reconcileBudget({
        reservationId: attemptId,
        outcome: { type: "released", errorCode: "FORMAT_LEASE_EXPIRED" },
      });
      reservationReconciled = true;
      await dependencies.releaseClaim({
        userId: input.userId,
        headerFingerprint: input.headerFingerprint,
        attemptId,
      });
      return { state: "busy" };
    }

    providerStarted = true;
    const providerResult: OpenAiStructuredResult<CsvFormatSpec> =
      await dependencies.detect(input.sampleRows, {
        transport: input.transport,
        isEnabled: true,
        signal: input.signal,
        model,
      });
    await dependencies.reconcileBudget({
      reservationId: attemptId,
      outcome: {
        type: "actual",
        attemptStatus: "succeeded",
        providerRequestId: providerResult.providerRequestId,
        latencyMs: providerResult.latencyMs,
        usage: providerResult.usage,
      },
    });
    reservationReconciled = true;

    if (!(await input.acceptSpec(providerResult.data))) {
      const retryAfter = await dependencies.failClaim({
        userId: input.userId,
        headerFingerprint: input.headerFingerprint,
        attemptId,
        failureCode: "FORMAT_NOT_RECOGNIZED",
      });
      return { state: "not_resolved", retryAfter };
    }

    const completed = await dependencies.completeClaim({
      userId: input.userId,
      headerFingerprint: input.headerFingerprint,
      attemptId,
      spec: providerResult.data,
    });
    if (!completed) return { state: "unavailable", retryAfter: null };
    return { state: "resolved", spec: providerResult.data };
  } catch (error) {
    if (!reservationReconciled && reservationCreated && !reservationAttached) {
      await dependencies.reconcileBudget({
        reservationId: attemptId,
        outcome: { type: "released", errorCode: "FORMAT_AUTHORIZATION_STALE" },
      });
    } else if (!reservationReconciled && reservationAttached) {
      const safeRelease =
        !providerStarted || error instanceof ProviderInputTooLargeError;
      await dependencies.reconcileBudget({
        reservationId: attemptId,
        outcome: safeRelease
          ? { type: "released", errorCode: "FORMAT_PROVIDER_INPUT_REJECTED" }
          : {
              type: "reserved_unknown",
              errorCode: "FORMAT_PROVIDER_OUTCOME_UNKNOWN",
            },
      });
    }
    const retryAfter = providerStarted
      ? await dependencies.failClaim({
          userId: input.userId,
          headerFingerprint: input.headerFingerprint,
          attemptId,
          failureCode: "FORMAT_PROVIDER_UNAVAILABLE",
        })
      : (await dependencies.releaseClaim({
          userId: input.userId,
          headerFingerprint: input.headerFingerprint,
          attemptId,
        }),
        null);
    return { state: "unavailable", retryAfter };
  } finally {
    if (concurrencyLeaseId) {
      await dependencies.releaseLease({
        leaseId: concurrencyLeaseId,
        holderKey,
      });
    }
  }
}
