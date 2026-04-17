/**
 * Integration tests for classifyPipeline — exercises all four resolution steps:
 *   1. Per-user rule match  (merchant_rules)
 *   2. Per-user cache hit   (merchant_classifications) — overrides structural matches
 *   3. Global seed hit      (merchant_classifications_global)
 *   4. Structural keyword   (classifier.ts CATEGORY_RULES)
 *   5. AI fallback          (graceful timeout / error handling)
 *
 * These tests use the real DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import {
  merchantClassifications,
  merchantClassificationsGlobal,
  users,
} from "../shared/schema.js";
import { eq, inArray } from "drizzle-orm";
import {
  classifyPipeline,
  type PipelineOptions,
  type PipelineRow,
} from "./classifyPipeline.js";
import { normalizeMerchant } from "./transactionUtils.js";
import { recurrenceKey } from "./recurrenceDetector.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_EMAIL = `pipeline-test-${Date.now()}@test.internal`;
let testUserId: number;

/**
 * Compute the merchantKey the pipeline will actually look up.
 * Must match exactly what classifyPipeline does internally (Phase 1.7 / 1.8).
 */
function toMerchantKey(rawDescription: string): string {
  return recurrenceKey(normalizeMerchant(rawDescription));
}

/** Options that skip AI (threshold impossibly high = 1.5 so no row reaches AI). */
function noAiOpts(): PipelineOptions {
  return {
    userId: testUserId,
    aiTimeoutMs: 100,
    aiConfidenceThreshold: 1.5,
    cacheWriteMinConfidence: 0.7,
  };
}

/** Production-like options that allow AI but with a very short timeout (1 ms). */
function aiOpts(): PipelineOptions {
  return {
    userId: testUserId,
    aiTimeoutMs: 1,
    aiConfidenceThreshold: 0.5,
    cacheWriteMinConfidence: 0.7,
  };
}

function row(rawDescription: string, amount: number): PipelineRow {
  return { rawDescription, amount };
}

const seededGlobalKeys: string[] = [];

async function seedPerUser(merchantKey: string, category: string) {
  await db.insert(merchantClassifications).values({
    userId: testUserId,
    merchantKey,
    category,
    transactionClass: "expense",
    recurrenceType: "one-time",
    labelConfidence: "0.95",
    source: "manual",
    hitCount: 0,
    updatedAt: new Date(),
  }).onConflictDoNothing();
}

async function seedGlobal(merchantKey: string, category: string) {
  seededGlobalKeys.push(merchantKey);
  await db.insert(merchantClassificationsGlobal).values({
    merchantKey,
    category,
    transactionClass: "expense",
    recurrenceType: "one-time",
    labelConfidence: "0.88",
    source: "test-seed",
    hitCount: 0,
    updatedAt: new Date(),
  }).onConflictDoNothing();
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  const [user] = await db.insert(users).values({
    email: TEST_EMAIL,
    password: "test-hash-not-real",
    displayName: "Pipeline Test",
    companyName: "Test Corp",
  }).returning({ id: users.id });
  testUserId = user!.id;
});

afterAll(async () => {
  await db.delete(merchantClassifications).where(eq(merchantClassifications.userId, testUserId));
  if (seededGlobalKeys.length > 0) {
    await db.delete(merchantClassificationsGlobal)
      .where(inArray(merchantClassificationsGlobal.merchantKey, seededGlobalKeys));
  }
  await db.delete(users).where(eq(users.id, testUserId));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Resolution step 2 — per-user merchant_classifications cache", () => {
  it("merchant existing only in per-user cache resolves via cache", async () => {
    const desc = "POCKETPULSE TEST UTILITIES VENDOR";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "utilities");

    const [out] = await classifyPipeline([row(desc, -50)], noAiOpts());
    expect(out).toBeTruthy();
    expect(out!.category).toBe("utilities");
    expect(out!.labelSource).toBe("cache");
    expect(out!.fromCache).toBe(true);
  });

  it("per-user cache overrides a high-confidence structural keyword match", async () => {
    // "restaurant" is a structural keyword (dining, 0.80 confidence).
    // A per-user cache entry for this merchant should override it.
    const desc = "POCKETPULSE RESTAURANT BUSINESS EXPENSE";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "business");  // user categorized it as business

    const [out] = await classifyPipeline([row(desc, -75)], noAiOpts());
    expect(out).toBeTruthy();
    // Structural rules would say "dining" but per-user cache wins
    expect(out!.category).toBe("business");
    expect(out!.labelSource).toBe("cache");
    expect(out!.fromCache).toBe(true);
  });
});

