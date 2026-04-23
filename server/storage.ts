import { and, asc, count, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from "drizzle-orm";
import { DatabaseError } from "pg";

import {
  accounts,
  classificationSamples,
  csvFormatSpecs,
  merchantClassifications,
  merchantClassificationsGlobal,
  merchantRules,
  recurringReviews,
  transactions,
  uploads,
  USER_PREFERENCE_DEFAULTS,
  userPreferences,
  users,
  waitlist,
  type ClassificationSampleRow,
  type ClassificationVerdict,
  type CsvFormatSpec,
  type MerchantClassification,
  type MerchantClassificationSource,
} from "../shared/schema.js";

import { normalizeEmail } from "./auth.js";
import { db } from "./db.js";
import { recurrenceKey } from "./recurrenceDetector.js";
import { toPublicUser, type PublicUser } from "./public-user.js";
import { RULE_SEED_ENTRIES } from "./classifierRuleMigration.js";

export type { PublicUser } from "./public-user.js";
export { toPublicUser } from "./public-user.js";

const publicUserColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  companyName: users.companyName,
  isDev: users.isDev,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

/** Server-only record for password verification (Task 4 login). Not for JSON responses. */
export type UserAuthRecord = {
  id: number;
  email: string;
  passwordHash: string;
};

export class DuplicateEmailError extends Error {
  readonly code = "DUPLICATE_EMAIL" as const;

  constructor() {
    super("An account with this email already exists");
    this.name = "DuplicateEmailError";
  }
}

export type CreateUserInput = {
  email: string;
  /** Bcrypt (or other) hash — never store plaintext in `users.password`. */
  passwordHash: string;
  displayName: string;
  companyName?: string | null;
  isDev?: boolean;
};

/**
 * Create a user and their `user_preferences` row in one transaction (preferred registration path).
 */
export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const email = normalizeEmail(input.email);

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email,
          password: input.passwordHash,
          displayName: input.displayName,
          companyName: input.companyName ?? null,
          isDev: input.isDev ?? false,
        })
        .returning();

      if (!user) {
        throw new Error("createUser: insert did not return a row");
      }

      await tx.insert(userPreferences).values({
        userId: user.id,
        theme: USER_PREFERENCE_DEFAULTS.theme,
        weekStartsOn: USER_PREFERENCE_DEFAULTS.weekStartsOn,
        defaultCurrency: USER_PREFERENCE_DEFAULTS.defaultCurrency,
      });

      return toPublicUser(user);
    });
  } catch (e) {
    if (e instanceof DatabaseError && e.code === "23505") {
      throw new DuplicateEmailError();
    }
    throw e;
  }
}

/** Public profile lookup by email (no password column fetched). */
export async function getUserByEmail(email: string): Promise<PublicUser | null> {
  const [row] = await db
    .select(publicUserColumns)
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

/**
 * Auth-only lookup: includes password hash under explicit `passwordHash` for `verifyPassword`.
 * Do not attach this object to session or send in HTTP responses.
 */
export async function getUserByEmailForAuth(
  email: string,
): Promise<UserAuthRecord | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.password,
    })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

export async function getUserById(id: number): Promise<PublicUser | null> {
  const [row] = await db
    .select(publicUserColumns)
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}

export async function listAccountsForUser(userId: number) {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(asc(accounts.id));
}

export type CreateAccountInput = {
  label: string;
  lastFour?: string | null;
  accountType?: string | null;
};

export async function createAccountForUser(
  userId: number,
  input: CreateAccountInput,
) {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      label: input.label,
      lastFour: input.lastFour ?? null,
      accountType: input.accountType ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("createAccountForUser: insert did not return a row");
  }

  return row;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export type CreateUploadInput = {
  userId: number;
  accountId: number;
  filename: string;
  status?: string;
  errorMessage?: string | null;
};

export async function createUpload(input: CreateUploadInput) {
  const [row] = await db
    .insert(uploads)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      filename: input.filename,
      status: input.status ?? "pending",
      errorMessage: input.errorMessage ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("createUpload: insert did not return a row");
  }

  return row;
}

export async function updateUploadStatus(
  uploadId: number,
  status: string,
  rowCount?: number,
  errorMessage?: string | null,
  formatSpec?: CsvFormatSpec | null,
  warningCount?: number,
) {
  const values: Record<string, unknown> = { status };
  if (rowCount !== undefined) values.rowCount = rowCount;
  if (errorMessage !== undefined) values.errorMessage = errorMessage;
  if (formatSpec !== undefined) values.formatSpec = formatSpec;
  if (warningCount !== undefined) values.warningCount = warningCount;

  const [row] = await db
    .update(uploads)
    .set(values)
    .where(eq(uploads.id, uploadId))
    .returning();

  return row ?? null;
}

export async function listUploadsForUser(userId: number) {
  return db
    .select()
    .from(uploads)
    .where(eq(uploads.userId, userId))
    .orderBy(desc(uploads.uploadedAt));
}

