import { describe, expect, it } from "vitest";

import {
  getPlusPlan,
  InvalidPlusPlanConfigError,
  PLUS_PLAN_ENV,
} from "./billingPlan.js";

describe("Plus plan display configuration", () => {
  it("uses the current validation hypothesis by default", () => {
    expect(getPlusPlan({})).toEqual({
      key: "plus",
      name: "PocketPulse Plus",
      monthlyPriceCents: 500,
      currency: "USD",
      interval: "month",
      trialDays: 7,
    });
  });

  it("keeps displayed price and trial configuration explicit", () => {
    expect(
      getPlusPlan({
        [PLUS_PLAN_ENV.monthlyPriceCents]: "800",
        [PLUS_PLAN_ENV.trialDays]: "14",
      }),
    ).toMatchObject({ monthlyPriceCents: 800, trialDays: 14 });
  });

  it.each([
    [PLUS_PLAN_ENV.monthlyPriceCents, "0"],
    [PLUS_PLAN_ENV.monthlyPriceCents, "five"],
    [PLUS_PLAN_ENV.trialDays, "0"],
    [PLUS_PLAN_ENV.trialDays, "31"],
  ])("rejects invalid %s value %s", (name, value) => {
    expect(() => getPlusPlan({ [name]: value })).toThrow(
      InvalidPlusPlanConfigError,
    );
  });
});
