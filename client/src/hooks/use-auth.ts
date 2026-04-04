import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

export const authMeQueryKey = ["auth", "me"] as const;

/** Prefix for `invalidateQueries` — matches every `accountsListQueryKey(userId)`. */
export const accountsListQueryRoot = ["accounts", "list"] as const;

export function accountsListQueryKey(userId: number) {
  return [...accountsListQueryRoot, userId] as const;
}

/** Row shape from `GET /api/accounts` / `POST /api/accounts` JSON. */
export type AuthAccount = {
  id: number;
  userId: number;
  label: string;
  lastFour: string | null;
  accountType: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAccountInput = {
  label: string;
  lastFour?: string;
  accountType?: string;
};

/** API shape for `GET /api/auth/me` — never includes password fields. */
export type AuthUser = {
  id: number;
  email: string;
  displayName: string;
  companyName: string | null;
  isDev: boolean;
};

/** API shape for `GET /api/auth/me` — never includes password fields. */
export type AuthMeResponse =
  | { authenticated: false }
  | { authenticated: true; user: AuthUser };

export type LoginInput = { email: string; password: string };

export type RegisterInput = {
  email: string;
  password: string;
  displayName: string;
  companyName?: string;
  isDev?: boolean;
};

/** Shape returned by POST /api/auth/login and POST /api/auth/register */
type AuthSuccessResponse = { user: AuthUser; accounts: AuthAccount[] };

async function readJsonError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    /* ignore */
  }
  return res.statusText || "Request failed";
}

export type UseAuthReturn = {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: AuthUser | null;
  meError: Error | null;
  refetch: ReturnType<typeof useQuery<AuthMeResponse>>["refetch"];
  accounts: AuthAccount[] | null;
  accountsLoading: boolean;
  accountsError: Error | null;
  refetchAccounts: ReturnType<
    typeof useQuery<{ accounts: AuthAccount[] }>
  >["refetch"];
  login: UseMutationResult<AuthSuccessResponse, Error, LoginInput>;
  register: UseMutationResult<AuthSuccessResponse, Error, RegisterInput>;
  createAccount: UseMutationResult<
    { account: AuthAccount },
    Error,
    CreateAccountInput
  >;
  logout: UseMutationResult<void, Error, void>;
};

export function useAuth(): UseAuthReturn {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: authMeQueryKey,
    queryFn: async (): Promise<AuthMeResponse> => {
      const res = await fetch("/api/auth/me");
      if (!res.ok) {
        throw new Error(await readJsonError(res));
      }
      return res.json() as Promise<AuthMeResponse>;
    },
  });

  const meData = meQuery.data;
  const isAuthenticated = meData?.authenticated === true;
  const accountOwnerId =
    meData?.authenticated === true ? meData.user.id : null;

  const accountsQuery = useQuery({
    queryKey:
      accountOwnerId != null
        ? accountsListQueryKey(accountOwnerId)
        : [...accountsListQueryRoot, null],
    enabled: accountOwnerId != null,
    queryFn: async (): Promise<{ accounts: AuthAccount[] }> => {
      const res = await fetch("/api/accounts");
      if (!res.ok) {
        throw new Error(await readJsonError(res));
      }
      return res.json() as Promise<{ accounts: AuthAccount[] }>;
    },
  });

  const login = useMutation<AuthSuccessResponse, Error, LoginInput>({
    mutationFn: async (input) => {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json() as Promise<AuthSuccessResponse>;
    },
    onSuccess: (data) => {
      // Immediately populate auth + accounts caches from the response so
      // AppGate transitions instantly with zero sequential fetches.
      queryClient.setQueryData<AuthMeResponse>(authMeQueryKey, {
        authenticated: true,
        user: data.user,
      });
      queryClient.setQueryData(
        accountsListQueryKey(data.user.id),
        { accounts: data.accounts },
      );
      // Remove any stale data from a previous session (dashboard, ledger, etc.)
      queryClient.removeQueries({
        predicate: (q) =>
          q.queryKey[0] !== "auth" && q.queryKey[0] !== "accounts",
      });
    },
  });

  const register = useMutation<AuthSuccessResponse, Error, RegisterInput>({
    mutationFn: async (input) => {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          displayName: input.displayName,
          ...(input.companyName !== undefined && input.companyName !== ""
            ? { companyName: input.companyName }
            : {}),
          ...(input.isDev === true ? { isDev: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json() as Promise<AuthSuccessResponse>;
    },
    onSuccess: (data) => {
      // Same instant-transition pattern as login.
      queryClient.setQueryData<AuthMeResponse>(authMeQueryKey, {
        authenticated: true,
        user: data.user,
      });
      queryClient.setQueryData(
        accountsListQueryKey(data.user.id),
        { accounts: data.accounts },
      );
      queryClient.removeQueries({
        predicate: (q) =>
          q.queryKey[0] !== "auth" && q.queryKey[0] !== "accounts",
      });
    },
  });

  const logout = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) {
        throw new Error(await readJsonError(res));
      }
    },
    onSuccess: () => {
      // Immediately flip auth state to unauthenticated so AppGate redirects to
      // the login screen before any other query has a chance to re-fetch against
      // the now-destroyed session and render a 401 error.
      queryClient.setQueryData(authMeQueryKey, { authenticated: false });
      // Remove all non-auth cached data so no previous user's data survives.
      queryClient.removeQueries({
        predicate: (q) => q.queryKey[0] !== "auth",
      });
    },
  });

  const createAccount = useMutation({
    mutationFn: async (input: CreateAccountInput) => {
      const lastFourDigits =
        input.lastFour !== undefined && input.lastFour !== ""
          ? input.lastFour.replace(/\D/g, "").slice(0, 4)
          : "";
      const res = await apiFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: input.label,
          ...(lastFourDigits !== ""
            ? { lastFour: lastFourDigits }
            : {}),
          ...(input.accountType !== undefined && input.accountType !== ""
            ? { accountType: input.accountType }
            : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(await readJsonError(res));
      }
      return res.json() as Promise<{ account: AuthAccount }>;
    },
    onSuccess: (data) => {
      // Immediately push the new account into the cache so AppGate transitions
      // to AppAuthenticated before the next re-fetch, eliminating a loading flash.
      if (accountOwnerId != null) {
        queryClient.setQueryData<{ accounts: AuthAccount[] }>(
          accountsListQueryKey(accountOwnerId),
          (prev) => ({
            accounts: [...(prev?.accounts ?? []), data.account],
          }),
        );
      }
      // Invalidate in the background to keep the canonical server list in sync.
      void queryClient.invalidateQueries({ queryKey: accountsListQueryRoot });
    },
  });

  const user =
    meData && meData.authenticated === true ? meData.user : null;

  const accounts =
    isAuthenticated && accountsQuery.data
      ? accountsQuery.data.accounts
      : null;
  const accountsLoading = isAuthenticated && accountsQuery.isPending;
  const accountsError = isAuthenticated
    ? (accountsQuery.error as Error | null)
    : null;

  return {
    isLoading: meQuery.isPending,
    isAuthenticated,
    user,
    meError: meQuery.error as Error | null,
    refetch: meQuery.refetch,
    accounts,
    accountsLoading,
    accountsError,
    refetchAccounts: accountsQuery.refetch,
    login,
    register,
    createAccount,
    logout,
  };
}
