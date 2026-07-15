import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_PROVIDER_TIMEOUT_MS,
  OPENAI_PROVIDER_MAX_OUTPUT_TOKENS,
  ProviderAbortedError,
  ProviderDisabledError,
  ProviderResponseValidationError,
  ProviderTimeoutError,
  createOpenAiChatTransport,
  executeOpenAiStructuredRequest,
  type OpenAiChatTransport,
} from "./openaiProvider.js";
import { UnknownPricedModelError } from "./aiPricing.js";

const RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "test_result",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
};

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_test",
    _request_id: "req_test_123",
    model: "gpt-5-nano",
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify({ ok: true }), refusal: null },
      },
    ],
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 200,
      total_tokens: 1_200,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 75 },
    },
    ...overrides,
  };
}

function request(
  operation:
    | "transaction_classification"
    | "csv_format_detection" = "transaction_classification",
) {
  return {
    operation,
    model: "gpt-5-nano",
    messages: [
      { role: "system" as const, content: "Return structured JSON." },
      { role: "user" as const, content: "Classify this bounded input." },
    ],
    responseFormat: RESPONSE_FORMAT,
    validate: (value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        (value as { ok?: unknown }).ok !== true
      ) {
        throw new Error("expected ok=true");
      }
      return value as { ok: true };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAI provider configuration", () => {
  it("constructs the SDK client with a bounded timeout and zero retries", async () => {
    const create = vi.fn(async () => validResponse());
    const factory = vi.fn(() => ({ chat: { completions: { create } } }));
    const transport = createOpenAiChatTransport("test-key", factory);

    await transport(
      {
        model: "gpt-5-nano",
        messages: [],
        response_format: RESPONSE_FORMAT,
        reasoning_effort: "minimal",
        max_completion_tokens: 2_000,
      },
      {
        maxRetries: 0,
        timeout: OPENAI_PROVIDER_TIMEOUT_MS,
        signal: new AbortController().signal,
      },
    );

    expect(factory).toHaveBeenCalledWith({
      apiKey: "test-key",
      maxRetries: 0,
      timeout: OPENAI_PROVIDER_TIMEOUT_MS,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAI structured provider boundary", () => {
  it("is disabled by default and makes no transport call", async () => {
    const transport = vi.fn(async () => validResponse());

    await expect(
      executeOpenAiStructuredRequest(request(), { transport }),
    ).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown-priced model before transport", async () => {
    const transport = vi.fn(async () => validResponse());

    await expect(
      executeOpenAiStructuredRequest(
        { ...request(), model: "future-unknown-model" },
        { isEnabled: true, transport },
      ),
    ).rejects.toBeInstanceOf(UnknownPricedModelError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns validated data, request metadata, normalized usage, and cost", async () => {
    const transport = vi.fn(async () => validResponse());

    const result = await executeOpenAiStructuredRequest(request(), {
      isEnabled: true,
      transport,
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_025),
    });

    expect(result).toEqual({
      data: { ok: true },
      provider: "openai",
      providerRequestId: "req_test_123",
      model: "gpt-5-nano",
      operation: "transaction_classification",
      latencyMs: 25,
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        uncachedInputTokens: 600,
        outputTokens: 200,
        reasoningOutputTokens: 75,
        totalTokens: 1_200,
      },
      pricingVersion: "openai-standard-2026-07-15",
      costMicrousd: 112,
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5-nano",
        reasoning_effort: "minimal",
        max_completion_tokens:
          OPENAI_PROVIDER_MAX_OUTPUT_TOKENS.transaction_classification,
      }),
      expect.objectContaining({
        maxRetries: 0,
        timeout: OPENAI_PROVIDER_TIMEOUT_MS,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses the smaller CSV-format output ceiling", async () => {
    const transport = vi.fn(async () => validResponse());

    await executeOpenAiStructuredRequest(request("csv_format_detection"), {
      isEnabled: true,
      transport,
    });

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        max_completion_tokens:
          OPENAI_PROVIDER_MAX_OUTPUT_TOKENS.csv_format_detection,
      }),
      expect.any(Object),
    );
  });

  it("rejects an already-aborted caller signal before transport", async () => {
    const controller = new AbortController();
    controller.abort("user cancelled");
    const transport = vi.fn(async () => validResponse());

    await expect(
      executeOpenAiStructuredRequest(request(), {
        isEnabled: true,
        transport,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ProviderAbortedError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts the in-flight request when its timeout expires", async () => {
    vi.useFakeTimers();
    const transport: OpenAiChatTransport = vi.fn(
      async (_body, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );

    const pending = executeOpenAiStructuredRequest(request(), {
      isEnabled: true,
      transport,
      timeoutMs: 25,
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it.each([
    {
      name: "truncated completion",
      response: validResponse({
        choices: [
          {
            finish_reason: "length",
            message: { content: JSON.stringify({ ok: true }), refusal: null },
          },
        ],
      }),
    },
    {
      name: "invalid JSON",
      response: validResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "not json", refusal: null },
          },
        ],
      }),
    },
    {
      name: "missing usage",
      response: validResponse({ usage: undefined }),
    },
    {
      name: "schema rejection",
      response: validResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ ok: false }), refusal: null },
          },
        ],
      }),
    },
  ])("rejects untrusted provider responses: $name", async ({ response }) => {
    const transport = vi.fn(async () => response);

    await expect(
      executeOpenAiStructuredRequest(request(), {
        isEnabled: true,
        transport,
      }),
    ).rejects.toBeInstanceOf(ProviderResponseValidationError);
  });
});
