import { describe, expect, it } from "vitest";

import { formatFromEmail } from "./resend.js";

describe("formatFromEmail", () => {
  it("adds the PocketPulse display name to a plain configured address", () => {
    expect(formatFromEmail("noreply@pocket-pulse.com")).toBe(
      "PocketPulse <noreply@pocket-pulse.com>",
    );
  });

  it("preserves an explicitly configured display name", () => {
    expect(formatFromEmail("PocketPulse Support <support@pocket-pulse.com>")).toBe(
      "PocketPulse Support <support@pocket-pulse.com>",
    );
  });
});
