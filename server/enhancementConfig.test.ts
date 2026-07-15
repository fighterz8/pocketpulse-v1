import { afterEach, describe, expect, it } from "vitest";

import {
  getEnhancementFeatureFlags,
  InvalidEnhancementFlagError,
} from "./enhancementConfig.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("enhancement feature flags", () => {
  it("defaults every paid capability off even when an OpenAI key exists", () => {
    process.env.OPENAI_API_KEY = "configured-but-must-remain-idle";
    delete process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED;
    delete process.env.POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED;
    delete process.env.POCKETPULSE_FULL_RECLASSIFY_ENABLED;

    expect(getEnhancementFeatureFlags()).toEqual({
      transactionEnhancement: false,
      csvFormatAssistance: false,
      fullReclassification: false,
    });
  });

  it("accepts only explicit true and false values", () => {
    process.env.POCKETPULSE_TRANSACTION_ENHANCEMENT_ENABLED = "true";
    process.env.POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED = "false";
    process.env.POCKETPULSE_FULL_RECLASSIFY_ENABLED = "true";

    expect(getEnhancementFeatureFlags()).toEqual({
      transactionEnhancement: true,
      csvFormatAssistance: false,
      fullReclassification: true,
    });
  });

  it("fails closed on ambiguous configuration", () => {
    process.env.POCKETPULSE_CSV_FORMAT_ASSISTANCE_ENABLED = "yes";

    expect(() => getEnhancementFeatureFlags()).toThrow(
      InvalidEnhancementFlagError,
    );
  });
});
