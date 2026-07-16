import { describe, expect, it } from "vitest";

import {
  parseAiUsageCliArgs,
  parseAiUsageReportFilters,
} from "./aiUsageDiagnostics.js";

describe("AI usage diagnostics filters", () => {
  const now = new Date("2026-07-16T18:00:00.000Z");

  it("uses a bounded 30-day UTC window by default", () => {
    expect(parseAiUsageReportFilters({}, now)).toEqual({
      from: new Date("2026-06-16T18:00:00.000Z"),
      to: now,
    });
  });

  it("parses the documented endpoint and CLI filters", () => {
    expect(
      parseAiUsageReportFilters(
        {
          from: "2026-07-01",
          to: "2026-07-16T18:00:00.000Z",
          userId: "12",
          accountId: "34",
          operation: "transaction_classification",
        },
        now,
      ),
    ).toEqual({
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-16T18:00:00.000Z"),
      userId: 12,
      accountId: 34,
      operation: "transaction_classification",
    });
  });

  it.each([
    [{ from: "yesterday" }, /from/i],
    [{ from: "2026-02-31" }, /valid ISO UTC date/i],
    [{ userId: "1e3" }, /userId/i],
    [{ operation: "gpt-5-nano" }, /operation/i],
    [
      { from: "2025-01-01", to: "2026-07-16" },
      /366 days/i,
    ],
  ])("rejects unsafe or ambiguous filters %#", (input, message) => {
    expect(() => parseAiUsageReportFilters(input, now)).toThrow(message);
  });

  it("uses the same validated contract for maintenance CLI flags", () => {
    expect(
      parseAiUsageCliArgs(
        [
          "--from=2026-07-01",
          "--to",
          "2026-07-16T18:00:00.000Z",
          "--userId",
          "12",
          "--accountId=34",
          "--operation",
          "csv_format_detection",
        ],
        now,
      ),
    ).toEqual({
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-16T18:00:00.000Z"),
      userId: 12,
      accountId: 34,
      operation: "csv_format_detection",
    });
    expect(() => parseAiUsageCliArgs(["--model", "gpt-5-nano"], now)).toThrow(
      /unknown AI usage option/i,
    );
    expect(() =>
      parseAiUsageCliArgs(["--userId", "1", "--userId", "2"], now),
    ).toThrow(/duplicate/i);
  });
});
