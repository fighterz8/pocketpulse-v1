/**
 * End-to-end flow test for the async-AI progress badge.
 *
 * Wires Vitest + supertest into the jsdom React tree by mounting the real
 * Express app (via `createApp` with module-boundary mocks for storage,
 * the AI worker, CSRF, and CSV parsing) and shimming `globalThis.fetch`
 * to delegate to a single supertest agent. That gives us:
 *
 *   • A real react-query client running the actual `useAiEnhancementStatus`
 *     polling hook and the gated `useTransactions` refetchInterval.
 *   • The real `/api/uploads/ai-status`, `/api/upload`, `/api/transactions`
 *     route handlers with real session middleware (so cookies and auth
 *     are honoured end-to-end).
 *   • A scripted "worker" — the test mutates the value returned by the
 *     mocked `listActiveAiUploadsForUser` to simulate progress without
 *     having to spin up the real worker / Postgres / OpenAI.
 *
 * What this pins:
 *   1. The aggregate ai-status query begins polling once the upload
 *      mutation resolves (no need to wait for window focus).
 *   2. As the worker advances, the badge's `text-ai-pulse-count` updates
 *      with monotonically non-decreasing percentage.
 *   3. On worker completion the badge shows a completion message
 *      toast and unmounts within ~2.5s.
 *   4. On worker failure the badge shows the failure variant and unmounts
 *      within ~5s.
 *   5. The Ledger transactions query refetches on the 5s cadence while AI
 *      is active and stops once it goes idle.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import session from "express-session";
import type { ReactNode } from "react";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ── Module-boundary mocks ────────────────────────────────────────────────
// Same boundary the existing route tests use (server/upload-async-ai-routes.test.ts).
// Storage is the only place the routes read AI status from, so the test
// drives the whole worker progression by mutating its return value.

vi.mock("../../../../server/storage.js", async () => {
  return {
    // Auth / users
    createUser: vi.fn(
      async (input: { email: string; displayName: string }) => ({
        id: 42,
        email: input.email,
        displayName: input.displayName,
        companyName: null,
      }),
    ),
    getUserById: vi.fn(async (id: number) => ({
      id,
      email: "test@test.com",
      displayName: "Test",
      companyName: null,
    })),
    getUserByEmailForAuth: vi.fn(),
    DuplicateEmailError: class extends Error {},

    // Accounts
    listAccountsForUser: vi.fn(async () => [
      {
        id: 7,
        userId: 42,
        label: "Checking",
        lastFour: "1234",
        accountType: "checking",
      },
    ]),
    createAccountForUser: vi.fn(),

    // Uploads
    createUpload: vi.fn(async () => ({ id: 555 })),
    updateUploadStatus: vi.fn(async () => undefined),
    updateUploadAiStatus: vi.fn(async () => undefined),
    countNeedsAiForUpload: vi.fn(async () => 4),
    listUploadsForUser: vi.fn(async () => []),
    getUploadAiStatusForUser: vi.fn(),
    listActiveAiUploadsForUser: vi.fn(async () => []),
    getFormatSpec: vi.fn(async () => null),
    saveFormatSpec: vi.fn(async () => undefined),

    // Transactions
    createTransactionBatch: vi.fn(async () => ({
      insertedCount: 4,
      previouslyImported: 0,
      intraBatchDuplicates: 0,
    })),
    listTransactionsForUser: vi.fn(async () => ({
      transactions: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
      totals: { totalInflow: 0, totalOutflow: 0, totalRefund: 0 },
    })),
    listAllTransactionsForExport: vi.fn(async () => []),
    getTransactionById: vi.fn(),
    updateTransaction: vi.fn(),
    propagateUserCorrection: vi.fn(),
    deleteAllTransactionsForUser: vi.fn(),
    deleteWorkspaceDataForUser: vi.fn(),

    // Misc helpers referenced by the routes file at import time
    listRecurringReviewsForUser: vi.fn(async () => []),
    upsertRecurringReview: vi.fn(),
    upsertMerchantClassification: vi.fn(),
    upsertMerchantRule: vi.fn(),
  };
});

vi.mock("../../../../server/aiWorker.js", () => ({
  // The real worker is fire-and-forget after the upload response. The
  // test scripts progression directly via listActiveAiUploadsForUser, so
  // a no-op worker is exactly what we want.
  runUploadAiWorker: vi
    .fn()
    .mockResolvedValue({ uploadId: 555, status: "skipped", rowsProcessed: 0 }),
}));

vi.mock("../../../../server/csvParser.js", () => ({
  // One row is enough — the upload route only needs `parseResult.ok` plus
  // a row count so the response status is "complete" and the AI tracking
  // columns are seeded.
  parseCSV: vi.fn(async () => ({
    ok: true,
    rows: [
      {
        date: "2026-04-01",
        description: "STARBUCKS #1234",
        amount: -5.5,
        ambiguous: false,
      },
    ],
    warnings: [],
    detectedSpec: { hasHeader: true, columns: {}, dateFormat: "YYYY-MM-DD" },
  })),
}));

vi.mock("../../../../server/csvFormatDetector.js", () => ({
  detectCsvFormat: vi.fn(async () => null),
}));

vi.mock("../../../../server/classifyPipeline.js", () => ({
  classifyPipeline: vi.fn(
    async (rows: Array<{ rawDescription: string; amount: number }>) =>
      rows.map((r) => ({
        merchant: "Starbucks",
        amount: r.amount,
        flowType: r.amount < 0 ? "outflow" : "inflow",
        transactionClass: "expense",
        recurrenceType: "one-time",
        recurrenceSource: "none",
        category: "other",
        labelSource: "rule",
        labelConfidence: 0.5,
        labelReason: "rule:test",
        aiAssisted: true,
      })),
  ),
}));

vi.mock("../../../../server/recurrenceDetector.js", () => ({
  detectRecurringCandidates: vi.fn(() => []),
  recurrenceKey: vi.fn((m: string) => m.toLowerCase()),
}));

vi.mock("../../../../server/csrf.js", () => ({
  // Pass-through: we don't want CSRF cookie/state mechanics in the way of
  // the polling assertions. The route exists end-to-end either way.
  doubleCsrfProtection: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  generateToken: () => "test-token",
  invalidCsrfTokenError: new Error("invalid csrf"),
}));

vi.mock("../../../../server/auth.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  normalizeEmail: vi.fn((e: string) => e.toLowerCase().trim()),
}));

vi.mock("../../../../server/db.js", () => {
  // syncRecurringCandidates issues db.update().set().where() chains. We
  // never assert on those — return a resolved promise from .where so the
  // route handler completes cleanly.
  const chain = {
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return {
    db: { update: () => chain },
    pool: {},
    ensureUserPreferences: vi.fn(),
  };
});

vi.mock("../../../../server/dashboardQueries.js", () => ({
  buildDashboardSummary: vi.fn(async () => ({})),
}));

vi.mock("../../../../server/cashflow.js", () => ({
  detectLeaks: vi.fn(() => []),
}));

vi.mock("../../../../server/reclassify.js", () => ({
  reclassifyTransactions: vi.fn(async () => ({
    total: 0,
    updated: 0,
    skippedUserCorrected: 0,
    unchanged: 0,
  })),
}));

vi.mock("../../../../server/devTestSuite.js", () => ({
  createDevTestSuiteRouter: () => {
    // Minimal express-compatible no-op router.
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

// ── Imports that depend on the mocks above ──────────────────────────────

import { createApp } from "../../../../server/routes.js";
import {
  listActiveAiUploadsForUser,
  listTransactionsForUser,
} from "../../../../server/storage.js";
// Main rebased onto a refactor that replaced AiEnhancementBadge with the
// brand-integrated BrandPulse component. BrandPulse preserves the same
// data-testid contract (`ai-pulse-badge`, `text-ai-pulse-count`,
// `text-ai-pulse-status`, `ai-pulse-tooltip-row-{id}`) so this test
// continues to exercise the same end-to-end flow without modification.
import { BrandPulse as AiEnhancementBadge } from "./BrandPulse";
import { useTransactions } from "../../hooks/use-transactions";
import {
  aiEnhancementStatusKey,
  useAiEnhancementStatus,
} from "../../hooks/use-ai-enhancement-status";
import { useUploads } from "../../hooks/use-uploads";

// ── Supertest agent + fetch shim ────────────────────────────────────────

type FlexAgent = ReturnType<typeof request.agent>;

let agent: FlexAgent;
let originalFetch: typeof fetch;

/**
 * Translate a Fetch API call into a supertest agent call. The agent
 * carries cookies between requests, so once /api/auth/register sets the
 * session, every subsequent call from react-query is authenticated.
 */
