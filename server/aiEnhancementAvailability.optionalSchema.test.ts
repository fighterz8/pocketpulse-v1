import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { getAiEnhancementAvailability } from "./aiEnhancementJobs.js";

describe("disabled enhancement availability", () => {
  it("returns the Free/Plus projection without querying optional job tables", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        const sql = String(statement);
        queries.push(sql);
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("FROM uploads")) {
          return { rows: [{ status: "complete" }] };
        }
        if (sql.includes("FROM transactions")) {
          return {
            rows: [
              { id: 11, merchant: "PYMT*NETFLIX.COM" },
              { id: 12, merchant: "NETFLIX 8473923" },
            ],
          };
        }
        throw new Error(`optional schema query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const connectionPool = {
      connect: vi.fn(async () => client),
    } as unknown as Pick<pg.Pool, "connect">;

    await expect(getAiEnhancementAvailability({
      userId: 7,
      uploadId: 9,
      featureEnabled: false,
      providerAvailable: false,
    }, connectionPool)).resolves.toEqual({
      uploadId: 9,
      state: "blocked",
      unresolvedTransactionCount: 2,
      unresolvedMerchantCount: 1,
      blockedReason: "FEATURE_DISABLED",
    });

    expect(queries.join("\n")).not.toContain("ai_enhancement_jobs");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("preserves the resolved-import state without querying optional job tables", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        const sql = String(statement);
        queries.push(sql);
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("FROM uploads")) {
          return { rows: [{ status: "complete" }] };
        }
        if (sql.includes("FROM transactions")) return { rows: [] };
        throw new Error(`optional schema query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const connectionPool = {
      connect: vi.fn(async () => client),
    } as unknown as Pick<pg.Pool, "connect">;

    await expect(getAiEnhancementAvailability({
      userId: 7,
      uploadId: 9,
      featureEnabled: false,
      providerAvailable: false,
    }, connectionPool)).resolves.toMatchObject({
      state: "not_needed",
      unresolvedTransactionCount: 0,
      unresolvedMerchantCount: 0,
    });

    expect(queries.join("\n")).not.toContain("ai_enhancement_jobs");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