describe("Resolution step 3 — global merchant_classifications_global seed", () => {
  it("merchant existing only in global seed resolves via global seed", async () => {
    const desc = "POCKETPULSE GLOBAL SEED VENDOR ALPHA";
    const key = toMerchantKey(desc);
    await seedGlobal(key, "software");

    const [out] = await classifyPipeline([row(desc, -25)], noAiOpts());
    expect(out).toBeTruthy();
    expect(out!.category).toBe("software");
    expect(out!.labelSource).toBe("cache");
    expect(out!.fromCache).toBe(true);
    expect(out!.labelReason).toMatch(/global seed hit/);
  });

  it("per-user cache wins over global seed for the same merchant key", async () => {
    const desc = "POCKETPULSE SHARED OVERRIDE VENDOR";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "medical");  // per-user: medical
    await seedGlobal(key, "software");  // global: software — should be ignored

    const [out] = await classifyPipeline([row(desc, -10)], noAiOpts());
    expect(out!.category).toBe("medical");
    expect(out!.labelSource).toBe("cache");
  });

  it("global seed overrides a high-confidence structural keyword match", async () => {
    // "restaurant" is a structural keyword (dining, 0.80 confidence → needsAi=false at threshold=0.5).
    // A global seed entry for this merchant should override the structural result.
    const desc = "POCKETPULSE RESTAURANT GLOBAL OVERRIDE";
    const key = toMerchantKey(desc);
    await seedGlobal(key, "business");  // global seed: business

    // Use production-like threshold (0.5) so structural "dining" match gives needsAi=false
    const [out] = await classifyPipeline(
      [row(desc, -75)],
      { ...aiOpts(), aiTimeoutMs: 100 },
    );
    expect(out).toBeTruthy();
    // Structural rules say "dining" but global seed wins
    expect(out!.category).toBe("business");
    expect(out!.labelSource).toBe("cache");
    expect(out!.fromCache).toBe(true);
  });
});

describe("Resolution step 4 — structural keyword rules (classifier.ts)", () => {
  it("'ZELLE PAYMENT TO FRIEND' → transfer", async () => {
    const [out] = await classifyPipeline([row("ZELLE PAYMENT TO FRIEND", -100)], noAiOpts());
    expect(out!.transactionClass).toBe("transfer");
  });

  it("'LOCAL RESTAURANT KITCHEN DINER' → dining/expense", async () => {
    const [out] = await classifyPipeline([row("LOCAL RESTAURANT KITCHEN DINER", -42)], noAiOpts());
    expect(out!.category).toBe("dining");
    expect(out!.transactionClass).toBe("expense");
  });

  it("'PHARMACY PRESCRIPTION CHARGE' → medical/expense", async () => {
    const [out] = await classifyPipeline([row("PHARMACY PRESCRIPTION CHARGE", -18)], noAiOpts());
    expect(out!.category).toBe("medical");
  });

  it("'MONTHLY SUBSCRIPTION RENEWAL' → software/recurring (via CATEGORY_RULE)", async () => {
    const [out] = await classifyPipeline([row("MONTHLY SUBSCRIPTION RENEWAL", -9.99)], noAiOpts());
    expect(out!.transactionClass).toBe("expense");
    expect(out!.recurrenceType).toBe("recurring");
  });

  it("'ACH CREDIT PAYROLL DEPOSIT' → income/recurring", async () => {
    const [out] = await classifyPipeline([row("ACH CREDIT PAYROLL DEPOSIT", 3500)], noAiOpts());
    expect(out!.transactionClass).toBe("income");
    expect(out!.category).toBe("income");
    expect(out!.recurrenceType).toBe("recurring");
  });
});

