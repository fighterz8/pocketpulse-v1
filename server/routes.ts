import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import express, { type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import session from "express-session";
import multer from "multer";
import helmet from "helmet";

import crypto from "crypto";
import { parse as csvParseSync } from "csv-parse/sync";
import { doubleCsrfProtection, generateToken, invalidCsrfTokenError } from "./csrf.js";
import { hashPassword, verifyPassword } from "./auth.js";
import { classifyPipeline } from "./classifyPipeline.js";
import { parseCSV } from "./csvParser.js";
import { detectCsvFormat } from "./csvFormatDetector.js";
import { ensureUserPreferences, pool } from "./db.js";
import { AUTO_ESSENTIAL_CATEGORIES, REVIEW_STATUSES, V1_CATEGORIES } from "../shared/schema.js";
import { DEV_MODE_ENABLED } from "../shared/devConfig.js";
import {
  countNeedsAiForUpload,
  createAccountForUser,
  createTransactionBatch,
  createUpload,
  createUser,
  deleteAllTransactionsForUser,
  deleteWorkspaceDataForUser,
  addWaitlistEmail,
  listAllWaitlistEmails,
  DuplicateEmailError,
  DuplicateWaitlistEmailError,
  getFormatSpec,
  getTransactionById,
  getUploadAiStatusForUser,
  getUserByEmailForAuth,
  getUserById,
  listAccountsForUser,
  listActiveAiUploadsForUser,
  listAllTransactionsForExport,
  listRecurringReviewsForUser,
  listTransactionsForUser,
  listUploadsForUser,
  propagateUserCorrection,
  saveFormatSpec,
  updateTransaction,
  updateUploadAiStatus,
  updateUploadStatus,
  upsertMerchantClassification,
  upsertMerchantRule,
  upsertRecurringReview,
  type UpdateTransactionInput,
} from "./storage.js";
import { and, eq, inArray, ne } from "drizzle-orm";
import { buildDashboardSummary } from "./dashboardQueries.js";
import { db } from "./db.js";
import { detectRecurringCandidates, recurrenceKey } from "./recurrenceDetector.js";
import { detectLeaks } from "./cashflow.js";
import { createDevTestSuiteRouter } from "./devTestSuite.js";
import { reclassifyTransactions } from "./reclassify.js";
import { runUploadAiWorker } from "./aiWorker.js";
import { getUncachableResendClient } from "./resend.js";
import { buildLaunchEmailHtml, buildLaunchEmailText } from "./launchEmail.js";
import { transactions as txnTable, users as usersTable } from "../shared/schema.js";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    lastActivity?: number;
  }
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const PgSession = connectPgSimple(session);

export type CreateAppOptions = {
  /** Override session store (route tests use `MemoryStore` so PostgreSQL `session` is not required). */
  sessionStore?: session.Store;
};

function defaultSessionStore() {
  return new PgSession({
    pool,
    tableName: "session",
    // Table is defined in `shared/schema.ts`; create via `npm run db:push` / migrations.
    createTableIfMissing: false,
  });
}

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
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

function saveSession(req: express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function regenerateSession(req: express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session.userId == null) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const now = Date.now();
  const lastActivity = req.session.lastActivity;
  if (lastActivity != null && now - lastActivity > IDLE_TIMEOUT_MS) {
    req.session.destroy(() => {
      res.clearCookie("pocketpulse.sid", sessionCookieOptions);
      res.status(401).json({ error: "Session expired due to inactivity" });
    });
    return;
  }
  req.session.lastActivity = now;
  next();
};

const sessionCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
};

/**
 * Runs the recurring-expense detector and writes back to every outflow
 * transaction row for the given user:
 *   - recurrenceType:   detected recurring IDs → "recurring"; others → "one-time"
 *   - transactionClass: recurring outflow transfers (not user-corrected) →
 *                       "expense" (labelSource="recurring-transfer"), reversed
 *                       on the next sync if the pattern stops.
 *
 * Called automatically after every successful upload, after a full reclassify
 * run, and by the manual POST /api/recurring-candidates/sync endpoint.
 */
