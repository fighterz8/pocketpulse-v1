import { describe, expect, it, vi } from "vitest";

vi.mock("./db.js", () => ({ pool: {} }));

import {
  PlusEntitlementRequiredError,
  assertPlusEntitlement,
  resolveBillingEntitlement,
} from "./billingEntitlements.js";

const now = new Date("2026-07-16T18:00:00.000Z");

describe("Plus entitlement resolution", () => {
  it("keeps free access and exposes one unconsumed trial", () => {
    expect(
      resolveBillingEntitlement({ subscription: null, trialConsumed: false, now }),
    ).toEqual({ state: "free", trialAvailable: true, entitled: false });
  });

  it("does not restore trial eligibility after its durable row exists", () => {
    expect(
      resolveBillingEntitlement({ subscription: null, trialConsumed: true, now }),
    ).toEqual({ state: "free", trialAvailable: false, entitled: false });
  });

  it("grants only an unexpired trial", () => {
    expect(
      resolveBillingEntitlement({
        subscription: {
          accessState: "trialing",
          trialEndsAt: new Date("2026-07-17T18:00:00.000Z"),
          currentPeriodEndsAt: null,
        },
        trialConsumed: true,
        now,
      }),
    ).toMatchObject({ state: "trialing", entitled: true, trialAvailable: false });
    expect(
      resolveBillingEntitlement({
        subscription: {
          accessState: "trialing",
          trialEndsAt: now,
          currentPeriodEndsAt: null,
        },
        trialConsumed: true,
        now,
      }),
    ).toEqual({ state: "expired", entitled: false, trialAvailable: false });
  });

  it("grants active access only through the current period", () => {
    expect(
      resolveBillingEntitlement({
        subscription: {
          accessState: "active",
          trialEndsAt: null,
          currentPeriodEndsAt: new Date("2026-08-16T18:00:00.000Z"),
        },
        trialConsumed: false,
        now,
      }),
    ).toMatchObject({ state: "active", entitled: true });
    expect(
      resolveBillingEntitlement({
        subscription: {
          accessState: "active",
          trialEndsAt: null,
          currentPeriodEndsAt: now,
        },
        trialConsumed: false,
        now,
      }),
    ).toEqual({ state: "expired", entitled: false, trialAvailable: true });
  });

  it.each(["past_due", "expired"] as const)("denies %s subscriptions", (state) => {
    expect(
      resolveBillingEntitlement({
        subscription: {
          accessState: state,
          trialEndsAt: null,
          currentPeriodEndsAt: null,
        },
        trialConsumed: true,
        now,
      }),
    ).toEqual({ state, entitled: false, trialAvailable: false });
  });

  it("throws a typed error when a protected operation is not entitled", async () => {
    await expect(
      assertPlusEntitlement(7, async () => ({
        state: "past_due",
        trialAvailable: false,
        entitled: false,
      })),
    ).rejects.toBeInstanceOf(PlusEntitlementRequiredError);
  });
});
