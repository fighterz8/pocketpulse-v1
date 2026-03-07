import type { Express, Request, Response } from "express";
import { type Server } from "http";
import multer from "multer";
import { storage } from "./storage";
import { setupAuth, requireAuth } from "./auth";
import { parseCSV } from "./csvParser";
import { calculateCashflow, detectLeaks } from "./cashflow";
import { updateTransactionSchema, insertAccountSchema } from "@shared/schema";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
    
    const accountId = parseInt(req.body.accountId);
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
    const filters: { flowType?: string; accountId?: number } = {};
    if (req.query.flowType) filters.flowType = req.query.flowType as string;
    if (req.query.accountId) filters.accountId = parseInt(req.query.accountId as string);
    const txns = await storage.getTransactions(req.user!.id, filters);
    res.json(txns);
  });

  app.patch("/api/transactions/:id", requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id);
    const parsed = updateTransactionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid update data" });

    const updated = await storage.updateTransaction(id, req.user!.id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Transaction not found" });
    res.json(updated);
  });

  // ── Cashflow Summary ──────────────────────────────────
  app.get("/api/cashflow", requireAuth, async (req: Request, res: Response) => {
    const txns = await storage.getTransactions(req.user!.id);
    const summary = calculateCashflow(txns);
    res.json(summary);
  });

  // ── Leak Detection ────────────────────────────────────
  app.get("/api/leaks", requireAuth, async (req: Request, res: Response) => {
    const txns = await storage.getTransactions(req.user!.id);
    const leaks = detectLeaks(txns);
    res.json(leaks);
  });

  // ── CSV Export ─────────────────────────────────────────
  app.get("/api/export/summary", requireAuth, async (req: Request, res: Response) => {
    const txns = await storage.getTransactions(req.user!.id);
    const summary = calculateCashflow(txns);

    const csvRows = [
      "Metric,Value",
      `Total Inflows,$${summary.totalInflows}`,
      `Total Outflows,$${summary.totalOutflows}`,
      `Recurring Income,$${summary.recurringIncome}`,
      `Recurring Expenses,$${summary.recurringExpenses}`,
      `One-time Income,$${summary.oneTimeIncome}`,
      `One-time Expenses,$${summary.oneTimeExpenses}`,
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
      "Date,Merchant,Amount,Type,Class,Recurrence,Raw Description",
      ...txns.map(tx =>
        `${tx.date},"${tx.merchant}",${tx.amount},${tx.flowType},${tx.transactionClass},${tx.recurrenceType},"${tx.rawDescription.replace(/"/g, '""')}"`
      ),
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=transactions-export.csv");
    res.send(csvRows.join("\n"));
  });

  return httpServer;
}
