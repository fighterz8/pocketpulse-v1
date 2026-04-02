import { describe, expect, it } from "vitest";

import { classifyTransaction, type ClassificationResult } from "./classifier.js";

describe("classifyTransaction", () => {
  it("classifies a subscription service", () => {
    const result = classifyTransaction("NETFLIX INC", -15.99, "outflow");
    expect(result.category).toBe("subscriptions");
    expect(result.transactionClass).toBe("expense");
    expect(result.labelSource).toBe("rule");
    expect(result.labelReason).toBeTruthy();
  });

  it("classifies grocery stores", () => {
    const result = classifyTransaction("WHOLE FOODS MARKET", -85.20, "outflow");
    expect(result.category).toBe("groceries");
    expect(result.transactionClass).toBe("expense");
  });

  it("classifies dining/restaurants", () => {
    const result = classifyTransaction("CHIPOTLE MEXICAN GRILL", -12.50, "outflow");
    expect(result.category).toBe("dining");
  });

  it("classifies utility payments", () => {
    const result = classifyTransaction("ELECTRIC COMPANY", -120.00, "outflow");
    expect(result.category).toBe("utilities");
  });

  it("classifies income from inflow", () => {
    const result = classifyTransaction("PAYROLL DEPOSIT", 3500.00, "inflow");
    expect(result.category).toBe("income");
    expect(result.transactionClass).toBe("income");
  });

  it("classifies transfers", () => {
    const result = classifyTransaction("TRANSFER TO SAVINGS", -500.00, "outflow");
    expect(result.category).toBe("transfers");
    expect(result.transactionClass).toBe("transfer");
  });

  it("classifies insurance payments", () => {
    const result = classifyTransaction("STATE FARM INSURANCE", -150.00, "outflow");
    expect(result.category).toBe("insurance");
  });

  it("classifies transportation/gas", () => {
    const result = classifyTransaction("SHELL GAS STATION", -45.00, "outflow");
    expect(result.category).toBe("transportation");
  });

  it("classifies health-related", () => {
    const result = classifyTransaction("CVS PHARMACY", -22.00, "outflow");
    expect(result.category).toBe("health");
  });

  it("classifies shopping", () => {
    const result = classifyTransaction("AMAZON.COM", -49.99, "outflow");
    expect(result.category).toBe("shopping");
  });

  it("classifies fees", () => {
    const result = classifyTransaction("MONTHLY SERVICE FEE", -12.00, "outflow");
    expect(result.category).toBe("fees");
  });

  it("classifies housing/rent", () => {
    const result = classifyTransaction("RENT PAYMENT", -1200.00, "outflow");
    expect(result.category).toBe("housing");
  });

  it("classifies refunds", () => {
    const result = classifyTransaction("REFUND FROM AMAZON", 29.99, "inflow");
    expect(result.transactionClass).toBe("refund");
  });

  it("defaults unknown merchants to 'other'", () => {
    const result = classifyTransaction("XYZZY CORP #99", -10.00, "outflow");
    expect(result.category).toBe("other");
  });

  it("returns confidence score between 0 and 1", () => {
    const result = classifyTransaction("NETFLIX INC", -15.99, "outflow");
    expect(result.labelConfidence).toBeGreaterThanOrEqual(0);
    expect(result.labelConfidence).toBeLessThanOrEqual(1);
  });

  it("sets recurrenceType to one-time by default", () => {
    const result = classifyTransaction("RANDOM STORE", -5.00, "outflow");
    expect(result.recurrenceType).toBe("one-time");
  });

  it("hints recurring for known subscription merchants", () => {
    const result = classifyTransaction("SPOTIFY PREMIUM", -9.99, "outflow");
    expect(result.recurrenceType).toBe("recurring");
  });

  it("classifies business software", () => {
    const result = classifyTransaction("GITHUB INC", -4.00, "outflow");
    expect(result.category).toBe("business_software");
  });

  it("classifies entertainment", () => {
    const result = classifyTransaction("AMC THEATRES", -18.00, "outflow");
    expect(result.category).toBe("entertainment");
  });

  it("classifies debt payments", () => {
    const result = classifyTransaction("STUDENT LOAN PAYMENT", -300.00, "outflow");
    expect(result.category).toBe("debt");
  });
});
