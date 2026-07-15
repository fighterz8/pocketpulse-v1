import { describe, expect, it } from "vitest";

import {
  AI_PROCESSING_STALE_AFTER_MS,
  isStaleAiProcessing,
  publicEnhancementError,
} from "./aiLifecycle.js";

describe("AI enhancement lifecycle", () => {
  const now = Date.parse("2026-07-15T16:00:00.000Z");

  it("ages abandoned processing work into a terminal state", () => {
    expect(
      isStaleAiProcessing(
        {
          aiStatus: "processing",
          aiStartedAt: new Date(now - AI_PROCESSING_STALE_AFTER_MS - 1),
        },
        now,
      ),
    ).toBe(true);
  });

  it("does not expire active work or pending uploads", () => {
    expect(
      isStaleAiProcessing(
        { aiStatus: "processing", aiStartedAt: new Date(now - 60_000) },
        now,
      ),
    ).toBe(false);
    expect(
      isStaleAiProcessing(
        { aiStatus: "pending", aiStartedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it("translates provider and runtime failures into user-native language", () => {
    expect(publicEnhancementError("AI chunk timed out after 45000ms")).toMatch(
      /stopped before it finished/i,
    );
    expect(publicEnhancementError("OPENAI_API_KEY is not set")).toMatch(
      /temporarily unavailable/i,
    );
    expect(publicEnhancementError("insufficient_quota")).not.toMatch(/quota/i);
  });
});