async function syncRecurringCandidates(
  userId: number,
): Promise<{ recurringCount: number; oneTimeCount: number }> {
  const allTxns = await listAllTransactionsForExport({ userId });
  const candidates = detectRecurringCandidates(allTxns as any);

  const recurringIds = new Set<number>();
  for (const c of candidates) {
    for (const id of c.transactionIds) recurringIds.add(id);
  }

  // Step 1: reset all outflow transactions to "one-time" / "detected" EXCEPT rows
  // where the user has explicitly set a recurrence value (userCorrected=true →
  // labelSource "manual") or a same-merchant propagation carried that value
  // (labelSource "propagated"). User edits are law — the detector never overwrites them.
  //
  // recurrenceSource is set to "detected" (not "none") because the batch detector
  // has now evaluated every outflow row for this user. A reset row means the
  // detector explicitly found insufficient evidence — that IS a detector determination,
  // distinguishable from rows the detector never touched (source="none"/"hint").
  await db
    .update(txnTable)
    .set({ recurrenceType: "one-time", recurrenceSource: "detected" })
    .where(
      and(
        eq(txnTable.userId, userId),
        eq(txnTable.flowType, "outflow"),
        eq(txnTable.excludedFromAnalysis, false),
        ne(txnTable.labelSource, "manual"),
        ne(txnTable.labelSource, "propagated"),
      ),
    );

  // Step 1b: Roll back any previously-promoted recurring-transfer rows that
  // are no longer in the recurring set (stale promotions). Skips user-corrected
  // rows so explicit manual edits are always preserved.
  // recurrenceSource stays "detected" (set by Step 1) — the detector evaluated
  // and rejected these rows on this sync cycle.
  await db
    .update(txnTable)
    .set({ transactionClass: "transfer", labelSource: "rule" })
    .where(
      and(
        eq(txnTable.userId, userId),
        eq(txnTable.labelSource, "recurring-transfer"),
        eq(txnTable.userCorrected, false),
      ),
    );

  // Step 2: mark detected IDs as "recurring" / "detected". Same user-edit guard
  // as Step 1 — a manually-set "one-time" on a recurring-looking transaction
  // stays "one-time".
  if (recurringIds.size > 0) {
    const ids = [...recurringIds];
    for (let i = 0; i < ids.length; i += 500) {
      await db
        .update(txnTable)
        .set({ recurrenceType: "recurring", recurrenceSource: "detected" })
        .where(
          and(
            eq(txnTable.userId, userId),
            inArray(txnTable.id, ids.slice(i, i + 500)),
            ne(txnTable.labelSource, "manual"),
            ne(txnTable.labelSource, "propagated"),
          ),
        );
    }
  }

  // Step 3: Recurring outflow transfers → reclassify as expense.
  //
  // A bank transfer that repeats on a predictable schedule is almost always a
  // real financial obligation (rent, loan, regular payments to a vendor) rather
  // than a neutral fund movement.  Reclassifying it as an expense makes the
  // dashboard totals, safe-to-spend, and category breakdowns accurate.
  //
  // We only promote rows that:
  //   • Are in the recurring candidate set (confirmed by detector)
  //   • Have flowType="outflow" (never touch transfer inflows)
  //   • Have transactionClass="transfer" (already expense-classified rows are fine)
  //   • Have NOT been manually overridden by the user
  //
  // We store labelSource="recurring-transfer" so Step 1b can cleanly undo
  // the promotion on the next sync if the pattern stops.
  if (recurringIds.size > 0) {
    const ids = [...recurringIds];
    for (let i = 0; i < ids.length; i += 500) {
      await db
        .update(txnTable)
        .set({ transactionClass: "expense", labelSource: "recurring-transfer" })
        .where(
          and(
            eq(txnTable.userId, userId),
            inArray(txnTable.id, ids.slice(i, i + 500)),
            eq(txnTable.transactionClass, "transfer"),
            eq(txnTable.flowType, "outflow"),
            eq(txnTable.userCorrected, false),
            ne(txnTable.labelSource, "manual"),
            ne(txnTable.labelSource, "propagated"),
          ),
        );
    }
  }

  const oneTimeCount = (allTxns as any[]).filter(
    (t) =>
      t.flowType === "outflow" &&
      !t.excludedFromAnalysis &&
      !recurringIds.has(t.id),
  ).length;

  return { recurringCount: recurringIds.size, oneTimeCount };
}

