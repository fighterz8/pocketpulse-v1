/**
 * Classifier accuracy estimation — zero manual review required.
 *
 * The overall accuracy score is the average of four independent signals:
 *   1. Trust-weighted label score    (what % of transactions are "probably right")
 *   2. Merchant consistency rate     (same merchant → same category?)
 *   3. High-confidence rate          (how many have a confident classification?)
 *   4. Inverse correction rate       (1 - % manually corrected)
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "./db.js";
import { transactions } from "../shared/schema.js";
import { classifyTransaction } from "./classifier.js";

// ─── Types ────────────────────────────────────────────────────────────────────

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

export type AccuracyReport = {
  totalTransactions: number;
  labelSourceBreakdown: LabelSourceBreakdown;
  correctionRate: number;         // 0–1
  confidenceDistribution: ConfidenceDistribution;
  merchantConsistencyRate: number; // 0–1
  inconsistentMerchants: InconsistentMerchant[];
  staleAiRate: number;            // 0–1  (AI-labeled that rules would now override)
  staleAiCount: number;
  overallScore: number;           // 0–100 weighted composite
};

// ─── Per-label trust weights ──────────────────────────────────────────────────
// Used to compute the trust-weighted score (Metric 1 component of overall).
const TRUST: Record<string, number> = {
  manual:               1.00,
  propagated:           0.98,
  "recurring-transfer": 0.90,
  rule:                 0.90, // baseline; boosted by high confidence below
  ai:                   0.65, // baseline; boosted by high confidence below
};

// ─── Main function ────────────────────────────────────────────────────────────

export async function computeAccuracyReport(userId: number): Promise<AccuracyReport> {

  // ── 1. Label source breakdown + correction rate ───────────────────────────
  const sourceRows = await db
    .select({
      labelSource: transactions.labelSource,
      userCorrected: transactions.userCorrected,
      labelConfidence: transactions.labelConfidence,
      count: sql<string>`COUNT(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.excludedFromAnalysis, false),
      ),
    )
    .groupBy(transactions.labelSource, transactions.userCorrected, transactions.labelConfidence);

  // Aggregate into breakdown buckets
  let totalTransactions = 0;
  let manualCorrections = 0;
  let aiLabeledTotal = 0;

  const sourceCounts: LabelSourceBreakdown = {
    rule: 0, ai: 0, manual: 0, propagated: 0, recurringTransfer: 0, other: 0,
  };
  const conf: ConfidenceDistribution = { high: 0, medium: 0, low: 0, unknown: 0 };

  // We build the trust-weighted sum in a single pass
  let trustSum = 0;

  for (const row of sourceRows) {
    const n = Number(row.count);
    const src = row.labelSource ?? "other";
    const confVal = row.labelConfidence != null ? parseFloat(String(row.labelConfidence)) : null;

    totalTransactions += n;

    // Label source buckets
    if (src === "rule")                sourceCounts.rule += n;
    else if (src === "ai")             sourceCounts.ai += n;
    else if (src === "manual")         sourceCounts.manual += n;
    else if (src === "propagated")     sourceCounts.propagated += n;
    else if (src === "recurring-transfer") sourceCounts.recurringTransfer += n;
    else                               sourceCounts.other += n;

    // Correction rate numerator
    if (row.userCorrected) manualCorrections += n;

    // AI-labeled denominator (for correction rate denominator)
    if (src === "ai") aiLabeledTotal += n;

    // Confidence distribution
    if (confVal == null)       conf.unknown += n;
    else if (confVal >= 0.70)  conf.high += n;
    else if (confVal >= 0.50)  conf.medium += n;
    else                       conf.low += n;

    // Trust-weighted score contribution
    let trust = TRUST[src] ?? 0.65;
    if (src === "rule" && confVal != null && confVal >= 0.70) trust = 0.95;
    if (src === "rule" && confVal != null && confVal < 0.50)  trust = 0.78;
    if (src === "ai"   && confVal != null && confVal >= 0.70) trust = 0.78;
    if (src === "ai"   && confVal != null && confVal < 0.50)  trust = 0.48;
    // Manual corrections: were wrong once — don't reward them
    if (row.userCorrected) trust = Math.min(trust, 0.90);

    trustSum += trust * n;
  }

  const correctionRate = aiLabeledTotal > 0
    ? Math.min(1, manualCorrections / aiLabeledTotal)
    : 0;

  // ── 2. Merchant consistency ───────────────────────────────────────────────
  // Find merchants with ≥ 3 transactions that have more than one distinct category.
  const consistencyRows = await db
    .select({
      merchant: transactions.merchant,
      categories: sql<string[]>`array_agg(DISTINCT ${transactions.category})`,
      distinctCount: sql<number>`COUNT(DISTINCT ${transactions.category})`,
      occurrences: sql<number>`COUNT(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.excludedFromAnalysis, false),
        eq(transactions.flowType, "outflow"),
        ne(transactions.labelSource, "manual"),
        ne(transactions.merchant, ""),
      ),
    )
    .groupBy(transactions.merchant)
    .having(sql`COUNT(*) >= 3`)
    .orderBy(
      sql`COUNT(DISTINCT ${transactions.category}) DESC`,
      sql`COUNT(*) DESC`,
    )
    .limit(60);

  const inconsistentMerchants: InconsistentMerchant[] = consistencyRows
    .filter((r) => Number(r.distinctCount) > 1)
    .slice(0, 10)
    .map((r) => ({
      merchant: r.merchant,
      categories: r.categories,
      occurrences: Number(r.occurrences),
    }));

  const merchantConsistencyRate = consistencyRows.length > 0
    ? consistencyRows.filter((r) => Number(r.distinctCount) === 1).length /
      consistencyRows.length
    : 1.0;

  // ── 3. Stale AI classification check ─────────────────────────────────────
  // For AI-labeled transactions, re-run the rule-based classifier.
  // If the current rules would now assign a different category using a keyword
  // match (labelSource = 'rule'), the stored classification is stale.
  // Capped at 500 rows for performance.
  const aiRows = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      rawDescription: transactions.rawDescription,
      amount: transactions.amount,
      flowType: transactions.flowType,
      category: transactions.category,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.labelSource, "ai"),
        eq(transactions.excludedFromAnalysis, false),
        ne(transactions.userCorrected, true),
      ),
    )
    .limit(500);

  let staleCount = 0;
  for (const txn of aiRows) {
    let amount = parseFloat(String(txn.amount));
    // If stored as a positive outflow (unsigned CSV path), negate so the
    // classifier correctly identifies it as an expense.
    if (txn.flowType === "outflow" && amount > 0) amount = -amount;
    const result = classifyTransaction(
      txn.rawDescription || txn.merchant,
      amount,
    );
    // A stale label: a keyword rule now confidently overrides what AI stored.
    // aiAssisted=false means a rule matched without needing AI enrichment.
    if (
      !result.aiAssisted &&
      result.labelConfidence >= 0.65 &&
      result.category !== txn.category
    ) {
      staleCount++;
    }
  }

  const staleAiRate = aiRows.length > 0 ? staleCount / aiRows.length : 0;

  // ── 4. Overall score (0–100) ──────────────────────────────────────────────
  // Four components, equal weight:
  //   A. Trust-weighted label score
  //   B. High-confidence rate
  //   C. Merchant consistency rate
  //   D. Inverse correction rate
  const trustScore = totalTransactions > 0 ? trustSum / totalTransactions : 1;
  const highConfRate = totalTransactions > 0
    ? (conf.high + sourceCounts.manual + sourceCounts.propagated + sourceCounts.recurringTransfer) /
      totalTransactions
    : 1;
  const inverseCorrectionRate = 1 - Math.min(1, correctionRate);
  const stalePenalty = Math.max(0, 1 - staleAiRate * 0.5); // soft penalty

  const overallScore = Math.round(
    (trustScore * 0.35 +
      highConfRate * 0.20 +
      merchantConsistencyRate * 0.25 +
      inverseCorrectionRate * 0.15 +
      stalePenalty * 0.05) *
      100,
  );

  return {
    totalTransactions,
    labelSourceBreakdown: sourceCounts,
    correctionRate,
    confidenceDistribution: conf,
    merchantConsistencyRate,
    inconsistentMerchants,
    staleAiRate,
    staleAiCount: staleCount,
    overallScore: Math.min(100, Math.max(0, overallScore)),
  };
}
