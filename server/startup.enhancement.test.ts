import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage.js", () => ({
  findStuckProcessingUploads: vi.fn(),
  seedGlobalMerchantClassifications: vi.fn(),
  seedMerchantClassificationsForUser: vi.fn(),
  updateUploadAiStatus: vi.fn(async () => undefined),
}));

vi.mock("./db.js", () => ({
  db: {},
}));

vi.mock("../shared/schema.js", () => ({
  users: {},
}));

import { recoverStuckAiUploads } from "./startup.js";
import {
  findStuckProcessingUploads,
  updateUploadAiStatus,
} from "./storage.js";

describe("legacy enhancement startup cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retires pending and processing states without scheduling paid work", async () => {
    vi.mocked(findStuckProcessingUploads).mockResolvedValue([
      {
        id: 10,
        userId: 1,
        aiStatus: "pending",
        aiStartedAt: null,
        uploadedAt: new Date(),
      },
      {
        id: 11,
        userId: 2,
        aiStatus: "processing",
        aiStartedAt: new Date(),
        uploadedAt: new Date(),
      },
    ]);

    await recoverStuckAiUploads();

    expect(updateUploadAiStatus).toHaveBeenCalledTimes(2);
    for (const [, patch] of vi.mocked(updateUploadAiStatus).mock.calls) {
      expect(patch).toMatchObject({
        aiStatus: "none",
        aiRowsPending: 0,
        aiRowsDone: 0,
        aiStartedAt: null,
        aiCompletedAt: null,
        aiError: null,
      });
    }
  });
});
