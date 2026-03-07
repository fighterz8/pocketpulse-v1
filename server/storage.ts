import { eq, and, desc } from "drizzle-orm";
import { db } from "./db";
import {
  users, accounts, uploads, transactions,
  type User, type InsertUser,
  type Account, type InsertAccount,
  type Upload,
  type Transaction, type InsertTransaction, type UpdateTransaction,
} from "@shared/schema";

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
  getTransactions(userId: number, filters?: { flowType?: string; accountId?: number }): Promise<Transaction[]>;
  getTransaction(id: number, userId: number): Promise<Transaction | undefined>;
  updateTransaction(id: number, userId: number, data: UpdateTransaction): Promise<Transaction | undefined>;
}

export class DatabaseStorage implements IStorage {
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

  async getTransactions(userId: number, filters?: { flowType?: string; accountId?: number }): Promise<Transaction[]> {
    let query = db.select().from(transactions).where(eq(transactions.userId, userId)).orderBy(desc(transactions.date));

    if (filters?.flowType) {
      query = db.select().from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.flowType, filters.flowType)))
        .orderBy(desc(transactions.date));
    }
    if (filters?.accountId) {
      query = db.select().from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.accountId, filters.accountId)))
        .orderBy(desc(transactions.date));
    }

    return query;
  }

  async getTransaction(id: number, userId: number): Promise<Transaction | undefined> {
    const [tx] = await db.select().from(transactions).where(
      and(eq(transactions.id, id), eq(transactions.userId, userId))
    );
    return tx;
  }

  async updateTransaction(id: number, userId: number, data: UpdateTransaction): Promise<Transaction | undefined> {
    const [updated] = await db.update(transactions)
      .set({ ...data, userCorrected: true })
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .returning();
    return updated;
  }
}

export const storage = new DatabaseStorage();