export async function getUploadById(uploadId: number) {
  const [row] = await db
    .select()
    .from(uploads)
    .where(eq(uploads.id, uploadId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Async-AI upload lifecycle helpers (PR2)
//
// These functions own all writes to the AI tracking columns added in PR1
// (ai_status, ai_rows_pending, ai_rows_done, ai_started_at, ai_completed_at,
// ai_error). They are deliberately small typed setters so the worker, the
// upload handler, and the startup sweep can move uploads through the
// pending → processing → complete/failed lifecycle without each caller
// re-stating the column list.
// ---------------------------------------------------------------------------

export type UploadAiStatusUpdate = {
  aiStatus?: "none" | "pending" | "processing" | "complete" | "failed";
  aiRowsPending?: number;
  aiRowsDone?: number;
  aiStartedAt?: Date | null;
  aiCompletedAt?: Date | null;
  aiError?: string | null;
};

/**
 * Apply a partial AI-status update to an upload row. Only the fields
 * present in `patch` are written; everything else is left untouched.
 * Returns the updated row, or null when the upload does not exist.
 */
export async function updateUploadAiStatus(
  uploadId: number,
  patch: UploadAiStatusUpdate,
) {
  if (Object.keys(patch).length === 0) {
    return getUploadById(uploadId);
  }
  const [row] = await db
    .update(uploads)
    .set(patch)
    .where(eq(uploads.id, uploadId))
    .returning();
  return row ?? null;
}

/**
 * Atomically bump an upload's `ai_rows_done` counter. Used by the worker
 * after each chunk so progress is visible to status pollers without the
 * worker needing to re-read the row first.
 */
export async function incrementUploadAiRowsDone(
  uploadId: number,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  await db
    .update(uploads)
    .set({ aiRowsDone: sql`${uploads.aiRowsDone} + ${delta}` })
    .where(eq(uploads.id, uploadId));
}

/**
 * Count the rows in `transactions` that the AI worker still needs to
 * enhance for a given upload. The worker pool is "rule/cache labeled
 * rows that the pipeline flagged as wanting AI" — i.e. aiAssisted=true
 * and labelSource has not been promoted to "ai" yet.
 *
 * Used by the upload handler to seed `ai_rows_pending` after insert,
 * and by the worker to detect when there is genuinely nothing to do.
 */
export async function countNeedsAiForUpload(uploadId: number): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(transactions)
    .where(
      and(
        eq(transactions.uploadId, uploadId),
        eq(transactions.aiAssisted, true),
        ne(transactions.labelSource, "ai"),
      ),
    );
  return row?.c ?? 0;
}

/**
 * Return the rows that the AI worker should process for one upload, in
 * insertion order. Includes the data the worker needs to call the AI
 * batch (merchant, rawDescription, amount, flowType) and write results
 * back individually (id, current category for skip-on-no-change).
 */
export async function listNeedsAiTransactionsForUpload(
  userId: number,
  uploadId: number,
) {
  return db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      rawDescription: transactions.rawDescription,
      amount: transactions.amount,
      flowType: transactions.flowType,
      category: transactions.category,
      transactionClass: transactions.transactionClass,
      recurrenceType: transactions.recurrenceType,
      labelSource: transactions.labelSource,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.uploadId, uploadId),
        eq(transactions.aiAssisted, true),
        ne(transactions.labelSource, "ai"),
      ),
    )
    .orderBy(asc(transactions.id));
}

/**
 * Return uploads whose async AI work is orphaned across a server
 * restart. We include BOTH `processing` and `pending` rows because:
 *
 *   • `processing` — the worker was actively running batches when the
 *     process died. Obvious candidate.
 *   • `pending` — either (a) the upload route flipped to `pending` and
 *     fired the worker but the process died before the worker could
 *     transition to `processing`, or (b) a previous recovery sweep
 *     already flipped a `processing` upload back to `pending` and re-
 *     kicked, then the process died again before that re-kick reached
 *     the status flip. In both cases the upload sits at `pending` with
 *     no live worker — without this we'd leave it stuck forever, which
 *     is exactly what users see as "X transactions left, never ticks".
 *
 * `uploaded_at` is included so the sweep can age out abandoned `pending`
 * rows whose `ai_started_at` is still null.
 */
export async function findStuckProcessingUploads() {
  return db
    .select({
      id: uploads.id,
      userId: uploads.userId,
      aiStatus: uploads.aiStatus,
      aiStartedAt: uploads.aiStartedAt,
      uploadedAt: uploads.uploadedAt,
    })
    .from(uploads)
    .where(inArray(uploads.aiStatus, ["processing", "pending"]));
}

/**
 * Per-upload AI status lookup, scoped to the calling user. Returns null
 * when the upload does not exist OR belongs to a different user — both
 * cases collapse to a 404 in the route handler so we never leak whether
 * an unrelated upload id exists.
 */
export async function getUploadAiStatusForUser(
  userId: number,
  uploadId: number,
) {
  const [row] = await db
    .select({
      id: uploads.id,
      aiStatus: uploads.aiStatus,
      aiRowsPending: uploads.aiRowsPending,
      aiRowsDone: uploads.aiRowsDone,
      aiStartedAt: uploads.aiStartedAt,
      aiCompletedAt: uploads.aiCompletedAt,
      aiError: uploads.aiError,
    })
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Aggregate AI status for a user's recent uploads. Returns anything
 * still moving (`pending` / `processing`) plus anything that finished
 * within the last 24h, so the frontend pulse badge can show "just
 * completed" results without polling forever. Capped at 50 rows.
 */
export async function listActiveAiUploadsForUser(userId: number) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return db
    .select({
      id: uploads.id,
      filename: uploads.filename,
      aiStatus: uploads.aiStatus,
      aiRowsPending: uploads.aiRowsPending,
      aiRowsDone: uploads.aiRowsDone,
      aiStartedAt: uploads.aiStartedAt,
      aiCompletedAt: uploads.aiCompletedAt,
      aiError: uploads.aiError,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.userId, userId),
        or(
          inArray(uploads.aiStatus, ["pending", "processing"]),
          and(
            inArray(uploads.aiStatus, ["complete", "failed"]),
            gte(uploads.uploadedAt, dayAgo),
          ),
        ),
      ),
    )
    .orderBy(desc(uploads.uploadedAt))
    .limit(50);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type CreateTransactionInput = {
  userId: number;
  uploadId: number;
  accountId: number;
  date: string;
  amount: string;
  merchant: string;
  rawDescription: string;
  flowType: string;
  transactionClass: string;
  recurrenceType?: string;
  recurrenceSource?: string;
  category?: string;
  labelSource?: string;
  labelConfidence?: string | null;
  labelReason?: string | null;
  aiAssisted?: boolean;
};

export type CreateBatchResult = {
  insertedCount: number;
  /** Rows skipped because they matched a row already in the DB from a prior upload. */
  previouslyImported: number;
  /** Rows skipped because the same row appeared more than once within this upload batch. */
  intraBatchDuplicates: number;
};

/**
 * Insert a batch of transactions, skipping any that are already in the DB
 * for the same account (dedup key: userId + accountId + date + amount + rawDescription).
 *
 * Dedup check is a single bulk SELECT restricted to the date range of the
 * incoming batch, so it stays efficient even for large accounts.
 *
 * @param txns         The transactions to insert.
 * @param sessionSeen  Optional cross-file fingerprint accumulator for multi-file
 *                     uploads. Pass the same Set instance for every file in one
 *                     upload request so overlaps between files are counted as
 *                     `intraBatchDuplicates` rather than `previouslyImported`.
 *                     The set is mutated in-place as new rows are processed.
 */
