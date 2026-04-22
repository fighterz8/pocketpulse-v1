/**
 * Regression tests for the Phase 1.7 / Phase 1.8 cache-hit AI gating.
 *
 * Bug pinned here: a per-user cache hit or global seed hit with
 * `category = "other"` MUST keep `row.needsAi = true` so the AI pass still
 * runs. A hit with a real category (e.g. "food") MUST set
 * `row.needsAi = false` so AI is skipped.
 *
 * `needsAi` is internal state — observed indirectly by mocking
 * `aiClassifyBatch` and asserting whether it was invoked with the row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const aiSpy = vi.fn(async (_items: unknown[], _examples?: unknown[]) => new Map());

vi.mock("./ai-classifier.js", () => ({
  aiClassifyBatch: (items: unknown[], examples: unknown[]) => aiSpy(items, examples),
}));

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

const TEST_EMAIL = `pipeline-needsai-${Date.now()}@test.internal`;
let testUserId: number;
const seededGlobalKeys: string[] = [];

function toMerchantKey(rawDescription: string): string {
  return recurrenceKey(normalizeMerchant(rawDescription));
}

function opts(): PipelineOptions {
  return {
    userId: testUserId,
    aiTimeoutMs: 200,
    aiConfidenceThreshold: 0.5,
    cacheWriteMinConfidence: 0.7,
    includeUserExamplesInAi: false,
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
    displayName: "needsAi Test",
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
});

function aiSawMerchant(merchant: string): boolean {
  for (const call of aiSpy.mock.calls) {
    const items = call[0] as Array<{ merchant: string }>;
    if (items.some((i) => i.merchant === merchant)) return true;
  }
  return false;
}

describe("Phase 1.7 (per-user cache) — needsAi gating", () => {
  it("cached category='other' keeps needsAi=true (AI still runs)", async () => {
    const desc = "PP NEEDSAI USERCACHE OTHER VENDOR";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "other");

    const [out] = await classifyPipeline([{ rawDescription: desc, amount: -10 }], opts());
    expect(out).toBeTruthy();
    // Prove the per-user cache hit actually fired (mock returns empty Map so
    // AI does not overwrite these fields).
    expect(out!.fromCache).toBe(true);
    expect(out!.labelSource).toBe("cache");
    expect(out!.labelReason).toMatch(/cache hit/);
    // ...AND that AI was still invoked despite the hit.
    expect(aiSawMerchant(out!.merchant)).toBe(true);
  });

  it("cached real category (food) sets needsAi=false (AI skipped)", async () => {
    const desc = "PP NEEDSAI USERCACHE FOOD VENDOR";
    const key = toMerchantKey(desc);
    await seedPerUser(key, "food");

    const [out] = await classifyPipeline([{ rawDescription: desc, amount: -10 }], opts());
    expect(out).toBeTruthy();
    expect(out!.category).toBe("food");
    expect(out!.labelSource).toBe("cache");
    expect(aiSawMerchant(out!.merchant)).toBe(false);
  });
});

describe("Phase 1.8 (global seed) — needsAi gating", () => {
  it("global seed category='other' keeps needsAi=true (AI still runs)", async () => {
    const desc = "PP NEEDSAI GLOBALSEED OTHER VENDOR";
    const key = toMerchantKey(desc);
    await seedGlobal(key, "other");

    const [out] = await classifyPipeline([{ rawDescription: desc, amount: -10 }], opts());
    expect(out).toBeTruthy();
    // Prove the global-seed hit actually fired (mock returns empty Map so
    // AI does not overwrite these fields).
    expect(out!.fromCache).toBe(true);
    expect(out!.labelSource).toBe("cache");
    expect(out!.labelReason).toMatch(/global seed hit/);
    // ...AND that AI was still invoked despite the hit.
    expect(aiSawMerchant(out!.merchant)).toBe(true);
  });

  it("global seed real category (food) sets needsAi=false (AI skipped)", async () => {
    const desc = "PP NEEDSAI GLOBALSEED FOOD VENDOR";
    const key = toMerchantKey(desc);
    await seedGlobal(key, "food");

    const [out] = await classifyPipeline([{ rawDescription: desc, amount: -10 }], opts());
    expect(out).toBeTruthy();
    expect(out!.category).toBe("food");
    expect(out!.labelSource).toBe("cache");
    expect(aiSawMerchant(out!.merchant)).toBe(false);
  });
});
