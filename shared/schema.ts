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
  isDev: boolean("is_dev").notNull().default(false),
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
    /** Count of non-fatal parser warnings (skipped rows, preamble notices, etc.).
     *  Used by the Dev Test Suite parser fidelity tool to snapshot upload-level
     *  context at sample creation time. */
    warningCount: integer("warning_count").notNull().default(0),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    /**
     * The format spec that was applied when parsing this upload.
     * Stored for debugging purposes — lets devs inspect how a file was read.
     * null for uploads that pre-date AI format detection.
     */
    formatSpec: json("format_spec").$type<CsvFormatSpec | null>(),
    uploadedAt: timestamp("uploaded_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Async AI classification lifecycle (independent of `status`, which
     * tracks file parse/insert).
     * "none"        no AI work was ever required
     * "pending"     rows queued for the background worker, not started
     * "processing"  worker actively running AI batches
     * "complete"    worker finished successfully
     * "failed"      worker hit a fatal error (see aiError)
     */
    aiStatus: text("ai_status").notNull().default("none"),
    /** Rows the worker still needs to enhance. Captured at upload completion. */
    aiRowsPending: integer("ai_rows_pending").notNull().default(0),
    /** Rows the worker has already enhanced. Climbs monotonically. */
    aiRowsDone: integer("ai_rows_done").notNull().default(0),
    aiStartedAt: timestamp("ai_started_at", { mode: "date", withTimezone: true }),
    aiCompletedAt: timestamp("ai_completed_at", { mode: "date", withTimezone: true }),
    /** Human-readable diagnostic; populated only when aiStatus='failed'. */
    aiError: text("ai_error"),
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
    recurrenceSource: text("recurrence_source").notNull().default("none"),
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
    // NOTE: A functional unique index enforces dedup at the DB level.
    // Drizzle's DSL does not support functional index expressions so it is
    // created (and kept idempotent) by the startup migration in server/index.ts:
    //
    //   CREATE UNIQUE INDEX IF NOT EXISTS transactions_dedup_idx
    //     ON transactions (user_id, account_id, date, amount,
    //                      lower(trim(raw_description)));
    //
    // lower(trim()) matches the JS fingerprint in createTransactionBatch
    // (trim + toLowerCase on rawDescription).  amount is numeric(12,2) so
    // DB stores with 2dp, matching parseFloat().toFixed(2) in JS.
    // The startup migration also purges pre-existing duplicates before
    // creating the index, so it is safe to run on any DB state.
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
 * User-specific merchant classification overrides.
 * Keyed by normalized merchant key (recurrenceKey()). Written automatically
 * on every manual transaction edit; applied at upload time (and reclassify)
 * before the AI phase, so corrections persist across CSV uploads.
 */
export const merchantRules = pgTable(
  "merchant_rules",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantKey: text("merchant_key").notNull(),
    category: text("category"),
    transactionClass: text("transaction_class"),
    recurrenceType: text("recurrence_type"),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("merchant_rules_user_id_idx").on(t.userId),
    uniqueIndex("merchant_rules_user_key_idx").on(t.userId, t.merchantKey),
  ],
);

/**
 * Structured description of how to read a bank's CSV file.
 * Produced by the heuristic parser or the AI format detector and cached
 * per user + header fingerprint so repeat uploads skip the detection step.
 */
export type CsvFormatSpec = {
  /** Number of leading rows to skip before the header (or data when hasHeader=false). */
  preambleRows: number;
  /** True when the CSV has a named header row; false for positional/headerless formats. */
  hasHeader: boolean;
  /** 0-based column index of the date field. */
  dateColumn: number;
  /** 0-based column index of the description/merchant field. */
  descriptionColumn: number;
  /** 0-based index of a combined amount column, or null when debit/credit columns are used. */
  amountColumn: number | null;
  /** 0-based index of a debit (outflow) column, or null if not present. */
  debitColumn: number | null;
  /** 0-based index of a credit (inflow) column, or null if not present. */
  creditColumn: number | null;
  /** 0-based index of a transaction-type column (e.g. "DR"/"CR"), or null if not present. */
  typeColumn: number | null;
  /**
   * How to interpret the amount column sign:
   *   "signed"   — negative = outflow, positive = inflow (most banks)
   *   "unsigned" — all values are positive; direction from description or type column
   */
  signConvention: "signed" | "unsigned";
  /**
   * Date format hint detected by the AI for non-standard date strings.
   * Examples: "MM/DD/YYYY", "YYYY-MM-DD", "MMM D YYYY", "D MMM YYYY"
   * When present, the parser tries this format first before its built-in list.
   * Optional — absent for formats already handled by the heuristic date parser.
   */
  dateFormat?: string;
};

/**
 * Cached CSV format specs keyed by (userId, headerFingerprint).
 * The fingerprint is a SHA-256 hex of the first up-to-10 raw lines of the file,
 * which is stable across different monthly exports from the same bank.
 */
