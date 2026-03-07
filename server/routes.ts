import type { Express, Request, Response } from "express";
import { type Server } from "http";
import multer from "multer";
import { storage } from "./storage";
import { setupAuth, requireAuth } from "./auth";
import { parseCSV } from "./csvParser";
import { calculateCashflow, detectLeaks } from "./cashflow";
import { updateTransactionSchema, insertAccountSchema } from "@shared/schema";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function parseWindowDays(value: unknown): number {
  const parsed = parseInt(String(value ?? "90"), 10);
  if (![30, 60, 90].includes(parsed)) {
    return 90;
  }

  return parsed;
}

function getWindowStartDate(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupAuth(app);

  // ── Accounts ──────────────────────────────────────────
  app.get("/api/accounts", requireAuth, async (req: Request, res: Response) => {
    const accounts = await storage.getAccounts(req.user!.id);
    res.json(accounts);
  });

  app.post("/api/accounts", requireAuth, async (req: Request, res: Response) => {
    const parsed = insertAccountSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid account data" });
    const account = await storage.createAccount(req.user!.id, parsed.data);
    res.status(201).json(account);
  });

  // ── CSV Upload ────────────────────────────────────────
  app.post("/api/upload", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    
    const accountId = parseInt(String(req.body.accountId), 10);
    if (!accountId) return res.status(400).json({ message: "Account ID is required" });

    const account = await storage.getAccount(accountId, req.user!.id);
    if (!account) return res.status(404).json({ message: "Account not found" });

    try {
      const csvContent = req.file.buffer.toString("utf-8");
      const uploadRecord = await storage.createUpload(req.user!.id, accountId, req.file.originalname, 0);
      const txns = parseCSV(csvContent, req.user!.id, accountId, uploadRecord.id);
      const created = await storage.createTransactions(txns);

      res.status(201).json({
        uploadId: uploadRecord.id,
        filename: req.file.originalname,
        transactionCount: created.length,
      });
    } catch (err: any) {
      res.status(422).json({ message: err.message });
    }
  });

  app.get("/api/uploads", requireAuth, async (req: Request, res: Response) => {
    const uploads = await storage.getUploads(req.user!.id);
    res.json(uploads);
  });

  // ── Transactions ──────────────────────────────────────
  app.get("/api/transactions", requireAuth, async (req: Request, res: Response) => {
    const filters: {
      flowType?: string;
      accountId?: number;
      search?: string;
      merchant?: string;
      category?: string;
      transactionClass?: string;
      recurrenceType?: string;
      startDate?: string;
    } = {};
    if (req.query.flowType) filters.flowType = req.query.flowType as string;
    if (req.query.accountId) filters.accountId = parseInt(String(req.query.accountId), 10);
    if (req.query.search) filters.search = req.query.search as string;
    if (req.query.merchant) filters.merchant = req.query.merchant as string;
    if (req.query.category) filters.category = req.query.category as string;
    if (req.query.transactionClass) filters.transactionClass = req.query.transactionClass as string;
    if (req.query.recurrenceType) filters.recurrenceType = req.query.recurrenceType as string;
    if (req.query.days) filters.startDate = getWindowStartDate(parseWindowDays(req.query.days));
    if (req.query.startDate) filters.startDate = String(req.query.startDate);

    const page = parseInt(String(req.query.page ?? ""), 10) || 1;
    const pageSize = parseInt(String(req.query.pageSize ?? ""), 10) || 50;
    const txns = await storage.getTransactionPage(req.user!.id, {
      ...filters,
      page,
      pageSize,
    });
    res.json(txns);
  });

  app.patch("/api/transactions/:id", requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const parsed = updateTransactionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid update data" });

    const updated = await storage.updateTransaction(id, req.user!.id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Transaction not found" });
    res.json(updated);
  });

  app.post("/api/transactions/reprocess", requireAuth, async (req: Request, res: Response) => {
    const result = await storage.reprocessTransactions(req.user!.id);
    res.json(result);
  });

  app.delete("/api/transactions", requireAuth, async (req: Request, res: Response) => {
    const result = await storage.wipeImportedData(req.user!.id);
    res.json(result);
  });

  app.delete("/api/workspace-data", requireAuth, async (req: Request, res: Response) => {
    const result = await storage.wipeWorkspaceData(req.user!.id);
    res.json(result);
  });

  // ── Cashflow Summary ──────────────────────────────────
  app.get("/api/cashflow", requireAuth, async (req: Request, res: Response) => {
    const days = parseWindowDays(req.query.days);
    const txns = await storage.getTransactions(req.user!.id, {
      startDate: getWindowStartDate(days),
    });
    const summary = calculateCashflow(txns, { windowDays: days });
    res.json(summary);
  });

  // ── Leak Detection ────────────────────────────────────
  app.get("/api/leaks", requireAuth, async (req: Request, res: Response) => {
    const days = req.query.days ? parseWindowDays(req.query.days) : undefined;
    const txns = await storage.getTransactions(req.user!.id, days ? {
      startDate: getWindowStartDate(days),
    } : undefined);
    const leaks = detectLeaks(txns);
    res.json(leaks);
  });

  // ── CSV Export ─────────────────────────────────────────
  app.get("/api/export/summary", requireAuth, async (req: Request, res: Response) => {
    const days = parseWindowDays(req.query.days);
    const txns = await storage.getTransactions(req.user!.id, {
      startDate: getWindowStartDate(days),
    });
    const summary = calculateCashflow(txns, { windowDays: days });

    const csvRows = [
      "Metric,Value",
      `Window,${days} days`,
      `Total Inflows,$${summary.totalInflows}`,
      `Total Outflows,$${summary.totalOutflows}`,
      `Recurring Income,$${summary.recurringIncome}`,
      `Recurring Expenses,$${summary.recurringExpenses}`,
      `One-time Income,$${summary.oneTimeIncome}`,
      `One-time Expenses,$${summary.oneTimeExpenses}`,
      `Utilities Baseline,$${summary.utilitiesBaseline}`,
      `Subscriptions Baseline,$${summary.subscriptionsBaseline}`,
      `Discretionary Spend,$${summary.discretionarySpend}`,
      `Safe to Spend,$${summary.safeToSpend}`,
      `Net Cashflow,$${summary.netCashflow}`,
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=cashflow-summary.csv");
    res.send(csvRows.join("\n"));
  });

  app.get("/api/export/transactions", requireAuth, async (req: Request, res: Response) => {
    const txns = await storage.getTransactions(req.user!.id);

    const csvRows = [
      "Date,Merchant,Amount,Type,Class,Recurrence,Category,Raw Description",
      ...txns.map(tx =>
        `${tx.date},"${tx.merchant}",${tx.amount},${tx.flowType},${tx.transactionClass},${tx.recurrenceType},${tx.category},"${tx.rawDescription.replace(/"/g, '""')}"`
      ),
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=transactions-export.csv");
    res.send(csvRows.join("\n"));
  });

  return httpServer;
}
