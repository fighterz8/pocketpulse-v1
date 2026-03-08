import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function readApiErrorMessage(res: Response) {
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const payload = await res.json().catch(() => null) as { message?: string } | null;
    if (payload?.message) {
      return payload.message;
    }
  }

  const text = (await res.text()) || res.statusText;
  if (text) {
    return text;
  }

  return res.status >= 500
    ? "Something went wrong on the server. Please try again."
    : "Request failed.";
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const message = await readApiErrorMessage(res);
    throw new Error(res.status >= 500 ? "Something went wrong on the server. Please try again." : message);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

export { readApiErrorMessage };

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
