import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, numeric, boolean, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const flowTypeSchema = z.enum(["inflow", "outflow"]);
export type FlowType = z.infer<typeof flowTypeSchema>;

export const transactionClassSchema = z.enum(["income", "expense", "transfer", "refund"]);
export type TransactionClass = z.infer<typeof transactionClassSchema>;

export const recurrenceTypeSchema = z.enum(["recurring", "one-time"]);
export type RecurrenceType = z.infer<typeof recurrenceTypeSchema>;

export const transactionCategorySchema = z.enum([
  "income",
  "transfers",
  "utilities",
  "subscriptions",
  "insurance",
  "housing",
  "groceries",
  "transportation",
  "dining",
  "shopping",
  "health",
  "debt",
  "business_software",
  "entertainment",
  "fees",
  "other",
]);
export type TransactionCategory = z.infer<typeof transactionCategorySchema>;

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  companyName: text("company_name").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  password: true,
  companyName: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  lastFour: text("last_four"),
});

export const insertAccountSchema = createInsertSchema(accounts).pick({
  name: true,
  lastFour: true,
});
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accounts.$inferSelect;

export const uploads = pgTable("uploads", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  accountId: integer("account_id").notNull().references(() => accounts.id),
  filename: text("filename").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
});

export type Upload = typeof uploads.$inferSelect;

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  uploadId: integer("upload_id").references(() => uploads.id),
  accountId: integer("account_id").notNull().references(() => accounts.id),
  date: text("date").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  merchant: text("merchant").notNull(),
  rawDescription: text("raw_description").notNull(),
  flowType: text("flow_type").notNull(), // inflow | outflow
  transactionClass: text("transaction_class").notNull(), // income | expense | transfer | refund
  recurrenceType: text("recurrence_type").notNull(), // recurring | one-time
  category: text("category").notNull().default("other"),
  aiAssisted: boolean("ai_assisted").notNull().default(false),
  userCorrected: boolean("user_corrected").notNull().default(false),
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
});
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;

export const updateTransactionSchema = z.object({
  transactionClass: transactionClassSchema.optional(),
  recurrenceType: recurrenceTypeSchema.optional(),
  flowType: flowTypeSchema.optional(),
  category: transactionCategorySchema.optional(),
  merchant: z.string().optional(),
});
export type UpdateTransaction = z.infer<typeof updateTransactionSchema>;