async function fetchShim(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  // Strip any origin if present — supertest expects path-only.
  const url = rawUrl.replace(/^https?:\/\/[^/]+/, "");
  const method = (init?.method ?? "GET").toUpperCase();

  let req: ReturnType<FlexAgent["get"]>;
  switch (method) {
    case "POST":
      req = agent.post(url);
      break;
    case "PATCH":
      req = agent.patch(url);
      break;
    case "PUT":
      req = agent.put(url);
      break;
    case "DELETE":
      req = agent.delete(url);
      break;
    default:
      req = agent.get(url);
  }

  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => {
      req.set(key, value);
    });
  }

  if (init?.body != null) {
    const body = init.body;
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      // Iterate entries and split string/file fields into supertest's
      // .field()/.attach() calls. jsdom's `Blob.arrayBuffer()` is unstable
      // under fake timers (its internal microtask sometimes never settles),
      // so we read text via `.text()` and re-buffer ourselves — every File
      // we attach in this test is small UTF-8 CSV content.
      for (const [name, value] of body.entries()) {
        if (typeof value === "string") {
          req.field(name, value);
        } else {
          const blob = value as Blob & { name?: string; __buffer?: Buffer };
          const buf = blob.__buffer ?? Buffer.from(await blob.text(), "utf-8");
          req.attach(name, buf, blob.name ?? "file.csv");
        }
      }
    } else if (typeof body === "string") {
      req.send(body);
    } else {
      req.send(body as never);
    }
  }

  const res = await req;

  const headerInit: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    headerInit[k] = Array.isArray(v) ? v.join(",") : String(v);
  }
  // supertest exposes the raw body as `res.text` for textual content
  // types (which is everything our routes return) and `res.body` for
  // pre-parsed JSON. Prefer `res.text` so jsdom's Response.json() runs
  // the same parsing path the production frontend would.
  const bodyText =
    typeof res.text === "string" && res.text.length > 0
      ? res.text
      : res.body != null
        ? JSON.stringify(res.body)
        : "";

  return new Response(bodyText, {
    status: res.status,
    headers: headerInit,
  });
}

