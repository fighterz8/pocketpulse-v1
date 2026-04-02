import { describe, expect, it } from "vitest";

describe("project config", () => {
  it("defines a Phase 1 typecheck script", async () => {
    const pkg = await import("../package.json");
    expect(pkg.default.scripts.check).toBeDefined();
  });
});
