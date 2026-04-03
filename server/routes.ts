import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import express, { type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import session from "express-session";
import multer from "multer";
import helmet from "helmet";

import { doubleCsrfProtection, generateToken, invalidCsrfTokenError } from "./csrf.js";
import { hashPassword, verifyPassword } from "./auth.js";
import { classifyTransaction } from "./classifier.js";
import { parseCSV } from "./csvParser.js";
import { ensureUserPreferences, pool } from "./db.js";
import { REVIEW_STATUSES, V1_CATEGORIES } from "../shared/schema.js";
import {
  createAccountForUser,
  createTransactionBatch,
  createUpload,
  createUser,
  deleteAllTransactionsForUser,
  deleteWorkspaceDataForUser,
  DuplicateEmailError,
  getTransactionById,
  getUserByEmailForAuth,
  getUserById,
  listAccountsForUser,
  listAllTransactionsForExport,
  listRecurringReviewsForUser,
  listTransactionsForUser,
  listUploadsForUser,
  updateTransaction,
  updateUploadStatus,
  upsertRecurringReview,
  type UpdateTransactionInput,
} from "./storage.js";
import { buildDashboardSummary } from "./dashboardQueries.js";
import { detectRecurringCandidates } from "./recurrenceDetector.js";
import { reclassifyTransactions } from "./reclassify.js";
import {
  aiClassifyBatch,
  type AiClassificationInput,
} from "./ai-classifier.js";
import {
  inferFlowType,
  normalizeMerchant,
} from "./transactionUtils.js";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

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
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
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
  next();
};

const sessionCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};

