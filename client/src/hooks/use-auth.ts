import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

export const authMeQueryKey = ["auth", "me"] as const;

/** API shape for `GET /api/auth/me` — never includes password fields. */
export type AuthUser = {
  id: number;
  email: string;
  displayName: string;
  companyName: string | null;
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
};

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
  login: UseMutationResult<unknown, Error, LoginInput>;
  register: UseMutationResult<unknown, Error, RegisterInput>;
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

  const login = useMutation({
    mutationFn: async (input: LoginInput) => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error(await readJsonError(res));
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
    },
  });

  const register = useMutation({
    mutationFn: async (input: RegisterInput) => {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          displayName: input.displayName,
          ...(input.companyName !== undefined && input.companyName !== ""
            ? { companyName: input.companyName }
            : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(await readJsonError(res));
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
    },
  });

  const data = meQuery.data;
  const isAuthenticated = data?.authenticated === true;
  const user =
    data && data.authenticated === true ? data.user : null;

  return {
    isLoading: meQuery.isPending,
    isAuthenticated,
    user,
    meError: meQuery.error as Error | null,
    refetch: meQuery.refetch,
    login,
    register,
  };
}
