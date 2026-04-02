import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { accounts, session, userPreferences, users } from "../shared/schema.js";

describe("shared schema", () => {
  it("exports users and accounts tables", () => {
    expect(users).toBeDefined();
    expect(accounts).toBeDefined();
  });

  it("uses expected PostgreSQL table names", () => {
    expect(getTableConfig(users).name).toBe("users");
    expect(getTableConfig(accounts).name).toBe("accounts");
    expect(getTableConfig(userPreferences).name).toBe("user_preferences");
    expect(getTableConfig(session).name).toBe("session");
  });

  it("indexes accounts.user_id for user-scoped lookups", () => {
    const idx = getTableConfig(accounts).indexes.find(
      (i) => i.config.name === "accounts_user_id_idx",
    );
    expect(idx).toBeDefined();
  });
});
