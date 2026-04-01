/**
 * Phase 1 schema authority — import from here only (including Drizzle Kit).
 *
 * ## User preferences lifecycle
 *
 * **Preferred:** When a `users` row is created at registration, insert a matching
 * `user_preferences` row in the same transaction (reuse `USER_PREFERENCE_DEFAULTS`
 * so app defaults stay aligned with the schema defaults).
 *
 * **Fallback:** If legacy or partially migrated users lack a row, call
 * `ensureUserPreferences` from `server/db.ts` on first authenticated request
 * (lazy creation, conflict-safe under concurrency). New code should prefer the
 * registration-time path.
 */
import {
  index,
  integer,
  json,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Keep in sync with `.default()` on `userPreferences` columns for explicit inserts. */
export const USER_PREFERENCE_DEFAULTS = {
  theme: "system",
  weekStartsOn: 0,
  defaultCurrency: "USD",
} as const;

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  displayName: text("display_name").notNull(),
  companyName: text("company_name"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userPreferences = pgTable("user_preferences", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme")
    .notNull()
    .default(USER_PREFERENCE_DEFAULTS.theme),
  weekStartsOn: smallint("week_starts_on")
    .notNull()
    .default(USER_PREFERENCE_DEFAULTS.weekStartsOn),
  defaultCurrency: text("default_currency")
    .notNull()
    .default(USER_PREFERENCE_DEFAULTS.defaultCurrency),
});

export const accounts = pgTable(
  "accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    lastFour: text("last_four"),
    accountType: text("account_type"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

/**
 * Matches `connect-pg-simple` expected shape (`table.sql` in that package).
 * Default store table name is `session`; keep this name for drop-in use later.
 */
export const session = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6, mode: "date" }).notNull(),
  },
  (t) => [index("IDX_session_expire").on(t.expire)],
);
