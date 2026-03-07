import { eq, and, desc, gte, ilike, or, count } from "drizzle-orm";
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
  getTransactions(userId: number, filters?: {
    flowType?: string;
    accountId?: number;
    search?: string;
    startDate?: string;
    merchant?: string;
    category?: string;
    transactionClass?: string;
    recurrenceType?: string;
  }): Promise<Transaction[]>;
  getTransactionPage(userId: number, filters?: {
    flowType?: string;
    accountId?: number;
    search?: string;
    startDate?: string;
    merchant?: string;
    category?: string;
    transactionClass?: string;
    recurrenceType?: string;
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
  private buildTransactionWhere(
    userId: number,
    filters?: {
      flowType?: string;
      accountId?: number;
      search?: string;
      startDate?: string;
      merchant?: string;
      category?: string;
      transactionClass?: string;
      recurrenceType?: string;
    },
  ) {
    const conditions = [eq(transactions.userId, userId)];

    if (filters?.flowType) {
      conditions.push(eq(transactions.flowType, filters.flowType));
    }

    if (filters?.accountId) {
      conditions.push(eq(transactions.accountId, filters.accountId));
    }

    if (filters?.startDate) {
      conditions.push(gte(transactions.date, filters.startDate));
    }

    if (filters?.merchant?.trim()) {
      conditions.push(ilike(transactions.merchant, filters.merchant.trim()));
    }

    if (filters?.category) {
      conditions.push(eq(transactions.category, filters.category));
    }

    if (filters?.transactionClass) {
      conditions.push(eq(transactions.transactionClass, filters.transactionClass));
    }

    if (filters?.recurrenceType) {
      conditions.push(eq(transactions.recurrenceType, filters.recurrenceType));
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

  async getTransactions(userId: number, filters?: {
    flowType?: string;
    accountId?: number;
    search?: string;
    startDate?: string;
    merchant?: string;
    category?: string;
    transactionClass?: string;
    recurrenceType?: string;
  }): Promise<Transaction[]> {
    return db.select()
      .from(transactions)
      .where(this.buildTransactionWhere(userId, filters))
      .orderBy(desc(transactions.date), desc(transactions.id));
  }

  async getTransactionPage(userId: number, filters?: {
    flowType?: string;
    accountId?: number;
    search?: string;
    startDate?: string;
    merchant?: string;
    category?: string;
    transactionClass?: string;
    recurrenceType?: string;
    page?: number;
    pageSize?: number;
  }) {
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

    for (const transaction of existingTransactions) {
      if (transaction.userCorrected) {
        skipped += 1;
        continue;
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

      if (signedAmountResult.ambiguous) {
        ambiguous += 1;
      }

      await db.update(transactions)
        .set({
          amount: normalizedAmount.toFixed(2),
          flowType: flowTypeFromAmount(normalizedAmount),
          transactionClass: classification.transactionClass,
          recurrenceType: classification.recurrenceType,
          category: classification.category,
          merchant: classification.merchant,
          aiAssisted: classification.aiAssisted || signedAmountResult.ambiguous,
        })
        .where(eq(transactions.id, transaction.id));

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