export async function createTransactionBatch(
  txns: CreateTransactionInput[],
  sessionSeen?: Set<string>,
): Promise<CreateBatchResult> {
  if (txns.length === 0) return { insertedCount: 0, previouslyImported: 0, intraBatchDuplicates: 0 };

  // All rows in a batch share the same userId and accountId (one file → one account).
  const { userId, accountId } = txns[0]!;

  // Build a normalized fingerprint: date|amount(2dp)|rawDescription(lower-trimmed)
  const fingerprint = (date: string, amount: string | number, rawDesc: string) =>
    `${date}|${parseFloat(String(amount)).toFixed(2)}|${rawDesc.trim().toLowerCase()}`;

  // Determine the date range of incoming rows so the lookup is bounded.
  const dates = txns.map((t) => t.date).sort();
  const minDate = dates[0]!;
  const maxDate = dates[dates.length - 1]!;

  // Fetch existing rows for this account in the same date window.
  const existing = await db
    .select({
      date: transactions.date,
      amount: transactions.amount,
      rawDescription: transactions.rawDescription,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        gte(transactions.date, minDate),
        lte(transactions.date, maxDate),
      ),
    );

  // Fingerprints that exist in the DB BEFORE this upload request started.
  // Used to distinguish "already in DB from prior session" from "intra-batch" skips.
  const dbFingerprints = new Set(
    existing.map((r) => fingerprint(r.date, r.amount, r.rawDescription)),
  );

  // sessionFp scopes the cross-file key to this account so uploads spanning
  // multiple accounts never false-deduplicate each other.
  const sessionFp = (fp: string) => `${accountId}|${fp}`;

  // seen = union of DB fingerprints + same-account cross-file session fingerprints so
  // duplicates across files in the same upload are caught without a DB round-trip.
  // Only same-account entries from sessionSeen are pulled in (they are stored with a
  // "accountId|" prefix to prevent false-dedup across accounts in the same request).
  const seen = new Set(dbFingerprints);
  if (sessionSeen) {
    const prefix = `${accountId}|`;
    for (const sfp of sessionSeen) {
      if (sfp.startsWith(prefix)) {
        const raw = sfp.slice(prefix.length);
        if (!dbFingerprints.has(raw)) seen.add(raw);
      }
    }
  }

  let previouslyImported = 0;
  let intraBatchDuplicates = 0;

  const newRows: CreateTransactionInput[] = [];
  for (const t of txns) {
    const fp = fingerprint(t.date, t.amount, t.rawDescription);
    if (seen.has(fp)) {
      // Classification priority:
      // 1. sessionSeen first — if this fingerprint was seen earlier in THIS upload
      //    request (even if an earlier file just wrote it to DB), it's intra-batch.
      //    This prevents rows inserted by earlier files in the same request from
      //    being mis-classified as "previously imported".
      // 2. dbFingerprints only when not in sessionSeen — genuinely from a prior session.
      if (sessionSeen?.has(sessionFp(fp))) {
        intraBatchDuplicates++;
      } else if (dbFingerprints.has(fp)) {
        previouslyImported++;
      } else {
        // Within-file duplicate (no sessionSeen provided, or first file in session).
        intraBatchDuplicates++;
      }
    } else {
      seen.add(fp);
      // Track across files within the same upload request (account-scoped).
      if (sessionSeen) sessionSeen.add(sessionFp(fp));
      newRows.push(t);
    }
  }

  if (newRows.length === 0) {
    return { insertedCount: 0, previouslyImported, intraBatchDuplicates };
  }

  const values = newRows.map((t) => ({
    userId: t.userId,
    uploadId: t.uploadId,
    accountId: t.accountId,
    date: t.date,
    amount: t.amount,
    merchant: t.merchant,
    rawDescription: t.rawDescription,
    flowType: t.flowType,
    transactionClass: t.transactionClass,
    recurrenceType: t.recurrenceType ?? "one-time",
    recurrenceSource: t.recurrenceSource ?? "none",
    category: t.category ?? "other",
    labelSource: t.labelSource ?? "rule",
    labelConfidence: t.labelConfidence ?? null,
    labelReason: t.labelReason ?? null,
    aiAssisted: t.aiAssisted ?? false,
  }));

  // onConflictDoNothing is the final DB-level safety net for race conditions
  // (two uploads for the same account arriving concurrently).
  const result = await db
    .insert(transactions)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: transactions.id });

  // Any race-condition DB skips (concurrent uploads) are counted as intra-batch duplicates.
  const raceSkips = newRows.length - result.length;
  return {
    insertedCount: result.length,
    previouslyImported,
    intraBatchDuplicates: intraBatchDuplicates + raceSkips,
  };
}

export type ListTransactionsOptions = {
  userId: number;
  accountId?: number;
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  transactionClass?: string;
  recurrenceType?: string;
  dateFrom?: string;
  dateTo?: string;
  excluded?: "true" | "false" | "all";
};

