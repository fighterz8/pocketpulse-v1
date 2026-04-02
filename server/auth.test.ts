import { describe, expect, it, beforeAll } from "vitest";

import { hashPassword, normalizeEmail, verifyPassword } from "./auth.js";
import { toPublicUser, type UserRow } from "./public-user.js";

describe("auth helpers", () => {
  describe("normalizeEmail", () => {
    it("trims whitespace and lowercases ASCII", () => {
      expect(normalizeEmail("  User@EXAMPLE.com \t")).toBe("user@example.com");
    });
  });

  describe("password hashing and verification", () => {
    it("produces a non-plain-text hash different from the input", async () => {
      const plain = "correct-horse-battery-staple";
      const hash = await hashPassword(plain);
      expect(hash).not.toBe(plain);
      expect(hash.length).toBeGreaterThan(20);
    });

    it("verifyPassword returns true for the same password", async () => {
      const plain = "my-secret-password";
      const hash = await hashPassword(plain);
      await expect(verifyPassword(plain, hash)).resolves.toBe(true);
    });

    it("verifyPassword returns false for a different password", async () => {
      const hash = await hashPassword("one-password");
      await expect(verifyPassword("other-password", hash)).resolves.toBe(false);
    });
  });
});

describe("toPublicUser", () => {
  it("omits password so responses cannot leak the hash", () => {
    const row = {
      id: 1,
      email: "a@b.co",
      password: "$2b$12$deadbeef",
      displayName: "A",
      companyName: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies UserRow;

    const pub = toPublicUser(row);
    expect(pub).not.toHaveProperty("password");
    expect(pub.email).toBe("a@b.co");
  });
});

/**
 * Storage tests hit PostgreSQL and require a migrated schema (`npm run db:push` or equivalent).
 * Opt in with POCKETPULSE_STORAGE_TESTS=1 so CI and local runs without tables stay green.
 */
const runStorageIntegrationTests =
  Boolean(process.env.DATABASE_URL) &&
  process.env.POCKETPULSE_STORAGE_TESTS === "1";

describe.skipIf(!runStorageIntegrationTests)("storage helpers", () => {
  let storage: typeof import("./storage.js");

  beforeAll(async () => {
    storage = await import("./storage.js");
  });

  it("createUser persists user and default user_preferences", async () => {
    const email = `storage-test-${crypto.randomUUID()}@example.com`;
    const { createUser, getUserById } = storage;
    const user = await createUser({
      email,
      passwordHash: await hashPassword("pw"),
      displayName: "Test User",
    });
    expect(user.id).toBeTypeOf("number");
    expect(user.email).toBe(email);
    expect(user).not.toHaveProperty("password");

    const again = await getUserById(user.id);
    expect(again).not.toBeNull();
    expect(again!.email).toBe(email);
    expect(again!).not.toHaveProperty("password");

    const { db } = await import("./db.js");
    const schema = await import("../shared/schema.js");
    const { eq } = await import("drizzle-orm");
    const [prefs] = await db
      .select()
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, user.id))
      .limit(1);
    expect(prefs).toBeDefined();
    expect(prefs!.theme).toBe(schema.USER_PREFERENCE_DEFAULTS.theme);
    expect(prefs!.weekStartsOn).toBe(schema.USER_PREFERENCE_DEFAULTS.weekStartsOn);
    expect(prefs!.defaultCurrency).toBe(
      schema.USER_PREFERENCE_DEFAULTS.defaultCurrency,
    );
  });

  it("getUserByEmail returns the user when the email exists", async () => {
    const email = `storage-email-${crypto.randomUUID()}@example.com`;
    const { createUser, getUserByEmail } = storage;
    await createUser({
      email,
      passwordHash: "hash-placeholder",
      displayName: "Email Lookup",
    });
    const found = await getUserByEmail(`  ${email.toUpperCase()}  `);
    expect(found).not.toBeNull();
    expect(found!.email).toBe(email);
    expect(found!).not.toHaveProperty("password");
  });

  it("createUser stores normalized email and rejects duplicate case variants", async () => {
    const base = `dup-${crypto.randomUUID()}@example.com`;
    const { createUser, DuplicateEmailError } = storage;
    await createUser({
      email: `  ${base.toUpperCase()}  `,
      passwordHash: "x",
      displayName: "First",
    });
    await expect(
      createUser({
        email: base,
        passwordHash: "y",
        displayName: "Second",
      }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);
  });

  it("getUserByEmailForAuth returns passwordHash for login verification only", async () => {
    const email = `storage-auth-${crypto.randomUUID()}@example.com`;
    const plain = "login-secret-99";
    const { createUser, getUserByEmailForAuth } = storage;
    await createUser({
      email,
      passwordHash: await hashPassword(plain),
      displayName: "Auth Lookup",
    });
    const record = await getUserByEmailForAuth(` ${email.toUpperCase()} `);
    expect(record).not.toBeNull();
    expect(record!.passwordHash).toMatch(/^\$2[aby]\$/);
    await expect(verifyPassword(plain, record!.passwordHash)).resolves.toBe(
      true,
    );
  });

  it("getUserByEmail returns null when missing", async () => {
    const { getUserByEmail } = storage;
    expect(await getUserByEmail("no-such-user@example.com")).toBeNull();
  });

  it("listAccountsForUser orders by account id ascending", async () => {
    const email = `storage-acct-${crypto.randomUUID()}@example.com`;
    const {
      createUser,
      listAccountsForUser,
      createAccountForUser,
    } = storage;
    const user = await createUser({
      email,
      passwordHash: "x",
      displayName: "Acct User",
    });
    expect(await listAccountsForUser(user.id)).toEqual([]);

    const second = await createAccountForUser(user.id, {
      label: "Second",
    });
    const first = await createAccountForUser(user.id, {
      label: "First",
    });
    expect(second.id).toBeLessThan(first.id);

    const list = await listAccountsForUser(user.id);
    expect(list.map((a) => a.id)).toEqual([second.id, first.id]);
    expect(list.map((a) => a.label)).toEqual(["Second", "First"]);
  });
});
