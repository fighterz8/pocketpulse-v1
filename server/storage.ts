import { eq, and, desc, gte, lte, ilike, or, count, inArray } from "drizzle-orm";
import { db } from "./db";
import {
  users, accounts, uploads, transactions,
  type User, type InsertUser,
  type Account, type InsertAccount,
  type Upload,
  type Transaction, type InsertTransaction, type UpdateTransaction,
} from "@shared/schema";
import { buildTransactionUpdate, deriveSignedAmount, flowTypeFromAmount, normalizeAmountForClass } from "./transactionUtils";
import { classifyTransaction } from "./classifier";
import { maybeApplyLlmLabels } from "./llmLabeler";
import { detectMonthlyRecurringPatterns } from "./recurrenceDetector";

export interface TransactionFilters {
  flowType?: string;
  accountId?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  merchant?: string;
  category?: string;
  transactionClass?: string;
  recurrenceType?: string;
}

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getAccounts(userId: number): Promise<Account[]>;
  getAccount(id: number, userId: number): Promise<Account | undefined>;
  createAccount(userId: number, account: InsertAccount): Promise<Account>;

  createUpload(userId: number, accountId: number, filename: string, rowCount: number): Promise<Upload>;
  getUploads(userId: number): Promise<Upload[]>;

  createTransactions(txns: InsertTransaction[]): Promise<Transaction[]>;
  getTransactions(userId: number, filters?: TransactionFilters): Promise<Transaction[]>;
  getTransactionPage(userId: number, filters?: TransactionFilters & {
    page?: number;
    pageSize?: number;
  }): Promise<{
    rows: Transaction[];
    totalCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>;
  getTransaction(id: number, userId: number): Promise<Transaction | undefined>;
  updateTransaction(id: number, userId: number, data: UpdateTransaction): Promise<Transaction | undefined>;
  reprocessTransactions(userId: number): Promise<{ updated: number; skipped: number; ambiguous: number }>;
  wipeImportedData(userId: number): Promise<{ deletedTransactions: number; deletedUploads: number }>;
  wipeWorkspaceData(userId: number): Promise<{ deletedTransactions: number; deletedUploads: number; deletedAccounts: number }>;
}