export async function listTransactionsForUser(options: ListTransactionsOptions) {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const offset = (page - 1) * limit;

  const conditions = buildTransactionFilters(options);
  const where = and(...conditions);

  const [rows, totalResult, amountResult] = await Promise.all([
    db
      .select()
      .from(transactions)
      .where(where)
      .orderBy(desc(transactions.date), desc(transactions.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(transactions)
      .where(where),
    db
      .select({
        totalInflow:  sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='income'  THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        totalOutflow: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='expense' THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
        totalRefund:  sql<string>`COALESCE(SUM(CASE WHEN ${transactions.transactionClass}='refund'  THEN ABS(${transactions.amount}) ELSE 0 END),0)`,
      })
      .from(transactions)
      .where(where),
  ]);

  const total = totalResult[0]?.total ?? 0;
  const a = amountResult[0];

  return {
    transactions: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    totals: {
      totalInflow:  parseFloat(a?.totalInflow  ?? "0") || 0,
      totalOutflow: parseFloat(a?.totalOutflow ?? "0") || 0,
      totalRefund:  parseFloat(a?.totalRefund  ?? "0") || 0,
    },
  };
}

/** Shared filter builder used by both list and export. */
export function buildTransactionFilters(options: ListTransactionsOptions) {
  const conditions = [eq(transactions.userId, options.userId)];

  if (options.accountId !== undefined) {
    conditions.push(eq(transactions.accountId, options.accountId));
  }
  if (options.search) {
    const pattern = `%${options.search}%`;
    conditions.push(
      or(
        ilike(transactions.merchant, pattern),
        ilike(transactions.rawDescription, pattern),
      )!,
    );
  }
  if (options.category) {
    conditions.push(eq(transactions.category, options.category));
  }
  if (options.transactionClass) {
    conditions.push(eq(transactions.transactionClass, options.transactionClass));
  }
  if (options.recurrenceType) {
    conditions.push(eq(transactions.recurrenceType, options.recurrenceType));
  }
  if (options.dateFrom) {
    conditions.push(gte(transactions.date, options.dateFrom));
  }
  if (options.dateTo) {
    conditions.push(lte(transactions.date, options.dateTo));
  }
  if (options.excluded === "true") {
    conditions.push(eq(transactions.excludedFromAnalysis, true));
  } else if (options.excluded === "false") {
    conditions.push(eq(transactions.excludedFromAnalysis, false));
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Transaction editing
// ---------------------------------------------------------------------------

export type UpdateTransactionInput = {
  date?: string;
  merchant?: string;
  amount?: string;
  flowType?: string;
  category?: string;
  transactionClass?: string;
  recurrenceType?: string;
  excludedFromAnalysis?: boolean;
  excludedReason?: string | null;
};

export async function getTransactionById(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Pure helper: build the column/value map for an updateTransaction call.
 * Exported so unit tests can verify field-mapping rules (including the
 * recurrenceSource='manual' co-write) without needing a live database.
 */
export function buildUpdateSetValues(
  fields: UpdateTransactionInput,
): Record<string, unknown> {
  const setValues: Record<string, unknown> = {
    userCorrected: true,
    labelSource: "manual",
  };
  if (fields.date !== undefined) setValues.date = fields.date;
  if (fields.merchant !== undefined) setValues.merchant = fields.merchant;
  if (fields.amount !== undefined) setValues.amount = fields.amount;
  if (fields.flowType !== undefined) setValues.flowType = fields.flowType;
  if (fields.category !== undefined) setValues.category = fields.category;
  if (fields.transactionClass !== undefined)
    setValues.transactionClass = fields.transactionClass;
  if (fields.recurrenceType !== undefined) {
    setValues.recurrenceType = fields.recurrenceType;
    // Stamp recurrenceSource so KPI aggregates and future provenance queries
    // can distinguish manual overrides from system-detected classifications.
    setValues.recurrenceSource = "manual";
  }
  if (fields.excludedFromAnalysis !== undefined) {
    setValues.excludedFromAnalysis = fields.excludedFromAnalysis;
    setValues.excludedAt = fields.excludedFromAnalysis ? new Date() : null;
  }
  if (fields.excludedReason !== undefined)
    setValues.excludedReason = fields.excludedReason;
  return setValues;
}

export async function updateTransaction(
  id: number,
  userId: number,
  fields: UpdateTransactionInput,
) {
  const setValues = buildUpdateSetValues(fields);

  const [row] = await db
    .update(transactions)
    .set(setValues)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .returning();

  return row ?? null;
}

/**
 * Propagates a manual correction (category, transactionClass, recurrenceType)
 * to all non-user-corrected transactions from the same merchant.
 *
 * Matching strategy:
 *   1. Fuzzy (primary): normalize both the source merchant and every candidate
 *      via recurrenceKey(). Match on normalized key so "OpenAI 123" and
 *      "OpenAI 1234" both propagate together.
 *   2. Exact (fallback): case-insensitive string equality, used only when
 *      fuzzy finds zero candidates.
 *
 * Skips the source transaction itself. Sets labelSource to "propagated" so
 * reclassify and syncRecurringCandidates never overwrite these rows.
 *
 * Returns { count, matchType } where matchType is "fuzzy" (normalized-key
 * match), "exact" (case-insensitive string fallback with ≥1 match), or "none"
 * (no propagatable fields, no source merchant, or 0 matching rows).
 */
export type PropagateResult = {
  count: number;
  matchType: "fuzzy" | "exact" | "none";
};

export async function propagateUserCorrection(
  userId: number,
  sourceTxnId: number,
  category?: string,
  transactionClass?: string,
  recurrenceType?: string,
): Promise<PropagateResult> {
  if (!category && !transactionClass && !recurrenceType) return { count: 0, matchType: "none" };

  const [source] = await db
    .select({ merchant: transactions.merchant })
    .from(transactions)
    .where(and(eq(transactions.id, sourceTxnId), eq(transactions.userId, userId)))
    .limit(1);

  if (!source?.merchant?.trim()) return { count: 0, matchType: "none" };

  const sourceMerchant = source.merchant.trim();
  const sourceKey = recurrenceKey(sourceMerchant);

  const setValues: Record<string, unknown> = { labelSource: "propagated" };
  if (category !== undefined) setValues.category = category;
  if (transactionClass !== undefined) setValues.transactionClass = transactionClass;
  if (recurrenceType !== undefined) {
    setValues.recurrenceType = recurrenceType;
    // Mirror updateTransaction: propagated rows get recurrenceSource='manual'
    // so their provenance is clear and KPI aggregates treat them identically
    // to directly-edited rows.
    setValues.recurrenceSource = "manual";
  }

  // --- Fuzzy path: JS-side normalization via recurrenceKey() ---
  // Fetch all non-corrected, non-source transactions for the user and filter
  // in JS so that merchants normalizing to the same key are matched together
  // (e.g. "OpenAI 123" and "OpenAI 1234" both produce key "openai").
  const candidates = await db
    .select({ id: transactions.id, merchant: transactions.merchant })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.userCorrected, false),
        ne(transactions.id, sourceTxnId),
      ),
    );

  const fuzzyIds = candidates
    .filter((c) => c.merchant && recurrenceKey(c.merchant) === sourceKey)
    .map((c) => c.id);

  if (fuzzyIds.length > 0) {
    const fuzzyUpdated = await db
      .update(transactions)
      .set(setValues)
      .where(
        and(
          inArray(transactions.id, fuzzyIds),
          eq(transactions.userId, userId),
          eq(transactions.userCorrected, false),
        ),
      )
      .returning({ id: transactions.id });
    return { count: fuzzyUpdated.length, matchType: "fuzzy" };
  }

  // --- Exact fallback: case-insensitive string match ---
  const merchantLower = sourceMerchant.toLowerCase();
  const updated = await db
    .update(transactions)
    .set(setValues)
    .where(
      and(
        eq(transactions.userId, userId),
        sql`lower(${transactions.merchant}) = ${merchantLower}`,
        eq(transactions.userCorrected, false),
        ne(transactions.id, sourceTxnId),
      ),
    )
    .returning({ id: transactions.id });

  return { count: updated.length, matchType: updated.length > 0 ? "exact" : "none" };
}

export type UserCorrectionExample = {
  merchant: string;
  category: string;
  transactionClass: string;
  recurrenceType: string;
};

/**
 * Returns up to 100 distinct recent user corrections for use as AI few-shot
 * examples. Deduplicates by lowercase merchant name (most-recent correction
 * wins). Includes both manually-corrected and auto-propagated rows.
 */
export async function getUserCorrectionExamples(
  userId: number,
): Promise<UserCorrectionExample[]> {
  const rows = await db
    .select({
      merchant: transactions.merchant,
      category: transactions.category,
      transactionClass: transactions.transactionClass,
      recurrenceType: transactions.recurrenceType,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.labelSource, ["manual", "propagated"]),
      ),
    )
    .orderBy(desc(transactions.id))
    .limit(400);

  // Deduplicate by lowercase merchant name in application memory — most recent
  // correction per merchant wins because we ordered by id desc.
  const seen = new Set<string>();
  const examples: UserCorrectionExample[] = [];
  for (const row of rows) {
    const key = row.merchant.toLowerCase().trim();
    if (!seen.has(key) && key) {
      seen.add(key);
      examples.push({
        merchant: row.merchant,
        category: row.category,
        transactionClass: row.transactionClass,
        recurrenceType: row.recurrenceType,
      });
      if (examples.length >= 100) break;
    }
  }
  return examples;
}

export type BulkTransactionUpdate = {
  id: number;
  amount: string;
  flowType: string;
  transactionClass: string;
  category: string;
  recurrenceType: string;
  recurrenceSource?: string;
  labelSource: string;
  labelConfidence: string;
  labelReason: string;
  aiAssisted?: boolean;
};

export async function bulkUpdateTransactions(
  userId: number,
  updates: BulkTransactionUpdate[],
) {
  if (updates.length === 0) return;

  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx
        .update(transactions)
        .set({
          amount: u.amount,
          flowType: u.flowType,
          transactionClass: u.transactionClass,
          category: u.category,
          recurrenceType: u.recurrenceType,
          ...(u.recurrenceSource !== undefined ? { recurrenceSource: u.recurrenceSource } : {}),
          labelSource: u.labelSource,
          labelConfidence: u.labelConfidence,
          labelReason: u.labelReason,
          ...(u.aiAssisted !== undefined ? { aiAssisted: u.aiAssisted } : {}),
        })
        .where(and(eq(transactions.id, u.id), eq(transactions.userId, userId)));
    }
  });
}

