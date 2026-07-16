import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  clearImportedDataQueries,
  financialDataQueryRoots,
  refreshFinancialDataQueries,
} from "./financialDataQueries";

describe("financial data query refresh", () => {
  it("refetches every cached financial view after an import", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const readers = financialDataQueryRoots.map(() =>
      vi.fn().mockResolvedValue({ refreshed: true }),
    );

    await Promise.all(
      financialDataQueryRoots.map((queryKey, index) =>
        client.fetchQuery({ queryKey, queryFn: readers[index]! }),
      ),
    );

    await refreshFinancialDataQueries(client);

    for (const reader of readers) {
      expect(reader).toHaveBeenCalledTimes(2);
    }
  });

  it("removes stale financial and upload-scoped state after a data wipe", () => {
    const client = new QueryClient();
    const cachedKeys = [
      ...financialDataQueryRoots,
      ["enhancement-availability", 42] as const,
      ["enhancement-job", 91] as const,
      ["active-enhancement-job"] as const,
    ];
    for (const queryKey of cachedKeys) {
      client.setQueryData(queryKey, { stale: true });
    }

    clearImportedDataQueries(client);

    for (const queryKey of cachedKeys) {
      expect(client.getQueryData(queryKey)).toBeUndefined();
    }
  });
});
