import type { Express, Request, Response } from "express";
import { type Server } from "http";
import multer from "multer";
import { storage } from "./storage";
import { setupAuth, requireAuth } from "./auth";
import { parseCSV } from "./csvParser";
import {
  buildCashflowAnalysis,
  calculateCashflow,
  detectLeaks,
  getDashboardMetricDefinition,
  getDashboardMetricTransactions,
  getDashboardMetricValue,
  type DashboardMetric,
} from "./cashflow";
import { updateTransactionSchema, insertAccountSchema } from "@shared/schema";
import { resolveDateRange } from "./dateRanges";
import { maybeApplyLlmLabels } from "./llmLabeler";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const CSV_MIME_TYPES = new Set(["text/csv", "application/vnd.ms-excel", "application/csv", "text/plain"]);

function toCsvCell(value: unknown): string {
  const raw = String(value ?? "").replace(/\r?\n/g, " ").trim();
  const neutralized = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function hasRangeQuery(query: Request["query"]): boolean {
  return ["days", "preset", "startDate", "endDate", "year"].some((key) => query[key] !== undefined);
}

function getResolvedRange(query: Request["query"], fallbackToRecent = false) {
  if (!fallbackToRecent && !hasRangeQuery(query)) {
    return undefined;
  }

  return resolveDateRange({
    days: query.days,
    preset: query.preset,
    startDate: query.startDate,
    endDate: query.endDate,
    year: query.year,
  });
}

function parseDashboardMetric(value: unknown): DashboardMetric | undefined {
  const metric = String(value ?? "");
  const allowedMetrics: DashboardMetric[] = [
    "totalInflows",
    "totalOutflows",
    "recurringIncome",
    "recurringExpenses",
    "oneTimeIncome",
    "oneTimeExpenses",
    "safeToSpend",
    "netCashflow",
    "utilitiesBaseline",
    "subscriptionsBaseline",
    "discretionarySpend",
  ];
  return allowedMetrics.includes(metric as DashboardMetric) ? (metric as DashboardMetric) : undefined;
}

function buildTransactionFilters(query: Request["query"], options: { fallbackToRecent?: boolean } = {}) {
  const filters: {
    flowType?: string;
    accountId?: number;
    search?: string;
    merchant?: string;
    category?: string;
    transactionClass?: string;
    recurrenceType?: string;
    startDate?: string;
    endDate?: string;
  } = {};

  if (query.flowType) filters.flowType = query.flowType as string;
  if (query.accountId) filters.accountId = parseInt(String(query.accountId), 10);
  if (query.search) filters.search = query.search as string;
  if (query.merchant) filters.merchant = query.merchant as string;
  if (query.category) filters.category = query.category as string;
  if (query.transactionClass) filters.transactionClass = query.transactionClass as string;
  if (query.recurrenceType) filters.recurrenceType = query.recurrenceType as string;

  const range = getResolvedRange(query, options.fallbackToRecent);
  if (range) {
    filters.startDate = range.startDate;
    filters.endDate = range.endDate;
  }

  return { filters, range, metric: parseDashboardMetric(query.metric) };
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

    const originalName = String(req.file.originalname || "").trim();
    const lowerName = originalName.toLowerCase();
    if (!lowerName.endsWith(".csv")) {
      return res.status(400).json({ message: "Upload a CSV file." });
    }

    if (req.file.mimetype && !CSV_MIME_TYPES.has(req.file.mimetype)) {
      return res.status(400).json({ message: "Unsupported file type. Upload a CSV export." });
    }

    const account = await storage.getAccount(accountId, req.user!.id);
    if (!account) return res.status(404).json({ message: "Account not found" });

    try {
      const csvContent = req.file.buffer.toString("utf-8");
      const uploadRecord = await storage.createUpload(req.user!.id, accountId, originalName, 0);
      const parsedTransactions = parseCSV(csvContent, req.user!.id, accountId, uploadRecord.id);
      const enrichedLabels = await maybeApplyLlmLabels(parsedTransactions.map((transaction) => ({
        rawDescription: transaction.rawDescription,
        amount: parseFloat(String(transaction.amount)),
        transactionClass: transaction.transactionClass as "income" | "expense" | "transfer" | "refund",
        recurrenceType: transaction.recurrenceType as "recurring" | "one-time",
        category: (transaction.category ?? "other") as
          | "income"
          | "transfers"
          | "utilities"
          | "subscriptions"
          | "insurance"
          | "housing"
          | "groceries"
          | "transportation"
          | "dining"
          | "shopping"
          | "health"
          | "debt"
          | "business_software"
          | "entertainment"
          | "fees"
          | "other",
        aiAssisted: Boolean(transaction.aiAssisted),
        labelSource: (transaction.labelSource ?? "rule") as "rule" | "llm" | "manual",
        labelConfidence: transaction.labelConfidence ?? null,
        labelReason: transaction.labelReason ?? null,
      })));
      const txns = parsedTransactions.map((transaction, index) => {
        const decision = enrichedLabels[index];
        return {
          ...transaction,
          transactionClass: decision.transactionClass,
          recurrenceType: decision.recurrenceType,
          category: decision.category,
          labelSource: decision.labelSource,
          labelConfidence: decision.labelConfidence,
          labelReason: decision.labelReason,
          aiAssisted: decision.aiAssisted,
        };
      });
      const created = await storage.createTransactions(txns);

      res.status(201).json({
        uploadId: uploadRecord.id,
        filename: originalName,
        transactionCount: created.length,
      });
    } catch {
      res.status(422).json({ message: "The CSV could not be processed. Please verify the format and try again." });
    }
  });

  app.get("/api/uploads", requireAuth, async (req: Request, res: Response) => {
    const uploads = await storage.getUploads(req.user!.id);
    res.json(uploads);
  });

  // ── Transactions ──────────────────────────────────────
  app.get("/api/transactions", requireAuth, async (req: Request, res: Response) => {
    const { filters, range, metric } = buildTransactionFilters(req.query);
    const page = parseInt(String(req.query.page ?? ""), 10) || 1;
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize ?? ""), 10) || 50, 1), 100);
    if (!metric) {
      const txns = await storage.getTransactionPage(req.user!.id, {
        ...filters,
        page,
        pageSize,
      });
      return res.json(txns);
    }

    const sourceRows = await storage.getTransactions(req.user!.id, filters);
    const metricRows = getDashboardMetricTransactions(sourceRows, metric);
    const totalCount = metricRows.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const currentPage = Math.min(Math.max(page, 1), totalPages);
    const offset = (currentPage - 1) * pageSize;
    const rows = metricRows.slice(offset, offset + pageSize);
    const metricDefinition = getDashboardMetricDefinition(metric);

    return res.json({
      rows,
      totalCount,
      page: currentPage,
      pageSize,
      totalPages,
      metric,
      metricLabel: metricDefinition.label,
      metricDescription: metricDefinition.description,
      metricTotal: getDashboardMetricValue(metricRows, metric, { rangeDays: range?.rangeDays }),
    });
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
    const { filters, range } = buildTransactionFilters(req.query, { fallbackToRecent: true });
    const txns = await storage.getTransactions(req.user!.id, filters);
    const summary = calculateCashflow(txns, { rangeDays: range?.rangeDays });
    res.json({ ...summary, range });
  });

  // ── Leak Detection ────────────────────────────────────
  app.get("/api/leaks", requireAuth, async (req: Request, res: Response) => {
    const { filters, range } = buildTransactionFilters(req.query, { fallbackToRecent: true });
    const txns = await storage.getTransactions(req.user!.id, filters);
    const leaks = detectLeaks(txns, { rangeDays: range?.rangeDays });
    res.json(leaks);
  });

  app.get("/api/analysis", requireAuth, async (req: Request, res: Response) => {
    const range = getResolvedRange(req.query, true)!;
    const [currentTransactions, previousTransactions] = await Promise.all([
      storage.getTransactions(req.user!.id, {
        startDate: range.startDate,
        endDate: range.endDate,
      }),
      storage.getTransactions(req.user!.id, {
        startDate: range.previousStartDate,
        endDate: range.previousEndDate,
      }),
    ]);

    const analysis = buildCashflowAnalysis(currentTransactions, previousTransactions, {
      rangeDays: range.rangeDays,
    });

    res.json({
      range,
      analysis,
      currentTransactionCount: currentTransactions.length,
      previousTransactionCount: previousTransactions.length,
    });
  });

  // ── CSV Export ─────────────────────────────────────────
  app.get("/api/export/summary", requireAuth, async (req: Request, res: Response) => {
    const { filters, range } = buildTransactionFilters(req.query, { fallbackToRecent: true });
    const txns = await storage.getTransactions(req.user!.id, filters);
    const summary = calculateCashflow(txns, { rangeDays: range?.rangeDays });

    const csvRows = [
      "Metric,Value",
      `Window,${range?.label ?? "Custom range"}`,
      `Start Date,${range?.startDate ?? ""}`,
      `End Date,${range?.endDate ?? ""}`,
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
    const { filters, range, metric } = buildTransactionFilters(req.query);
    const sourceRows = await storage.getTransactions(req.user!.id, filters);
    const txns = metric ? getDashboardMetricTransactions(sourceRows, metric) : sourceRows;
    const metricDefinition = metric ? getDashboardMetricDefinition(metric) : undefined;
    const metricTotal = metric ? getDashboardMetricValue(txns, metric, { rangeDays: range?.rangeDays }) : undefined;

    const csvRows = [
      `${toCsvCell("Window")},${toCsvCell(range?.label ?? "All transactions")}`,
      ...(metricDefinition
        ? [`${toCsvCell("Metric")},${toCsvCell(metricDefinition.label)}`, `${toCsvCell("Metric Total")},${toCsvCell(`$${metricTotal}`)}`]
        : []),
      "Date,Merchant,Amount,Type,Class,Recurrence,Category,Label Source,Label Confidence,Label Reason,Raw Description",
      ...txns.map(tx =>
        [
          toCsvCell(tx.date),
          toCsvCell(tx.merchant),
          tx.amount,
          toCsvCell(tx.flowType),
          toCsvCell(tx.transactionClass),
          toCsvCell(tx.recurrenceType),
          toCsvCell(tx.category),
          toCsvCell(tx.labelSource),
          toCsvCell(tx.labelConfidence ?? ""),
          toCsvCell(tx.labelReason ?? ""),
          toCsvCell(tx.rawDescription),
        ].join(",")
      ),
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=transactions-export.csv");
    res.send(csvRows.join("\n"));
  });

  return httpServer;
}
