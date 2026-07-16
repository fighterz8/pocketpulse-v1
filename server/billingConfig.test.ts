import { describe, expect, it } from "vitest";

import {
  BILLING_ENV,
  getBillingConfig,
  InvalidBillingConfigError,
} from "./billingConfig.js";

const valid = {
  [BILLING_ENV.enabled]: "true",
  [BILLING_ENV.stripeSecretKey]: "sk_test_example",
  [BILLING_ENV.stripeWebhookSecret]: "whsec_example",
  [BILLING_ENV.stripePlusPriceId]: "price_example",
  [BILLING_ENV.appBaseUrl]: "https://sandbox.pocketpulse.test/",
};

describe("billing configuration", () => {
  it("fails closed when the billing flag is absent", () => {
    expect(getBillingConfig({})).toEqual({ enabled: false });
  });

  it("accepts complete sandbox-only configuration", () => {
    expect(getBillingConfig(valid)).toMatchObject({
      enabled: true,
      provider: "stripe",
      trialDays: 7,
      appBaseUrl: "https://sandbox.pocketpulse.test",
    });
  });

  it("rejects live Stripe keys in the Slice 6 foundation", () => {
    expect(() =>
      getBillingConfig({ ...valid, [BILLING_ENV.stripeSecretKey]: "sk_live_nope" }),
    ).toThrow(InvalidBillingConfigError);
  });

  it.each(["TRUE", "1", "yes"])("rejects ambiguous enabled value %s", (enabled) => {
    expect(() => getBillingConfig({ [BILLING_ENV.enabled]: enabled })).toThrow(
      InvalidBillingConfigError,
    );
  });

  it("requires HTTPS except for local development", () => {
    expect(() =>
      getBillingConfig({ ...valid, [BILLING_ENV.appBaseUrl]: "http://example.test" }),
    ).toThrow(/HTTPS/);
    expect(
      getBillingConfig({ ...valid, [BILLING_ENV.appBaseUrl]: "http://localhost:5000" }),
    ).toMatchObject({ enabled: true });
  });

  it.each(["0", "31", "2.5", "seven"])("rejects invalid trial days %s", (days) => {
    expect(() =>
      getBillingConfig({ ...valid, [BILLING_ENV.trialDays]: days }),
    ).toThrow(InvalidBillingConfigError);
  });
});
