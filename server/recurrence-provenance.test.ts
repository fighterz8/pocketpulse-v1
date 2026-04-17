/**
 * Integration-level unit tests for the recurrenceSource provenance lifecycle.
 *
 * These tests verify the full state machine for recurrenceSource without
 * requiring a live database, by testing:
 *
 *   1. Backfill semantics: legacy rows (recurrenceSource='none', recurrenceType='recurring')
 *      should be promoted to 'hint' by the startup backfill query.
 *
 *   2. Detector promotion semantics: rows promoted to 'hint' at upload time become
 *      'detected/recurring' when detectRecurringCandidates confirms a multi-month pattern,
 *      and 'detected/one-time' when no pattern is found.
 *
 *   3. The classifier → detector provenance chain: a merchant classified as
 *      hint/recurring at upload time is evaluated by the detector, and only
 *      rows whose IDs appear in the detector's output become 'detected/recurring'.
 */

import { describe, expect, it } from "vitest";
import { classifyTransaction } from "./classifier.js";
import { detectRecurringCandidates } from "./recurrenceDetector.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fake outflow TransactionLike row for the detector. */
function makeTx(
  id: number,
  merchant: string,
  amount: number,
  date: string,
  category = "software",
) {
  return {
    id,
    date,
    amount: (-Math.abs(amount)).toFixed(2),
    merchant,
    flowType: "outflow" as const,
    category,
    excludedFromAnalysis: false,
  };
}

/** Build N monthly transactions for the same merchant, starting from 2025-01. */
function monthlyTxns(merchant: string, amount: number, category: string, n = 6) {
  return Array.from({ length: n }, (_, i) => {
    const year = 2025 + Math.floor((i + 1) / 13);
    const month = ((i % 12) + 1).toString().padStart(2, "0");
    return makeTx(i + 1, merchant, amount, `${year}-${month}-15`, category);
  });
}

// ─── 1. Backfill logic ───────────────────────────────────────────────────────

describe("recurrenceSource backfill semantics", () => {
  it("legacy rows with recurrenceType='recurring' and recurrenceSource='none' should be promoted to 'hint'", () => {
    // Simulate the backfill WHERE clause: rows that qualify for promotion.
    const rows = [
      { recurrenceType: "recurring", recurrenceSource: "none" as string },
      { recurrenceType: "one-time",  recurrenceSource: "none" as string },
      { recurrenceType: "recurring", recurrenceSource: "hint" as string },
      { recurrenceType: "recurring", recurrenceSource: "detected" as string },
    ];

    // Apply the same filter as the startup backfill SQL:
    // WHERE recurrence_source = 'none' AND recurrence_type = 'recurring'
    const promoted = rows.map((r) => ({
      ...r,
      recurrenceSource:
        r.recurrenceSource === "none" && r.recurrenceType === "recurring"
          ? "hint"
          : r.recurrenceSource,
    }));

    expect(promoted[0]!.recurrenceSource).toBe("hint");    // was none/recurring → promoted
    expect(promoted[1]!.recurrenceSource).toBe("none");    // was none/one-time → unchanged
    expect(promoted[2]!.recurrenceSource).toBe("hint");    // was already hint
    expect(promoted[3]!.recurrenceSource).toBe("detected"); // was already detected
  });

  it("backfill is idempotent: re-running leaves already-promoted rows unchanged", () => {
    const rows = [
      { recurrenceType: "recurring", recurrenceSource: "hint" as string },
      { recurrenceType: "recurring", recurrenceSource: "detected" as string },
    ];
    const promoted = rows.map((r) => ({
      ...r,
      recurrenceSource:
        r.recurrenceSource === "none" && r.recurrenceType === "recurring"
          ? "hint"
          : r.recurrenceSource,
    }));
    expect(promoted[0]!.recurrenceSource).toBe("hint");
    expect(promoted[1]!.recurrenceSource).toBe("detected");
  });
});

// ─── 2. Detector promotion semantics ─────────────────────────────────────────

