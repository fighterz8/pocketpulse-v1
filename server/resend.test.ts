import { describe, expect, it } from "vitest";

import { assertResendSendSucceeded, formatFromEmail } from "./resend.js";

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

describe("assertResendSendSucceeded", () => {
  it("returns the accepted message data", () => {
    expect(
      assertResendSendSucceeded({ data: { id: "email_123" }, error: null }),
    ).toEqual({ id: "email_123" });
  });

  it("throws when Resend resolves with an API error", () => {
    expect(() =>
      assertResendSendSucceeded({
        data: null,
        error: {
          name: "validation_error",
          message: "Domain not verified",
        },
      }),
    ).toThrow(
      "Resend email send failed: validation_error: Domain not verified",
    );
  });

  it("throws when Resend returns neither data nor an error", () => {
    expect(() =>
      assertResendSendSucceeded({ data: null, error: null }),
    ).toThrow("response contained no message id");
  });
});
