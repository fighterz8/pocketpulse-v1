import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  accounts,
  session,
  transactions,
  uploads,
  userPreferences,
  users,
  V1_CATEGORIES,
} from "../shared/schema.js";

describe("shared schema", () => {
  it("exports users and accounts tables", () => {
    expect(users).toBeDefined();
    expect(accounts).toBeDefined();
  });

  it("exports uploads and transactions tables", () => {
    expect(uploads).toBeDefined();
    expect(transactions).toBeDefined();
  });

  it("uses expected PostgreSQL table names", () => {
    expect(getTableConfig(users).name).toBe("users");
    expect(getTableConfig(accounts).name).toBe("accounts");
    expect(getTableConfig(userPreferences).name).toBe("user_preferences");
    expect(getTableConfig(session).name).toBe("session");
    expect(getTableConfig(uploads).name).toBe("uploads");
    expect(getTableConfig(transactions).name).toBe("transactions");
  });

  it("indexes accounts.user_id for user-scoped lookups", () => {
    const idx = getTableConfig(accounts).indexes.find(
      (i) => i.config.name === "accounts_user_id_idx",
    );
    expect(idx).toBeDefined();
  });

  it("indexes uploads by user_id and account_id", () => {
    const config = getTableConfig(uploads);
    expect(
      config.indexes.find((i) => i.config.name === "uploads_user_id_idx"),
    ).toBeDefined();
    expect(
      config.indexes.find((i) => i.config.name === "uploads_account_id_idx"),
    ).toBeDefined();
  });

  it("indexes transactions by user_id, upload_id, account_id, and date", () => {
    const config = getTableConfig(transactions);
    expect(
      config.indexes.find(
        (i) => i.config.name === "transactions_user_id_idx",
      ),
    ).toBeDefined();
    expect(
      config.indexes.find(
        (i) => i.config.name === "transactions_upload_id_idx",
      ),
    ).toBeDefined();
    expect(
      config.indexes.find(
        (i) => i.config.name === "transactions_account_id_idx",
      ),
    ).toBeDefined();
    expect(
      config.indexes.find((i) => i.config.name === "transactions_date_idx"),
    ).toBeDefined();
  });

  it("exports the V1 category set with expected categories", () => {
    expect(V1_CATEGORIES).toContain("income");
    expect(V1_CATEGORIES).toContain("other");
    expect(V1_CATEGORIES).toContain("subscriptions");
    expect(V1_CATEGORIES.length).toBeGreaterThanOrEqual(15);
  });
});
