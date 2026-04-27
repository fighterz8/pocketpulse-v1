import { describe, expect, it } from "vitest";
import { __testing } from "./devTestSuite.js";
import type { ClassificationVerdict } from "../shared/schema.js";

const { validateVerdicts, dimensionAccuracy, parseDevTeamUserIds } = __testing;

function snap(id: number, overrides: Partial<ClassificationVerdict> = {}): ClassificationVerdict {
  return {
    transactionId: id,
    classifierCategory: "dining",
    classifierClass: "expense",
    classifierRecurrence: "one-time",
    classifierLabelSource: "rule",
    classifierLabelConfidence: 0.9,
    verdict: "skipped",
    correctedCategory: null,
    correctedClass: null,
    correctedRecurrence: null,
    ...overrides,
  };
}

describe("parseDevTeamUserIds", () => {
  it("returns [] for empty/undefined", () => {
    expect(parseDevTeamUserIds(undefined)).toEqual([]);
    expect(parseDevTeamUserIds("")).toEqual([]);
    expect(parseDevTeamUserIds("   ")).toEqual([]);
  });
  it("parses comma-separated ints, ignoring junk", () => {
    expect(parseDevTeamUserIds("1, 2 ,3")).toEqual([1, 2, 3]);
    expect(parseDevTeamUserIds("1,abc,7,-2,0,9")).toEqual([1, 7, 9]);
  });
});

describe("validateVerdicts", () => {
  const original = [snap(101), snap(102), snap(103)];

  it("rejects non-array payloads", () => {
    expect(validateVerdicts({}, original).ok).toBe(false);
    expect(validateVerdicts(null, original).ok).toBe(false);
  });

  it("rejects unknown transactionId (anti-tamper)", () => {
    const r = validateVerdicts([{ transactionId: 999, verdict: "confirmed" }], original);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown transactionId/);
  });

  it("rejects duplicate transactionId", () => {
    const r = validateVerdicts(
      [
        { transactionId: 101, verdict: "confirmed" },
        { transactionId: 101, verdict: "skipped" },
      ],
      original,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Duplicate/);
  });

  it("rejects invalid verdict value", () => {
    const r = validateVerdicts([{ transactionId: 101, verdict: "lgtm" }], original);
    expect(r.ok).toBe(false);
  });

  it("force-nulls corrected* fields when verdict !== corrected", () => {
    const r = validateVerdicts(
      [{ transactionId: 101, verdict: "confirmed", correctedCategory: "travel" }],
      original,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdicts[0]!.correctedCategory).toBeNull();
      expect(r.confirmed).toBe(1);
    }
  });

  it("requires at least one corrected* field when verdict=corrected", () => {
    const r = validateVerdicts(
      [{ transactionId: 101, verdict: "corrected" }],
      original,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-set corrected category/class/recurrence", () => {
    const r1 = validateVerdicts(
      [{ transactionId: 101, verdict: "corrected", correctedCategory: "Hovercrafts" }],
      original,
    );
    expect(r1.ok).toBe(false);
    const r2 = validateVerdicts(
      [{ transactionId: 101, verdict: "corrected", correctedClass: "barter" }],
      original,
    );
    expect(r2.ok).toBe(false);
    const r3 = validateVerdicts(
      [{ transactionId: 101, verdict: "corrected", correctedRecurrence: "biweekly" }],
      original,
    );
    expect(r3.ok).toBe(false);
  });

  it("snapshots the classifier output from the original — never lets the client overwrite it", () => {
    const r = validateVerdicts(
      [
        {
          transactionId: 101,
          verdict: "confirmed",
          classifierCategory: "TAMPERED",          // should be ignored
          classifierLabelSource: "ai",             // should be ignored
          classifierLabelConfidence: 0.01,         // should be ignored
        },
      ],
      original,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdicts[0]!.classifierCategory).toBe("dining");
      expect(r.verdicts[0]!.classifierLabelSource).toBe("rule");
      expect(r.verdicts[0]!.classifierLabelConfidence).toBe(0.9);
    }
  });

  // ── Per-row legibility test parameters (Task #118) ────────────────────────
  describe("legibility fields", () => {
    it("rejects an unknown merchantLegibility value", () => {
      const r = validateVerdicts(
        [{ transactionId: 101, verdict: "confirmed", merchantLegibility: "blurry" }],
        original,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/merchantLegibility/);
    });

    it("rejects a non-boolean containsCardNumber", () => {
      const r = validateVerdicts(
        [{ transactionId: 101, verdict: "confirmed", containsCardNumber: "yes" }],
        original,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/containsCardNumber/);
    });

    it("round-trips valid legibility values into the stored verdict", () => {
      const r = validateVerdicts(
        [
          { transactionId: 101, verdict: "confirmed", merchantLegibility: "clear",     containsCardNumber: false },
          { transactionId: 102, verdict: "skipped",   merchantLegibility: "illegible", containsCardNumber: true  },
          { transactionId: 103, verdict: "corrected", correctedCategory: "travel", merchantLegibility: "partial" },
        ],
        original,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.verdicts[0]!.merchantLegibility).toBe("clear");
        expect(r.verdicts[0]!.containsCardNumber).toBe(false);
        expect(r.verdicts[1]!.merchantLegibility).toBe("illegible");
        expect(r.verdicts[1]!.containsCardNumber).toBe(true);
        expect(r.verdicts[2]!.merchantLegibility).toBe("partial");
        // Not provided → null, not omitted
        expect(r.verdicts[2]!.containsCardNumber).toBeNull();
      }
    });

    it("defaults missing legibility fields to null (does not omit them)", () => {
      const r = validateVerdicts(
        [{ transactionId: 101, verdict: "confirmed" }],
        original,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.verdicts[0]).toHaveProperty("merchantLegibility", null);
        expect(r.verdicts[0]).toHaveProperty("containsCardNumber", null);
      }
    });
  });

  it("counts confirmed/corrected/skipped correctly", () => {
    const r = validateVerdicts(
      [
        { transactionId: 101, verdict: "confirmed" },
        { transactionId: 102, verdict: "corrected", correctedCategory: "travel" },
        { transactionId: 103, verdict: "skipped" },
      ],
      original,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.confirmed).toBe(1);
      expect(r.corrected).toBe(1);
      expect(r.skipped).toBe(1);
    }
  });
});

describe("dimensionAccuracy", () => {
  it("returns null when every row was skipped", () => {
    const verdicts = [snap(1, { verdict: "skipped" }), snap(2, { verdict: "skipped" })];
    expect(dimensionAccuracy(verdicts, "correctedCategory")).toBeNull();
  });

  it("computes per-dimension accuracy from corrected* nulls", () => {
    // 4 non-skipped: 1 corrected category, 3 not corrected → 3/4 = 0.75
    const verdicts: ClassificationVerdict[] = [
      snap(1, { verdict: "confirmed" }),
      snap(2, { verdict: "confirmed" }),
      snap(3, { verdict: "corrected", correctedCategory: "travel" }),
      snap(4, { verdict: "corrected", correctedClass: "income" }),
      snap(5, { verdict: "skipped" }), // ignored
    ];
    expect(dimensionAccuracy(verdicts, "correctedCategory")).toBeCloseTo(3 / 4);
    expect(dimensionAccuracy(verdicts, "correctedClass")).toBeCloseTo(3 / 4);
    expect(dimensionAccuracy(verdicts, "correctedRecurrence")).toBe(1);
  });
});
