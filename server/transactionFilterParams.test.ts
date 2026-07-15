import { describe, expect, it } from "vitest";

import { parseTransactionIdsParam } from "./transactionFilterParams.js";

describe("parseTransactionIdsParam", () => {
  it("parses and deduplicates a Leak Hunter transaction selection", () => {
    expect(parseTransactionIdsParam("13,12,13")).toEqual([13, 12]);
  });

  it("distinguishes an absent filter from a malformed one", () => {
    expect(parseTransactionIdsParam(undefined)).toBeUndefined();
    expect(parseTransactionIdsParam("")).toBeNull();
    expect(parseTransactionIdsParam("13,nope")).toBeNull();
    expect(parseTransactionIdsParam("0,12")).toBeNull();
  });

  it("rejects oversized exact selections", () => {
    const tooMany = Array.from({ length: 251 }, (_, i) => i + 1).join(",");
    expect(parseTransactionIdsParam(tooMany)).toBeNull();
  });
});
