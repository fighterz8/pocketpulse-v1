import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export const transactionsQueryKey = ["transactions"] as const;

export type Transaction = {
  id: number;
  userId: number;
  uploadId: number;
  accountId: number;
  date: string;
  amount: string;
  merchant: string;
  rawDescription: string;
  flowType: string;
  transactionClass: string;
  recurrenceType: string;
  category: string;
  labelSource: string;
  labelConfidence: string | null;
  labelReason: string | null;
  aiAssisted: boolean;
  userCorrected: boolean;
  excludedFromAnalysis: boolean;
  excludedReason: string | null;
  excludedAt: string | null;
  createdAt: string;
};

export type TransactionFilters = {
  page?: number;
  limit?: number;
  accountId?: number;
  search?: string;
  category?: string;
  transactionClass?: string;
  recurrenceType?: string;
  dateFrom?: string;
  dateTo?: string;
  excluded?: "true" | "false" | "all";
};

export type TransactionsResponse = {
  transactions: Transaction[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type UpdateTransactionInput = {
  date?: string;
  merchant?: string;
  amount?: string;
  flowType?: string;
  category?: string;
  transactionClass?: string;
  recurrenceType?: string;
  excludedFromAnalysis?: boolean;
  excludedReason?: string | null;
};

async function readJsonError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; errors?: string[] };
    if (typeof body.error === "string") return body.error;
    if (Array.isArray(body.errors)) return body.errors.join("; ");
  } catch {
    /* ignore */
  }
  return res.statusText || "Request failed";
}

function buildQueryString(filters: TransactionFilters): string {
  const params = new URLSearchParams();
  if (filters.page) params.set("page", String(filters.page));
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.accountId) params.set("accountId", String(filters.accountId));
  if (filters.search) params.set("search", filters.search);
  if (filters.category) params.set("category", filters.category);
  if (filters.transactionClass) params.set("transactionClass", filters.transactionClass);
  if (filters.recurrenceType) params.set("recurrenceType", filters.recurrenceType);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.excluded) params.set("excluded", filters.excluded);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useTransactions(filters: TransactionFilters) {
  const queryClient = useQueryClient();
  const queryKey = [...transactionsQueryKey, filters] as const;

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<TransactionsResponse> => {
      const res = await fetch(`/api/transactions${buildQueryString(filters)}`);
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json() as Promise<TransactionsResponse>;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, fields }: { id: number; fields: UpdateTransactionInput }) => {
      const res = await apiFetch(`/api/transactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json() as Promise<{ transaction: Transaction }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: transactionsQueryKey });
    },
  });

  const wipeDataMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/transactions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: transactionsQueryKey });
    },
  });

  const resetWorkspaceMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/workspace-data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: transactionsQueryKey });
    },
  });

  const reclassifyMutation = useMutation({
    mutationFn: async (): Promise<{ total: number; updated: number; skippedUserCorrected: number; unchanged: number }> => {
      const res = await apiFetch("/api/transactions/reclassify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json() as Promise<{ total: number; updated: number; skippedUserCorrected: number; unchanged: number }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: transactionsQueryKey });
    },
  });

  return {
    transactions: query.data?.transactions ?? [],
    pagination: query.data?.pagination ?? null,
    isLoading: query.isPending,
    error: query.error as Error | null,
    updateTransaction: updateMutation,
    wipeData: wipeDataMutation,
    resetWorkspace: resetWorkspaceMutation,
    reclassify: reclassifyMutation,
  };
}