// ---------------------------------------------------------------------------
// Destructive actions
// ---------------------------------------------------------------------------

/** Wipe transactions + uploads for a user. Accounts are preserved. */
export async function deleteAllTransactionsForUser(userId: number) {
  return db.transaction(async (tx) => {
    const txnResult = await tx
      .delete(transactions)
      .where(eq(transactions.userId, userId))
      .returning({ id: transactions.id });
    const uploadResult = await tx
      .delete(uploads)
      .where(eq(uploads.userId, userId))
      .returning({ id: uploads.id });
    return {
      deletedTransactions: txnResult.length,
      deletedUploads: uploadResult.length,
    };
  });
}

/** Full workspace reset: wipe transactions + uploads + accounts. */
export async function deleteWorkspaceDataForUser(userId: number) {
  return db.transaction(async (tx) => {
    const txnResult = await tx
      .delete(transactions)
      .where(eq(transactions.userId, userId))
      .returning({ id: transactions.id });
    const uploadResult = await tx
      .delete(uploads)
      .where(eq(uploads.userId, userId))
      .returning({ id: uploads.id });
    const acctResult = await tx
      .delete(accounts)
      .where(eq(accounts.userId, userId))
      .returning({ id: accounts.id });
    return {
      deletedTransactions: txnResult.length,
      deletedUploads: uploadResult.length,
      deletedAccounts: acctResult.length,
    };
  });
}

/** Return all filtered transactions (no pagination) for CSV export. */
export async function listAllTransactionsForExport(options: ListTransactionsOptions) {
  const conditions = buildTransactionFilters(options);
  const where = and(...conditions);

  return db
    .select()
    .from(transactions)
    .where(where)
    .orderBy(desc(transactions.date), desc(transactions.id));
}

/**
 * Fetch low-confidence or uncategorised transactions for a specific upload.
 * Used by the background AI enrichment pass after an upload completes.
 */
export async function listLowConfidenceTransactionsForUpload(
  userId: number,
  uploadId: number,
  confidenceThreshold = 0.5,
) {
  return db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.uploadId, uploadId),
        or(
          eq(transactions.category, "other"),
          sql`cast(${transactions.labelConfidence} as float) < ${confidenceThreshold}`,
        ),
      ),
    );
}