export function createApp(options?: CreateAppOptions) {
  const store = options?.sessionStore ?? defaultSessionStore();
  const app = express();
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

      const user = await getUserById(userId);
      if (!user) {
        await destroySession(req);
        res.clearCookie("pocketpulse.sid", sessionCookieOptions);
        res.json({ authenticated: false });
        return;
      }

      res.json({ authenticated: true, user });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/auth/register", authLimiter, async (req, res, next) => {
    try {
      const { email, password, displayName, companyName } = req.body ?? {};
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
      });

      await regenerateSession(req);
      req.session.userId = user.id;
      await saveSession(req);
      res.status(201).json({ user });
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
      await saveSession(req);
      res.json({ user });
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
          error?: string;
          warnings?: string[];
        }> = [];

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

          // Parse the CSV
          const parseResult = await parseCSV(file.buffer, file.originalname);

          if (!parseResult.ok) {
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

          // Phase 1: rules-based classification for all rows
          const AI_THRESHOLD = 0.5;

          const txnInputs: Array<{
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
            labelConfidence: string;
            labelReason: string;
            aiAssisted: boolean;
          }> = parseResult.rows.map((row) => {
            const merchant = normalizeMerchant(row.description);
            const rawFlowType = inferFlowType(row.amount);
            const classification = classifyTransaction(
              merchant || row.description,
              row.amount,
              rawFlowType,
            );

            const effectiveFlowType = classification.flowOverride ?? rawFlowType;
            const effectiveAmount =
              effectiveFlowType === "outflow" && row.amount > 0
                ? -Math.abs(row.amount)
                : row.amount;

            return {
              userId,
              uploadId: uploadRecord.id,
              accountId: fileMeta.accountId,
              date: row.date,
              amount: effectiveAmount.toFixed(2),
              merchant: merchant || row.description,
              rawDescription: row.description,
              flowType: effectiveFlowType,
              transactionClass: classification.transactionClass,
              recurrenceType: classification.recurrenceType,
              category: classification.category,
              labelSource: classification.labelSource,
              labelConfidence: classification.labelConfidence.toFixed(2),
              labelReason: classification.labelReason,
              aiAssisted: false,
            };
          });

          // Phase 2: AI fallback for low-confidence rows
          const aiCandidates: AiClassificationInput[] = [];
          const txnIndexToAiIdx = new Map<number, number>();

          for (let i = 0; i < txnInputs.length; i++) {
            const t = txnInputs[i]!;
            const conf = parseFloat(t.labelConfidence);
            if (conf < AI_THRESHOLD || t.category === "other") {
              const aiIdx = aiCandidates.length;
              txnIndexToAiIdx.set(i, aiIdx);
              aiCandidates.push({
                index: aiIdx,
                merchant: t.merchant,
                rawDescription: t.rawDescription,
                amount: parseFloat(t.amount),
                flowType: t.flowType as "inflow" | "outflow",
              });
            }
          }

          if (aiCandidates.length > 0) {
            try {
              const aiResults = await aiClassifyBatch(aiCandidates);
              for (const [txnIdx, aiIdx] of txnIndexToAiIdx) {
                const aiResult = aiResults.get(aiIdx);
                if (!aiResult) continue;
                const t = txnInputs[txnIdx]!;
                t.category = aiResult.category;
                t.transactionClass = aiResult.transactionClass;
                t.recurrenceType = aiResult.recurrenceType;
                t.labelConfidence = aiResult.labelConfidence.toFixed(2);
                t.labelReason = aiResult.labelReason;
                t.labelSource = "ai";
                t.aiAssisted = true;
              }
            } catch {
              // AI unavailable — keep rules results, upload still succeeds
            }
          }

          const insertedCount = await createTransactionBatch(txnInputs);

          await updateUploadStatus(
            uploadRecord.id,
            "complete",
            insertedCount,
          );

          results.push({
            filename: file.originalname,
            uploadId: uploadRecord.id,
            status: "complete",
            rowCount: insertedCount,
            warnings:
              parseResult.warnings.length > 0
                ? parseResult.warnings
                : undefined,
          });
        }

        res.status(201).json({ results });
      } catch (e) {
        next(e);
      }
    },
  );

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
        excluded: (q.excluded as "true" | "false" | "all") || undefined,
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/dashboard-summary", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;

      await reclassifyTransactions(userId);

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
      res.json({ transaction: updated });
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
  // CSV Export (Phase 3)
  // -----------------------------------------------------------------------

  app.get("/api/export/transactions", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const q = req.query;

      const rows = await listAllTransactionsForExport({
        userId,
        accountId: q.accountId ? parseInt(q.accountId as string) : undefined,
        search: (q.search as string) || undefined,
        category: (q.category as string) || undefined,
        transactionClass: (q.transactionClass as string) || undefined,
        recurrenceType: (q.recurrenceType as string) || undefined,
        dateFrom: (q.dateFrom as string) || undefined,
        dateTo: (q.dateTo as string) || undefined,
        excluded: (q.excluded as "true" | "false" | "all") || undefined,
      });

      const header = "date,merchant,amount,category,class,recurrence,account_id,excluded,excluded_reason,raw_description";
      const csvLines = rows.map((r) => {
        const escape = (v: string | null | undefined) => {
          const s = v ?? "";
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        };
        return [
          r.date,
          escape(r.merchant),
          r.amount,
          r.category,
          r.transactionClass,
          r.recurrenceType,
          r.accountId,
          r.excludedFromAnalysis ? "yes" : "no",
          escape(r.excludedReason),
          escape(r.rawDescription),
        ].join(",");
      });

      const csv = [header, ...csvLines].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="pocketpulse-transactions.csv"');
      res.send(csv);
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/recurring-candidates", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;

      const allTxns = await listAllTransactionsForExport({ userId });
      const candidates = detectRecurringCandidates(allTxns as any);

      const reviews = await listRecurringReviewsForUser(userId);
      const reviewMap = new Map(reviews.map((r) => [r.candidateKey, r]));

      const merged = candidates.map((c) => {
        const review = reviewMap.get(c.candidateKey);
        return {
          ...c,
          reviewStatus: review?.status ?? "unreviewed",
          reviewNotes: review?.notes ?? null,
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

  app.get("/api/recurring-reviews", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const reviews = await listRecurringReviewsForUser(userId);
      res.json(reviews);
    } catch (e) {
      next(e);
    }
  });

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

  return app;
}
