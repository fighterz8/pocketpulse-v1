/**
 * Versioned OpenAI standard-tier pricing reviewed against:
 * https://developers.openai.com/api/docs/pricing/
 *
 * Rates are integer micro-USD per one million tokens. Cost calculations use
 * BigInt and round the combined request cost up to one micro-USD so internal
 * accounting never understates provider spend.
 */

export type NormalizedTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type ModelPricing = {
  model: string;
  pricingVersion: string;
  inputMicrousdPerMillionTokens: number;
  cachedInputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
};

export type PricedAiOperation =
  | "transaction_classification"
  | "csv_format_detection";

/**
 * Conservative per-request ceilings used before a paid request is authorized.
 * Input is charged entirely at the uncached rate because cache eligibility is
 * unknowable before the provider responds.
 */
export const AI_PROVIDER_TOKEN_CEILINGS: Record<
  PricedAiOperation,
  { inputTokens: number; outputTokens: number }
> = {
  transaction_classification: { inputTokens: 20_000, outputTokens: 2_000 },
  csv_format_detection: { inputTokens: 4_000, outputTokens: 600 },
};

const PRICING_CATALOG = {
  "gpt-5-nano": {
    model: "gpt-5-nano",
    pricingVersion: "openai-standard-2026-07-15",
    inputMicrousdPerMillionTokens: 50_000,
    cachedInputMicrousdPerMillionTokens: 5_000,
    outputMicrousdPerMillionTokens: 400_000,
  },
} as const satisfies Record<string, ModelPricing>;

export class InvalidProviderUsageError extends Error {
  readonly code = "INVALID_PROVIDER_USAGE" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderUsageError";
  }
}

export class UnknownPricedModelError extends Error {
  readonly code = "UNKNOWN_PRICED_MODEL" as const;

  constructor(model: string) {
    super(`No reviewed pricing entry exists for model ${JSON.stringify(model)}`);
    this.name = "UnknownPricedModelError";
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidProviderUsageError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidProviderUsageError(
      `${field} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function optionalTokenCount(
  parent: Record<string, unknown>,
  detailsField: string,
  tokenField: string,
): number {
  const details = parent[detailsField];
  if (details === undefined || details === null) return 0;
  const record = asRecord(details, detailsField);
  const value = record[tokenField];
  if (value === undefined || value === null) return 0;
  return asTokenCount(value, `${detailsField}.${tokenField}`);
}

export function normalizeChatCompletionUsage(
  rawUsage: unknown,
): NormalizedTokenUsage {
  const usage = asRecord(rawUsage, "usage");
  const inputTokens = asTokenCount(usage.prompt_tokens, "prompt_tokens");
  const outputTokens = asTokenCount(
    usage.completion_tokens,
    "completion_tokens",
  );
  const totalTokens = asTokenCount(usage.total_tokens, "total_tokens");
  const cachedInputTokens = optionalTokenCount(
    usage,
    "prompt_tokens_details",
    "cached_tokens",
  );
  const reasoningOutputTokens = optionalTokenCount(
    usage,
    "completion_tokens_details",
    "reasoning_tokens",
  );

  if (cachedInputTokens > inputTokens) {
    throw new InvalidProviderUsageError(
      "cached input tokens cannot exceed total input tokens",
    );
  }
  if (reasoningOutputTokens > outputTokens) {
    throw new InvalidProviderUsageError(
      "reasoning output tokens cannot exceed total output tokens",
    );
  }
  if (inputTokens + outputTokens !== totalTokens) {
    throw new InvalidProviderUsageError(
      "total tokens must equal input tokens plus output tokens",
    );
  }

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

export function getModelPricing(model: string): ModelPricing {
  const pricing = PRICING_CATALOG[model as keyof typeof PRICING_CATALOG];
  if (!pricing) throw new UnknownPricedModelError(model);
  return { ...pricing };
}

export function validateNormalizedTokenUsage(
  usage: NormalizedTokenUsage,
): NormalizedTokenUsage {
  for (const [field, value] of Object.entries(usage)) {
    asTokenCount(value, field);
  }
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new InvalidProviderUsageError(
      "cached input tokens cannot exceed total input tokens",
    );
  }
  if (usage.uncachedInputTokens !== usage.inputTokens - usage.cachedInputTokens) {
    throw new InvalidProviderUsageError(
      "uncached input tokens must equal input tokens minus cached input tokens",
    );
  }
  if (usage.reasoningOutputTokens > usage.outputTokens) {
    throw new InvalidProviderUsageError(
      "reasoning output tokens cannot exceed total output tokens",
    );
  }
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new InvalidProviderUsageError(
      "total tokens must equal input tokens plus output tokens",
    );
  }
  return { ...usage };
}

export function calculateMaximumRequestCostMicrousd(
  model: string,
  operation: PricedAiOperation,
): { model: string; pricingVersion: string; costMicrousd: number } {
  const ceiling = AI_PROVIDER_TOKEN_CEILINGS[operation];
  return calculateUsageCostMicrousd(model, {
    inputTokens: ceiling.inputTokens,
    cachedInputTokens: 0,
    uncachedInputTokens: ceiling.inputTokens,
    outputTokens: ceiling.outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: ceiling.inputTokens + ceiling.outputTokens,
  });
}

export function calculateUsageCostMicrousd(
  model: string,
  usage: NormalizedTokenUsage,
): { model: string; pricingVersion: string; costMicrousd: number } {
  validateNormalizedTokenUsage(usage);
  const pricing = getModelPricing(model);
  const numerator =
    BigInt(usage.uncachedInputTokens) *
      BigInt(pricing.inputMicrousdPerMillionTokens) +
    BigInt(usage.cachedInputTokens) *
      BigInt(pricing.cachedInputMicrousdPerMillionTokens) +
    BigInt(usage.outputTokens) *
      BigInt(pricing.outputMicrousdPerMillionTokens);
  const divisor = 1_000_000n;
  const roundedUp = (numerator + divisor - 1n) / divisor;

  if (roundedUp > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidProviderUsageError(
      "calculated request cost exceeds the supported integer range",
    );
  }

  return {
    model: pricing.model,
    pricingVersion: pricing.pricingVersion,
    costMicrousd: Number(roundedUp),
  };
}
