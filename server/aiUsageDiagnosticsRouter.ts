import { Router } from "express";

import { parseAiUsageReportFilters } from "./aiUsageDiagnostics.js";
import { getAiUsageReport } from "./aiUsageQueries.js";
import { requireDev } from "./devTestSuite.js";

export function createAiUsageDiagnosticsRouter() {
  const router = Router();
  router.use(requireDev);
  router.get("/ai-usage/summary", async (req, res, next) => {
    try {
      const filters = parseAiUsageReportFilters(req.query);
      res.json(await getAiUsageReport(filters));
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });
  return router;
}