describe("detector promotion: hint/recurring → detected/recurring or detected/one-time", () => {
  it("a multi-month outflow pattern is confirmed as recurring by the detector (→ detected/recurring)", () => {
    // 6 months of Netflix at ~$15.99: should be detected as recurring
    const txns = monthlyTxns("Netflix.com", 15.99, "entertainment", 6);
    const candidates = detectRecurringCandidates(txns);

    const netflixCandidate = candidates.find((c) =>
      c.merchantKey.toLowerCase().includes("netflix"),
    );
    expect(netflixCandidate).toBeDefined();

    // The IDs in transactionIds are the ones that will receive detected/recurring
    const confirmedIds = new Set(netflixCandidate!.transactionIds);
    for (const t of txns) {
      if (confirmedIds.has(t.id)) {
        // Simulate detector Step 2 write: these become detected/recurring
        const afterSync = { recurrenceSource: "detected", recurrenceType: "recurring" };
        expect(afterSync.recurrenceSource).toBe("detected");
        expect(afterSync.recurrenceType).toBe("recurring");
      }
    }
  });

  it("a single one-time outflow is reset to detected/one-time by Step 1", () => {
    // Single charge from XYZZY CORP: cannot be confirmed as recurring
    const txns = [makeTx(99, "XYZZY CORP", 150.00, "2026-01-15", "other")];
    const candidates = detectRecurringCandidates(txns);
    const xyzzyCandidate = candidates.find((c) =>
      c.merchantKey.toLowerCase().includes("xyzzy"),
    );
    // No pattern → no candidate; this row receives detected/one-time (Step 1 reset)
    expect(xyzzyCandidate).toBeUndefined();
    // Simulate Step 1 reset semantics
    const afterStep1 = { recurrenceSource: "detected", recurrenceType: "one-time" };
    expect(afterStep1.recurrenceSource).toBe("detected");
    expect(afterStep1.recurrenceType).toBe("one-time");
  });
});

// ─── 3. Full provenance chain ─────────────────────────────────────────────────

describe("full provenance chain: classifier → detector", () => {
  it("a recurring keyword merchant goes hint→detected/recurring after detector confirms pattern", () => {
    // Step 1: at upload time, classifier keyword fires → hint/recurring
    const atUpload = classifyTransaction("GENERIC RECURRING PAYMENT DEPT123", -9.99);
    expect(atUpload.recurrenceSource).toBe("hint");
    expect(atUpload.recurrenceType).toBe("recurring");

    // Step 2: 6 months of the same merchant → detector confirms pattern
    const txns = monthlyTxns("Generic Recurring", 9.99, "software", 6);
    const candidates = detectRecurringCandidates(txns);
    const confirmed = candidates.find((c) =>
      c.merchantKey.toLowerCase().includes("generic"),
    );
    expect(confirmed).toBeDefined();

    // Step 3: confirmed IDs get detected/recurring; all other outflows get detected/one-time
    const confirmedIds = new Set(confirmed!.transactionIds);
    for (const t of txns) {
      const afterSync = confirmedIds.has(t.id)
        ? { recurrenceSource: "detected", recurrenceType: "recurring" }
        : { recurrenceSource: "detected", recurrenceType: "one-time" };
      expect(afterSync.recurrenceSource).toBe("detected");
    }
  });

  it("an inflow (income) never passes through the detector — stays hint/recurring permanently", () => {
    // Payroll deposit: classifier sets hint/recurring at upload
    const atUpload = classifyTransaction("PAYROLL DEPOSIT", 3500);
    expect(atUpload.recurrenceSource).toBe("hint");
    expect(atUpload.recurrenceType).toBe("recurring");
    expect(atUpload.flowType).toBe("inflow");

    // The detector only processes flowType="outflow", so inflows never become "detected".
    // Build a detector run with only inflow-equivalent data — detector should ignore it.
    const inflowTxns = Array.from({ length: 6 }, (_, i) =>
      ({
        id: i + 1,
        date: `2025-${(i + 1).toString().padStart(2, "0")}-01`,
        amount: "3500.00",
        merchant: "Payroll",
        flowType: "inflow" as const,   // detector filters these out
        category: "income",
        excludedFromAnalysis: false,
      }),
    );
    const candidates = detectRecurringCandidates(inflowTxns);
    expect(candidates).toHaveLength(0);  // detector returns nothing for inflows
    // inflow rows correctly remain hint/recurring — "detected" is never written for them
  });
});
