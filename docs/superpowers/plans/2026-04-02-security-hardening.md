# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical and high-severity security findings from the code review and CodeQL scanner: esbuild SSRF, CSRF protection, rate limiting, session secret enforcement, password validation, and helmet security headers.

**Architecture:** Add security middleware layers (helmet, rate-limit, CSRF) to the Express app in `routes.ts`, harden the Vite dev server config, enforce session secrets at startup, and add input validation on auth endpoints. All changes are additive middleware -- no business logic changes. Client needs a small update to send CSRF tokens on mutating requests.

**Tech Stack:** express-rate-limit, helmet, csrf-csrf (double-submit cookie CSRF for SPAs), Vite server config

---

### Task 1: Install Security Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the three new dependencies**

All three packages ship their own TypeScript declarations -- no separate `@types` packages needed.

```bash
npm install helmet express-rate-limit csrf-csrf@^3
```

- [ ] **Step 2: Verify install succeeded**

Run: `npm ls helmet express-rate-limit csrf-csrf`
Expected: All three listed without UNMET PEER DEPENDENCY errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install helmet, express-rate-limit, csrf-csrf"
```

---

### Task 2: Enforce SESSION_SECRET in Production

**Files:**
- Modify: `server/routes.ts` -- the `sessionMiddleware` function (search for `function sessionMiddleware`)
- Test: `server/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `server/routes.test.ts` **inside** the existing `describe.skipIf(!runRouteIntegrationTests)("API routes", ...)` block (after the `testApp()` helper). Since `getSessionSecret()` reads `process.env` at call time (inside `createApp()`), no module cache busting is needed:

```typescript
  it("throws if SESSION_SECRET is missing in production", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origSecret = process.env.SESSION_SECRET;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.SESSION_SECRET;
      expect(() => createApp()).toThrow(/SESSION_SECRET/i);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origSecret !== undefined) {
        process.env.SESSION_SECRET = origSecret;
      } else {
        delete process.env.SESSION_SECRET;
      }
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: FAIL -- the current code does not throw.

- [ ] **Step 3: Implement the guard**

In `server/routes.ts`, replace lines 62-77 (the `sessionMiddleware` function) with:

```typescript
function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is required in production. Set it to a long random string.",
    );
  }
  return secret ?? "dev-session-secret-not-for-production";
}

