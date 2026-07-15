import { describe, expect, it } from "vitest";

import { lookupRuleSeedEntries } from "./classifierRuleMigration.js";

describe("lookupRuleSeedEntries", () => {
  it("returns recurring subscription knowledge without database startup seeding", () => {
    const matches = lookupRuleSeedEntries(["netflix", "spotify"]);

    expect(matches.get("netflix")).toMatchObject({
      category: "entertainment",
      transactionClass: "expense",
      recurrenceType: "recurring",
    });
    expect(matches.get("spotify")).toMatchObject({
      category: "software",
      transactionClass: "expense",
      recurrenceType: "recurring",
    });
  });

  it("returns recurring obligation knowledge for housing and utilities", () => {
    const matches = lookupRuleSeedEntries([
      "freedom mortgage",
      "duke energy",
    ]);

    expect(matches.get("freedom mortgage")?.recurrenceType).toBe("recurring");
    expect(matches.get("freedom mortgage")?.category).toBe("housing");
    expect(matches.get("duke energy")?.recurrenceType).toBe(
      "recurring",
    );
    expect(matches.get("duke energy")?.category).toBe(
      "utilities",
    );
  });

  it("ignores unknown and duplicate keys", () => {
    const matches = lookupRuleSeedEntries([
      "netflix",
      "netflix",
      "unknown merchant",
    ]);

    expect([...matches.keys()]).toEqual(["netflix"]);
  });
});
