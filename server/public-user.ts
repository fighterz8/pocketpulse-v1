import type { InferSelectModel } from "drizzle-orm";

import { users } from "../shared/schema.js";

export type UserRow = InferSelectModel<typeof users>;

/** Row shape safe to return from APIs — never includes `password`. */
export type PublicUser = Omit<UserRow, "password">;

/**
 * Strip `password` from a full `users` row (e.g. after `returning()` on insert).
 * Prefer selecting explicit non-password columns when reading from the DB so the hash is never loaded.
 */
export function toPublicUser(row: UserRow): PublicUser {
  const { password: _password, ...rest } = row;
  return rest;
}