export function createApp(options?: CreateAppOptions) {
  const store = options?.sessionStore ?? defaultSessionStore();
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" },
  });
  app.use(globalLimiter);
  app.use(express.json());
  app.use(cookieParser());
  app.use(sessionMiddleware(store));

  /**
   * POST /api/admin/send-launch-email
   *
   * Sends the PocketPulse launch announcement to every address in the waitlist.
   * Protected by the ADMIN_SECRET header — only the team triggers this on launch day.
   * Registered before the CSRF middleware because it is a server-to-server call.
   *
   * Request body (optional):
   *   { dryRun: true }  — lists subscribers without sending; useful for a pre-flight check.
   *
   * Returns: { sent: number, failed: number, dryRun: boolean }
   */
  app.post("/api/admin/send-launch-email", async (req, res, next) => {
    try {
      const secret = req.headers["x-admin-secret"];
      const expected = process.env.ADMIN_SECRET;
      if (!expected || secret !== expected) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const dryRun = Boolean(req.body?.dryRun);
      const subscribers = await listAllWaitlistEmails();

      if (dryRun) {
        res.json({ dryRun: true, count: subscribers.length, emails: subscribers.map((s) => s.email) });
        return;
      }

      if (subscribers.length === 0) {
        res.json({ sent: 0, failed: 0, dryRun: false });
        return;
      }

      const { client, fromEmail } = await getUncachableResendClient();
      const html = buildLaunchEmailHtml();
      const text = buildLaunchEmailText();

      const BATCH_SIZE = 50;
      const BATCH_DELAY_MS = 1000;
      let sent = 0;
      let failed = 0;

      for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
        const batch = subscribers.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async ({ email }) => {
            try {
              await client.emails.send({
                from: "PocketPulse <onboarding@resend.dev>",
                to: email,
                subject: "PocketPulse is live — your finances just got a whole lot clearer 🎉",
                html,
                text,
              });
              sent++;
            } catch (err) {
              console.error(`[launch-email] Failed to send to ${email}:`, err);
              failed++;
            }
          }),
        );
        if (i + BATCH_SIZE < subscribers.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      res.json({ sent, failed, dryRun: false });
    } catch (e) {
      next(e);
    }
  });

  app.use(doubleCsrfProtection);

  app.get("/api/csrf-token", (req, res) => {
    const token = generateToken(req, res);
    res.json({ token });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/auth/me", async (req, res, next) => {
    try {
      const userId = req.session.userId;
      if (userId == null) {
        res.json({ authenticated: false });
        return;
      }

      const now = Date.now();
      const lastActivity = req.session.lastActivity;
      if (lastActivity != null && now - lastActivity > IDLE_TIMEOUT_MS) {
        await destroySession(req);
        res.clearCookie("pocketpulse.sid", sessionCookieOptions);
        res.json({ authenticated: false });
        return;
      }

      const user = await getUserById(userId);
      if (!user) {
        await destroySession(req);
        res.clearCookie("pocketpulse.sid", sessionCookieOptions);
        res.json({ authenticated: false });
        return;
      }

      req.session.lastActivity = now;
      res.json({ authenticated: true, user });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/beta/unlock", authLimiter, (req, res) => {
    const expected = process.env.BETA_ACCESS_CODE;
    if (!expected || expected.length === 0) {
      console.warn(
        "[beta] BETA_ACCESS_CODE is not set — all beta unlock attempts will be rejected. Add it in Replit Secrets to enable the gate.",
      );
      res.status(401).json({ error: "Invalid code" });
      return;
    }

    const submitted = req.body?.code;
    if (typeof submitted !== "string" || submitted.length === 0) {
      res.status(401).json({ error: "Invalid code" });
      return;
    }

    const a = Buffer.from(submitted.trim().toLowerCase(), "utf8");
    const b = Buffer.from(expected.trim().toLowerCase(), "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: "Invalid code" });
      return;
    }

    res.json({ ok: true });
  });

  app.post("/api/waitlist", authLimiter, async (req, res, next) => {
    try {
      const { email } = req.body ?? {};
      if (typeof email !== "string" || !email.trim()) {
        res.status(400).json({ error: "A valid email is required." });
        return;
      }
      const normalized = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        res.status(400).json({ error: "Please enter a valid email address." });
        return;
      }
      await addWaitlistEmail(normalized);
      res.status(201).json({ ok: true });
    } catch (e) {
      if (e instanceof DuplicateWaitlistEmailError) {
        res.status(200).json({ ok: true });
        return;
      }
      next(e);
    }
  });

  app.post("/api/auth/register", authLimiter, async (req, res, next) => {
    try {
      const { email, password, displayName, companyName, isDev } = req.body ?? {};
      if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        typeof displayName !== "string"
      ) {
        res
          .status(400)
          .json({ error: "email, password, and displayName are required" });
        return;
      }

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

      const passwordHash = await hashPassword(password);
      const user = await createUser({
        email,
        passwordHash,
        displayName,
        companyName:
          companyName === undefined || companyName === null
            ? null
            : String(companyName),
        isDev: DEV_MODE_ENABLED && isDev === true,
      });

      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.lastActivity = Date.now();
      await saveSession(req);
      // Return accounts (empty for new users) so the client can pre-populate
      // its cache and skip a sequential fetch after the session is established.
      res.status(201).json({ user, accounts: [] });
    } catch (e) {
      if (e instanceof DuplicateEmailError) {
        res.status(409).json({ error: e.message });
        return;
      }
      next(e);
    }
  });

  app.post("/api/auth/login", authLimiter, async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "email and password are required" });
        return;
      }

      const record = await getUserByEmailForAuth(email);
      if (
        !record ||
        !(await verifyPassword(password, record.passwordHash))
      ) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const user = await getUserById(record.id);
      if (!user) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      await ensureUserPreferences(record.id);
      await regenerateSession(req);
      req.session.userId = record.id;
      req.session.lastActivity = Date.now();
      await saveSession(req);
      // Return accounts alongside user so the client can pre-populate its cache
      // and skip a sequential fetch after the session is established.
      const userAccounts = await listAccountsForUser(record.id);
      res.json({ user, accounts: userAccounts });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/auth/logout", (req, res, next) => {
    if (!req.session) {
      res.status(204).end();
      return;
    }
    req.session.destroy((err) => {
      if (err) {
        next(err);
        return;
      }
      res.clearCookie("pocketpulse.sid", sessionCookieOptions);
      res.status(204).end();
    });
  });

  app.get("/api/accounts", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const accounts = await listAccountsForUser(userId);
      res.json({ accounts });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/accounts", requireAuth, async (req, res, next) => {
    try {
      const { label, lastFour, accountType } = req.body ?? {};
      if (typeof label !== "string" || !label.trim()) {
        res.status(400).json({ error: "label is required" });
        return;
      }

      const userId = req.session.userId!;
      const account = await createAccountForUser(userId, {
        label: label.trim(),
        lastFour:
          lastFour === undefined || lastFour === null
            ? null
            : String(lastFour),
        accountType:
          accountType === undefined || accountType === null
            ? null
            : String(accountType),
      });
      res.status(201).json({ account });
    } catch (e) {
      next(e);
    }
  });

  // -----------------------------------------------------------------------
  // Upload & import routes (Phase 2)
  // -----------------------------------------------------------------------

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
    fileFilter: (_req, file, cb) => {
      const isCSV =
        file.mimetype === "text/csv" ||
        file.mimetype === "application/vnd.ms-excel" ||
        file.originalname.toLowerCase().endsWith(".csv");
      cb(null, isCSV);
    },
  });

  /**
   * POST /api/upload
   *
   * Accepts multipart/form-data with:
   * - `files`: one or more CSV files
   * - `metadata`: JSON string mapping each filename to { accountId }
   *
   * Pipeline per file: validate -> parse -> classify -> persist upload + transactions.
   */
  app.post(
    "/api/upload",
    requireAuth,
    upload.array("files", 20),
    async (req, res, next) => {
      try {
        const userId = req.session.userId!;
        const files = req.files as Express.Multer.File[] | undefined;

        if (!files || files.length === 0) {
          res.status(400).json({ error: "No CSV files provided" });
          return;
        }

        let metadata: Record<string, { accountId: number }>;
        try {
          metadata = JSON.parse(
            typeof req.body.metadata === "string" ? req.body.metadata : "{}",
          );
        } catch {
          res.status(400).json({ error: "Invalid metadata JSON" });
          return;
        }

        // Verify all referenced accounts belong to the user
        const userAccounts = await listAccountsForUser(userId);
        const userAccountIds = new Set(userAccounts.map((a) => a.id));

        const results: Array<{
          filename: string;
          uploadId: number | null;
          status: string;
          rowCount: number;
          previouslyImported?: number;
          intraBatchDuplicates?: number;
          error?: string;
          warnings?: string[];
        }> = [];

        // Shared across all files in this request so that cross-file duplicates
        // (e.g. month-end and month-start exports from the same bank) are counted
        // as intraBatchDuplicates rather than previouslyImported.
        const sessionSeen = new Set<string>();

        for (const file of files) {
          const fileMeta = metadata[file.originalname];
          if (!fileMeta || !fileMeta.accountId) {
            results.push({
              filename: file.originalname,
              uploadId: null,
              status: "failed",
              rowCount: 0,
              error: `No account assigned to file "${file.originalname}"`,
            });
            continue;
          }

          if (!userAccountIds.has(fileMeta.accountId)) {
            results.push({
              filename: file.originalname,
              uploadId: null,
              status: "failed",
              rowCount: 0,
              error: `Account ${fileMeta.accountId} does not belong to this user`,
            });
            continue;
          }

          // Create upload record in pending state
          const uploadRecord = await createUpload({
            userId,
            accountId: fileMeta.accountId,
            filename: file.originalname,
            status: "processing",
          });

          // ── CSV parsing with AI format detection fallback ─────────────────

          // Helper: parse the first 12 rows of the raw file exactly once (memoized).
          // Used for both fingerprinting and AI detection.
          let _cachedSampleRows: string[][] | null = null;
          const getSampleRows = (): string[][] => {
            if (_cachedSampleRows !== null) return _cachedSampleRows;
            const rawText = file.buffer.toString("utf-8").replace(/^\uFEFF/, "").trimStart();
            try {
              _cachedSampleRows = csvParseSync(rawText, {
                relax_column_count: true,
                relax_quotes: true,
                skip_empty_lines: true,
                trim: true,
                to: 12,
              }) as string[][];
            } catch {
              _cachedSampleRows = [];
            }
            return _cachedSampleRows;
          };

          // 1. Fingerprint: SHA-256 of the structural header row only.
          //    We find the first row where ALL non-empty cells look like column
          //    names (text, not dates or numbers). This row is always identical
          //    across different monthly exports from the same bank.
          //    Returns null when sample parsing fails — cache is skipped entirely
          //    for that upload (no fingerprint collision on empty string).
          const isDateLike = (c: string) =>
            /^\d{1,4}[\/\-]\d{1,2}/.test(c) || /^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(c);
          const isAmountLike = (c: string) =>
            /^-?\$?[\d,]+\.?\d*$/.test(c) || /^\([0-9,]+\.?\d*\)$/.test(c);

          const headerFingerprint = (() => {
            const rows = getSampleRows();
            if (rows.length === 0) return null; // parse failed — skip cache entirely

            // Look for a header-like row (all cells are text, no dates/numbers)
            for (const row of rows.slice(0, 10)) {
              const nonEmpty = row.filter((c) => c.trim());
              if (nonEmpty.length < 2) continue;
              if (nonEmpty.every((c) => !isDateLike(c.trim()) && !isAmountLike(c.trim()))) {
                const normalized = row.map((c) => c.toLowerCase().trim()).join("|");
                return crypto.createHash("sha256").update(normalized).digest("hex");
              }
            }

            // Headerless (e.g. Wells Fargo) — structural fingerprint that is stable
            // across monthly exports. Based on: number of columns + per-column type
            // pattern (D=date, A=amount, T=text, _=empty). Content is NOT used,
            // so this fingerprint does not change when transaction values change.
            const dataRows = rows.slice(0, 6).filter((r) => r.some((c) => c.trim()));
            if (dataRows.length === 0) return null;
            const colCount = Math.max(...dataRows.map((r) => r.length));
            const colTypes: string[] = [];
            for (let col = 0; col < colCount; col++) {
              const types = dataRows.map((r) => {
                const c = (r[col] ?? "").trim();
                if (!c) return "_";
                if (isDateLike(c)) return "D";
                if (isAmountLike(c)) return "A";
                return "T";
              });
              // Use the most common type label for this column
              const freq = types.reduce<Record<string, number>>((acc, t) => {
                acc[t] = (acc[t] ?? 0) + 1;
                return acc;
              }, {});
              colTypes.push(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
            }
            const pattern = `${colCount}:${colTypes.join("")}`;
            return crypto.createHash("sha256").update(pattern).digest("hex");
          })();

          // The applied format spec for this parse (set after resolution).
          let appliedSpec: import("../shared/schema.js").CsvFormatSpec | null = null;

          // 2. Check for a cached format spec (fast path for repeat uploads).
          //    Skipped when fingerprint is null (sample rows unparseable).
          const cachedSpec = headerFingerprint
            ? await getFormatSpec(userId, headerFingerprint)
            : null;

          // 3a. Parse: use cached spec if available, otherwise run heuristic.
          let parseResult = await parseCSV(
            file.buffer,
            file.originalname,
            cachedSpec ?? undefined,
          );
          if (parseResult.ok && cachedSpec) appliedSpec = cachedSpec;

          // 3b. If a cached spec produced a failure (stale/invalid), retry heuristic.
          if (!parseResult.ok && cachedSpec) {
            console.warn(
              `[upload] cached spec failed for "${file.originalname}" ` +
              `(fp=${headerFingerprint?.slice(0, 8)}), retrying heuristic`,
            );
            parseResult = await parseCSV(file.buffer, file.originalname);
            if (parseResult.ok) appliedSpec = parseResult.detectedSpec ?? null;
          }

          // 3c. Low-confidence heuristic: trigger AI detection when the parse succeeded
          //     but used the positional (headerless) fallback or skipped many rows.
          //     "headerless positional" = hasHeader=false in detectedSpec.
          //     "high skip rate" = more than 15% of rows produced date/amount warnings.
          const isLowConfidenceParse =
            parseResult.ok &&
            !cachedSpec &&
            (parseResult.detectedSpec?.hasHeader === false ||
              parseResult.warnings.filter((w) => w.includes("skipped")).length >
                Math.max(3, parseResult.rows.length * 0.15));

          // 3d. If parse fully failed OR low-confidence, try AI format detection.
          const needsAi = !parseResult.ok || isLowConfidenceParse;
          if (needsAi) {
            const priorError = parseResult.ok ? null : parseResult.error;
            try {
              const sampleRecords = getSampleRows();
              if (sampleRecords.length > 0) {
                const aiSpec = await detectCsvFormat(sampleRecords);
                if (aiSpec) {
                  const aiParseResult = await parseCSV(file.buffer, file.originalname, aiSpec);
                  // Accept AI result only if it's better (ok, or same-ok with fewer skips)
                  const aiIsBetter =
                    aiParseResult.ok &&
                    (!parseResult.ok ||
                      aiParseResult.warnings.filter((w) => w.includes("skipped")).length <
                        parseResult.warnings.filter((w) => w.includes("skipped")).length);

                  if (aiIsBetter) {
                    if (headerFingerprint) {
                      saveFormatSpec(userId, headerFingerprint, aiSpec, "ai").catch((e) => {
                        console.warn(`[upload] saveFormatSpec (ai) failed: ${e}`);
                      });
                    }
                    parseResult = aiParseResult;
                    appliedSpec = aiSpec;
                    console.log(
                      `[upload] AI format detection improved parse for "${file.originalname}" ` +
                      `(user=${userId}, fp=${headerFingerprint?.slice(0, 8)})`,
                    );
                  }
                }
              }
            } catch (aiErr) {
              console.warn(
                `[upload] AI format detection threw for "${file.originalname}": ${aiErr}`,
              );
            }

            // If parse was already ok (low-confidence trigger), it remains ok.
            // If it was failing and AI didn't fix it, restore original error.
            if (!parseResult.ok && priorError !== null) {
              parseResult = { ok: false, error: priorError };
            }
          } else if (!cachedSpec && parseResult.ok && parseResult.detectedSpec) {
            // 4. Heuristic succeeded with sufficient confidence — save spec for next time.
            if (headerFingerprint) {
              saveFormatSpec(userId, headerFingerprint, parseResult.detectedSpec, "heuristic").catch(
                (e) => { console.warn(`[upload] saveFormatSpec (heuristic) failed: ${e}`); },
              );
            }
            appliedSpec = parseResult.detectedSpec;
          }

          // Safety net: appliedSpec must always reflect the spec that was actually
          // used when parsing succeeded (e.g. low-confidence path where AI didn't
          // improve things). This guarantees uploads.formatSpec is never null on success.
          if (parseResult.ok && !appliedSpec && parseResult.detectedSpec) {
            appliedSpec = parseResult.detectedSpec;
          }

          if (!parseResult.ok) {
            // DEV: log parse failures to the server console with the full error
            // so the workflow logs give an actionable diagnosis. Remove before GA.
            console.error(
              `[upload] parse FAILED for user=${userId} file="${file.originalname}": ${parseResult.error}`,
            );
            await updateUploadStatus(
              uploadRecord.id,
              "failed",
              0,
              parseResult.error,
            );
            results.push({
              filename: file.originalname,
              uploadId: uploadRecord.id,
              status: "failed",
              rowCount: 0,
              error: parseResult.error,
            });
            continue;
          }

          // Classification pipeline: rules → user-rules → cache → (AI deferred).
          //
          // We pass `skipAi: true` here so the upload request returns as soon
          // as rule + cache labels are applied. Rows that still want an AI
          // verdict are flagged via `needsAi` / `aiAssisted=true`; the
          // background worker spawned after `res.json()` (see below) then
          // promotes them to `labelSource='ai'` and writes the merchant
          // cache. `aiTimeoutMs` is unused on this code path but the option
          // type still requires a number — set to 0 for clarity.
          const pipelineOutputs = await classifyPipeline(
            parseResult.rows.map((r) => ({
              rawDescription: r.description,
              amount: r.amount,
              ambiguous: r.ambiguous,
            })),
            {
              userId,
              aiTimeoutMs: 0,
              aiConfidenceThreshold: 0.5,
              cacheWriteMinConfidence: 0.7,
              skipAi: true,
            },
          );

          const txnInputs = pipelineOutputs.map((out, i) => ({
            userId,
            uploadId: uploadRecord.id,
            accountId: fileMeta.accountId,
            date: parseResult.rows[i]!.date,
            amount: out.amount.toFixed(2),
            merchant: out.merchant,
            rawDescription: parseResult.rows[i]!.description,
            flowType: out.flowType,
            transactionClass: out.transactionClass,
            recurrenceType: out.recurrenceType,
            recurrenceSource: out.recurrenceSource,
            category: out.category,
            labelSource: out.labelSource,
            labelConfidence: out.labelConfidence.toFixed(2),
            labelReason: out.labelReason,
            aiAssisted: out.aiAssisted,
          }));

          const { insertedCount, previouslyImported, intraBatchDuplicates } =
            await createTransactionBatch(txnInputs, sessionSeen);

          await updateUploadStatus(
            uploadRecord.id,
            "complete",
            insertedCount,
            null,
            appliedSpec,
            parseResult.warnings.length,
          );

          // Seed the AI tracking columns based on what actually landed in
          // the DB. dedup may have removed some inputs, so we count the
          // surviving rows that still want AI rather than trusting the
          // pre-insert pipeline output count.
          let needsAiCount = 0;
          try {
            needsAiCount = await countNeedsAiForUpload(uploadRecord.id);
          } catch {
            // Non-fatal: the worker will recount when it starts.
          }
          await updateUploadAiStatus(uploadRecord.id, {
            aiStatus: needsAiCount > 0 ? "pending" : "complete",
            aiRowsPending: needsAiCount,
            aiRowsDone: 0,
            aiStartedAt: null,
            aiCompletedAt: needsAiCount > 0 ? null : new Date(),
            aiError: null,
          });

          results.push({
            filename: file.originalname,
            uploadId: uploadRecord.id,
            status: "complete",
            rowCount: insertedCount,
            previouslyImported: previouslyImported > 0 ? previouslyImported : undefined,
            intraBatchDuplicates: intraBatchDuplicates > 0 ? intraBatchDuplicates : undefined,
            warnings:
              parseResult.warnings.length > 0
                ? parseResult.warnings
                : undefined,
          });
        }

        // Auto-sync recurring candidates after all files are processed so the
        // dashboard reflects the updated recurring-expense baseline immediately
        // (no manual "Sync to Dashboard" button click required).
        const anySuccess = results.some((r) => r.status === "complete");
        if (anySuccess) {
          try {
            await syncRecurringCandidates(userId);
          } catch {
            // Non-fatal: sync failure should not break the upload response.
            // The user can manually trigger re-sync from the Leaks page.
          }
        }

        res.status(201).json({ results });

        // Fire-and-forget the AI worker for every upload that has pending
        // rows. Runs AFTER res.json so the user sees their data immediately;
        // rule + cache labels are already in the response. Each worker
        // self-guards against double-spawn via an in-process Set, so it is
        // safe to call here even if the startup sweep also picked up the
        // same uploadId.
        for (const r of results) {
          if (r.status === "complete" && r.uploadId != null) {
            const uploadId = r.uploadId;
            // Detached intentionally — never awaited from the request.
            void runUploadAiWorker(userId, uploadId).catch((err) => {
              console.error(
                `[aiWorker] uncaught error for upload=${uploadId}: ${err}`,
              );
            });
          }
        }
      } catch (e) {
        next(e);
      }
    },
  );

  /**
   * GET /api/uploads/:id/status
   *
   * Per-upload AI progress poll. Returns the worker's current state plus
   * a derived `progress` ratio for convenient frontend rendering. 404 when
   * the upload does not belong to the calling user (we collapse "not found"
   * and "not yours" so we don't leak the existence of unrelated uploads).
   */
  app.get("/api/uploads/:id/status", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const uploadId = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(uploadId) || uploadId <= 0) {
        res.status(400).json({ error: "Invalid upload id" });
        return;
      }
      const status = await getUploadAiStatusForUser(userId, uploadId);
      if (!status) {
        res.status(404).json({ error: "Upload not found" });
        return;
      }
      const pending = status.aiRowsPending ?? 0;
      const done = status.aiRowsDone ?? 0;
      res.json({
        uploadId: status.id,
        aiStatus: status.aiStatus,
        aiRowsPending: pending,
        aiRowsDone: done,
        progress: pending > 0 ? Math.min(1, done / pending) : 1,
        aiStartedAt: status.aiStartedAt,
        aiCompletedAt: status.aiCompletedAt,
        aiError: status.aiError,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/uploads/ai-status
   *
   * Aggregate poll: returns AI status for the user's recently active
   * uploads (anything still in pending/processing, plus anything that
   * completed/failed within the last 24h). Used by the dashboard "pulse"
   * badge so the frontend doesn't have to track upload IDs across page
   * navigations.
   */
  app.get("/api/uploads/ai-status", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const rows = await listActiveAiUploadsForUser(userId);
      res.json({
        uploads: rows.map((row) => {
          const pending = row.aiRowsPending ?? 0;
          const done = row.aiRowsDone ?? 0;
          return {
            uploadId: row.id,
            filename: row.filename,
            aiStatus: row.aiStatus,
            aiRowsPending: pending,
            aiRowsDone: done,
            progress: pending > 0 ? Math.min(1, done / pending) : 1,
            aiStartedAt: row.aiStartedAt,
            aiCompletedAt: row.aiCompletedAt,
            aiError: row.aiError,
          };
        }),
      });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/uploads", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const uploadList = await listUploadsForUser(userId);
      res.json({ uploads: uploadList });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/transactions", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const q = req.query;

      const result = await listTransactionsForUser({
        userId,
        page: parseInt(q.page as string) || 1,
        limit: parseInt(q.limit as string) || 50,
        accountId: q.accountId ? parseInt(q.accountId as string) : undefined,
        search: (q.search as string) || undefined,
        category: (q.category as string) || undefined,
        transactionClass: (q.transactionClass as string) || undefined,
        recurrenceType: (q.recurrenceType as string) || undefined,
        dateFrom: (q.dateFrom as string) || undefined,
        dateTo: (q.dateTo as string) || undefined,
        excluded: (q.excluded === "true" || q.excluded === "all") ? (q.excluded as "true" | "all") : "false",
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/dashboard/months", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const rows = await pool.query<{ month: string; txn_count: string }>(
        `SELECT SUBSTRING(date, 1, 7) AS month,
                COUNT(*)              AS txn_count
         FROM   transactions
         WHERE  user_id = $1
           AND  excluded_from_analysis = false
         GROUP  BY 1
         ORDER  BY 1 DESC`,
        [userId],
      );
      res.json(rows.rows.map((r) => ({
        month: r.month,
        transactionCount: parseInt(r.txn_count, 10),
      })));
    } catch (e) {
      next(e);
    }
  });

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

  // -----------------------------------------------------------------------
  // Transaction editing (Phase 3)
  // -----------------------------------------------------------------------

  const VALID_CLASSES = ["income", "expense", "transfer", "refund"];
  const VALID_RECURRENCE = ["recurring", "one-time"];

  app.patch("/api/transactions/:id", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid transaction ID" });
        return;
      }

      const existing = await getTransactionById(id, userId);
      if (!existing) {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }

      const body = req.body ?? {};
      const fields: UpdateTransactionInput = {};
      const errors: string[] = [];

      if (body.date !== undefined) {
        if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
          errors.push("date must be YYYY-MM-DD format");
        } else {
          fields.date = body.date;
        }
      }
      if (body.merchant !== undefined) {
        if (typeof body.merchant !== "string" || !body.merchant.trim()) {
          errors.push("merchant must be a non-empty string");
        } else {
          fields.merchant = body.merchant.trim();
        }
      }
      if (body.amount !== undefined) {
        const parsed = parseFloat(body.amount);
        if (isNaN(parsed)) {
          errors.push("amount must be a valid number");
        } else {
          fields.amount = parsed.toFixed(2);
          fields.flowType = parsed < 0 ? "outflow" : "inflow";
        }
      }
      if (body.category !== undefined) {
        if (!V1_CATEGORIES.includes(body.category)) {
          errors.push(`category must be one of: ${V1_CATEGORIES.join(", ")}`);
        } else {
          fields.category = body.category;
        }
      }
      if (body.transactionClass !== undefined) {
        if (!VALID_CLASSES.includes(body.transactionClass)) {
          errors.push(`transactionClass must be one of: ${VALID_CLASSES.join(", ")}`);
        } else {
          fields.transactionClass = body.transactionClass;
          if (body.transactionClass === "expense") {
            fields.flowType = "outflow";
          } else if (body.transactionClass === "income" || body.transactionClass === "refund") {
            fields.flowType = "inflow";
          }
        }
      }
      if (body.recurrenceType !== undefined) {
        if (!VALID_RECURRENCE.includes(body.recurrenceType)) {
          errors.push(`recurrenceType must be one of: ${VALID_RECURRENCE.join(", ")}`);
        } else {
          fields.recurrenceType = body.recurrenceType;
        }
      }
      if (body.excludedFromAnalysis !== undefined) {
        if (typeof body.excludedFromAnalysis !== "boolean") {
          errors.push("excludedFromAnalysis must be a boolean");
        } else {
          fields.excludedFromAnalysis = body.excludedFromAnalysis;
        }
      }
      if (body.excludedReason !== undefined) {
        fields.excludedReason = body.excludedReason === null ? null : String(body.excludedReason);
      }

      if (errors.length > 0) {
        res.status(400).json({ errors });
        return;
      }

      if (Object.keys(fields).length === 0) {
        res.status(400).json({ error: "No editable fields provided" });
        return;
      }

      const updated = await updateTransaction(id, userId, fields);

      // Persist a user-rule for this merchant so future uploads apply the
      // correction automatically. Only written when classification fields are
      // changing (same condition as propagation). Non-fatal if it fails.
      if (
        updated &&
        (fields.category !== undefined ||
          fields.transactionClass !== undefined ||
          fields.recurrenceType !== undefined)
      ) {
        const merchantKey = recurrenceKey(updated.merchant ?? "");
        if (merchantKey) {
          try {
            await upsertMerchantRule(
              userId,
              merchantKey,
              updated.category,
              updated.transactionClass,
              updated.recurrenceType,
            );
          } catch {
            // Non-fatal — rule persistence is best-effort
          }
          // Also write to merchant_classifications cache with source="manual".
          // Manual wins on conflict and is never overwritten by AI or rule-seed.
          upsertMerchantClassification(userId, {
            merchantKey,
            category: updated.category,
            transactionClass: updated.transactionClass,
            recurrenceType: updated.recurrenceType,
            labelConfidence: 1.0,
            source: "manual",
          }).catch(() => undefined);
        }
      }

      // Propagate category, class, and recurrence corrections to all same-merchant
      // uncorrected rows. User edits are law — propagated rows get labelSource=
      // "propagated" so neither reclassify nor sync ever overwrites them.
      let propagated = 0;
      let matchType: "fuzzy" | "exact" | "none" = "none";
      if (
        fields.category !== undefined ||
        fields.transactionClass !== undefined ||
        fields.recurrenceType !== undefined
      ) {
        const propagateResult = await propagateUserCorrection(
          userId,
          id,
          fields.category,
          fields.transactionClass,
          fields.recurrenceType,
        );
        propagated = propagateResult.count;
        matchType = propagateResult.matchType;
      }

      res.json({ transaction: updated, propagated, matchType });
    } catch (e) {
      next(e);
    }
  });

  // -----------------------------------------------------------------------
  // AI re-categorization (Phase 2b)
  // -----------------------------------------------------------------------

  app.post("/api/transactions/reclassify", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const result = await reclassifyTransactions(userId);
      // Re-sync recurring patterns so recurring-transfer promotions are
      // reapplied after the rules engine may have reset them to "transfer".
      await syncRecurringCandidates(userId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Export filtered ledger as CSV
  app.get("/api/transactions/export", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const q = req.query as Record<string, string>;

      const [rows, userAccounts] = await Promise.all([
        listAllTransactionsForExport({
          userId,
          accountId: q.accountId ? parseInt(q.accountId) : undefined,
          search: q.search || undefined,
          category: q.category || undefined,
          transactionClass: q.transactionClass || undefined,
          recurrenceType: q.recurrenceType || undefined,
          dateFrom: q.dateFrom || undefined,
          dateTo: q.dateTo || undefined,
          excluded: (q.excluded === "true" || q.excluded === "all") ? (q.excluded as "true" | "all") : "false",
        }),
        listAccountsForUser(userId),
      ]);

      const accountMap = new Map(userAccounts.map((a) => [a.id, a.label]));

      const header = [
        "Date",
        "Merchant",
        "Amount",
        "Category",
        "Class",
        "Recurrence",
        "Account",
        "Excluded",
      ].join(",");

      const escape = (v: string | number | boolean | null | undefined) => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      };

      const csvLines = rows.map((r) =>
        [
          escape(r.date),
          escape(r.merchant),
          escape(r.amount),
          escape(r.category),
          escape(r.transactionClass),
          escape(r.recurrenceType),
          escape(accountMap.get(r.accountId ?? 0) ?? ""),
          escape(r.excludedFromAnalysis ? "yes" : "no"),
        ].join(","),
      );

      const csv = [header, ...csvLines].join("\n");
      const filename = `pocketpulse-ledger-${new Date().toISOString().slice(0, 10)}.csv`;

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (e) {
      next(e);
    }
  });

  // -----------------------------------------------------------------------
  // Destructive actions (Phase 3)
  // -----------------------------------------------------------------------

  app.delete("/api/transactions", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      if (req.body?.confirm !== true) {
        res.status(400).json({ error: "Must send { confirm: true } to wipe data" });
        return;
      }
      const result = await deleteAllTransactionsForUser(userId);
      res.json({ message: "Transactions and uploads deleted", ...result });
    } catch (e) {
      next(e);
    }
  });

  app.delete("/api/workspace-data", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      if (req.body?.confirm !== true) {
        res.status(400).json({ error: "Must send { confirm: true } to reset workspace" });
        return;
      }
      const result = await deleteWorkspaceDataForUser(userId);
      res.json({ message: "Workspace data deleted", ...result });
    } catch (e) {
      next(e);
    }
  });

  // -----------------------------------------------------------------------
  // Recurring candidates (Phase 4)
  // -----------------------------------------------------------------------

  app.get("/api/recurring-candidates", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;

      const allTxns = await listAllTransactionsForExport({ userId });
      const candidates = detectRecurringCandidates(allTxns as any);

      const reviews = await listRecurringReviewsForUser(userId);
      const reviewMap = new Map(reviews.map((r) => [r.candidateKey, r]));

      const merged = candidates.map((c) => {
        const review = reviewMap.get(c.candidateKey);
        // Auto-label necessary categories as essential when not yet manually reviewed
        const autoEssential = AUTO_ESSENTIAL_CATEGORIES.has(c.category) && !review;
        return {
          ...c,
          reviewStatus: review?.status ?? (autoEssential ? "essential" : "unreviewed"),
          reviewNotes: review?.notes ?? null,
          autoEssential,
        };
      });

      const summary = {
        total: merged.length,
        unreviewed: merged.filter((c) => c.reviewStatus === "unreviewed").length,
        essential: merged.filter((c) => c.reviewStatus === "essential").length,
        leak: merged.filter((c) => c.reviewStatus === "leak").length,
        dismissed: merged.filter((c) => c.reviewStatus === "dismissed").length,
      };

      res.json({ candidates: merged, summary });
    } catch (e) {
      next(e);
    }
  });

  app.patch("/api/recurring-reviews/:candidateKey", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const candidateKey = decodeURIComponent(req.params.candidateKey as string);
      const { status, notes } = req.body as { status?: string; notes?: string };

      if (!status || !REVIEW_STATUSES.includes(status as any)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${REVIEW_STATUSES.join(", ")}`,
        });
      }

      const row = await upsertRecurringReview(userId, candidateKey, status, notes);
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  /**
   * POST /api/recurring-candidates/sync
   * Runs the detector and writes recurrence_type back to the transactions table:
   *   - candidate transaction IDs → "recurring"
   *   - all other active outflow transactions for this user → "one-time"
   * Returns { recurringCount, oneTimeCount }.
   */
  app.post("/api/recurring-candidates/sync", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const result = await syncRecurringCandidates(userId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/recurring-reviews", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const reviews = await listRecurringReviewsForUser(userId);
      res.json(reviews);
    } catch (e) {
      next(e);
    }
  });

  // ── Automatic leak detection ───────────────────────────────────────────────
  // GET /api/leaks?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Falls back to the current calendar month when either param is absent.
  app.get("/api/leaks", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;

      let startDate =
        typeof req.query.startDate === "string" && req.query.startDate
          ? req.query.startDate
          : null;
      let endDate =
        typeof req.query.endDate === "string" && req.query.endDate
          ? req.query.endDate
          : null;

      if (!startDate || !endDate) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const pad = (n: number) => String(n).padStart(2, "0");
        startDate = `${year}-${pad(month)}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        endDate = `${year}-${pad(month)}-${pad(lastDay)}`;
      }

      const rangeDays = Math.max(
        1,
        Math.ceil(
          (new Date(endDate).getTime() - new Date(startDate).getTime()) /
            86_400_000,
        ) + 1,
      );

      const rows = await listAllTransactionsForExport({
        userId,
        dateFrom: startDate,
        dateTo: endDate,
        excluded: "false",
      });

      // Map DB rows to the typed TxRow shape expected by detectLeaks.
      const txns = rows.map((t) => ({
        transactionClass:     t.transactionClass,
        category:             t.category,
        merchant:             t.merchant,
        amount:               t.amount,
        date:                 t.date,
        recurrenceType:       t.recurrenceType,
        recurrenceSource:     t.recurrenceSource,
        excludedFromAnalysis: t.excludedFromAnalysis,
      }));

      // Build the recurring merchant key exclusion set from the active recurring
      // candidates.  Using detectRecurringCandidates() + isActive filter (rather
      // than the raw recurrenceType='recurring' DB column) ensures only currently
      // active subscriptions suppress leak detection.  Inactive/cancelled recurring
      // items (isActive=false) are NOT excluded so they can still surface as leaks
      // if the user's pattern now looks discretionary rather than scheduled.
      const allTxnsForRecurring = await listAllTransactionsForExport({ userId });
      const activeRecurringCandidates = detectRecurringCandidates(
        allTxnsForRecurring as any,
      ).filter((c) => c.isActive);
      const recurringMerchantKeys = new Set(
        activeRecurringCandidates.map((c) => c.merchantKey),
      );

      // Also exclude merchants the user has manually marked as recurring
      // (recurrenceSource='manual').  These may not yet appear in the
      // recurring-candidates pipeline output, so without this step a
      // manually-recurring merchant could simultaneously show up in
      // Recurring Expenses and in Leaks.
      for (const tx of txns) {
        if (
          tx.recurrenceType === "recurring" &&
          tx.recurrenceSource === "manual"
        ) {
          recurringMerchantKeys.add(recurrenceKey(tx.merchant));
        }
      }

      const leaks = detectLeaks(txns, { rangeDays, recurringMerchantKeys });
      res.json(leaks);
    } catch (e) {
      next(e);
    }
  });

  // ── Dev Test Suite (PR1: classification sampler + team view) ─────────────
  // All routes inside the router are gated by requireDev — DEV_MODE_ENABLED +
  // session auth + users.isDev. Failures return 404 (never reveal the feature).
  app.use("/api/dev", createDevTestSuiteRouter());

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

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

  // Startup recurring re-sync: ensures the updated detector logic applies
  // immediately for all existing users without requiring a manual re-upload.
  setImmediate(async () => {
    try {
      // Step 0: Backfill recurrenceSource for pre-feature rows.
      // Rows with recurrenceSource='none' but recurrenceType='recurring' were
      // written before this column existed — they got their recurring label from
      // a classifier keyword pass (hint), so promote them to 'hint' now.
      // syncRecurringCandidates (below) will then promote outflow rows to
      // 'detected' once it evaluates them, making the full corpus consistent.
      const backfillResult = await db
        .update(txnTable)
        .set({ recurrenceSource: "hint" })
        .where(
          and(
            eq(txnTable.recurrenceSource, "none"),
            eq(txnTable.recurrenceType, "recurring"),
          ),
        );
      console.log(`[startup] recurrenceSource backfill: ${(backfillResult as { rowCount?: number }).rowCount ?? 0} rows promoted to 'hint'`);

      const allUsers = await db.select({ id: usersTable.id }).from(usersTable);
      for (const user of allUsers) {
        await syncRecurringCandidates(user.id);
      }
      console.log(`[startup] recurring-sync complete for ${allUsers.length} user(s)`);
    } catch (err) {
      console.warn("[startup] recurring-sync skipped:", err);
    }
  });

  return app;
}
