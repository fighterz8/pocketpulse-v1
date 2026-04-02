import { and, asc, count, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { DatabaseError } from "pg";

import {
  accounts,
  recurringReviews,
  transactions,
  uploads,
  USER_PREFERENCE_DEFAULTS,
  userPreferences,
  users,
} from "../shared/schema.js";

import { normalizeEmail } from "./auth.js";
import { db } from "./db.js";
import { toPublicUser, type PublicUser } from "./public-user.js";

export type { PublicUser } from "./public-user.js";
export { toPublicUser } from "./public-user.js";

const publicUserColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  companyName: users.companyName,
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
) {
  const values: Record<string, unknown> = { status };
  if (rowCount !== undefined) values.rowCount = rowCount;
  if (errorMessage !== undefined) values.errorMessage = errorMessage;

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
  category?: string;
  labelSource?: string;
  labelConfidence?: string | null;
  labelReason?: string | null;
};

export async function createTransactionBatch(
  txns: CreateTransactionInput[],
): Promise<number> {
  if (txns.length === 0) return 0;

  const values = txns.map((t) => ({
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
    category: t.category ?? "other",
    labelSource: t.labelSource ?? "rule",
    labelConfidence: t.labelConfidence ?? null,
    labelReason: t.labelReason ?? null,
  }));

  const result = await db.insert(transactions).values(values).returning({ id: transactions.id });
  return result.length;
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

  const [rows, totalResult] = await Promise.all([
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
  ]);

  const total = totalResult[0]?.total ?? 0;

  return {
    transactions: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
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

export async function updateTransaction(
  id: number,
  userId: number,
  fields: UpdateTransactionInput,
) {
  const setValues: Record<string, unknown> = {
    userCorrected: true,
    labelSource: "manual",
  };

  if (fields.date !== undefined) setValues.date = fields.date;
  if (fields.merchant !== undefined) setValues.merchant = fields.merchant;
  if (fields.amount !== undefined) setValues.amount = fields.amount;
  if (fields.flowType !== undefined) setValues.flowType = fields.flowType;
  if (fields.category !== undefined) setValues.category = fields.category;
  if (fields.transactionClass !== undefined) setValues.transactionClass = fields.transactionClass;
  if (fields.recurrenceType !== undefined) setValues.recurrenceType = fields.recurrenceType;
  if (fields.excludedFromAnalysis !== undefined) {
    setValues.excludedFromAnalysis = fields.excludedFromAnalysis;
    setValues.excludedAt = fields.excludedFromAnalysis ? new Date() : null;
  }
  if (fields.excludedReason !== undefined) setValues.excludedReason = fields.excludedReason;

  const [row] = await db
    .update(transactions)
    .set(setValues)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .returning();

  return row ?? null;
}

export type BulkTransactionUpdate = {
  id: number;
  amount: string;
  flowType: string;
  transactionClass: string;
  category: string;
  recurrenceType: string;
  labelSource: string;
  labelConfidence: string;
  labelReason: string;
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
          labelSource: u.labelSource,
          labelConfidence: u.labelConfidence,
          labelReason: u.labelReason,
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
