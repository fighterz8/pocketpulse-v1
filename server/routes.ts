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
import { classifyTransaction } from "./classifier.js";
import { parseCSV } from "./csvParser.js";
import { detectCsvFormat } from "./csvFormatDetector.js";
import { ensureUserPreferences, pool } from "./db.js";
import { AUTO_ESSENTIAL_CATEGORIES, REVIEW_STATUSES, V1_CATEGORIES } from "../shared/schema.js";
import { DEV_MODE_ENABLED } from "../shared/devConfig.js";
import {
  createAccountForUser,
  createTransactionBatch,
  createUpload,
  createUser,
  deleteAllTransactionsForUser,
  batchUpsertMerchantClassifications,
  deleteWorkspaceDataForUser,
  DuplicateEmailError,
  getFormatSpec,
  getMerchantClassifications,
  getMerchantRules,
  getTransactionById,
  getUserByEmailForAuth,
  getUserById,
  listAccountsForUser,
  listAllTransactionsForExport,
  listRecurringReviewsForUser,
  listTransactionsForUser,
  listUploadsForUser,
  propagateUserCorrection,
  recordCacheHits,
  saveFormatSpec,
  updateTransaction,
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
import { reclassifyTransactions } from "./reclassify.js";
import { aiClassifyBatch, type AiClassificationInput, type AiClassificationResult } from "./ai-classifier.js";
import { transactions as txnTable, users as usersTable } from "../shared/schema.js";

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

          // Phase 1: rules-based classification (fast, synchronous)
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
            recurrenceSource: string;
            category: string;
            labelSource: string;
            labelConfidence: string;
            labelReason: string;
            aiAssisted: boolean;
          }> = parseResult.rows.map((row) => {
            const classification = classifyTransaction(
              row.description,
              row.amount,
            );

            // Normalise amount sign to match the resolved flowType.
            // The classifier may have flipped the expected direction (e.g. a
            // positively-signed credit-card payment becomes outflow after the
            // debt merchant rule fires). Keeping the sign and flowType in sync
            // prevents the dashboard from double-counting transfers or debts.
            const effectiveAmount =
              classification.flowType === "outflow" && row.amount > 0
                ? -Math.abs(row.amount)
                : classification.flowType === "inflow" && row.amount < 0
                  ? Math.abs(row.amount)
                  : row.amount;

            return {
              userId,
              uploadId: uploadRecord.id,
              accountId: fileMeta.accountId,
              date: row.date,
              amount: effectiveAmount.toFixed(2),
              merchant: classification.merchant,
              rawDescription: row.description,
              flowType: classification.flowType,
              transactionClass: classification.transactionClass,
              recurrenceType: classification.recurrenceType,
              recurrenceSource: classification.recurrenceSource,
              category: classification.category,
              labelSource: classification.labelSource,
              labelConfidence: classification.labelConfidence.toFixed(2),
              labelReason: classification.labelReason,
              // OR with row.ambiguous: rows with an ambiguous amount direction
              // (positive single-column with no direction hint) also get AI review.
              aiAssisted: classification.aiAssisted || row.ambiguous,
            };
          });

          // Phase 1.5: apply user-specific merchant rules before AI enrichment.
          // Rows matched here get labelSource="user-rule" and confidence=1.0
          // so they are excluded from the AI candidate pool below.
          const userRules = await getMerchantRules(userId);
          if (userRules.size > 0) {
            for (const t of txnInputs) {
              const key = recurrenceKey(t.merchant);
              const rule = key ? userRules.get(key) : undefined;
              if (rule) {
                if (rule.category) t.category = rule.category;
                if (rule.transactionClass) t.transactionClass = rule.transactionClass;
                if (rule.recurrenceType) t.recurrenceType = rule.recurrenceType;
                t.recurrenceSource = "none";
                t.labelSource = "user-rule";
                t.labelConfidence = "1.00";
                t.labelReason = `user rule: ${key}`;
                t.aiAssisted = false;
              }
            }
          }

          // Phase 1.7: merchant classification cache — short-circuits AI for known merchants.
          // Batch-fetch cache for rows still needing AI, apply hits before the AI call.
          const txnIndexToKey = new Map<number, string>();
          const cacheKeyNeeded: string[] = [];
          for (let i = 0; i < txnInputs.length; i++) {
            const t = txnInputs[i]!;
            const conf = parseFloat(t.labelConfidence);
            if ((conf < AI_THRESHOLD || t.category === "other") && t.labelSource !== "user-rule") {
              const key = recurrenceKey(t.merchant);
              if (key) {
                txnIndexToKey.set(i, key);
                cacheKeyNeeded.push(key);
              }
            }
          }

          if (cacheKeyNeeded.length > 0) {
            try {
              const cacheHits = await getMerchantClassifications(userId, cacheKeyNeeded);
              const hitKeys: string[] = [];
              for (const [i, key] of txnIndexToKey) {
                const hit = cacheHits.get(key);
                if (!hit) continue;
                const t = txnInputs[i]!;
                t.category = hit.category;
                t.transactionClass = hit.transactionClass;
                t.recurrenceType = hit.recurrenceType;
                t.recurrenceSource = "none";
                t.labelConfidence = hit.labelConfidence.toFixed(2);
                t.labelReason = `cache hit: ${key} (${hit.source})`;
                t.labelSource = "cache";
                t.aiAssisted = false;
                txnIndexToKey.delete(i);
                hitKeys.push(key);
              }
              if (hitKeys.length > 0) {
                recordCacheHits(userId, hitKeys).catch(() => undefined);
              }
            } catch {
              // Non-fatal — fall through to AI pass
            }
          }

          // Phase 2: AI fallback for low-confidence rows — runs inline before
          // insert, but races against a 6-second timeout so the upload cannot
          // be blocked by a slow or unavailable OpenAI response.
          const aiCandidates: AiClassificationInput[] = [];
          const txnIndexToAiIdx = new Map<number, number>();

          for (let i = 0; i < txnInputs.length; i++) {
            const t = txnInputs[i]!;
            const conf = parseFloat(t.labelConfidence);
            if ((conf < AI_THRESHOLD || t.category === "other") && t.labelSource !== "user-rule" && t.labelSource !== "cache") {
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
            const AI_TIMEOUT_MS = 6000;
            try {
              const timeout = new Promise<Map<number, AiClassificationResult>>(
                (resolve) => setTimeout(() => resolve(new Map()), AI_TIMEOUT_MS),
              );
              const aiResults = await Promise.race([
                aiClassifyBatch(aiCandidates),
                timeout,
              ]);
              for (const [txnIdx, aiIdx] of txnIndexToAiIdx) {
                const aiResult = aiResults.get(aiIdx);
                if (!aiResult) continue;
                const t = txnInputs[txnIdx]!;
                t.category = aiResult.category;
                t.transactionClass = aiResult.transactionClass;
                t.recurrenceType = aiResult.recurrenceType;
                t.recurrenceSource = "none";
                t.labelConfidence = aiResult.labelConfidence.toFixed(2);
                t.labelReason = aiResult.labelReason;
                t.labelSource = "ai";
                t.aiAssisted = true;
              }
              // Write qualifying AI results back to the merchant cache (fire-and-forget).
              const cacheEntries = [];
              for (const [txnIdx, aiIdx] of txnIndexToAiIdx) {
                const aiResult = aiResults.get(aiIdx);
                if (!aiResult || aiResult.labelConfidence < 0.7) continue;
                const t = txnInputs[txnIdx]!;
                const key = recurrenceKey(t.merchant);
                if (!key) continue;
                cacheEntries.push({
                  merchantKey: key,
                  category: aiResult.category,
                  transactionClass: aiResult.transactionClass,
                  recurrenceType: aiResult.recurrenceType,
                  labelConfidence: aiResult.labelConfidence,
                  source: "ai" as const,
                });
              }
              if (cacheEntries.length > 0) {
                batchUpsertMerchantClassifications(userId, cacheEntries, 0.7).catch(() => undefined);
              }
            } catch {
              // AI unavailable — keep rules results, upload succeeds regardless
            }
          }

          const { insertedCount, previouslyImported, intraBatchDuplicates } =
            await createTransactionBatch(txnInputs, sessionSeen);

          await updateUploadStatus(
            uploadRecord.id,
            "complete",
            insertedCount,
            null,
            appliedSpec,
          );

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
          excluded: (q.excluded as "true" | "false" | "all") || undefined,
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

      const leaks = detectLeaks(txns, { rangeDays, recurringMerchantKeys });
      res.json(leaks);
    } catch (e) {
      next(e);
    }
  });

  // ── Accuracy report (dev users only) ─────────────────────────────────────
  app.get("/api/accuracy-report", requireAuth, async (req, res, next) => {
    try {
      if (!DEV_MODE_ENABLED) {
        res.status(403).json({ error: "Not available" });
        return;
      }
      const user = await getUserById(req.session.userId!);
      if (!user?.isDev) {
        res.status(403).json({ error: "Dev access required" });
        return;
      }
      const { computeAccuracyReport } = await import("./accuracyReport.js");
      const report = await computeAccuracyReport(req.session.userId!);
      res.json(report);
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