// ── Helpers to script the AI status state machine ───────────────────────

type StatusEntry = {
  id: number;
  filename: string;
  aiStatus: "pending" | "processing" | "complete" | "failed";
  aiRowsPending: number;
  aiRowsDone: number;
  aiStartedAt: Date | null;
  aiCompletedAt: Date | null;
  aiError: string | null;
};

function setActiveStatus(entries: StatusEntry[]) {
  vi.mocked(listActiveAiUploadsForUser).mockImplementation(
    async () => entries as never,
  );
}

// ── Test wiring ─────────────────────────────────────────────────────────

let queryClient: QueryClient;

beforeAll(() => {
  // The session middleware uses a memory store so no Postgres is needed.
  const app = createApp({ sessionStore: new session.MemoryStore() });
  agent = request.agent(app);
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchShim(input, init)) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  // Default: nothing active. Individual tests script progression.
  setActiveStatus([]);
  vi.mocked(listTransactionsForUser).mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

/**
 * Tiny Ledger stand-in: subscribes to the AI status hook, gates the
 * transactions refetch the same way the real Ledger does, and exposes
 * the raw call count to the test via a data-testid attribute. Avoids
 * pulling in the full Ledger page and its many unrelated dependencies.
 */
function LedgerProbe() {
  const { anyActive } = useAiEnhancementStatus();
  useTransactions(
    { page: 1, limit: 50 },
    { refetchInterval: anyActive ? 5000 : false },
  );
  return null;
}

function UploadButton() {
  const { upload } = useUploads();
  const onClick = () => {
    const csv = "date,desc,amount\n2026-04-01,Starbucks,-5.5";
    const file = new File([csv], "feb.csv", { type: "text/csv" });
    // jsdom's Blob.text()/.arrayBuffer() can hang under fake timers because
    // their internal microtask scheduling sometimes never settles. The
    // fetchShim looks for this side-channel buffer first and only falls
    // back to async Blob reads when it's absent.
    (file as unknown as { __buffer: Buffer }).__buffer = Buffer.from(
      csv,
      "utf-8",
    );
    upload.mutate({ files: [file], metadata: { "feb.csv": { accountId: 7 } } });
  };
  return (
    <button data-testid="button-test-upload" onClick={onClick}>
      upload
    </button>
  );
}

function TestRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      <AiEnhancementBadge gradId="test-ai-enhancement-pulse" />
      <LedgerProbe />
      <UploadButton />
    </QueryClientProvider>
  );
}

