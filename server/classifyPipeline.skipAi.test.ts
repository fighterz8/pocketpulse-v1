/**
 * Tests for the `skipAi: true` pipeline option (Async AI PR1).
 *
 * Behaviour pinned here:
 *   1. AI is never invoked when skipAi is true (mock spy must stay at 0 calls).
 *   2. Rows resolved by rule, user-rule, per-user cache, or global seed
 *      come back with `needsAi: false`.
 *   3. Rows that would have gone to AI (low confidence, "other", or
 *      `aiAssisted` from the classifier) come back with `needsAi: true`
 *      AND the rule-pass labelSource (typically "rule"), so the caller can
 *      count and queue them for the async worker.
 *   4. No AI cache writeback happens when AI is skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const aiSpy = vi.fn(async (_items: unknown[], _examples?: unknown[]) => new Map());

vi.mock("./ai-classifier.js", () => ({
  aiClassifyBatch: (items: unknown[], examples: unknown[]) => aiSpy(items, examples),
}));

// Spy on the two cache-write side effects that Phase 1.7 / 1.8 normally
// fire so we can assert they never run when skipAi=true. The non-write
// storage functions (rule lookups, cache reads, seed reads) keep their
// real implementations.
const recordCacheHitsSpy = vi.fn(async () => {});
const batchUpsertSpy = vi.fn(async () => {});

vi.mock("./storage.js", async () => {
  const actual = await vi.importActual<typeof import("./storage.js")>("./storage.js");
  return {
    ...actual,
    recordCacheHits: (...args: Parameters<typeof actual.recordCacheHits>) =>
      recordCacheHitsSpy(...(args as unknown as [])),
    batchUpsertMerchantClassifications: (
      ...args: Parameters<typeof actual.batchUpsertMerchantClassifications>
    ) => batchUpsertSpy(...(args as unknown as [])),
  };
});

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
} from "./classifyPipeline.js";
import { normalizeMerchant } from "./transactionUtils.js";
import { recurrenceKey } from "./recurrenceDetector.js";

const TEST_EMAIL = `pipeline-skipai-${Date.now()}@test.internal`;
let testUserId: number;
const seededGlobalKeys: string[] = [];

function toMerchantKey(rawDescription: string): string {
  return recurrenceKey(normalizeMerchant(rawDescription));
}

function skipAiOpts(): PipelineOptions {
  return {
    userId: testUserId,
    aiTimeoutMs: 200,
    aiConfidenceThreshold: 0.5,
    cacheWriteMinConfidence: 0.7,
    includeUserExamplesInAi: false,
    skipAi: true,
  };
}

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

beforeAll(async () => {
  const [user] = await db.insert(users).values({
    email: TEST_EMAIL,
    password: "test-hash-not-real",
    displayName: "skipAi Test",
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

beforeEach(() => {
  aiSpy.mockClear();
  recordCacheHitsSpy.mockClear();
  batchUpsertSpy.mockClear();
});

describe("classifyPipeline — skipAi option", () => {
  it("never invokes the AI classifier when skipAi=true", async () => {
    const [out] = await classifyPipeline(
      [{ rawDescription: "PP SKIPAI UNKNOWN GIBBERISH XK7", amount: -42 }],
      skipAiOpts(),
    );

    expect(out).toBeTruthy();
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("flags unresolved rows with needsAi=true and keeps the rule labelSource", async () => {
    // Gibberish merchant: no cache, no global seed, no structural keyword
    // match → classifier returns category='other' with low confidence.
    const desc = "PP SKIPAI UNKNOWN GIBBERISH XK7";

    const [out] = await classifyPipeline(
      [{ rawDescription: desc, amount: -42 }],
      skipAiOpts(),
    );

    expect(out).toBeTruthy();
    expect(out!.needsAi).toBe(true);
    expect(out!.labelSource).toBe("rule");
    expect(out!.fromCache).toBe(false);
    // labelSource must NOT be "ai" — the AI phase was skipped.
    expect(out!.labelSource).not.toBe("ai");
  });

  it("clears needsAi for rows resolved by a confident structural rule", async () => {
    // "RESTAURANT" is a structural keyword (dining, 0.80 confidence) — above
    // the 0.5 threshold and not "other", so the rule pass alone resolves it.
    const [out] = await classifyPipeline(
      [{ rawDescription: "LOCAL RESTAURANT KITCHEN DINER", amount: -22 }],
      skipAiOpts(),
    );

    expect(out!.category).toBe("dining");
    expect(out!.labelSource).toBe("rule");
    expect(out!.needsAi).toBe(false);
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("clears needsAi for rows resolved by the per-user cache", async () => {
    const desc = "PP SKIPAI USERCACHE FOOD";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "food");

    const [out] = await classifyPipeline(
      [{ rawDescription: desc, amount: -10 }],
      skipAiOpts(),
    );

    expect(out!.category).toBe("food");
    expect(out!.labelSource).toBe("cache");
    expect(out!.fromCache).toBe(true);
    expect(out!.needsAi).toBe(false);
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("clears needsAi for rows resolved by the global seed", async () => {
    const desc = "PP SKIPAI GLOBALSEED UTILITIES";
    const key = toMerchantKey(desc);
    await seedGlobal(key, "utilities");

    const [out] = await classifyPipeline(
      [{ rawDescription: desc, amount: -75 }],
      skipAiOpts(),
    );

    expect(out!.category).toBe("utilities");
    expect(out!.labelSource).toBe("cache");
    expect(out!.fromCache).toBe(true);
    expect(out!.needsAi).toBe(false);
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("keeps needsAi=true when a cache hit returns category='other'", async () => {
    // Even with a cache hit, "other" is a non-answer — the worker should
    // still try AI later. skipAi means we don't call AI now, but the row
    // is correctly flagged as still needing it.
    const desc = "PP SKIPAI USERCACHE OTHER";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "other");

    const [out] = await classifyPipeline(
      [{ rawDescription: desc, amount: -10 }],
      skipAiOpts(),
    );

    expect(out!.fromCache).toBe(true);
    expect(out!.labelSource).toBe("cache");
    expect(out!.needsAi).toBe(true);
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("processes a mixed batch — resolved rows have needsAi=false, unresolved have needsAi=true", async () => {
    const results = await classifyPipeline(
      [
        { rawDescription: "MONTHLY GYM FITNESS MEMBERSHIP FEE", amount: -40 }, // structural fitness
        { rawDescription: "PP SKIPAI MIXED UNKNOWN VENDOR", amount: -50 }, // unresolved
        { rawDescription: "LOCAL RESTAURANT KITCHEN DINER", amount: -22 }, // structural dining
      ],
      skipAiOpts(),
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.needsAi).toBe(false);
    expect(results[1]!.needsAi).toBe(true);
    expect(results[2]!.needsAi).toBe(false);
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("does not bump per-user cache hit counts when skipAi=true (Phase 1.7 side effect)", async () => {
    // Cached merchant — Phase 1.7 normally calls recordCacheHits(userId, [key]).
    const desc = "PP SKIPAI NOWRITE USERCACHE";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "food");

    const [out] = await classifyPipeline(
      [{ rawDescription: desc, amount: -10 }],
      skipAiOpts(),
    );

    // Sanity: the cache hit still happens (read-only); we just don't write.
    expect(out!.fromCache).toBe(true);
    expect(out!.labelSource).toBe("cache");
    expect(recordCacheHitsSpy).not.toHaveBeenCalled();
    expect(batchUpsertSpy).not.toHaveBeenCalled();
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("does not promote global-seed hits into the per-user cache when skipAi=true (Phase 1.8 side effect)", async () => {
    // Global-only merchant — Phase 1.8 normally calls
    // batchUpsertMerchantClassifications(userId, [seedHit]) to promote it.
    const desc = "PP SKIPAI NOWRITE GLOBALSEED";
    const key = toMerchantKey(desc);
    await seedGlobal(key, "utilities");

    const [out] = await classifyPipeline(
      [{ rawDescription: desc, amount: -50 }],
      skipAiOpts(),
    );

    expect(out!.fromCache).toBe(true);
    expect(out!.labelSource).toBe("cache");
    expect(out!.category).toBe("utilities");
    // No promotion write, no hit bump, no AI call — fully read-only.
    expect(batchUpsertSpy).not.toHaveBeenCalled();
    expect(recordCacheHitsSpy).not.toHaveBeenCalled();
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("surfaces needsAi on the public PipelineOutput for every row", async () => {
    const results = await classifyPipeline(
      [
        { rawDescription: "MONTHLY GYM FITNESS MEMBERSHIP FEE", amount: -40 },
        { rawDescription: "PP SKIPAI SURFACE TEST", amount: -25 },
      ],
      skipAiOpts(),
    );

    for (const out of results) {
      expect(out).toHaveProperty("needsAi");
      expect(typeof out.needsAi).toBe("boolean");
    }
  });
});
