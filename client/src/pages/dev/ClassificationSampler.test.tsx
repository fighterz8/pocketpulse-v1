/**
 * Component tests for the dev Classification Sampler — Task #118.
 *
 * Scope:
 *   - Per-row legibility chips toggle on/off and reflect aria-pressed state.
 *   - Submitting a sample sends the new fields in the PATCH payload, with
 *     explicit nulls for unanswered rows (so downstream analysis can tell
 *     "unanswered" apart from a real "clear/no" answer).
 *   - The report-screen legibility panel renders correct tallies, the
 *     flagged-rows table shows raw descriptions, and the empty-state copy
 *     appears when nothing is flagged.
 *
 * We export ReviewScreen / ReportScreen from the page module so we can
 * render them in isolation without having to mock wouter routing or
 * stand up the full create-sample flow.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassificationVerdict } from "@shared/schema";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock("../../lib/api", () => ({
  apiFetch: mockApiFetch,
  readJsonError: async (res: Response) => {
    try {
      const body = await res.json();
      return body?.error ?? "error";
    } catch {
      return "error";
    }
  },
}));

import {
  ReviewScreen,
  ReportScreen,
  type SampleRecord,
  type SampleTransaction,
} from "./ClassificationSampler";

function makeTxn(id: number, overrides: Partial<SampleTransaction> = {}): SampleTransaction {
  return {
    id,
    date: "2026-01-15",
    rawDescription: `MERCHANT ${id}`,
    amount: -10.5,
    category: "dining",
    transactionClass: "expense",
    recurrenceType: "one-time",
    labelSource: "rule",
    labelConfidence: 0.9,
    ...overrides,
  };
}

function makeVerdict(id: number, overrides: Partial<ClassificationVerdict> = {}): ClassificationVerdict {
  return {
    transactionId: id,
    classifierCategory: "dining",
    classifierClass: "expense",
    classifierRecurrence: "one-time",
    classifierLabelSource: "rule",
    classifierLabelConfidence: 0.9,
    verdict: "confirmed",
    correctedCategory: null,
    correctedClass: null,
    correctedRecurrence: null,
    merchantLegibility: null,
    containsCardNumber: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReviewScreen — legibility controls (Task #118)", () => {
  it("toggles a legibility chip on when clicked and off when clicked again", () => {
    render(
      <ReviewScreen sampleId={1} transactions={[makeTxn(101)]} onSubmitted={() => {}} />,
    );
    const clearBtn = screen.getByTestId("btn-legibility-clear-101");
    expect(clearBtn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(clearBtn);
    expect(clearBtn).toHaveAttribute("aria-pressed", "true");

    // Clicking the same chip again clears the answer (back to "unanswered").
    fireEvent.click(clearBtn);
    expect(clearBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("Yes / No card-number buttons are mutually exclusive and toggle off", () => {
    render(
      <ReviewScreen sampleId={1} transactions={[makeTxn(101)]} onSubmitted={() => {}} />,
    );
    const yes = screen.getByTestId("btn-card-yes-101");
    const no = screen.getByTestId("btn-card-no-101");

    fireEvent.click(yes);
    expect(yes).toHaveAttribute("aria-pressed", "true");
    expect(no).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(no);
    expect(yes).toHaveAttribute("aria-pressed", "false");
    expect(no).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(no);
    expect(no).toHaveAttribute("aria-pressed", "false");
  });

  it("includes legibility fields in the submit payload (with explicit null for unanswered rows)", async () => {
    // Need ≥ 40 verdicts to enable submit per spec §4 — render 40 transactions.
    const txns = Array.from({ length: 40 }, (_, i) => makeTxn(200 + i));
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 1, verdicts: [], completedAt: "now" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<ReviewScreen sampleId={1} transactions={txns} onSubmitted={() => {}} />);

    // Confirm all 40 (default verdict path).
    for (const t of txns) fireEvent.click(screen.getByTestId(`btn-confirm-${t.id}`));
    // Answer legibility on the FIRST row only — the other 39 stay "unanswered".
    fireEvent.click(screen.getByTestId("btn-legibility-illegible-200"));
    fireEvent.click(screen.getByTestId("btn-card-yes-200"));

    fireEvent.click(screen.getByTestId("btn-submit-classification"));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
    const [, options] = mockApiFetch.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.verdicts).toHaveLength(40);

    const answered = body.verdicts.find((v: ClassificationVerdict) => v.transactionId === 200);
    expect(answered.merchantLegibility).toBe("illegible");
    expect(answered.containsCardNumber).toBe(true);

    const unanswered = body.verdicts.find((v: ClassificationVerdict) => v.transactionId === 201);
    // Critical: explicit null, NOT undefined / missing — downstream analysis
    // depends on being able to count "unanswered" as its own bucket.
    expect(unanswered).toHaveProperty("merchantLegibility", null);
    expect(unanswered).toHaveProperty("containsCardNumber", null);
  });
});

describe("ReportScreen — legibility panel (Task #118)", () => {
  function makeCompletedSample(verdicts: ClassificationVerdict[]): SampleRecord {
    return {
      id: 42,
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:10:00Z",
      sampleSize: verdicts.length,
      categoryAccuracy: 1,
      classAccuracy: 1,
      recurrenceAccuracy: 1,
      confirmedCount: verdicts.filter((v) => v.verdict === "confirmed").length,
      correctedCount: verdicts.filter((v) => v.verdict === "corrected").length,
      skippedCount: verdicts.filter((v) => v.verdict === "skipped").length,
      verdicts,
    };
  }

  it("tallies legibility and card-number buckets, including 'Unanswered'", () => {
    const sample = makeCompletedSample([
      makeVerdict(1, { merchantLegibility: "clear",     containsCardNumber: false }),
      makeVerdict(2, { merchantLegibility: "clear",     containsCardNumber: false }),
      makeVerdict(3, { merchantLegibility: "partial",   containsCardNumber: false }),
      makeVerdict(4, { merchantLegibility: "illegible", containsCardNumber: true  }),
      // Unanswered (legacy / old verdicts where the field is absent).
      makeVerdict(5, { merchantLegibility: null, containsCardNumber: null }),
    ]);

    render(<ReportScreen sample={sample} transactions={null} />);

    expect(screen.getByTestId("legibility-panel")).toBeInTheDocument();
    expect(screen.getByTestId("metric-legibility")).toBeInTheDocument();
    expect(screen.getByTestId("metric-card-number")).toBeInTheDocument();

    expect(screen.getByTestId("leg-clear")).toHaveTextContent("2");
    expect(screen.getByTestId("leg-partial")).toHaveTextContent("1");
    expect(screen.getByTestId("leg-illegible")).toHaveTextContent("1");
    expect(screen.getByTestId("leg-unanswered")).toHaveTextContent("1");

    expect(screen.getByTestId("card-yes")).toHaveTextContent("1");
    expect(screen.getByTestId("card-no")).toHaveTextContent("3");
    expect(screen.getByTestId("card-unanswered")).toHaveTextContent("1");
  });

  it("shows flagged rows with hydrated raw descriptions and an OR'd reason column", () => {
    const sample = makeCompletedSample([
      makeVerdict(10, { merchantLegibility: "clear", containsCardNumber: false }),
      makeVerdict(11, { merchantLegibility: "illegible" }),
      makeVerdict(12, { containsCardNumber: true }),
      makeVerdict(13, { merchantLegibility: "illegible", containsCardNumber: true }),
    ]);
    const txns = [
      makeTxn(10, { rawDescription: "STARBUCKS #1234" }),
      makeTxn(11, { rawDescription: "X9F##__GARBLE" }),
      makeTxn(12, { rawDescription: "DEBIT CARD 4111111111111111" }),
      makeTxn(13, { rawDescription: "CARD 4242 — UNREADABLE" }),
    ];

    render(<ReportScreen sample={sample} transactions={txns} />);

    expect(screen.queryByTestId("text-flagged-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-flagged-10")).not.toBeInTheDocument(); // clean row excluded

    const r11 = screen.getByTestId("row-flagged-11");
    expect(within(r11).getByText("X9F##__GARBLE")).toBeInTheDocument();
    expect(r11).toHaveTextContent("illegible");

    const r12 = screen.getByTestId("row-flagged-12");
    expect(within(r12).getByText("DEBIT CARD 4111111111111111")).toBeInTheDocument();
    expect(r12).toHaveTextContent("card #");

    const r13 = screen.getByTestId("row-flagged-13");
    expect(r13).toHaveTextContent("illegible, card #");
  });

  it("falls back to '(unavailable)' when a flagged row has no hydrated transaction", () => {
    const sample = makeCompletedSample([makeVerdict(99, { merchantLegibility: "illegible" })]);
    render(<ReportScreen sample={sample} transactions={null} />);
    expect(screen.getByTestId("row-flagged-99")).toHaveTextContent("(unavailable)");
  });

  it("renders the empty-state when no rows are flagged", () => {
    const sample = makeCompletedSample([
      makeVerdict(1, { merchantLegibility: "clear", containsCardNumber: false }),
      makeVerdict(2, { merchantLegibility: "partial", containsCardNumber: false }),
      makeVerdict(3, {}), // unanswered — neither illegible nor card#=true, so NOT flagged
    ]);
    render(<ReportScreen sample={sample} transactions={[]} />);
    expect(screen.getByTestId("text-flagged-empty")).toBeInTheDocument();
  });
});
