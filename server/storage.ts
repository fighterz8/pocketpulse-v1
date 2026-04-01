import { asc, eq } from "drizzle-orm";
import { DatabaseError } from "pg";

import {
  accounts,
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
