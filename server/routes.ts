import connectPgSimple from "connect-pg-simple";
import express, { type RequestHandler } from "express";
import session from "express-session";
import multer from "multer";

import { hashPassword, verifyPassword } from "./auth.js";
import { classifyTransaction } from "./classifier.js";
import { parseCSV } from "./csvParser.js";
import { ensureUserPreferences, pool } from "./db.js";
import {
  createAccountForUser,
  createTransactionBatch,
  createUpload,
  createUser,
  DuplicateEmailError,
  getUserByEmailForAuth,
  getUserById,
  listAccountsForUser,
  listTransactionsForUser,
  listUploadsForUser,
  updateUploadStatus,
} from "./storage.js";
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

function sessionMiddleware(store: session.Store) {
  return session({
    store,
    name: "pocketpulse.sid",
    secret:
      process.env.SESSION_SECRET ?? "dev-session-secret-not-for-production",
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
  app.use(express.json());
  app.use(sessionMiddleware(store));

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

  app.post("/api/auth/register", async (req, res, next) => {
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

  app.post("/api/auth/login", async (req, res, next) => {
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

          // Classify and build transaction records
          const txnInputs = parseResult.rows.map((row) => {
            const merchant = normalizeMerchant(row.description);
            const flowType = inferFlowType(row.amount);
            const classification = classifyTransaction(
              merchant || row.description,
              row.amount,
              flowType,
            );

            return {
              userId,
              uploadId: uploadRecord.id,
              accountId: fileMeta.accountId,
              date: row.date,
              amount: row.amount.toFixed(2),
              merchant: merchant || row.description,
              rawDescription: row.description,
              flowType,
              transactionClass: classification.transactionClass,
              recurrenceType: classification.recurrenceType,
              category: classification.category,
              labelSource: classification.labelSource,
              labelConfidence: classification.labelConfidence.toFixed(2),
              labelReason: classification.labelReason,
            };
          });

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
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const accountId = req.query.accountId
        ? parseInt(req.query.accountId as string)
        : undefined;

      const result = await listTransactionsForUser({
        userId,
        accountId,
        page,
        limit,
      });

      res.json(result);
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
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  return app;
}
