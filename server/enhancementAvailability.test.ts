import { describe, expect, it } from "vitest";

import { summarizeUnresolvedTransactions } from "./enhancementAvailability.js";

describe("summarizeUnresolvedTransactions", () => {
  it("counts transactions and deduplicates normalized merchant variants", () => {
    expect(
      summarizeUnresolvedTransactions([
        { merchant: "SQ * NORTH STAR CAFE 0182" },
        { merchant: "North Star Cafe #9921" },
        { merchant: "MYSTERY CLOUD LLC" },
      ]),
    ).toEqual({
      unresolvedTransactionCount: 3,
      unresolvedMerchantCount: 2,
    });
  });

  it("does not invent a merchant for blank normalized keys", () => {
    expect(
      summarizeUnresolvedTransactions([
        { merchant: "" },
        { merchant: "   " },
      ]),
    ).toEqual({
      unresolvedTransactionCount: 2,
      unresolvedMerchantCount: 0,
    });
  });
});
