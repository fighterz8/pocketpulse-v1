import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "../lib/api";
import { refreshFinancialDataQueries } from "../lib/financialDataQueries";

export type EnhancementAccessState =
  | "free"
  | "trialing"
  | "active"
  | "past_due"
  | "expired";

export type EnhancementAccess = {
  state: EnhancementAccessState;
  trialAvailable: boolean;
};

export type EnhancementAvailability = {
  uploadId: number;
  state: "not_needed" | "available" | "active" | "complete" | "blocked";
  unresolvedTransactionCount: number;
  unresolvedMerchantCount: number;
  activeJobId?: number;
  blockedReason?:
    | "FEATURE_DISABLED"
    | "PLUS_REQUIRED"
    | "ACTIVE_JOB_EXISTS"
    | "USER_LIMIT_REACHED"
    | "PROVIDER_UNAVAILABLE";
  resetAt?: string;
  /** Verified server entitlement. The fallback is fail-closed for stale clients. */
  access?: EnhancementAccess;
};

export type EnhancementJobStatus =
  | "queued"
  | "processing"
  | "complete"
  | "partial"
  | "failed"
  | "cancelled"
  | "budget_blocked";

export type EnhancementJob = {
  id: number;
  uploadId: number;
  status: EnhancementJobStatus;
  totalMerchants: number;
  completedMerchants: number;
  skippedMerchants: number;
  failedMerchants: number;
  progress: number;
};

type BatchResult = {
  state: "complete" | "processed" | "busy" | "budget_blocked" | "cancelled";
  job: EnhancementJob;
};

class EnhancementRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EnhancementRequestError";
  }
}

export const enhancementAvailabilityKey = (uploadId: number) =>
  ["enhancement-availability", uploadId] as const;
export const enhancementJobKey = (jobId: number) =>
  ["enhancement-job", jobId] as const;
export const activeEnhancementJobKey = ["active-enhancement-job"] as const;

const batchRequests = new Map<number, Promise<BatchResult>>();

async function readEnhancementError(res: Response): Promise<EnhancementRequestError> {
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    return new EnhancementRequestError(
      body.error || "Enhancement is temporarily unavailable",
      body.code,
    );
  } catch {
    return new EnhancementRequestError(
      res.statusText || "Enhancement is temporarily unavailable",
    );
  }
}

function createIdempotencyKey(uploadId: number): string {
  const storageKey = `pocketpulse-enhancement-key:${uploadId}`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const created = `enhancement-${uploadId}-${nonce}`;
  window.sessionStorage.setItem(storageKey, created);
  return created;
}

