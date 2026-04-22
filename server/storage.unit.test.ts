/**
 * Unit tests for pure helper functions exported from storage.ts.
 * No database connection required — these cover field-mapping rules
 * that the DB-layer tests cannot easily isolate.
 */

import { describe, expect, it } from "vitest";
import { buildUpdateSetValues } from "./storage.js";

describe("buildUpdateSetValues — recurrenceSource provenance rule", () => {
  it("always sets userCorrected=true and labelSource='manual'", () => {
    const sv = buildUpdateSetValues({ category: "food" });
    expect(sv.userCorrected).toBe(true);
    expect(sv.labelSource).toBe("manual");
  });

  it("sets recurrenceSource='manual' when recurrenceType is provided", () => {
    for (const rt of ["recurring", "one-time", "unknown"]) {
      const sv = buildUpdateSetValues({ recurrenceType: rt });
      expect(sv.recurrenceType).toBe(rt);
      expect(sv.recurrenceSource).toBe("manual");
    }
  });

  it("does NOT set recurrenceSource when recurrenceType is absent", () => {
    const sv = buildUpdateSetValues({ category: "transport" });
    expect(sv).not.toHaveProperty("recurrenceSource");
    expect(sv).not.toHaveProperty("recurrenceType");
  });

  it("does NOT set recurrenceSource when recurrenceType is explicitly undefined", () => {
    const sv = buildUpdateSetValues({ recurrenceType: undefined, category: "food" });
    expect(sv).not.toHaveProperty("recurrenceSource");
  });

  it("includes all provided scalar fields alongside recurrenceSource", () => {
    const sv = buildUpdateSetValues({
      category: "utilities",
      transactionClass: "expense",
      recurrenceType: "recurring",
      merchant: "Electric Co",
    });
    expect(sv.category).toBe("utilities");
    expect(sv.transactionClass).toBe("expense");
    expect(sv.recurrenceType).toBe("recurring");
    expect(sv.recurrenceSource).toBe("manual");
    expect(sv.merchant).toBe("Electric Co");
  });

  it("sets excludedAt to a Date when excludedFromAnalysis=true", () => {
    const sv = buildUpdateSetValues({ excludedFromAnalysis: true });
    expect(sv.excludedFromAnalysis).toBe(true);
    expect(sv.excludedAt).toBeInstanceOf(Date);
  });

  it("sets excludedAt to null when excludedFromAnalysis=false", () => {
    const sv = buildUpdateSetValues({ excludedFromAnalysis: false });
    expect(sv.excludedFromAnalysis).toBe(false);
    expect(sv.excludedAt).toBeNull();
  });

  it("does not include optional fields that are not provided", () => {
    const sv = buildUpdateSetValues({});
    expect(sv).not.toHaveProperty("date");
    expect(sv).not.toHaveProperty("merchant");
    expect(sv).not.toHaveProperty("amount");
    expect(sv).not.toHaveProperty("flowType");
    expect(sv).not.toHaveProperty("category");
    expect(sv).not.toHaveProperty("transactionClass");
    expect(sv).not.toHaveProperty("recurrenceType");
    expect(sv).not.toHaveProperty("recurrenceSource");
    expect(sv).not.toHaveProperty("excludedFromAnalysis");
    expect(sv).not.toHaveProperty("excludedReason");
  });
});