function sessionMiddleware(store: session.Store) {
  return session({
    store,
    name: "pocketpulse.sid",
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run full server test suite for regressions**

Run: `npx vitest run --project server --reporter=verbose`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "fix: enforce SESSION_SECRET in production (C2)"
```

---

### Task 3: Add Password and Email Validation on Registration

**Files:**
- Modify: `server/routes.ts` -- the `app.post("/api/auth/register", ...)` handler
- Test: `server/routes.test.ts`

- [ ] **Step 1: Write failing tests**

Add inside the existing `describe.skipIf(!runRouteIntegrationTests)("API routes", ...)` block in `server/routes.test.ts`:

```typescript
  it("POST /api/auth/register rejects passwords shorter than 8 characters", async () => {
    const app = testApp();
    const email = `val-pw-${crypto.randomUUID()}@example.com`;
    const res = await request(app).post("/api/auth/register").send({
      email,
      password: "short",
      displayName: "Test",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
    expect(res.body.error).toMatch(/8/);
  });

  it("POST /api/auth/register rejects invalid email format", async () => {
    const app = testApp();
    const res = await request(app).post("/api/auth/register").send({
      email: "not-an-email",
      password: "long-enough-pw",
      displayName: "Test",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("POST /api/auth/register accepts valid 8+ char password", async () => {
    const app = testApp();
    const email = `val-ok-${crypto.randomUUID()}@example.com`;
    const res = await request(app).post("/api/auth/register").send({
      email,
      password: "exactly8",
      displayName: "Test",
    });
    expect(res.status).toBe(201);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: First two tests FAIL (current code accepts anything).

- [ ] **Step 3: Add validation to the register endpoint**

In `server/routes.ts`, inside the `app.post("/api/auth/register", ...)` handler, after the existing type-check block (the `if (typeof email !== "string" || ...)` block ending with `return;`) and **before** `const passwordHash = await hashPassword(password);`, add:

```typescript
      if (!email.includes("@") || email.indexOf("@") === 0 || email.indexOf("@") === email.length - 1) {
        res.status(400).json({ error: "A valid email address is required" });
        return;
      }

      if (password.length < 8) {
        res
          .status(400)
          .json({ error: "Password must be at least 8 characters" });
        return;
      }
```

- [ ] **Step 4: Update ALL existing tests that use short passwords**

In `server/routes.test.ts`, the following tests use passwords shorter than 8 characters and will now fail. Update each one:

| Test name | Current password(s) | Replace with |
|-----------|-------------------|--------------|
| `"returns 409 for duplicate email (normalized)"` | `"a"`, `"b"` | `"password-one"`, `"password-two"` |
| `"same safe error for unknown email"` | `"secret"` (6 chars) | `"secret-pw"` |
| `"logout destroys the session"` | `"pw"` | `"test-pw-99"` |
| `"GET /api/accounts returns an empty list"` | `"pw"` | `"test-pw-99"` |
| `"POST /api/accounts creates an account"` | `"pw"` | `"test-pw-99"` |

Search the file for `password: "` and verify no other occurrences use fewer than 8 characters.

- [ ] **Step 5: Run the tests to verify they all pass**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: All pass including the new validation tests and the updated passwords.

- [ ] **Step 6: Run full test suite for regressions**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "fix: validate password length and email format on registration (C1)"
```

---

### Task 4: Add Helmet Security Headers

**Files:**
- Modify: `server/routes.ts` -- inside `createApp()`, before `app.use(express.json())`
- Test: `server/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the `describe.skipIf(!runRouteIntegrationTests)` block:

```typescript
  it("responses include security headers from helmet", async () => {
    const app = testApp();
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: FAIL -- no security headers currently set.

- [ ] **Step 3: Add helmet to createApp**

In `server/routes.ts`, add the import at the top (after the existing imports):

```typescript
import helmet from "helmet";
```

Then inside `createApp()`, add `app.use(helmet());` **before** `app.use(express.json());`:

```typescript
export function createApp(options?: CreateAppOptions) {
  const store = options?.sessionStore ?? defaultSessionStore();
  const app = express();
  app.use(helmet());
  app.use(express.json());
  app.use(sessionMiddleware(store));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "fix: add helmet for security headers (M7)"
```

---

### Task 5: Add Rate Limiting (CodeQL #2, #3)

**Files:**
- Modify: `server/routes.ts` -- inside `createApp()`, add limiter middleware + apply to auth routes
- Test: `server/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the `describe.skipIf(!runRouteIntegrationTests)` block. Note: this test uses sequential requests (not parallel) because each needs the same app instance and rate-limit counter. After Task 6 adds CSRF, this test will need updating to include CSRF tokens -- a note in Task 6 Step 5 covers this.

```typescript
  it("login endpoint returns 429 after too many failed attempts", async () => {
    const app = testApp();
    const email = `rate-${crypto.randomUUID()}@example.com`;

    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email, password: "wrong-password-here" });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: FAIL -- all requests return 401, none return 429.

- [ ] **Step 3: Add rate limiting middleware**

In `server/routes.ts`, add the import at the top:

```typescript
import rateLimit from "express-rate-limit";
```

Inside `createApp()`, after `app.use(helmet());` and before `app.use(express.json());`, add:

```typescript
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
  app.use(globalLimiter);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" },
  });
```

Then apply `authLimiter` to the auth routes. Change:
```typescript
  app.post("/api/auth/login", async (req, res, next) => {
```
to:
```typescript
  app.post("/api/auth/login", authLimiter, async (req, res, next) => {
```

And change:
```typescript
  app.post("/api/auth/register", async (req, res, next) => {
```
to:
```typescript
  app.post("/api/auth/register", authLimiter, async (req, res, next) => {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: PASS -- 429 is returned after 10 attempts.

- [ ] **Step 5: Run full server test suite for regressions**

Run: `npx vitest run --project server --reporter=verbose`
Expected: All pass. Existing auth tests should stay under the 10-request limit.

- [ ] **Step 6: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "fix: add global and auth-specific rate limiting (C3, CodeQL #2, #3)"
```

---

### Task 6: Add CSRF Protection (CodeQL #1)

This uses the double-submit cookie pattern from `csrf-csrf`, which works well with SPA + same-origin fetch. The server sets a CSRF cookie; the client reads it and sends it back as a header on mutating requests.

**Files:**
- Create: `server/csrf.ts`
- Modify: `server/routes.ts` -- imports, middleware in `createApp()`, error handler
- Create: `client/src/lib/api.ts` (shared fetch wrapper with CSRF + `readJsonError`)
- Modify: `client/src/hooks/use-auth.ts`
- Modify: `client/src/hooks/use-transactions.ts`
- Modify: `client/src/hooks/use-uploads.ts`
- Modify: `client/src/hooks/use-recurring.ts`
- Test: `server/routes.test.ts`

- [ ] **Step 1: Write the CSRF tests first (TDD -- these will fail until implementation)**

Add a `withCsrf` helper and CSRF-specific tests inside the `describe.skipIf(!runRouteIntegrationTests)` block, alongside the existing `testApp()` helper:

```typescript
  async function withCsrf(agent: ReturnType<typeof request.agent>) {
    const res = await agent.get("/api/csrf-token");
    return res.body.token as string;
  }
```

Then add the CSRF tests:

```typescript
  it("mutating requests without CSRF token return 403", async () => {
    const app = testApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "a@b.com", password: "12345678" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  it("mutating requests with valid CSRF token succeed", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);

    const email = `csrf-${crypto.randomUUID()}@example.com`;
    const res = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", csrf)
      .send({
        email,
        password: "secure-password",
        displayName: "CSRF Test",
      });
    expect(res.status).toBe(201);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: FAIL -- `/api/csrf-token` returns 404, and POST without CSRF returns 401 not 403.

- [ ] **Step 3: Create the CSRF helper module**

Create `server/csrf.ts`:

```typescript
import { doubleCsrf } from "csrf-csrf";

const csrfSecret =
  process.env.CSRF_SECRET ?? process.env.SESSION_SECRET ?? "dev-csrf-secret";

export const {
  generateToken,
  doubleCsrfProtection,
  invalidCsrfTokenError,
} = doubleCsrf({
  getSecret: () => csrfSecret,
  cookieName: "pocketpulse.csrf",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  },
  getTokenFromRequest: (req) =>
    req.headers["x-csrf-token"] as string | undefined,
});
```

- [ ] **Step 4: Add CSRF middleware and token endpoint to routes**

In `server/routes.ts`, add the import at the top:

```typescript
import { doubleCsrfProtection, generateToken, invalidCsrfTokenError } from "./csrf.js";
```

Inside `createApp()`, after the session middleware line (`app.use(sessionMiddleware(store));`), add:

```typescript
  app.use(doubleCsrfProtection);

  app.get("/api/csrf-token", (req, res) => {
    const token = generateToken(req, res);
    res.json({ token });
  });
```

Then replace the error handler at the bottom of `createApp()` to handle CSRF errors:

```typescript
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err === invalidCsrfTokenError) {
        res.status(403).json({ error: "Invalid or missing CSRF token" });
        return;
      }
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    },
  );
```

- [ ] **Step 5: Run CSRF tests to verify they now pass**

Run: `npx vitest run server/routes.test.ts --reporter=verbose`
Expected: The two new CSRF tests PASS. Many existing tests will now FAIL because they don't send CSRF tokens.

- [ ] **Step 6: Update ALL existing mutating route tests to include CSRF token**

Every test that calls `POST`, `PATCH`, or `DELETE` must now use an agent, call `withCsrf(agent)`, and add `.set("X-CSRF-Token", csrf)` to each mutating request. Here is the complete list of tests that need updating:

| Test name | Mutating calls that need CSRF |
|-----------|-------------------------------|
| `"POST /api/auth/register creates user..."` | `agent.post("/api/auth/register")` |
| `"returns 409 for duplicate email"` | Both `request(app).post("/api/auth/register")` calls -- convert to use agents |
| `"POST /api/auth/login uses auth lookup..."` | `agent.post("/api/auth/login")` |
| `"login returns 401 for wrong password"` | `request(app).post("/api/auth/register")` and `request(app).post("/api/auth/login")` |
| `"same safe error for unknown email"` | All `request(app).post(...)` calls -- convert to agents |
| `"POST /api/auth/logout destroys the session"` | `agent.post("/api/auth/register")` and `agent.post("/api/auth/logout")` |
| `"POST /api/accounts returns 401"` | `request(app).post("/api/accounts")` -- convert to agent |
| `"POST /api/accounts creates an account"` | `agent.post("/api/auth/register")` and `agent.post("/api/accounts")` |
| `"GET /api/accounts returns empty list"` | `agent.post("/api/auth/register")` |
| `"rejects passwords shorter than 8"` (Task 3) | `request(app).post("/api/auth/register")` -- convert to agent |
| `"rejects invalid email format"` (Task 3) | `request(app).post("/api/auth/register")` -- convert to agent |
| `"accepts valid 8+ char password"` (Task 3) | `request(app).post("/api/auth/register")` -- convert to agent |
| `"helmet security headers"` (Task 4) | No change needed (GET only) |
| `"unmatched /api/* returns JSON 404"` | The POST to `/api/also-missing` will now get 403 instead of 404. **Fix:** Either add CSRF to it, or change the assertion to expect 403 for the POST (since CSRF fires before the 404 catch-all). Simplest fix: convert to agent, get CSRF, and keep the 404 assertion. |
| `"login returns 429 after too many attempts"` (Task 5) | Convert to use an agent with CSRF. Rewrite the loop: |

Rewritten rate-limit test with CSRF support:

```typescript
  it("login endpoint returns 429 after too many failed attempts", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const email = `rate-${crypto.randomUUID()}@example.com`;

    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await agent
        .post("/api/auth/login")
        .set("X-CSRF-Token", csrf)
        .send({ email, password: "wrong-password-here" });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });
```

For tests that use bare `request(app)` (no agent), convert them to use `request.agent(app)` so cookies (including CSRF) are preserved:

```typescript
    // Before:
    const res = await request(app).post("/api/auth/register").send({...});

    // After:
    const agent = request.agent(app);
    const csrf = await withCsrf(agent);
    const res = await agent.post("/api/auth/register").set("X-CSRF-Token", csrf).send({...});
```

- [ ] **Step 7: Run full server test suite**

Run: `npx vitest run --project server --reporter=verbose`
Expected: All pass.

- [ ] **Step 8: Create shared fetch wrapper for the client**

Create `client/src/lib/api.ts`:

```typescript
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
```

- [ ] **Step 9: Update `use-auth.ts` to use `apiFetch` and shared `readJsonError`**

In `client/src/hooks/use-auth.ts`:
- Replace the local `readJsonError` function import with: `import { apiFetch, clearCsrfToken, readJsonError } from "../lib/api.js";`
- Delete the local `readJsonError` definition (lines 56-66).
- Replace every `fetch(` call for POST endpoints with `apiFetch(`. GET endpoints (`/api/auth/me`, `/api/accounts` list) can stay as plain `fetch`.

Specifically change:
- `fetch("/api/auth/login", {` → `apiFetch("/api/auth/login", {`
- `fetch("/api/auth/register", {` → `apiFetch("/api/auth/register", {`
- `fetch("/api/auth/logout", { method: "POST" })` → `apiFetch("/api/auth/logout", { method: "POST" })`
- `fetch("/api/accounts", { method: "POST"` → `apiFetch("/api/accounts", { method: "POST"`

Also, in the `logout` mutation's `onSuccess` callback, add `clearCsrfToken();` to invalidate the cached CSRF token when the session is destroyed:

```typescript
  const logout = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) {
        throw new Error(await readJsonError(res));
      }
    },
    onSuccess: () => {
      clearCsrfToken();
      void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
      void queryClient.invalidateQueries({ queryKey: accountsListQueryRoot });
    },
  });
```

- [ ] **Step 10: Update `use-transactions.ts` to use `apiFetch` and shared `readJsonError`**

In `client/src/hooks/use-transactions.ts`:
- Add import: `import { apiFetch, readJsonError } from "../lib/api.js";`
- Delete the local `readJsonError` (lines 68-77).
- Change `fetch(\`/api/transactions/${id}\`, {` → `apiFetch(\`/api/transactions/${id}\`, {` (PATCH)
- Change `fetch("/api/transactions", { method: "DELETE"` → `apiFetch("/api/transactions", { method: "DELETE"`
- Change `fetch("/api/workspace-data", { method: "DELETE"` → `apiFetch("/api/workspace-data", { method: "DELETE"`
- GET endpoints (`/api/transactions?...`) stay as plain `fetch`.

- [ ] **Step 11: Update `use-uploads.ts` to use `apiFetch` and shared `readJsonError`**

In `client/src/hooks/use-uploads.ts`:
- Add import: `import { apiFetch, readJsonError } from "../lib/api.js";`
- Delete the local `readJsonError` (lines 34-44).
- Change `fetch("/api/upload", { method: "POST"` → `apiFetch("/api/upload", { method: "POST"`
- GET endpoint (`/api/uploads`) stays as plain `fetch`.

- [ ] **Step 12: Update `use-recurring.ts` to use `apiFetch`**

In `client/src/hooks/use-recurring.ts`:
- Add import: `import { apiFetch } from "../lib/api.js";`
- Change `fetch(\`/api/recurring-reviews/${encodeURIComponent(candidateKey)}\`, {` → `apiFetch(\`/api/recurring-reviews/${encodeURIComponent(candidateKey)}\`, {`
- Remove `credentials: "include"` from these calls (not needed for same-origin).
- GET endpoint (`/api/recurring-candidates`) stays as plain `fetch`.

- [ ] **Step 13: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 14: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All pass. Client tests mock `fetch` and should not be affected by `apiFetch` since hooks are mocked at the module level.

- [ ] **Step 15: Commit**

```bash
git add server/csrf.ts server/routes.ts server/routes.test.ts \
  client/src/lib/api.ts \
  client/src/hooks/use-auth.ts \
  client/src/hooks/use-transactions.ts \
  client/src/hooks/use-uploads.ts \
  client/src/hooks/use-recurring.ts
git commit -m "fix: add CSRF double-submit cookie protection (C4, CodeQL #1)"
```

---

### Task 7: Fix Vite Dev Server SSRF Vulnerability

**Files:**
- Modify: `vite.config.ts` -- the `server` block
- Modify: `server/vite.ts` -- the `createViteServer` config
- Modify: `.env.example`

- [ ] **Step 1: Run npm audit to check for known esbuild/vite vulnerabilities**

Run: `npm audit`
Expected: Review output for any esbuild or vite advisories.

- [ ] **Step 2: Update Vite if a patch is available**

Run: `npm update vite`
Then: `npm audit fix`

- [ ] **Step 3: Harden vite.config.ts**

Replace the `server` block in `vite.config.ts` (search for `server: {`) with:

```typescript
  server: {
    host: "0.0.0.0",
    port: 5000,
    strictPort: true,
    allowedHosts: process.env.ALLOWED_HOSTS
      ? process.env.ALLOWED_HOSTS.split(",")
      : [],
    cors: false,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? "5001"}`,
        changeOrigin: true,
      },
    },
    fs: {
      deny: [".env", ".env.*", "*.pem", "*.key"],
    },
  },
```

- [ ] **Step 4: Harden the middleware-mode Vite config in server/vite.ts**

Replace the `createViteServer({...})` call in `server/vite.ts` with:

```typescript
  const vite = await createViteServer({
    configFile: path.join(workspaceRoot, "vite.config.ts"),
    server: {
      middlewareMode: true,
      hmr: { server },
      cors: false,
      fs: {
        deny: [".env", ".env.*", "*.pem", "*.key"],
      },
    },
    appType: "spa",
  });
```

- [ ] **Step 5: Update .env.example to document ALLOWED_HOSTS**

Add to `.env.example`:

```
# Comma-separated hostnames for Vite dev server (prevents DNS rebinding)
# ALLOWED_HOSTS=your-replit-hostname.replit.dev
```

- [ ] **Step 6: Verify dev server still starts**

Run: `SKIP_VITE=1 npx tsx server/index.ts`
Expected: Server starts on the configured port without errors. Ctrl+C to stop.

- [ ] **Step 7: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add vite.config.ts server/vite.ts .env.example
git commit -m "fix: harden Vite dev server against SSRF/DNS rebinding (S1)"
```

---

### Task 8: Add Static Asset Cache Headers

**Files:**
- Modify: `server/static.ts` -- replace entire `setupStatic` function

- [ ] **Step 1: Update setupStatic to add cache headers**

Replace the contents of `server/static.ts` with:

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function setupStatic(app: Express) {
  const publicDir = path.join(__dirname, "..", "public");
  const assetsDir = path.join(publicDir, "assets");

  app.use(
    "/assets",
    express.static(assetsDir, {
      maxAge: "1y",
      immutable: true,
    }),
  );

  app.use(express.static(publicDir, { maxAge: "10m" }));

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });
}
```

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add server/static.ts
git commit -m "fix: add cache headers for static assets, no-cache for SPA HTML (M11)"
```

---

### Task 9: Add React Error Boundary

**Files:**
- Create: `client/src/components/ErrorBoundary.tsx`
- Modify: `client/src/App.tsx` -- the `App()` function
- Test: `client/src/components/ErrorBoundary.test.tsx` (new file)

- [ ] **Step 1: Create the ErrorBoundary component**

Create `client/src/components/ErrorBoundary.tsx`:

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-main">
          <div className="app-error-boundary" role="alert">
            <h1>Something went wrong</h1>
            <p>{this.state.error?.message ?? "An unexpected error occurred."}</p>
            <button
              type="button"
              className="auth-submit"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try again
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Wrap App content with ErrorBoundary**

In `client/src/App.tsx`, add the import:

```typescript
import { ErrorBoundary } from "./components/ErrorBoundary";
```

Then wrap the `AppGate` inside `App()` with it:

```tsx
export function App() {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <div className="app-shell" data-testid="app-root">
          <AppGate />
        </div>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
```

Note: also replaced `className={cn("app-shell")}` with `className="app-shell"` since `cn()` with a single string is a no-op (fixes L2).

- [ ] **Step 3: Write the test in a separate file**

**Important:** Do NOT put this test in `App.test.tsx`. Vitest hoists `vi.mock()` to module scope, so mocking `Dashboard` to throw would break all other tests in the same file. Create a dedicated test file instead.

Create `client/src/components/ErrorBoundary.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function ThrowingChild() {
  throw new Error("Boom");
}

describe("ErrorBoundary", () => {
  it("renders fallback UI when a child throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it("renders children normally when no error occurs", () => {
    render(
      <ErrorBoundary>
        <p>Hello</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run client/src/components/ErrorBoundary.test.tsx --reporter=verbose`
Expected: Both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ErrorBoundary.tsx client/src/components/ErrorBoundary.test.tsx client/src/App.tsx
git commit -m "feat: add React ErrorBoundary for graceful crash recovery (M3)"
```

---

### Task 10: Move Reclassify Off Dashboard Hot Path

**Files:**
- Modify: `server/routes.ts` -- `GET /api/dashboard-summary` handler (remove `reclassifyTransactions` call)
- Modify: `server/routes.ts` -- `POST /api/upload` handler (add fire-and-forget reclassify)
- Test: existing `server/reclassify.test.ts` (verify still passes)

- [ ] **Step 1: Remove reclassify from dashboard endpoint**

In `server/routes.ts`, find the `GET /api/dashboard-summary` handler (search for `app.get("/api/dashboard-summary"`). Remove the `await reclassifyTransactions(userId);` line. The handler becomes:

```typescript
  app.get("/api/dashboard-summary", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;

      const q = req.query;
      const dateFrom = typeof q.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.dateFrom) ? q.dateFrom : undefined;
      const dateTo = typeof q.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.dateTo) ? q.dateTo : undefined;

      const summary = await buildDashboardSummary(userId, { dateFrom, dateTo });
      res.json(summary);
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 2: Add reclassify as a fire-and-forget post-upload step**

In the `POST /api/upload` handler (search for `app.post("/api/upload"`), after the `for (const file of files)` loop completes and **before** `res.status(201).json({ results });`, add:

```typescript
        reclassifyTransactions(userId).catch((err) =>
          console.error("Post-upload reclassify failed:", err),
        );
```

This runs reclassification after each upload but does not block the response.

- [ ] **Step 3: Remove unused reclassify import if only used in upload now**

Verify the `reclassifyTransactions` import at the top of `routes.ts` is still needed. It is -- it's now used in the upload handler. No change needed.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project server --reporter=verbose`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts
git commit -m "perf: move reclassify from dashboard GET to post-upload fire-and-forget (H1)"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 3: Run npm audit**

Run: `npm audit`
Expected: No critical or high vulnerabilities. Review any remaining advisories.

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git status
```

If clean, done. If fixups were needed, commit with: `git commit -m "chore: final fixups from security hardening"`