export class DatabaseStorage implements IStorage {
  private parseFilterList(value?: string): string[] {
    return (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private buildTransactionWhere(
    userId: number,
    filters?: TransactionFilters,
  ) {
    const conditions = [eq(transactions.userId, userId)];

    const flowTypes = this.parseFilterList(filters?.flowType);
    if (flowTypes.length === 1) {
      conditions.push(eq(transactions.flowType, flowTypes[0]));
    } else if (flowTypes.length > 1) {
      conditions.push(inArray(transactions.flowType, flowTypes));
    }

    if (filters?.accountId) {
      conditions.push(eq(transactions.accountId, filters.accountId));
    }

    if (filters?.startDate) {
      conditions.push(gte(transactions.date, filters.startDate));
    }

    if (filters?.endDate) {
      conditions.push(lte(transactions.date, filters.endDate));
    }

    if (filters?.merchant?.trim()) {
      conditions.push(ilike(transactions.merchant, filters.merchant.trim()));
    }

    const categories = this.parseFilterList(filters?.category);
    if (categories.length === 1) {
      conditions.push(eq(transactions.category, categories[0]));
    } else if (categories.length > 1) {
      conditions.push(inArray(transactions.category, categories));
    }

    const transactionClasses = this.parseFilterList(filters?.transactionClass);
    if (transactionClasses.length === 1) {
      conditions.push(eq(transactions.transactionClass, transactionClasses[0]));
    } else if (transactionClasses.length > 1) {
      conditions.push(inArray(transactions.transactionClass, transactionClasses));
    }

    const recurrenceTypes = this.parseFilterList(filters?.recurrenceType);
    if (recurrenceTypes.length === 1) {
      conditions.push(eq(transactions.recurrenceType, recurrenceTypes[0]));
    } else if (recurrenceTypes.length > 1) {
      conditions.push(inArray(transactions.recurrenceType, recurrenceTypes));
    }

    if (filters?.search?.trim()) {
      const searchTerm = `%${filters.search.trim()}%`;
      conditions.push(
        or(
          ilike(transactions.merchant, searchTerm),
          ilike(transactions.rawDescription, searchTerm),
        )!,
      );
    }

    return and(...conditions);
  }

  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [created] = await db.insert(users).values(user).returning();
    return created;
  }

  async getAccounts(userId: number): Promise<Account[]> {
    return db.select().from(accounts).where(eq(accounts.userId, userId));
  }

  async getAccount(id: number, userId: number): Promise<Account | undefined> {
    const [account] = await db.select().from(accounts).where(
      and(eq(accounts.id, id), eq(accounts.userId, userId))
    );
    return account;
  }

  async createAccount(userId: number, account: InsertAccount): Promise<Account> {
    const [created] = await db.insert(accounts).values({ ...account, userId }).returning();
    return created;
  }

  async createUpload(userId: number, accountId: number, filename: string, rowCount: number): Promise<Upload> {
    const [created] = await db.insert(uploads).values({ userId, accountId, filename, rowCount }).returning();
    return created;
  }

  async getUploads(userId: number): Promise<Upload[]> {
    return db.select().from(uploads).where(eq(uploads.userId, userId)).orderBy(desc(uploads.uploadedAt));
  }

  async createTransactions(txns: InsertTransaction[]): Promise<Transaction[]> {
    if (txns.length === 0) return [];
    return db.insert(transactions).values(txns).returning();
  }

  async getTransactions(userId: number, filters?: TransactionFilters): Promise<Transaction[]> {
    return db.select()
      .from(transactions)
      .where(this.buildTransactionWhere(userId, filters))
      .orderBy(desc(transactions.date), desc(transactions.id));
  }

  async getTransactionPage(userId: number, filters?: TransactionFilters & { page?: number; pageSize?: number }) {
    const pageSize = Math.min(Math.max(filters?.pageSize ?? 50, 1), 100);
    const page = Math.max(filters?.page ?? 1, 1);
    const where = this.buildTransactionWhere(userId, filters);
    const offset = (page - 1) * pageSize;

    const [rows, totalRows] = await Promise.all([
      db.select()
        .from(transactions)
        .where(where)
        .orderBy(desc(transactions.date), desc(transactions.id))
        .limit(pageSize)
        .offset(offset),
      db.select({ value: count() }).from(transactions).where(where),
    ]);

    const totalCount = Number(totalRows[0]?.value ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    return {
      rows,
      totalCount,
      page: Math.min(page, totalPages),
      pageSize,
      totalPages,
    };
  }

  async getTransaction(id: number, userId: number): Promise<Transaction | undefined> {
    const [tx] = await db.select().from(transactions).where(
      and(eq(transactions.id, id), eq(transactions.userId, userId))
    );
    return tx;
  }

  async updateTransaction(id: number, userId: number, data: UpdateTransaction): Promise<Transaction | undefined> {
    const existing = await this.getTransaction(id, userId);
    if (!existing) return undefined;

    const normalizedUpdate = buildTransactionUpdate(existing, data);
    const [updated] = await db.update(transactions)
      .set(normalizedUpdate)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .returning();
    return updated;
  }

  async reprocessTransactions(userId: number): Promise<{ updated: number; skipped: number; ambiguous: number }> {
    const existingTransactions = await this.getTransactions(userId);
    let updated = 0;
    let skipped = 0;
    let ambiguous = 0;

    const pendingUpdates = existingTransactions
      .map((transaction) => {
        if (transaction.userCorrected) {
          skipped += 1;
          return undefined;
        }

        const currentAmount = parseFloat(transaction.amount);
        const signedAmountResult = deriveSignedAmount({
          rawAmount: currentAmount,
          rawDescription: transaction.rawDescription,
        });
        const classification = classifyTransaction(transaction.rawDescription, signedAmountResult.amount);
        const normalizedAmount = normalizeAmountForClass(
          signedAmountResult.amount,
          classification.transactionClass,
        );

        if (signedAmountResult.ambiguous || classification.aiAssisted) {
          ambiguous += 1;
        }

        return {
          transaction,
          normalizedAmount,
          decision: {
            rawDescription: transaction.rawDescription,
            amount: normalizedAmount,
            transactionClass: classification.transactionClass,
            recurrenceType: classification.recurrenceType,
            category: classification.category,
            aiAssisted: classification.aiAssisted || signedAmountResult.ambiguous,
            labelSource: classification.labelSource,
            labelConfidence: classification.labelConfidence,
            labelReason: classification.labelReason,
          },
          merchant: classification.merchant,
        };
      })
      .filter(Boolean) as Array<{
      transaction: Transaction;
      normalizedAmount: number;
      decision: Awaited<ReturnType<typeof maybeApplyLlmLabels>>[number];
      merchant: string;
    }>;

    const llmDecisions = await maybeApplyLlmLabels(pendingUpdates.map((entry) => entry.decision));
    const recurrenceMatches = detectMonthlyRecurringPatterns(pendingUpdates.map((entry, index) => ({
      merchant: entry.merchant,
      date: entry.transaction.date,
      amount: entry.normalizedAmount,
      flowType: flowTypeFromAmount(entry.normalizedAmount),
      recurrenceType: llmDecisions[index]?.recurrenceType ?? entry.decision.recurrenceType,
      userCorrected: entry.transaction.userCorrected,
      labelReason: llmDecisions[index]?.labelReason ?? entry.decision.labelReason,
    })));

    for (const [index, entry] of Array.from(pendingUpdates.entries())) {
      const llmDecision = llmDecisions[index];
      const decision = recurrenceMatches.matchedIndexes.has(index) && llmDecision.recurrenceType !== "recurring"
        ? {
            ...llmDecision,
            recurrenceType: "recurring" as const,
            labelReason: recurrenceMatches.reasonByIndex.get(index) ?? llmDecision.labelReason,
          }
        : llmDecision;
      await db.update(transactions)
        .set({
          amount: entry.normalizedAmount.toFixed(2),
          flowType: flowTypeFromAmount(entry.normalizedAmount),
          transactionClass: decision.transactionClass,
          recurrenceType: decision.recurrenceType,
          category: decision.category,
          merchant: entry.merchant,
          labelSource: decision.labelSource,
          labelConfidence: decision.labelConfidence,
          labelReason: decision.labelReason,
          aiAssisted: decision.aiAssisted,
        })
        .where(eq(transactions.id, entry.transaction.id));

      updated += 1;
    }

    return { updated, skipped, ambiguous };
  }

  async wipeImportedData(userId: number): Promise<{ deletedTransactions: number; deletedUploads: number }> {
    const deletedTransactions = await db.delete(transactions)
      .where(eq(transactions.userId, userId))
      .returning({ id: transactions.id });

    const deletedUploads = await db.delete(uploads)
      .where(eq(uploads.userId, userId))
      .returning({ id: uploads.id });

    return {
      deletedTransactions: deletedTransactions.length,
      deletedUploads: deletedUploads.length,
    };
  }

  async wipeWorkspaceData(userId: number): Promise<{ deletedTransactions: number; deletedUploads: number; deletedAccounts: number }> {
    const importedData = await this.wipeImportedData(userId);

    const deletedAccounts = await db.delete(accounts)
      .where(eq(accounts.userId, userId))
      .returning({ id: accounts.id });

    return {
      ...importedData,
      deletedAccounts: deletedAccounts.length,
    };
  }
}

export const storage = new DatabaseStorage();