describe("Resolution step 5 — AI fallback", () => {
  it("completely unknown merchant (no cache/global/structural match) reaches AI and falls back gracefully on timeout", async () => {
    // Gibberish description: no structural keyword, no cache entry, not in global seed.
    const desc = "ZXQW9 CORP UNKNOWN VENDOR XK7Q";

    const [out] = await classifyPipeline(
      [row(desc, -99)],
      { ...aiOpts(), aiTimeoutMs: 1 }, // 1 ms → AI always times out
    );

    expect(out).toBeTruthy();
    // AI timed out → pipeline falls back to structural result
    expect(out!.transactionClass).toBe("expense");
    expect(out!.category).toBe("other");
    // Not resolved from cache or global seed
    expect(out!.fromCache).toBe(false);
    expect(out!.labelSource).not.toBe("cache");
    expect(out!.labelSource).not.toBe("user-rule");
  });
});

describe("Mixed batch", () => {
  it("multiple rows resolve independently via different steps", async () => {
    const results = await classifyPipeline(
      [
        row("ZELLE TRANSFER TO SAVINGS", -500),
        row("MONTHLY GYM FITNESS MEMBERSHIP FEE", -40),
        row("ACH CREDIT DIRECT DEPOSIT PAYROLL", 4000),
      ],
      noAiOpts(),
    );

    expect(results.length).toBe(3);
    expect(results[0]!.transactionClass).toBe("transfer");   // structural
    expect(results[1]!.category).toBe("fitness");            // structural keyword
    expect(results[1]!.recurrenceType).toBe("recurring");
    expect(results[2]!.transactionClass).toBe("income");     // income keyword
  });
});

describe("classifier.ts unit (no DB)", () => {
  it("'loan payment' → debt/expense", async () => {
    const { classifyTransaction } = await import("./classifier.js");
    const r = classifyTransaction("LOAN PAYMENT CHASE BANK", -350);
    expect(r.category).toBe("debt");
    expect(r.transactionClass).toBe("expense");
  });

  it("'AMAZON REFUND RETURN' (positive) → refund", async () => {
    const { classifyTransaction } = await import("./classifier.js");
    const r = classifyTransaction("AMAZON REFUND RETURN", 29.99);
    expect(r.transactionClass).toBe("refund");
  });

  it("'OVERDRAFT FEE' → fees/expense", async () => {
    const { classifyTransaction } = await import("./classifier.js");
    const r = classifyTransaction("OVERDRAFT FEE CHARGED", -35);
    expect(r.category).toBe("fees");
  });

  it("'MONTHLY SUBSCRIPTION FEE' → recurring (CATEGORY_RULE, recurrenceSource='none')", async () => {
    // CATEGORY_RULES has {keywords:["subscription"], recurrenceType:"recurring"}.
    // Pass 6 sets recurrenceType directly → Pass 8 guard (recurrenceType==="one-time") fails
    // → recurrenceSource stays "none".
    const { classifyTransaction } = await import("./classifier.js");
    const r = classifyTransaction("MONTHLY SUBSCRIPTION FEE", -15);
    expect(r.recurrenceType).toBe("recurring");
    expect(r.recurrenceSource).toBe("none");
  });

  it("hint-only 'monthly' keyword without a CATEGORY_RULE match → recurrenceSource='hint'", async () => {
    const { classifyTransaction } = await import("./classifier.js");
    const r = classifyTransaction("MONTHLY PAYMENT INVOICE XJ99-WIDGET", -80);
    expect(r.recurrenceType).toBe("recurring");
    expect(r.recurrenceSource).toBe("hint");
  });
});