export async function upsertRecurringReview(
  userId: number,
  candidateKey: string,
  status: string,
  notes?: string | null,
) {
  const [row] = await db
    .insert(recurringReviews)
    .values({
      userId,
      candidateKey,
      status,
      notes: notes ?? null,
      reviewedAt: status !== "unreviewed" ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [recurringReviews.userId, recurringReviews.candidateKey],
      set: {
        status,
        notes: notes !== undefined ? (notes ?? null) : sql`${recurringReviews.notes}`,
        reviewedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function listRecurringReviewsForUser(userId: number) {
  return db
    .select()
    .from(recurringReviews)
    .where(eq(recurringReviews.userId, userId))
    .orderBy(desc(recurringReviews.reviewedAt));
}

// ---------------------------------------------------------------------------
// Merchant rules
// ---------------------------------------------------------------------------

export type MerchantRule = {
  category: string | null;
  transactionClass: string | null;
  recurrenceType: string | null;
};

/**
 * Upsert a user-specific merchant rule. Called automatically on every manual
 * transaction correction. Stores the full classification state at the time of
 * the edit so future uploads for the same normalized merchant key use the
 * user's preferred values instead of re-running AI.
 */
export async function upsertMerchantRule(
  userId: number,
  merchantKey: string,
  category: string,
  transactionClass: string,
  recurrenceType: string,
): Promise<void> {
  await db
    .insert(merchantRules)
    .values({
      userId,
      merchantKey,
      category,
      transactionClass,
      recurrenceType,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [merchantRules.userId, merchantRules.merchantKey],
      set: {
        category,
        transactionClass,
        recurrenceType,
        updatedAt: new Date(),
      },
    });
}

/**
 * Load all merchant rules for a user into a Map keyed by merchantKey.
 * Returns an empty Map when the user has no saved rules.
 */
export async function getMerchantRules(userId: number): Promise<Map<string, MerchantRule>> {
  const rows = await db
    .select({
      merchantKey: merchantRules.merchantKey,
      category: merchantRules.category,
      transactionClass: merchantRules.transactionClass,
      recurrenceType: merchantRules.recurrenceType,
    })
    .from(merchantRules)
    .where(eq(merchantRules.userId, userId));

  const map = new Map<string, MerchantRule>();
  for (const row of rows) {
    map.set(row.merchantKey, {
      category: row.category,
      transactionClass: row.transactionClass,
      recurrenceType: row.recurrenceType,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// CSV format spec cache
// ---------------------------------------------------------------------------

/**
 * Look up a cached CSV format spec by (userId, headerFingerprint).
 * Returns null when no spec has been saved for this user + fingerprint pair.
 */
export async function getFormatSpec(
  userId: number,
  headerFingerprint: string,
): Promise<CsvFormatSpec | null> {
  const [row] = await db
    .select({ spec: csvFormatSpecs.spec })
    .from(csvFormatSpecs)
    .where(
      and(
        eq(csvFormatSpecs.userId, userId),
        eq(csvFormatSpecs.headerFingerprint, headerFingerprint),
      ),
    )
    .limit(1);
  return row?.spec ?? null;
}

/**
 * Persist a CSV format spec for a (userId, headerFingerprint) pair.
 * Uses upsert so duplicate calls (e.g. concurrent uploads of the same bank's
 * CSV) are safe and always store the latest spec.
 */
export async function saveFormatSpec(
  userId: number,
  headerFingerprint: string,
  spec: CsvFormatSpec,
  source: "heuristic" | "ai" = "ai",
): Promise<void> {
  await db
    .insert(csvFormatSpecs)
    .values({ userId, headerFingerprint, spec, source })
    .onConflictDoUpdate({
      target: [csvFormatSpecs.userId, csvFormatSpecs.headerFingerprint],
      set: { spec, source },
    });
}

// ---------------------------------------------------------------------------
// Merchant classification cache
// ---------------------------------------------------------------------------

/**
 * Batch-fetch merchant classification cache entries for a user.
 * Only returns entries whose merchantKey is in the provided set.
 * Returns a Map<merchantKey, MerchantClassification>.
 */
export async function getMerchantClassifications(
  userId: number,
  merchantKeys: string[],
): Promise<Map<string, MerchantClassification>> {
  if (merchantKeys.length === 0) return new Map();
  const unique = [...new Set(merchantKeys.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({
      merchantKey: merchantClassifications.merchantKey,
      category: merchantClassifications.category,
      transactionClass: merchantClassifications.transactionClass,
      recurrenceType: merchantClassifications.recurrenceType,
      labelConfidence: merchantClassifications.labelConfidence,
      source: merchantClassifications.source,
    })
    .from(merchantClassifications)
    .where(
      and(
        eq(merchantClassifications.userId, userId),
        inArray(merchantClassifications.merchantKey, unique),
      ),
    );

  const map = new Map<string, MerchantClassification>();
  for (const row of rows) {
    map.set(row.merchantKey, {
      merchantKey: row.merchantKey,
      category: row.category,
      transactionClass: row.transactionClass,
      recurrenceType: row.recurrenceType,
      labelConfidence: parseFloat(row.labelConfidence ?? "0"),
      source: row.source as MerchantClassificationSource,
    });
  }
  return map;
}

/**
 * Query the global merchant classification seed table for a list of keys.
 * Returns a Map<merchantKey, MerchantClassification> for all keys found.
 */
export async function getGlobalMerchantClassifications(
  merchantKeys: string[],
): Promise<Map<string, MerchantClassification>> {
  if (merchantKeys.length === 0) return new Map();
  const unique = [...new Set(merchantKeys.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({
      merchantKey: merchantClassificationsGlobal.merchantKey,
      category: merchantClassificationsGlobal.category,
      transactionClass: merchantClassificationsGlobal.transactionClass,
      recurrenceType: merchantClassificationsGlobal.recurrenceType,
      labelConfidence: merchantClassificationsGlobal.labelConfidence,
      source: merchantClassificationsGlobal.source,
    })
    .from(merchantClassificationsGlobal)
    .where(inArray(merchantClassificationsGlobal.merchantKey, unique));

  const map = new Map<string, MerchantClassification>();
  for (const row of rows) {
    map.set(row.merchantKey, {
      merchantKey: row.merchantKey,
      category: row.category,
      transactionClass: row.transactionClass,
      recurrenceType: row.recurrenceType,
      labelConfidence: parseFloat(row.labelConfidence ?? "0"),
      source: row.source as MerchantClassificationSource,
    });
  }
  return map;
}

/**
 * Populate the global seed table from RULE_SEED_ENTRIES (once at boot).
 * Uses onConflictDoNothing — safe to call on every restart.
 * Returns the number of new rows inserted.
 */
export async function seedGlobalMerchantClassifications(): Promise<number> {
  const now = new Date();
  const CHUNK_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < RULE_SEED_ENTRIES.length; i += CHUNK_SIZE) {
    const chunk = RULE_SEED_ENTRIES.slice(i, i + CHUNK_SIZE).map((entry) => ({
      merchantKey: entry.merchantKeyPattern,
      category: entry.category,
      transactionClass: entry.transactionClass,
      recurrenceType: entry.recurrenceType,
      labelConfidence: entry.confidence.toFixed(2),
      source: "rule-seed",
      hitCount: 0,
      updatedAt: now,
    }));
    const rows = await db
      .insert(merchantClassificationsGlobal)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: merchantClassificationsGlobal.id });
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Upsert a single merchant classification cache entry.
 *
 * Priority rules on conflict:
 *   - "manual" always wins (never overwritten by ai or rule-seed).
 *   - "ai" overwrites "ai" or "rule-seed".
 *   - "rule-seed" is a no-op when a row already exists.
 *
 * hitCount and lastUsedAt are only updated on actual cache hits — this
 * function handles writes only; hit tracking is separate.
 *
 * Returns true when a row was actually inserted (relevant for rule-seed only);
 * always returns true for manual and ai upserts.
 */
export async function upsertMerchantClassification(
  userId: number,
  entry: MerchantClassification,
): Promise<boolean> {
  const now = new Date();
  const confidenceStr = entry.labelConfidence.toFixed(2);

  if (entry.source === "rule-seed") {
    const rows = await db
      .insert(merchantClassifications)
      .values({
        userId,
        merchantKey: entry.merchantKey,
        category: entry.category,
        transactionClass: entry.transactionClass,
        recurrenceType: entry.recurrenceType,
        labelConfidence: confidenceStr,
        source: entry.source,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: merchantClassifications.id });
    return rows.length > 0;
  }

  if (entry.source === "manual") {
    await db
      .insert(merchantClassifications)
      .values({
        userId,
        merchantKey: entry.merchantKey,
        category: entry.category,
        transactionClass: entry.transactionClass,
        recurrenceType: entry.recurrenceType,
        labelConfidence: confidenceStr,
        source: "manual",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [merchantClassifications.userId, merchantClassifications.merchantKey],
        set: {
          category: entry.category,
          transactionClass: entry.transactionClass,
          recurrenceType: entry.recurrenceType,
          labelConfidence: confidenceStr,
          source: "manual",
          updatedAt: now,
        },
      });
    return true;
  }

  // source === "ai": overwrite any row except manual
  await db
    .insert(merchantClassifications)
    .values({
      userId,
      merchantKey: entry.merchantKey,
      category: entry.category,
      transactionClass: entry.transactionClass,
      recurrenceType: entry.recurrenceType,
      labelConfidence: confidenceStr,
      source: "ai",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [merchantClassifications.userId, merchantClassifications.merchantKey],
      set: {
        category: entry.category,
        transactionClass: entry.transactionClass,
        recurrenceType: entry.recurrenceType,
        labelConfidence: confidenceStr,
        source: "ai",
        updatedAt: now,
      },
      setWhere: sql`${merchantClassifications.source} <> 'manual'`,
    });
  return true;
}

/**
 * Bulk-upsert merchant classification cache entries (AI write-back path).
 * Only entries with confidence ≥ minConfidence are persisted.
 * Skips merchantKeys that already have a "manual" entry.
 */
export async function batchUpsertMerchantClassifications(
  userId: number,
  entries: MerchantClassification[],
  minConfidence = 0.7,
): Promise<void> {
  const qualified = entries.filter((e) => e.labelConfidence >= minConfidence);
  for (const e of qualified) {
    try {
      await upsertMerchantClassification(userId, e);
    } catch {
      // Non-fatal — cache write failure must never break the upload/reclassify
    }
  }
}

/**
 * Record a cache hit: increment hitCount and set lastUsedAt for the given keys.
 * Non-fatal — a failure here never breaks classification.
 */
export async function recordCacheHits(userId: number, merchantKeys: string[]): Promise<void> {
  if (merchantKeys.length === 0) return;
  const unique = [...new Set(merchantKeys.filter(Boolean))];
  if (unique.length === 0) return;
  try {
    await db
      .update(merchantClassifications)
      .set({
        hitCount: sql`${merchantClassifications.hitCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(
        and(
          eq(merchantClassifications.userId, userId),
          inArray(merchantClassifications.merchantKey, unique),
        ),
      );
  } catch {
    // Non-fatal
  }
}

/**
 * Bulk-seed the merchant classification cache with rule-derived entries from
 * RULE_SEED_ENTRIES. Runs once per user on first cache miss (see classifyPipeline).
 * Uses onConflictDoNothing so manual and AI entries are never overwritten.
 * Returns the number of new rows inserted.
 */
export async function seedRuleSeedForUser(userId: number): Promise<number> {
  const now = new Date();
  const CHUNK_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < RULE_SEED_ENTRIES.length; i += CHUNK_SIZE) {
    const chunk = RULE_SEED_ENTRIES.slice(i, i + CHUNK_SIZE).map((entry) => ({
      userId,
      merchantKey: entry.merchantKeyPattern,
      category: entry.category,
      transactionClass: entry.transactionClass,
      recurrenceType: entry.recurrenceType,
      labelConfidence: entry.confidence.toFixed(2),
      source: "rule-seed",
      hitCount: 0,
      updatedAt: now,
    }));
    const rows = await db
      .insert(merchantClassifications)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: merchantClassifications.id });
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Day-one seed: populate the cache from existing transactions where
 * userCorrected = true OR labelSource = "manual".
 *
 * Uses source = "rule-seed" and onConflictDoNothing so it never overwrites
 * an existing entry. Safe to call on every startup.
 *
 * Returns the number of new rows inserted.
 */
export async function seedMerchantClassificationsForUser(userId: number): Promise<number> {
  const corrected = await db
    .select({
      merchant: transactions.merchant,
      category: transactions.category,
      transactionClass: transactions.transactionClass,
      recurrenceType: transactions.recurrenceType,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        or(
          eq(transactions.userCorrected, true),
          eq(transactions.labelSource, "manual"),
        ),
      ),
    );

  const seen = new Set<string>();
  let inserted = 0;
  for (const row of corrected) {
    const key = recurrenceKey(row.merchant ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const wasInserted = await upsertMerchantClassification(userId, {
        merchantKey: key,
        category: row.category,
        transactionClass: row.transactionClass,
        recurrenceType: row.recurrenceType,
        labelConfidence: 1.0,
        source: "rule-seed",
      });
      if (wasInserted) inserted++;
    } catch {
      // Non-fatal
    }
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Dev Test Suite — classification samples (sandboxed; never mutates txns)
// ---------------------------------------------------------------------------

export type ClassificationSampleListItem = {
  id: number;
  createdAt: Date;
  completedAt: Date | null;
  sampleSize: number;
  categoryAccuracy: number | null;
  classAccuracy: number | null;
  recurrenceAccuracy: number | null;
  confirmedCount: number;
  correctedCount: number;
  skippedCount: number;
};

function rowToListItem(r: ClassificationSampleRow): ClassificationSampleListItem {
  return {
    id: r.id,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    sampleSize: r.sampleSize,
    categoryAccuracy: r.categoryAccuracy != null ? parseFloat(String(r.categoryAccuracy)) : null,
    classAccuracy:    r.classAccuracy    != null ? parseFloat(String(r.classAccuracy))    : null,
    recurrenceAccuracy: r.recurrenceAccuracy != null ? parseFloat(String(r.recurrenceAccuracy)) : null,
    confirmedCount: r.confirmedCount,
    correctedCount: r.correctedCount,
    skippedCount:   r.skippedCount,
  };
}

/**
 * Pick `n` random transactions from a user's data for classification sampling.
 * Filters mirror the Dev Test Suite spec §4: only verifiable rows that came out
 * of the active classifier subsystems (rule / cache / ai / user-rule).
 *
 * Excluded labelSources (`propagated`, `recurring-transfer`, `manual`) are
 * system-derived or already user-confirmed and shouldn't be re-verified here.
 */
export async function pickClassificationSampleTransactions(
  userId: number,
  sampleSize: number,
) {
  return db
    .select({
      id: transactions.id,
      date: transactions.date,
      rawDescription: transactions.rawDescription,
      amount: transactions.amount,
      category: transactions.category,
      transactionClass: transactions.transactionClass,
      recurrenceType: transactions.recurrenceType,
      labelSource: transactions.labelSource,
      labelConfidence: transactions.labelConfidence,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.userCorrected, false),
        eq(transactions.excludedFromAnalysis, false),
        inArray(transactions.labelSource, ["rule", "cache", "ai", "user-rule"]),
      ),
    )
    .orderBy(sql`random()`)
    .limit(sampleSize);
}

export async function createClassificationSample(input: {
  userId: number;
  sampleSize: number;
  verdicts: ClassificationVerdict[];
}): Promise<ClassificationSampleRow> {
  const [row] = await db
    .insert(classificationSamples)
    .values({
      userId: input.userId,
      sampleSize: input.sampleSize,
      verdicts: input.verdicts,
    })
    .returning();
  if (!row) throw new Error("createClassificationSample: insert returned no row");
  return row;
}

export async function getClassificationSampleById(
  id: number,
  userId: number,
): Promise<ClassificationSampleRow | null> {
  const [row] = await db
    .select()
    .from(classificationSamples)
    .where(and(eq(classificationSamples.id, id), eq(classificationSamples.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function listClassificationSamplesForUser(
  userId: number,
): Promise<ClassificationSampleListItem[]> {
  const rows = await db
    .select()
    .from(classificationSamples)
    .where(eq(classificationSamples.userId, userId))
    .orderBy(desc(classificationSamples.createdAt))
    .limit(50);
  return rows.map(rowToListItem);
}

export async function completeClassificationSample(input: {
  id: number;
  userId: number;
  verdicts: ClassificationVerdict[];
  categoryAccuracy: number | null;
  classAccuracy: number | null;
  recurrenceAccuracy: number | null;
  confirmedCount: number;
  correctedCount: number;
  skippedCount: number;
}): Promise<ClassificationSampleRow | null> {
  const [row] = await db
    .update(classificationSamples)
    .set({
      verdicts: input.verdicts,
      completedAt: new Date(),
      categoryAccuracy:   input.categoryAccuracy   != null ? input.categoryAccuracy.toFixed(4)   : null,
      classAccuracy:      input.classAccuracy      != null ? input.classAccuracy.toFixed(4)      : null,
      recurrenceAccuracy: input.recurrenceAccuracy != null ? input.recurrenceAccuracy.toFixed(4) : null,
      confirmedCount: input.confirmedCount,
      correctedCount: input.correctedCount,
      skippedCount:   input.skippedCount,
    })
    .where(and(eq(classificationSamples.id, input.id), eq(classificationSamples.userId, input.userId)))
    .returning();
  return row ?? null;
}

/**
 * Delete a classification sample owned by `userId`. The userId scope prevents
 * cross-account deletion even with a guessed id. Returns true when a row was
 * actually removed, false when no matching row existed (caller treats as 404).
 *
 * Used by the Dev Test Suite to let testers discard abandoned in-progress
 * samples (and re-runs of completed ones) without leaving stale rows in the
 * "Past classification samples" table.
 */
export async function deleteClassificationSample(
  id: number,
  userId: number,
): Promise<boolean> {
  const rows = await db
    .delete(classificationSamples)
    .where(and(eq(classificationSamples.id, id), eq(classificationSamples.userId, userId)))
    .returning({ id: classificationSamples.id });
  return rows.length > 0;
}

/**
 * Latest completed classification sample per user — used by the team
 * side-by-side view. Returns at most one row per user_id in `userIds`.
 */
export async function getLatestCompletedClassificationByUsers(
  userIds: number[],
): Promise<Map<number, ClassificationSampleRow>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(classificationSamples)
    .where(
      and(
        inArray(classificationSamples.userId, userIds),
        sql`${classificationSamples.completedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(classificationSamples.completedAt));
  const out = new Map<number, ClassificationSampleRow>();
  for (const r of rows) {
    if (!out.has(r.userId)) out.set(r.userId, r);
  }
  return out;
}

/**
 * Fetch transaction display data (date / description / amount) by ID for a
 * specific user. Used by the Dev Test Suite when reopening an in-progress
 * sample so the review screen can show the original Ledger context, not just
 * the classifier-snapshot fields stored on the verdict row.
 */
export async function getTransactionDisplayByIds(
  ids: number[],
  userId: number,
): Promise<Map<number, { id: number; date: string; rawDescription: string; amount: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      rawDescription: transactions.rawDescription,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)));
  return new Map(rows.map((r) => [r.id, r]));
}


export async function getUsersByIds(
  ids: number[],
): Promise<Array<{ id: number; email: string; displayName: string }>> {
  if (ids.length === 0) return [];
  return db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, ids));
}

export class DuplicateWaitlistEmailError extends Error {}

export async function addWaitlistEmail(email: string): Promise<void> {
  try {
    await db.insert(waitlist).values({ email });
  } catch (err) {
    if (err instanceof DatabaseError && err.code === "23505") {
      throw new DuplicateWaitlistEmailError("Email already registered");
    }
    throw err;
  }
}
