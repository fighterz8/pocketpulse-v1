#!/usr/bin/env npx tsx
/**
 * PocketPulse — Classifier Accuracy Report
 * =========================================
 * Dev/research tool. Computes accuracy metrics for all users (or a specific
 * user) without any manual transaction review.
 *
 * Usage:
 *   npx tsx scripts/accuracy-report.ts                # all users
 *   npx tsx scripts/accuracy-report.ts --user-id=3   # specific user
 *   npx tsx scripts/accuracy-report.ts --json         # machine-readable output
 *   npx tsx scripts/accuracy-report.ts --user-id=3 --json
 *
 * The DATABASE_URL env var must be set (same as the server).
 */

import { db, pool } from "../server/db.js";
import { computeAccuracyReport } from "../server/accuracyReport.js";
import { users } from "../shared/schema.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const userIdArg = args.find((a) => a.startsWith("--user-id="));
const singleUserId = userIdArg ? parseInt(userIdArg.split("=")[1]!, 10) : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bar(rate: number, width = 20): string {
  const filled = Math.round(rate * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pct(n: number, decimals = 1): string {
  return (n * 100).toFixed(decimals) + "%";
}

function scoreLabel(n: number): string {
  if (n >= 80) return "GOOD";
  if (n >= 60) return "FAIR";
  return "NEEDS WORK";
}

function hr(char = "─", width = 60): string {
  return char.repeat(width);
}

function printReport(userId: number, email: string, report: Awaited<ReturnType<typeof computeAccuracyReport>>) {
  const { labelSourceBreakdown: ls, confidenceDistribution: cd } = report;
  const lsTotal = ls.rule + ls.ai + ls.manual + ls.propagated + ls.recurringTransfer + ls.other;
  const cdTotal = cd.high + cd.medium + cd.low + cd.unknown;

  console.log();
  console.log(hr("═"));
  console.log(`  USER ${userId}: ${email}`);
  console.log(hr("═"));
  console.log(`  Transactions analysed : ${report.totalTransactions.toLocaleString()}`);
  console.log(`  Overall accuracy score: ${report.overallScore}/100  [${scoreLabel(report.overallScore)}]`);
  console.log();

  console.log(hr());
  console.log("  LABEL SOURCE BREAKDOWN");
  console.log(hr());
  const srcRows: [string, number][] = [
    ["Keyword rule",       ls.rule],
    ["AI classified",      ls.ai],
    ["User-corrected",     ls.manual],
    ["Propagated",         ls.propagated],
    ["Recurring transfer", ls.recurringTransfer],
  ];
  for (const [label, n] of srcRows) {
    const rate = lsTotal > 0 ? n / lsTotal : 0;
    console.log(`  ${label.padEnd(22)} ${bar(rate)} ${pct(rate).padStart(6)}  (${n.toLocaleString()})`);
  }
  console.log();

  console.log(hr());
  console.log("  CONFIDENCE DISTRIBUTION");
  console.log(hr());
  const confRows: [string, number][] = [
    ["High  (≥ 70%)", cd.high],
    ["Med   (50–69%)", cd.medium],
    ["Low   (< 50%)", cd.low],
    ["No score", cd.unknown],
  ];
  for (const [label, n] of confRows) {
    const rate = cdTotal > 0 ? n / cdTotal : 0;
    console.log(`  ${label.padEnd(22)} ${bar(rate)} ${pct(rate).padStart(6)}  (${n.toLocaleString()})`);
  }
  console.log();

  console.log(hr());
  console.log("  KEY METRICS");
  console.log(hr());
  console.log(`  Merchant consistency rate : ${pct(report.merchantConsistencyRate)}  (same merchant → same category)`);
  console.log(`  User correction rate      : ${pct(report.correctionRate)}  (AI labels manually overridden)`);
  console.log(`  Stale AI labels           : ${report.staleAiCount.toLocaleString()} / sampled AI rows  (${pct(report.staleAiRate)} — rules now override)`);
  console.log();

  if (report.inconsistentMerchants.length > 0) {
    console.log(hr());
    console.log("  INCONSISTENTLY CLASSIFIED MERCHANTS  (same merchant, different categories)");
    console.log(hr());
    for (const m of report.inconsistentMerchants) {
      const cats = m.categories.join(", ");
      console.log(`  ${m.merchant.padEnd(30)} [${cats}]  (${m.occurrences} txns)`);
    }
    console.log();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Fetch target users
  const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
  const targets = singleUserId
    ? allUsers.filter((u) => u.id === singleUserId)
    : allUsers;

  if (targets.length === 0) {
    console.error(singleUserId
      ? `No user found with id=${singleUserId}`
      : "No users in the database.");
    process.exit(1);
  }

  // Run reports
  const results: Array<{ userId: number; email: string; report: Awaited<ReturnType<typeof computeAccuracyReport>> }> = [];

  for (const u of targets) {
    process.stderr.write(`Computing report for user ${u.id} (${u.email})…\n`);
    const report = await computeAccuracyReport(u.id);
    results.push({ userId: u.id, email: u.email, report });
  }

  if (jsonMode) {
    // Machine-readable output — everything in one JSON blob
    console.log(JSON.stringify(
      results.map(({ userId, email, report }) => ({ userId, email, ...report })),
      null,
      2,
    ));
  } else {
    // Human-readable output
    console.log();
    console.log("PocketPulse — Classifier Accuracy Report");
    console.log(`Generated: ${new Date().toISOString()}`);
    for (const { userId, email, report } of results) {
      printReport(userId, email, report);
    }

    if (results.length > 1) {
      // Aggregate across all users
      const avg = (fn: (r: typeof results[0]["report"]) => number) =>
        results.reduce((s, { report }) => s + fn(report), 0) / results.length;
      console.log(hr("═"));
      console.log("  AGGREGATE (all users)");
      console.log(hr("═"));
      console.log(`  Avg overall score        : ${avg((r) => r.overallScore).toFixed(1)}/100`);
      console.log(`  Avg merchant consistency : ${pct(avg((r) => r.merchantConsistencyRate))}`);
      console.log(`  Avg correction rate      : ${pct(avg((r) => r.correctionRate))}`);
      console.log(`  Avg stale AI rate        : ${pct(avg((r) => r.staleAiRate))}`);
      console.log(`  Total transactions       : ${results.reduce((s, { report }) => s + report.totalTransactions, 0).toLocaleString()}`);
      console.log();
    }
  }
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(() => void pool.end());