export const csvFormatSpecs = pgTable(
  "csv_format_specs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the first up-to-10 lines of the normalized CSV content. */
    headerFingerprint: text("header_fingerprint").notNull(),
    /** The detected format spec as a JSON blob. */
    spec: json("spec").$type<CsvFormatSpec>().notNull(),
    /** How this spec was produced: "heuristic" or "ai". */
    source: text("source").notNull().default("ai"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("csv_format_specs_user_id_idx").on(t.userId),
    uniqueIndex("csv_format_specs_user_fp_idx").on(t.userId, t.headerFingerprint),
  ],
);

/**
 * Per-user merchant classification cache.
 *
 * Keyed by normalized merchant key (recurrenceKey()). Written by:
 *   - AI results with labelConfidence ≥ 0.70  (source = "ai")
 *   - Manual user corrections                 (source = "manual", confidence 1.0)
 *   - Day-one seed from userCorrected rows    (source = "rule-seed")
 *
 * Applied at upload time and during reclassify between the user-rule pass and
 * the AI fallback, so the same merchant never triggers a redundant AI call.
 * On conflict: "manual" source always wins; "ai" overwrites "ai" or "rule-seed";
 * "rule-seed" never overwrites an existing row.
 */
export const merchantClassifications = pgTable(
  "merchant_classifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantKey: text("merchant_key").notNull(),
    category: text("category").notNull(),
    transactionClass: text("transaction_class").notNull(),
    recurrenceType: text("recurrence_type").notNull(),
    labelConfidence: numeric("label_confidence", { precision: 5, scale: 2 }).notNull(),
    source: text("source").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("merchant_classifications_user_id_idx").on(t.userId),
    uniqueIndex("merchant_classifications_user_key_idx").on(t.userId, t.merchantKey),
  ],
);

/**
 * Global read-only seed table for merchant classifications.
 * Populated at boot from RULE_SEED_ENTRIES in classifierRuleMigration.ts.
 * Resolution order in classifyPipeline: per-user cache → global seed → structural rules → AI.
 * No userId — applies to all users equally.
 */
export const merchantClassificationsGlobal = pgTable(
  "merchant_classifications_global",
  {
    id: serial("id").primaryKey(),
    merchantKey: text("merchant_key").notNull(),
    category: text("category").notNull(),
    transactionClass: text("transaction_class").notNull(),
    recurrenceType: text("recurrence_type").notNull(),
    labelConfidence: numeric("label_confidence", { precision: 5, scale: 2 }).notNull(),
    source: text("source").notNull().default("rule-seed"),
    hitCount: integer("hit_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("merchant_classifications_global_key_idx").on(t.merchantKey)],
);

// ─── Dev Test Suite — classification sampler ─────────────────────────────────
// Sandboxed verdict storage for the Dev Test Suite. Verdicts NEVER write back
// to the transactions table. Tables drop cleanly with no inbound prod refs.

/** Per-row verdict shape stored in `classification_samples.verdicts` (json). */
export type ClassificationVerdict = {
  transactionId: number;
  // Snapshot of pipeline output AT SAMPLE CREATION TIME — persisted so later
  // reclassifies don't retroactively invalidate the sample.
  classifierCategory: string;
  classifierClass: string;
  classifierRecurrence: string;
  classifierLabelSource: string;
  classifierLabelConfidence: number;
  // User's verdict.
  verdict: "confirmed" | "corrected" | "skipped";
  // Only populated when verdict === "corrected". null means "user left this
  // dimension as-is"; a value means the user picked something else.
  correctedCategory: string | null;
  correctedClass: string | null;
  correctedRecurrence: string | null;
};

export const CLASSIFICATION_VERDICT_VALUES = ["confirmed", "corrected", "skipped"] as const;
export const CLASSIFICATION_CLASS_VALUES = ["income", "expense", "transfer", "refund"] as const;
export const CLASSIFICATION_RECURRENCE_VALUES = ["recurring", "one-time"] as const;

export const classificationSamples = pgTable(
  "classification_samples",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    sampleSize: integer("sample_size").notNull(),
    // Per-dimension accuracy; null until completed.
    categoryAccuracy: numeric("category_accuracy", { precision: 5, scale: 4 }),
    classAccuracy: numeric("class_accuracy", { precision: 5, scale: 4 }),
    recurrenceAccuracy: numeric("recurrence_accuracy", { precision: 5, scale: 4 }),
    confirmedCount: integer("confirmed_count").notNull().default(0),
    correctedCount: integer("corrected_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    verdicts: json("verdicts").$type<ClassificationVerdict[]>().notNull().default([]),
  },
  (t) => [
    index("classification_samples_user_id_idx").on(t.userId),
    index("classification_samples_completed_at_idx").on(t.completedAt),
  ],
);

export type ClassificationSampleRow = typeof classificationSamples.$inferSelect;

// (Parser-fidelity sampler / parser_samples table removed in Task #60. The
// table is dropped by drizzle/migrations/0008_drop_parser_samples.sql.)

export type MerchantClassificationSource = "manual" | "ai" | "rule-seed";

export type MerchantClassification = {
  merchantKey: string;
  category: string;
  transactionClass: string;
  recurrenceType: string;
  labelConfidence: number;
  source: MerchantClassificationSource;
};

export const waitlist = pgTable("waitlist", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WaitlistEntry = typeof waitlist.$inferSelect;

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
