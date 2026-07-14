import { describe, expect, it } from "vitest";
import { _csvFormatGenerationOptions } from "./csvFormatDetector.js";

describe("CSV format detector generation options", () => {
  it("uses minimal reasoning and enough structured-output headroom for GPT-5", () => {
    expect(_csvFormatGenerationOptions("gpt-5-nano")).toEqual({
      reasoning_effort: "minimal",
      max_completion_tokens: 4000,
    });
  });

  it("keeps deterministic legacy-model settings", () => {
    expect(_csvFormatGenerationOptions("gpt-4o-mini")).toEqual({
      temperature: 0,
      max_tokens: 350,
    });
  });
});
