import { asc, count, desc, eq, sql } from "drizzle-orm";
import { DatabaseError } from "pg";

import {
  accounts,
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
};

export async function listTransactionsForUser(options: ListTransactionsOptions) {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const offset = (page - 1) * limit;

  const conditions = [eq(transactions.userId, options.userId)];
  if (options.accountId !== undefined) {
    conditions.push(eq(transactions.accountId, options.accountId));
  }

  const where = conditions.length === 1
    ? conditions[0]!
    : sql`${conditions[0]} AND ${conditions[1]}`;

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
