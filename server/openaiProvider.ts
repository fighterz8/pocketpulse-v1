import OpenAI from "openai";

import {
  AI_PROVIDER_TOKEN_CEILINGS,
  InvalidProviderUsageError,
  calculateUsageCostMicrousd,
  getModelPricing,
  normalizeChatCompletionUsage,
  type NormalizedTokenUsage,
} from "./aiPricing.js";

export type OpenAiOperation =
  | "transaction_classification"
  | "csv_format_detection";

export const OPENAI_PROVIDER_TIMEOUT_MS = 40_000;
export const OPENAI_PROVIDER_MAX_OUTPUT_TOKENS: Record<OpenAiOperation, number> = {
  transaction_classification:
    AI_PROVIDER_TOKEN_CEILINGS.transaction_classification.outputTokens,
  csv_format_detection:
    AI_PROVIDER_TOKEN_CEILINGS.csv_format_detection.outputTokens,
};

type OpenAiMessage = {
  role: "system" | "user";
  content: string;
};

type OpenAiResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
};

export type OpenAiChatRequestBody = {
  model: string;
  messages: OpenAiMessage[];
  response_format: OpenAiResponseFormat;
  reasoning_effort: "minimal";
  max_completion_tokens: number;
};

export type OpenAiTransportOptions = {
  maxRetries: 0;
  timeout: number;
  signal: AbortSignal;
};

export type OpenAiChatTransport = (
  body: OpenAiChatRequestBody,
  options: OpenAiTransportOptions,
) => Promise<unknown>;

type OpenAiClientFactory = (options: {
  apiKey: string;
  maxRetries: 0;
  timeout: number;
}) => {
  chat: {
    completions: {
      create: (body: unknown, options: unknown) => Promise<unknown>;
    };
  };
};

export class ProviderDisabledError extends Error {
  readonly code = "PROVIDER_DISABLED" as const;

  constructor() {
    super("Paid AI provider requests are disabled");
    this.name = "ProviderDisabledError";
  }
}

export class ProviderAbortedError extends Error {
  readonly code = "PROVIDER_ABORTED" as const;

  constructor() {
    super("AI provider request was cancelled");
    this.name = "ProviderAbortedError";
  }
}

export class ProviderTimeoutError extends Error {
  readonly code = "PROVIDER_TIMEOUT" as const;

