let cachedCsrfToken: string | null = null;

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch("/api/csrf-token");
  if (!res.ok) throw new Error("Failed to fetch CSRF token");
  const body = (await res.json()) as { token: string };
  cachedCsrfToken = body.token;
  return cachedCsrfToken;
}

export async function getCsrfToken(): Promise<string> {
  if (cachedCsrfToken) return cachedCsrfToken;
  return fetchCsrfToken();
}

export function clearCsrfToken(): void {
  cachedCsrfToken = null;
}

export async function readJsonError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; errors?: string[] };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.join("; ");
    }
  } catch {
    /* ignore */
  }
  return res.statusText || "Request failed";
}

export async function apiFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const method = options?.method?.toUpperCase() ?? "GET";
  const headers = new Headers(options?.headers);

  if (method !== "GET" && method !== "HEAD") {
    const token = await getCsrfToken();
    headers.set("X-CSRF-Token", token);
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 403) {
    const body = await res.clone().json().catch(() => null) as { error?: string } | null;
    if (body?.error?.toLowerCase().includes("csrf")) {
      cachedCsrfToken = null;
      const freshToken = await fetchCsrfToken();
      headers.set("X-CSRF-Token", freshToken);
      return fetch(url, { ...options, headers });
    }
  }

  return res;
}
