import { describe, expect, it, vi } from "vitest";

import {
  _findExplicitDirectionColumn,
  detectCsvFormat,
} from "./csvFormatDetector.js";
import {
  OPENAI_PROVIDER_MAX_OUTPUT_TOKENS,
  ProviderResponseValidationError,
  type OpenAiChatRequestBody,
  type OpenAiTransportOptions,
} from "./openaiProvider.js";

const VALID_SPEC = {
  preambleRows: 1,
  hasHeader: true,
  dateColumn: 0,
  descriptionColumn: 1,
  amountColumn: 2,
  debitColumn: null,
  creditColumn: null,
  typeColumn: null,
  signConvention: "signed",
  dateFormat: null,
};

function providerResponse(spec: unknown = VALID_SPEC) {
  return {
    _request_id: "req_csv_123",
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify(spec), refusal: null },
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  };
}

const SAMPLE_ROWS = [
  ["Account holder", "Nick Secret"],
  ["Posting Date", "Description", "Amount"],
  ["07/01/2026", "Sensitive Merchant", "-1234.56"],
];

describe("CSV format detector provider boundary", () => {
  it("uses the bounded shared adapter and returns normalized request metadata", async () => {
    const transport = vi.fn(
      async (_body: OpenAiChatRequestBody, _options: OpenAiTransportOptions) =>
        providerResponse(),
    );

    const result = await detectCsvFormat(SAMPLE_ROWS, {
      isEnabled: true,
      transport,
    });

    expect(result.data).toMatchObject({
      preambleRows: 1,
      dateColumn: 0,
      descriptionColumn: 1,
      amountColumn: 2,
      signConvention: "signed",
    });
    expect(result).toMatchObject({
      provider: "openai",
      providerRequestId: "req_csv_123",
      operation: "csv_format_detection",
      model: "gpt-5-nano",
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      },
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5-nano",
        reasoning_effort: "minimal",
        max_completion_tokens:
          OPENAI_PROVIDER_MAX_OUTPUT_TOKENS.csv_format_detection,
      }),
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
  });

  it("sends structural evidence without preamble PII, merchants, or exact amounts", async () => {
    const transport = vi.fn(
      async (_body: OpenAiChatRequestBody, _options: OpenAiTransportOptions) =>
        providerResponse(),
    );

    await detectCsvFormat(SAMPLE_ROWS, { isEnabled: true, transport });

    const body = JSON.stringify(transport.mock.calls[0]?.[0]);
    expect(body).toContain("Posting Date");
    expect(body).toContain("07/01/2026");
    expect(body).toContain("-1.00");
    expect(body).not.toContain("Nick Secret");
    expect(body).not.toContain("Sensitive Merchant");
    expect(body).not.toContain("1234.56");
  });

  it("rejects an out-of-range provider mapping", async () => {
    const transport = vi.fn(
      async (_body: OpenAiChatRequestBody, _options: OpenAiTransportOptions) =>
        providerResponse({ ...VALID_SPEC, dateColumn: 99 }),
    );

    await expect(
      detectCsvFormat(SAMPLE_ROWS, { isEnabled: true, transport }),
    ).rejects.toBeInstanceOf(ProviderResponseValidationError);
  });
});

describe("CSV format detector direction headers", () => {
  it("prefers an explicit Navy Federal direction indicator over generic type", () => {
    expect(
      _findExplicitDirectionColumn([
        "Posting Date",
        "Transaction Date",
        "Amount",
        "Credit Debit Indicator",
        "type",
      ]),
    ).toBe(3);
  });

  it("does not mistake a generic mechanism column for a direction indicator", () => {
    expect(
      _findExplicitDirectionColumn(["Date", "Amount", "type", "Description"]),
    ).toBe(-1);
  });
});