  constructor(timeoutMs: number) {
    super(`AI provider request exceeded its ${timeoutMs}ms time limit`);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderInputTooLargeError extends Error {
  readonly code = "PROVIDER_INPUT_TOO_LARGE" as const;

  constructor(operation: OpenAiOperation) {
    super(`AI ${operation} request exceeds its reserved input ceiling`);
    this.name = "ProviderInputTooLargeError";
  }
}

export class ProviderResponseValidationError extends Error {
  readonly code = "PROVIDER_RESPONSE_INVALID" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderResponseValidationError";
  }
}

export type OpenAiStructuredRequest<T> = {
  operation: OpenAiOperation;
  model: string;
  messages: OpenAiMessage[];
  responseFormat: OpenAiResponseFormat;
  validate: (value: unknown) => T;
};

export type OpenAiStructuredResult<T> = {
  data: T;
  provider: "openai";
  providerRequestId: string | null;
  model: string;
  operation: OpenAiOperation;
  latencyMs: number;
  usage: NormalizedTokenUsage;
  pricingVersion: string;
  costMicrousd: number;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderResponseValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseProviderResponse<T>(
  responseValue: unknown,
  validate: (value: unknown) => T,
): {
  data: T;
  providerRequestId: string | null;
  usage: NormalizedTokenUsage;
} {
  const response = asRecord(responseValue, "provider response");
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderResponseValidationError(
      "provider response must contain a completion choice",
    );
  }

  const choice = asRecord(choices[0], "provider response choice");
  if (choice.finish_reason !== "stop") {
    throw new ProviderResponseValidationError(
      "provider completion did not finish normally",
    );
  }

  const message = asRecord(choice.message, "provider response message");
  if (message.refusal !== undefined && message.refusal !== null) {
    throw new ProviderResponseValidationError("provider refused the request");
  }
  if (typeof message.content !== "string" || message.content.trim() === "") {
    throw new ProviderResponseValidationError(
      "provider response content must be a non-empty string",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch (cause) {
    throw new ProviderResponseValidationError(
      "provider response content is not valid JSON",
      { cause },
    );
  }

  let data: T;
  try {
    data = validate(parsed);
  } catch (cause) {
    throw new ProviderResponseValidationError(
      "provider response failed schema validation",
      { cause },
    );
  }

  let usage: NormalizedTokenUsage;
  try {
    usage = normalizeChatCompletionUsage(response.usage);
  } catch (cause) {
    if (cause instanceof InvalidProviderUsageError) {
      throw new ProviderResponseValidationError(
        "provider response contained invalid usage data",
        { cause },
      );
    }
    throw cause;
  }

  return {
    data,
    providerRequestId:
      typeof response._request_id === "string" ? response._request_id : null,
    usage,
  };
}

export function createOpenAiChatTransport(
  apiKey: string,
  factory?: OpenAiClientFactory,
): OpenAiChatTransport {
  if (apiKey.trim() === "") {
    throw new Error("OpenAI API key must not be empty");
  }
  const clientOptions = {
    apiKey,
    maxRetries: 0 as const,
    timeout: OPENAI_PROVIDER_TIMEOUT_MS,
  };
  if (factory) {
    const client = factory(clientOptions);
    return (body, options) => client.chat.completions.create(body, options);
  }

  const client = new OpenAI(clientOptions);
  return (body, options) =>
    client.chat.completions.create(
      body as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      options,
    );
}

export async function executeOpenAiStructuredRequest<T>(
  request: OpenAiStructuredRequest<T>,
  options: {
    transport: OpenAiChatTransport;
    isEnabled?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    now?: () => number;
  },
): Promise<OpenAiStructuredResult<T>> {
  if (options.isEnabled !== true) throw new ProviderDisabledError();

  // Fail closed before any paid request if pricing has not been reviewed.
  getModelPricing(request.model);

  if (options.signal?.aborted) throw new ProviderAbortedError();

  const timeoutMs = options.timeoutMs ?? OPENAI_PROVIDER_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > OPENAI_PROVIDER_TIMEOUT_MS
  ) {
    throw new RangeError(
      `provider timeout must be an integer from 1 through ${OPENAI_PROVIDER_TIMEOUT_MS}`,
    );
  }

  const body: OpenAiChatRequestBody = {
    model: request.model,
    messages: request.messages,
    response_format: request.responseFormat,
    reasoning_effort: "minimal",
    max_completion_tokens:
      OPENAI_PROVIDER_MAX_OUTPUT_TOKENS[request.operation],
  };
  // A token represents at least one encoded byte. Keeping the complete request
  // body below the reserved token ceiling is deliberately conservative and
  // guarantees the pre-call cost reservation cannot be under-sized.
  if (
    Buffer.byteLength(JSON.stringify(body), "utf8") >
    AI_PROVIDER_TOKEN_CEILINGS[request.operation].inputTokens
  ) {
    throw new ProviderInputTooLargeError(request.operation);
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ProviderTimeoutError(timeoutMs));
  }, timeoutMs);

  let rawResponse: unknown;
  try {
    rawResponse = await options.transport(
      body,
      { maxRetries: 0, timeout: timeoutMs, signal: controller.signal },
    );
  } catch (cause) {
    if (timedOut) throw new ProviderTimeoutError(timeoutMs);
    if (controller.signal.aborted || options.signal?.aborted) {
      throw new ProviderAbortedError();
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  const completedAt = now();
  const parsed = parseProviderResponse(rawResponse, request.validate);
  const cost = calculateUsageCostMicrousd(request.model, parsed.usage);

  return {
    data: parsed.data,
    provider: "openai",
    providerRequestId: parsed.providerRequestId,
    model: request.model,
    operation: request.operation,
    latencyMs: Math.max(0, completedAt - startedAt),
    usage: parsed.usage,
    pricingVersion: cost.pricingVersion,
    costMicrousd: cost.costMicrousd,
  };
}
