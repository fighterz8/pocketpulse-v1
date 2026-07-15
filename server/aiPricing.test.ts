import { describe, expect, it } from "vitest";
import {
  InvalidProviderUsageError,
  UnknownPricedModelError,
  calculateUsageCostMicrousd,
  getModelPricing,
  normalizeChatCompletionUsage,
} from "./aiPricing.js";

describe("AI usage normalization", () => {
  it("separates cached input and exposes reasoning output without double counting", () => {
    expect(
      normalizeChatCompletionUsage({
        prompt_tokens: 1_000,
        completion_tokens: 200,
        total_tokens: 1_200,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 75 },
      }),
    ).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      uncachedInputTokens: 600,
      outputTokens: 200,
      reasoningOutputTokens: 75,
      totalTokens: 1_200,
    });
  });

  it.each([
    {
      name: "cached input exceeds total input",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 11 },
      },
    },
    {
      name: "reasoning output exceeds total output",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    },
    {
      name: "total does not reconcile",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 99,
      },
    },
  ])("rejects invalid provider usage: $name", ({ usage }) => {
    expect(() => normalizeChatCompletionUsage(usage)).toThrow(
      InvalidProviderUsageError,
    );
  });
});

describe("versioned AI pricing", () => {
  it("contains the reviewed standard gpt-5-nano rate snapshot", () => {
    expect(getModelPricing("gpt-5-nano")).toEqual({
      model: "gpt-5-nano",
      pricingVersion: "openai-standard-2026-07-15",
      inputMicrousdPerMillionTokens: 50_000,
      cachedInputMicrousdPerMillionTokens: 5_000,
      outputMicrousdPerMillionTokens: 400_000,
    });
  });

  it("fails closed for a model without a reviewed price", () => {
    expect(() => getModelPricing("future-unknown-model")).toThrow(
      UnknownPricedModelError,
    );
  });

  it("calculates cached, uncached, and output cost in integer micro-USD", () => {
    const usage = normalizeChatCompletionUsage({
      prompt_tokens: 2_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 3_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
      completion_tokens_details: { reasoning_tokens: 250_000 },
    });

    expect(calculateUsageCostMicrousd("gpt-5-nano", usage)).toEqual({
      model: "gpt-5-nano",
      pricingVersion: "openai-standard-2026-07-15",
      costMicrousd: 455_000,
    });
  });

  it("rounds fractional micro-USD up so accounting never understates spend", () => {
    const usage = normalizeChatCompletionUsage({
      prompt_tokens: 1,
      completion_tokens: 0,
      total_tokens: 1,
    });

    expect(
      calculateUsageCostMicrousd("gpt-5-nano", usage).costMicrousd,
    ).toBe(1);
  });
});
