import bcrypt from "bcrypt";

/** Cost factor for bcrypt; balance security vs registration latency. */
const BCRYPT_SALT_ROUNDS = 12;

/**
 * Canonical form for stored and looked-up emails (trim + lowercase ASCII).
 * Use for registration, login lookup, and any `getUserByEmail*` path so addresses
 * are not treated as distinct solely by case or surrounding whitespace.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Hash a plaintext password for storage in `users.password` (column stores the hash only).
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_SALT_ROUNDS);
}

/**
 * Check a plaintext password against a stored bcrypt hash from `users.password`.
 */
export async function verifyPassword(
  plain: string,
  storedHash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, storedHash);
}
