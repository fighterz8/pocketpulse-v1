/**
 * Schema authority — import from here only (including Drizzle Kit).
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
  boolean,
  index,
  integer,
  json,
  numeric,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
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
 * Necessary recurring expense categories — auto-labeled essential, never shown
 * on the Subscription Leaks review page.
 * Single source of truth: imported by server/routes.ts, client/src/pages/Leaks.tsx,
 * and client/src/components/layout/AppLayout.tsx.
 */
export const AUTO_ESSENTIAL_CATEGORIES: ReadonlySet<string> = new Set([
  "housing",    // mortgage, rent
  "utilities",  // electricity, water, gas, internet, phone bills
  "insurance",  // auto, health, home, renters insurance
  "medical",    // prescriptions, recurring health services
  "debt",       // loan payments, credit card minimums
]);

/** V1 category set — used by classifier and ledger UI. */
export const V1_CATEGORIES = [
  "income",
  "housing",
  "debt",
  "utilities",
  "groceries",
  "dining",
  "coffee",
  "delivery",
  "convenience",
  "gas",
  "parking",
  "travel",
  "auto",
  "fitness",
  "medical",
  "insurance",
  "shopping",
  "entertainment",
  "software",
  "fees",
  "other",
] as const;

export type V1Category = (typeof V1_CATEGORIES)[number];

export const uploads = pgTable(
  "uploads",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    uploadedAt: timestamp("uploaded_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("uploads_user_id_idx").on(t.userId),
    index("uploads_account_id_idx").on(t.accountId),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    uploadId: integer("upload_id")
      .notNull()
      .references(() => uploads.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    merchant: text("merchant").notNull(),
    rawDescription: text("raw_description").notNull(),
    flowType: text("flow_type").notNull(),
    transactionClass: text("transaction_class").notNull(),
    recurrenceType: text("recurrence_type").notNull().default("one-time"),
    category: text("category").notNull().default("other"),
    labelSource: text("label_source").notNull().default("rule"),
    labelConfidence: numeric("label_confidence", { precision: 5, scale: 2 }),
    labelReason: text("label_reason"),
    aiAssisted: boolean("ai_assisted").notNull().default(false),
    userCorrected: boolean("user_corrected").notNull().default(false),
    excludedFromAnalysis: boolean("excluded_from_analysis")
      .notNull()
      .default(false),
    excludedReason: text("excluded_reason"),
    excludedAt: timestamp("excluded_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("transactions_user_id_idx").on(t.userId),
    index("transactions_upload_id_idx").on(t.uploadId),
    index("transactions_account_id_idx").on(t.accountId),
    index("transactions_date_idx").on(t.date),
  ],
);

export const REVIEW_STATUSES = ["unreviewed", "essential", "leak", "dismissed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const recurringReviews = pgTable(
  "recurring_reviews",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    candidateKey: text("candidate_key").notNull(),
    status: text("status").notNull().default("unreviewed"),
    notes: text("notes"),
    reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("recurring_reviews_user_id_idx").on(t.userId),
    uniqueIndex("recurring_reviews_user_candidate_idx").on(t.userId, t.candidateKey),
  ],
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
