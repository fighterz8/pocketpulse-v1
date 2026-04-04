/**
 * Accuracy report types shared between server (accuracyReport.ts) and
 * client (AccuracyReport.tsx). Placing them in shared/ avoids an invalid
 * cross-boundary import from client code into server code.
 */

export type LabelSourceBreakdown = {
  rule: number;
  ai: number;
  manual: number;
  propagated: number;
  recurringTransfer: number;
  other: number;
};

export type ConfidenceDistribution = {
  high: number;   // ≥ 0.70
  medium: number; // 0.50 – 0.69
  low: number;    // < 0.50
  unknown: number; // null
};

export type InconsistentMerchant = {
  merchant: string;
  categories: string[];
  occurrences: number;
};

/** Describes whether manual corrections impacted the score. */
export type CorrectionImpact =
  | "none"           // zero corrections
  | "keyword-fixes"  // corrections on rule-labeled rows (doesn't move correction-rate metric)
  | "low"            // correctionRate < 5 %   — minor AI misses
  | "moderate"       // correctionRate 5–15 %  — noticeable AI misses
  | "high";          // correctionRate > 15 %  — AI struggled on this bank's format

export type AccuracyReport = {
  totalTransactions: number;
  labelSourceBreakdown: LabelSourceBreakdown;
  correctionRate: number;           // 0–1  (AI-labeled rows manually overridden)
  manualCorrectionCount: number;    // raw total of userCorrected=true rows
  correctionImpact: CorrectionImpact;
  confidenceDistribution: ConfidenceDistribution;
  merchantConsistencyRate: number;  // 0–1
  inconsistentMerchants: InconsistentMerchant[];
  staleAiRate: number;              // 0–1
  staleAiCount: number;
  overallScore: number;             // 0–100 weighted composite
};