async function requestBatch(jobId: number): Promise<BatchResult> {
  const current = batchRequests.get(jobId);
  if (current) return current;

  const request = (async () => {
    const res = await apiFetch(`/api/enhancement-jobs/${jobId}/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw await readEnhancementError(res);
    return res.json() as Promise<BatchResult>;
  })();
  batchRequests.set(jobId, request);
  void request.then(
    () => batchRequests.delete(jobId),
    () => batchRequests.delete(jobId),
  );
  return request;
}

function isEntitled(access: EnhancementAccess): boolean {
  return access.state === "active" || access.state === "trialing";
}

function isRunning(status: EnhancementJobStatus): boolean {
  return status === "queued" || status === "processing";
}

export function useActiveEnhancementJob() {
  return useQuery({
    queryKey: activeEnhancementJobKey,
    queryFn: async (): Promise<{ job: EnhancementJob | null }> => {
      const res = await fetch("/api/enhancement-jobs/active");
      if (!res.ok) throw await readEnhancementError(res);
      return res.json() as Promise<{ job: EnhancementJob | null }>;
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useEnhancementWorkflow(uploadId: number) {
  const queryClient = useQueryClient();
  const availabilityKey = enhancementAvailabilityKey(uploadId);
  const availabilityQuery = useQuery({
    queryKey: availabilityKey,
    queryFn: async (): Promise<EnhancementAvailability> => {
      const res = await fetch(`/api/uploads/${uploadId}/enhancement`);
      if (!res.ok) throw await readEnhancementError(res);
      return res.json() as Promise<EnhancementAvailability>;
    },
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const access: EnhancementAccess = availabilityQuery.data?.access ?? {
    state: "free",
    trialAvailable: true,
  };

  const startMutation = useMutation({
    mutationFn: async (): Promise<{ job: EnhancementJob }> => {
      const res = await apiFetch("/api/enhancement-jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": createIdempotencyKey(uploadId),
        },
        body: JSON.stringify({ uploadId }),
      });
      if (!res.ok) throw await readEnhancementError(res);
      return res.json() as Promise<{ job: EnhancementJob }>;
    },
    onSuccess: ({ job }) => {
      queryClient.setQueryData(enhancementJobKey(job.id), { job });
      queryClient.setQueryData<EnhancementAvailability>(availabilityKey, (old) =>
        old ? { ...old, state: "active", activeJobId: job.id } : old,
      );
    },
  });

  const activeJobId =
    availabilityQuery.data?.activeJobId ?? startMutation.data?.job.id;
  const jobQuery = useQuery({
    queryKey: enhancementJobKey(activeJobId ?? 0),
    queryFn: async (): Promise<{ job: EnhancementJob }> => {
      const res = await fetch(`/api/enhancement-jobs/${activeJobId}`);
      if (!res.ok) throw await readEnhancementError(res);
      return res.json() as Promise<{ job: EnhancementJob }>;
    },
    enabled: activeJobId !== undefined,
    staleTime: 0,
  });

  const currentJob = jobQuery.data?.job ?? startMutation.data?.job;
  const completedBeforeBatchRef = useRef(0);
  const batchMutation = useMutation({
    mutationFn: requestBatch,
    onSuccess: (result) => {
      const { job } = result;
      queryClient.setQueryData(enhancementJobKey(job.id), { job });
      if (job.completedMerchants > completedBeforeBatchRef.current) {
        completedBeforeBatchRef.current = job.completedMerchants;
        void refreshFinancialDataQueries(queryClient);
      }
      if (!isRunning(job.status)) {
        void queryClient.invalidateQueries({ queryKey: availabilityKey });
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (jobId: number): Promise<{ job: EnhancementJob }> => {
      const res = await apiFetch(`/api/enhancement-jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (!res.ok) throw await readEnhancementError(res);
      return res.json() as Promise<{ job: EnhancementJob }>;
    },
    onSuccess: ({ job }) => {
      queryClient.setQueryData(enhancementJobKey(job.id), { job });
      void queryClient.invalidateQueries({ queryKey: availabilityKey });
    },
  });

  const job = cancelMutation.data?.job ?? currentJob;
  const lastAdvancedSignatureRef = useRef<string | null>(null);
  const signature = job
    ? `${job.id}:${job.status}:${job.completedMerchants}:${job.skippedMerchants}:${job.failedMerchants}`
    : null;

  useEffect(() => {
    if (
      !job ||
      !signature ||
      !isEntitled(access) ||
      !isRunning(job.status) ||
      batchMutation.isPending ||
      lastAdvancedSignatureRef.current === signature
    ) {
      return;
    }
    lastAdvancedSignatureRef.current = signature;
    batchMutation.mutate(job.id);
  }, [access, batchMutation, job, signature]);

  const resume = () => {
    if (!job || batchMutation.isPending || !isRunning(job.status)) return;
    lastAdvancedSignatureRef.current = null;
    batchMutation.mutate(job.id);
  };

  return {
    availability: availabilityQuery.data,
    access,
    job,
    isLoading: availabilityQuery.isPending || (activeJobId !== undefined && jobQuery.isPending),
    error:
      availabilityQuery.error ??
      jobQuery.error ??
      startMutation.error ??
      batchMutation.error ??
      cancelMutation.error,
    isStarting: startMutation.isPending,
    isAdvancing: batchMutation.isPending,
    isCancelling: cancelMutation.isPending,
    start: () => startMutation.mutate(),
    resume,
    cancel: () => job && cancelMutation.mutate(job.id),
    retryAvailability: () => void availabilityQuery.refetch(),
  };
}
