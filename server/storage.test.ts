import { describe, expect, it } from "vitest";
import { buildTransactionFilters, type ListTransactionsOptions } from "./storage.js";

describe("buildTransactionFilters", () => {
  const base: ListTransactionsOptions = { userId: 1 };

  it("returns only the userId condition when no extra filters", () => {
    const conditions = buildTransactionFilters(base);
    expect(conditions).toHaveLength(1);
  });

  it("adds accountId filter", () => {
    const conditions = buildTransactionFilters({ ...base, accountId: 5 });
    expect(conditions).toHaveLength(2);
  });

  it("adds search filter (merchant + rawDescription)", () => {
    const conditions = buildTransactionFilters({ ...base, search: "coffee" });
    expect(conditions).toHaveLength(2);
  });

  it("adds category filter", () => {
    const conditions = buildTransactionFilters({ ...base, category: "dining" });
    expect(conditions).toHaveLength(2);
  });

  it("adds transactionClass filter", () => {
    const conditions = buildTransactionFilters({ ...base, transactionClass: "expense" });
    expect(conditions).toHaveLength(2);
  });

  it("adds recurrenceType filter", () => {
    const conditions = buildTransactionFilters({ ...base, recurrenceType: "recurring" });
    expect(conditions).toHaveLength(2);
  });

  it("adds dateFrom filter", () => {
    const conditions = buildTransactionFilters({ ...base, dateFrom: "2026-01-01" });
    expect(conditions).toHaveLength(2);
  });

  it("adds dateTo filter", () => {
    const conditions = buildTransactionFilters({ ...base, dateTo: "2026-12-31" });
    expect(conditions).toHaveLength(2);
  });

  it("adds excluded=true filter", () => {
    const conditions = buildTransactionFilters({ ...base, excluded: "true" });
    expect(conditions).toHaveLength(2);
  });

  it("adds excluded=false filter", () => {
    const conditions = buildTransactionFilters({ ...base, excluded: "false" });
    expect(conditions).toHaveLength(2);
  });

  it("does not add excluded filter when excluded=all", () => {
    const conditions = buildTransactionFilters({ ...base, excluded: "all" });
    expect(conditions).toHaveLength(1);
  });

  it("combines all filters", () => {
    const conditions = buildTransactionFilters({
      ...base,
      accountId: 2,
      search: "test",
      category: "groceries",
      transactionClass: "expense",
      recurrenceType: "one-time",
      dateFrom: "2026-01-01",
      dateTo: "2026-06-30",
      excluded: "false",
    });
    expect(conditions).toHaveLength(9);
  });
});