async function authenticate() {
  // Establishes the session cookie on the supertest agent. Subsequent
  // calls from the React tree (via fetchShim) inherit it automatically.
  const res = await agent
    .post("/api/auth/register")
    .set("X-CSRF-Token", "test-token")
    .send({
      email: "flow@test.com",
      password: "password123",
      displayName: "Flow",
    });
  expect(res.status).toBe(201);
}

async function flush() {
  // One macrotask + microtask drain. React-query's internal scheduling
  // sometimes needs an extra tick after fake timers advance.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("AI enhancement badge end-to-end", () => {
  it("appears, ticks monotonically, completes, and fades after the worker finishes", async () => {
    await authenticate();

    render(<TestRoot />);

    // Initial poll resolves with no active uploads → badge should not render.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.queryByTestId("ai-pulse-badge")).toBeNull();

    // Phase 1: upload mutation fires. Server seeds aiStatus=pending; the
    // mutation's onSuccess invalidates the ai-status query, which is what
    // promotes the badge BEFORE the next poll tick (the assertion called
    // out in the task as "without waiting for window focus").
    setActiveStatus([
      {
        id: 555,
        filename: "feb.csv",
        aiStatus: "pending",
        aiRowsPending: 4,
        aiRowsDone: 0,
        aiStartedAt: null,
        aiCompletedAt: null,
        aiError: null,
      },
    ]);

    screen.getByTestId("button-test-upload").click();

    // Drain the upload mutation + invalidation + refetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const initialBadge = await screen.findByTestId("text-ai-pulse-count");
    expect(initialBadge.textContent).toMatch(/Enhancing transactions/);
    expect(initialBadge.textContent).toMatch(/0%/);

    // Phase 2: worker advances. We script three progress points and each
    // poll tick (3s) should pick them up. Capture the percentage after
    // every advance and assert it is monotonically non-decreasing.
    const percentages: number[] = [0];
    const advance = async (done: number) => {
      setActiveStatus([
        {
          id: 555,
          filename: "feb.csv",
          aiStatus: "processing",
          aiRowsPending: 4,
          aiRowsDone: done,
          aiStartedAt: new Date(),
          aiCompletedAt: null,
          aiError: null,
        },
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      const text = screen.getByTestId("text-ai-pulse-count").textContent ?? "";
      const m = text.match(/(\d+)%/);
      expect(m).not.toBeNull();
      percentages.push(parseInt(m![1]!, 10));
    };

    await advance(1);
    await advance(2);
    await advance(3);

    for (let i = 1; i < percentages.length; i++) {
      expect(percentages[i]).toBeGreaterThanOrEqual(percentages[i - 1]!);
    }
    expect(percentages[percentages.length - 1]).toBeGreaterThan(0);

    // Phase 3: worker completes. Active set drains to empty, the hook's
    // edge-trigger flips lastJustCompleted=true, badge swaps to the
    // "complete" toast.
    setActiveStatus([
      {
        id: 555,
        filename: "feb.csv",
        aiStatus: "complete",
        aiRowsPending: 4,
        aiRowsDone: 4,
        aiStartedAt: new Date(Date.now() - 10000),
        aiCompletedAt: new Date(),
        aiError: null,
      },
    ]);
    // Refetch without advancing through the completion toast's own 2s
    // dismissal timer. Advancing one large fake-timer window can otherwise
    // both discover completion and dismiss it before this assertion observes
    // the intermediate state, depending on suite scheduling load.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: aiEnhancementStatusKey });
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-ai-pulse-status").textContent).toMatch(
        /4 transactions enhanced|AI enhancement complete/,
      );
    });

    // Phase 4: complete toast disappears within ~2.5s (hook uses a 2s
    // timeout — we give a small buffer for scheduling jitter).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await flush();
    expect(screen.queryByTestId("ai-pulse-badge")).toBeNull();
  });

  it("transitions to the failure variant and unmounts within ~5s on worker failure", async () => {
    await authenticate();
    render(<TestRoot />);

    // Active immediately so the next poll picks it up.
    setActiveStatus([
      {
        id: 777,
        filename: "broken.csv",
        aiStatus: "processing",
        aiRowsPending: 2,
        aiRowsDone: 0,
        aiStartedAt: new Date(),
        aiCompletedAt: null,
        aiError: null,
      },
    ]);

    screen.getByTestId("button-test-upload").click();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await screen.findByTestId("text-ai-pulse-count");

    // Worker fails — active drains, terminal entry is "failed".
    setActiveStatus([
      {
        id: 777,
        filename: "broken.csv",
        aiStatus: "failed",
        aiRowsPending: 2,
        aiRowsDone: 0,
        aiStartedAt: new Date(Date.now() - 5000),
        aiCompletedAt: new Date(),
        aiError: "AI provider timeout",
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-ai-pulse-status").textContent).toMatch(
        /AI enhancement failed/,
      );
    });

    // Failure variant fades after ~4s (hook timeout). Allow a 1s buffer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flush();
    expect(screen.queryByTestId("ai-pulse-badge")).toBeNull();
  });

  it("polls /api/transactions on the 5s cadence while AI is active and stops once idle", async () => {
    await authenticate();
    render(<TestRoot />);

    // Drain initial fetches (auth/me, accounts, ai-status with no active,
    // first transactions call from LedgerProbe). Use waitFor so timing
    // jitter from supertest's async path doesn't flake the assertion.
    await waitFor(
      async () => {
        await vi.advanceTimersByTimeAsync(50);
        expect(
          vi.mocked(listTransactionsForUser).mock.calls.length,
        ).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    const baseline = vi.mocked(listTransactionsForUser).mock.calls.length;

    // Activate AI: refetchInterval flips to 5000.
    setActiveStatus([
      {
        id: 999,
        filename: "live.csv",
        aiStatus: "processing",
        aiRowsPending: 5,
        aiRowsDone: 0,
        aiStartedAt: new Date(),
        aiCompletedAt: null,
        aiError: null,
      },
    ]);
    screen.getByTestId("button-test-upload").click();
    await waitFor(
      async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect(screen.queryByTestId("text-ai-pulse-count")).not.toBeNull();
      },
      { timeout: 3000 },
    );

    const beforePolling = vi.mocked(listTransactionsForUser).mock.calls.length;

    // Two 5s ticks → at least two extra transactions calls. supertest's
    // request handling rides on real-time microtasks, so each fake-timer
    // jump must be followed by a brief real-time drain to let the next
    // refetchInterval timer get re-scheduled before the next jump. Without
    // this drain the first refetch's response races past the second
    // advance and the second tick is silently dropped.
    for (let i = 0; i < 11; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    const duringPolling = vi.mocked(listTransactionsForUser).mock.calls.length;
    expect(duringPolling - beforePolling).toBeGreaterThanOrEqual(2);

    // Drain to complete + let the complete toast fade.
    setActiveStatus([
      {
        id: 999,
        filename: "live.csv",
        aiStatus: "complete",
        aiRowsPending: 5,
        aiRowsDone: 5,
        aiStartedAt: new Date(Date.now() - 10000),
        aiCompletedAt: new Date(),
        aiError: null,
      },
    ]);
    // Drain through the active→complete edge transition, the 2s
    // "complete" toast timeout, and any in-flight refetches that the
    // upload mutation queued. Same real-time drain trick as the polling
    // loop so the unmount actually settles.
    await waitFor(
      async () => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(screen.queryByTestId("ai-pulse-badge")).toBeNull();
      },
      { timeout: 8000 },
    );

    const afterIdle = vi.mocked(listTransactionsForUser).mock.calls.length;

    // Now that AI is idle, two more 5s windows must NOT bump the count.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(vi.mocked(listTransactionsForUser).mock.calls.length).toBe(
      afterIdle,
    );
  });
});
