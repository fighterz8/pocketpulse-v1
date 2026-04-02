# Phase 4: Recurring Leak Review + CSV Parser Bug Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the CSV parser sign bug that misclassifies all transactions as income, build a recurring transaction detection engine, and deliver the Leaks page where users review recurring candidates as essential, leak-related, or dismissed.

**Architecture:** Fix csvParser.ts to prefer debit/credit columns over unsigned Amount columns. Build `recurrenceDetector.ts` that groups outflow transactions by normalized merchant key + amount bucket, detects frequency via median interval analysis, and scores confidence from interval regularity, amount consistency, count, and recency. Expose candidates via API, persist review decisions in a new `recurring_reviews` table (keyed on userId + candidateKey which encodes merchant + amount bucket), and render card-based review UI on the Leaks page.

**Tech Stack:** TypeScript, Drizzle ORM, Express, React, TanStack Query, Vitest

---

## Bug Diagnosis: All Transactions Classified as "Income"

### Root Cause

The data flow is: CSV row -> `parseCSV` -> route handler (`inferFlowType` + `classifyTransaction`).

**`server/csvParser.ts:159-162`**: When a single "Amount" column is detected (`amountIdx !== null`), the parser uses `normalizeAmount(rawAmount)` which only produces negative values from explicit minus signs or accounting parentheses `(123.45)`. Most bank CSVs export all amounts as positive numbers (e.g. `42.50` for a purchase), so the parser returns positive amounts for expenses.

**`server/transactionUtils.ts:51-52`**: `inferFlowType` returns `"inflow"` for any `signedAmount >= 0`. Since amounts are all positive, every transaction gets `flowType = "inflow"`.

**`server/classifier.ts:414-415`**: When `flowType === "inflow"` and the merchant doesn't match transfer/refund keywords, the classifier assigns `transactionClass = "income"` and `category = "income"`.

**The fix:** When both Amount AND Debit/Credit columns exist in the CSV, prefer deriving sign from debit/credit. When only Amount exists, use it as-is (the sign is explicit in the CSV).

### Exact Fix

In `csvParser.ts`, change the amount resolution priority:
1. If debit/credit columns exist -> always use `deriveSignedAmount` from debit/credit (ignore Amount column)
2. If only Amount column exists -> use it as-is (negative means outflow, positive means inflow)

This is the simplest, most correct fix: banks that provide separate debit/credit columns are indicating direction explicitly.

---

## Recurring Detection Algorithm — Design Rationale

### Why group by merchant + amount bucket?

A single merchant (e.g. Amazon) can have both recurring charges ($14.99/mo Prime) and one-off purchases ($237.48). Grouping only by merchant would mix these. Amount bucketing separates distinct charge patterns within the same merchant, using 25% tolerance + $2 floor to absorb utility bill variability.

### Why median interval instead of mean?

A single missed or late payment creates an outlier gap. Mean would skew badly; median is robust to one outlier. Intervals exceeding 2.5x the median are filtered out before computing standard deviation.

### Frequency matching

The detector tests each bucket against known cadences (weekly +/-2d, monthly +/-5d, quarterly +/-15d, annual +/-30d). If the median interval doesn't match any cadence, the bucket is not flagged — it's irregular spending, not a subscription.

### Confidence scoring (4 weighted signals)

- **Interval regularity (0.35)**: How tightly spaced are charges vs expected cadence. Coefficient of variation (stdDev / medianInterval). cv=0 -> 1.0, cv>=0.5 -> 0.0.
- **Amount consistency (0.25)**: How stable is the charge amount. Subscriptions = stable, utilities = variable. For known variable categories (utilities, insurance), penalty is gentler.
- **Transaction count (0.20)**: More history = more certainty. 3 txns = 0.4, 6+ = 1.0.
- **Recency (0.20)**: Is it still active? Full score if last charge <=1.5x expected interval ago. Zero if >=3x (probably cancelled).

Each signal produces 0.0-1.0. Weighted sum yields overall confidence. Threshold: >=0.35 to surface.

### Minimum transaction counts by frequency

- Weekly, biweekly, monthly: 3 transactions minimum
- Quarterly: 3 transactions minimum
- Annual: 2 transactions minimum (annual charges are rare by definition, but require >=330 days span)

### Candidate key design

Since a single merchant can have multiple recurring patterns (e.g. Amazon Prime $14.99/mo + Amazon Fresh $120/week), the candidate key must encode both merchant and amount bucket. Format: `merchantKey|roundedCentroid` (e.g. `"amazon|14.99"`, `"amazon|120.00"`). This key is stored in `recurring_reviews.candidateKey` for persistent reviews.

### Edge cases handled

- **Price changes** (Netflix hike): split bucket at change point if amounts shift >20%, use recent segment
- **Variable amounts** (utilities): categories like `utilities`/`insurance` get gentler amount penalty (CV multiplier 2.0 vs 3.33)
- **Missed payments**: median + outlier filtering (discard intervals >2.5x median) absorb one gap
- **Seasonal charges** (annual/quarterly): detected natively; annual needs only 2 transactions with >=330d span

### Review statuses

- `unreviewed` — Not yet reviewed, surfaced in leak review
- `essential` — User confirms this is needed, counted in essential recurring expenses
- `leak` — User flags as wasteful, counted in leak spend
- `dismissed` — User says ignore, hidden from review, excluded from leak calcs

---

## File Structure

### New files
- `server/recurrenceDetector.ts` — detection engine (grouping, frequency, scoring)
- `server/recurrenceDetector.test.ts` — TDD tests for detection logic
- `server/recurring-routes.test.ts` — route tests for recurring API
- `client/src/hooks/use-recurring.ts` — TanStack Query hook for candidates + reviews
- `client/src/pages/Leaks.test.tsx` — client tests
- `docs/superpowers/specs/2026-04-02-phase-4-recurring-leak-review-design.md`
- `docs/phase-logs/phase-4-recurring-leak-review-progress.md`

### Modified files
- `shared/schema.ts` — add `recurringReviews` table
- `server/csvParser.ts` — fix amount sign when debit/credit columns present
- `server/csvParser.test.ts` — add test for debit/credit + Amount column CSV
- `server/storage.ts` — add recurring review CRUD functions
- `server/routes.ts` — add recurring candidate + review API routes
- `client/src/pages/Leaks.tsx` — replace placeholder with full review UI
- `client/src/index.css` — add Leaks page styles
- `README.md` — Phase 4 section + verification steps

---

## Task Breakdown

### Task 1: Branch setup + design spec + progress log

**Files:**
- Create: `docs/superpowers/specs/2026-04-02-phase-4-recurring-leak-review-design.md`
- Create: `docs/phase-logs/phase-4-recurring-leak-review-progress.md`

- [ ] **Step 1: Create branch from phase-3 tip**

```bash
git checkout feature/phase-3-ledger-review
git checkout -b feature/phase-4-recurring-leak-review
```

- [ ] **Step 2: Write design spec**

Create `docs/superpowers/specs/2026-04-02-phase-4-recurring-leak-review-design.md` with the detection algorithm rationale, API design, schema, and acceptance criteria from this plan. Include the full algorithm description, confidence scoring weights, threshold table, and edge case handling.

- [ ] **Step 3: Write progress log**

Create `docs/phase-logs/phase-4-recurring-leak-review-progress.md` with task table (pending for all tasks).

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(phase-4): add recurring leak review design spec and progress log"
```

---

### Task 2: Fix CSV parser sign bug

**Files:**
- Modify: `server/csvParser.ts:159-172`
- Modify: `server/csvParser.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/csvParser.test.ts`:

```typescript
it("prefers debit/credit columns over unsigned Amount column", async () => {
  const csv = makeCsv([
    "Date,Description,Amount,Debit,Credit",
    "01/15/2026,NETFLIX INC,15.99,15.99,",
    "01/16/2026,PAYROLL DEPOSIT,3500.00,,3500.00",
  ]);

  const result = await parseCSV(csv, "test.csv");

  expect(result.ok).toBe(true);
  const { rows } = result as CSVParseResult & { ok: true };
  expect(rows).toHaveLength(2);
  expect(rows[0]!.amount).toBe(-15.99);   // debit -> negative
  expect(rows[1]!.amount).toBe(3500.0);   // credit -> positive
});

it("handles CSV with only unsigned positive amounts (no debit/credit)", async () => {
  const csv = makeCsv([
    "Date,Description,Amount",
    "01/15/2026,NETFLIX INC,15.99",
    "01/16/2026,PAYROLL DEPOSIT,3500.00",
  ]);

  const result = await parseCSV(csv, "test.csv");

  expect(result.ok).toBe(true);
  const { rows } = result as CSVParseResult & { ok: true };
  expect(rows[0]!.amount).toBe(15.99);
  expect(rows[1]!.amount).toBe(3500.0);
});
```

- [ ] **Step 2: Run test to verify first test fails**

```bash
npx vitest run server/csvParser.test.ts
```

Expected: First test FAILs — returns `15.99` instead of `-15.99` because Amount column currently wins over debit/credit.

- [ ] **Step 3: Fix csvParser.ts**

In `server/csvParser.ts`, replace the amount resolution block (lines 159-172):

```typescript
    let amount: number;
    if (mapping.debitIdx !== null || mapping.creditIdx !== null) {
      // Prefer debit/credit when available — they carry explicit direction
      const rawDebit = mapping.debitIdx !== null ? row[mapping.debitIdx] ?? "" : "";
      const rawCredit = mapping.creditIdx !== null ? row[mapping.creditIdx] ?? "" : "";
      const debitVal = rawDebit ? normalizeAmount(rawDebit) : 0;
      const creditVal = rawCredit ? normalizeAmount(rawCredit) : 0;
      amount = deriveSignedAmount({
        debit: isNaN(debitVal) ? 0 : debitVal,
        credit: isNaN(creditVal) ? 0 : creditVal,
      });
    } else if (mapping.amountIdx !== null) {
      const rawAmount = row[mapping.amountIdx] ?? "";
      amount = normalizeAmount(rawAmount);
    } else {
      amount = NaN;
    }
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
npx vitest run server/csvParser.test.ts
```

Expected: All tests PASS including new debit/credit priority test.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
```

Expected: All 117+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/csvParser.ts server/csvParser.test.ts
git commit -m "fix(csv): prefer debit/credit columns over unsigned Amount for sign detection

When CSV has both Amount and Debit/Credit columns, use debit/credit to
derive signed amounts. Fixes bug where all transactions were classified
as income because unsigned positive amounts in the Amount column
produced flowType=inflow for every row."
```

---

### Task 3: Add `recurring_reviews` schema

**Files:**
- Modify: `shared/schema.ts`
- Modify: `server/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/schema.test.ts`, importing `recurringReviews` and `getTableConfig`:

```typescript
it("exports recurringReviews table with expected name and columns", () => {
  const config = getTableConfig(recurringReviews);
  expect(config.name).toBe("recurring_reviews");
  const colNames = config.columns.map((c) => c.name);
  expect(colNames).toContain("id");
  expect(colNames).toContain("user_id");
  expect(colNames).toContain("candidate_key");
  expect(colNames).toContain("status");
  expect(colNames).toContain("notes");
  expect(colNames).toContain("reviewed_at");
  expect(colNames).toContain("created_at");
});

it("has unique index on (user_id, candidate_key) in recurring_reviews", () => {
  const config = getTableConfig(recurringReviews);
  const idx = config.indexes.find(
    (i) => i.config.name === "recurring_reviews_user_candidate_idx",
  );
  expect(idx).toBeDefined();
  expect(idx!.config.unique).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run server/schema.test.ts
```

Expected: FAIL — `recurringReviews` not exported.

- [ ] **Step 3: Add schema to `shared/schema.ts`**

Add before the `session` table. Use `candidateKey` (format: `"merchantKey|roundedAmount"`) as the review identifier, with a **unique** index on `(userId, candidateKey)`:

```typescript
export const REVIEW_STATUSES = ["unreviewed", "essential", "leak", "dismissed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const recurringReviews = pgTable(
  "recurring_reviews",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    candidateKey: text("candidate_key").notNull(),
    status: text("status").notNull().default("unreviewed"),
    notes: text("notes"),
    reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("recurring_reviews_user_id_idx").on(t.userId),
    uniqueIndex("recurring_reviews_user_candidate_idx").on(t.userId, t.candidateKey),
  ],
);
```

Import `uniqueIndex` from `drizzle-orm/pg-core`.

- [ ] **Step 4: Run tests**

```bash
npx vitest run server/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add shared/schema.ts server/schema.test.ts
git commit -m "feat(schema): add recurring_reviews table for leak review persistence

Stores user review decisions (essential/leak/dismissed/unreviewed) per
candidate pattern (candidateKey = merchantKey|amount). Unique index on
(userId, candidateKey) prevents duplicates and enables atomic upsert."
```

---

### Task 4: Build recurrence detector engine

**Files:**
- Create: `server/recurrenceDetector.ts`
- Create: `server/recurrenceDetector.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/recurrenceDetector.test.ts`. The test helper `makeTxn` creates mock transaction objects matching the shape returned by `listAllTransactionsForExport`:

```typescript
import { describe, expect, it } from "vitest";
import {
  recurrenceKey,
  buildCandidateKey,
  detectRecurringCandidates,
  type RecurringCandidate,
} from "./recurrenceDetector.js";

function makeTxn(overrides: Partial<{
  id: number; date: string; amount: string; merchant: string;
  flowType: string; category: string; excludedFromAnalysis: boolean;
}>) {
  return {
    id: overrides.id ?? 1,
    userId: 1, uploadId: 1, accountId: 1,
    date: overrides.date ?? "2026-01-15",
    amount: overrides.amount ?? "-15.99",
    merchant: overrides.merchant ?? "Netflix",
    rawDescription: overrides.merchant ?? "Netflix",
    flowType: overrides.flowType ?? "outflow",
    transactionClass: "expense",
    recurrenceType: "one-time",
    category: overrides.category ?? "subscriptions",
    labelSource: "rule", labelConfidence: "0.80", labelReason: null,
    aiAssisted: false, userCorrected: false,
    excludedFromAnalysis: overrides.excludedFromAnalysis ?? false,
    excludedReason: null, excludedAt: null,
    createdAt: "2026-01-15T00:00:00Z",
  };
}

describe("recurrenceKey", () => {
  it("lowercases and trims", () => {
    expect(recurrenceKey("  Netflix  ")).toBe("netflix");
  });

  it("strips POS prefixes", () => {
    expect(recurrenceKey("SQ *Coffee Shop")).toBe("coffee shop");
  });

  it("strips trailing reference numbers", () => {
    expect(recurrenceKey("Spotify #12345")).toBe("spotify");
  });

  it("collapses whitespace", () => {
    expect(recurrenceKey("Home   Depot")).toBe("home depot");
  });
});

describe("buildCandidateKey", () => {
  it("combines merchant key and rounded amount", () => {
    expect(buildCandidateKey("netflix", 15.99)).toBe("netflix|15.99");
  });

  it("rounds to 2 decimal places", () => {
    expect(buildCandidateKey("utilities", 127.333)).toBe("utilities|127.33");
  });
});

describe("detectRecurringCandidates", () => {
  it("returns empty array when no transactions", () => {
    expect(detectRecurringCandidates([])).toEqual([]);
  });

  it("returns empty when all transactions are inflows", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", flowType: "inflow", amount: "3500" }),
      makeTxn({ id: 2, date: "2026-02-15", flowType: "inflow", amount: "3500" }),
      makeTxn({ id: 3, date: "2026-03-15", flowType: "inflow", amount: "3500" }),
    ];
    expect(detectRecurringCandidates(txns)).toEqual([]);
  });

  it("detects monthly recurring charges", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-15.99", merchant: "Netflix" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const netflix = candidates.find((c) => c.candidateKey.startsWith("netflix|"));
    expect(netflix).toBeDefined();
    expect(netflix!.frequency).toBe("monthly");
    expect(netflix!.averageAmount).toBeCloseTo(15.99, 1);
    expect(netflix!.confidence).toBeGreaterThan(0.35);
  });

  it("does not flag monthly merchants with fewer than 3 transactions", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(0);
  });

  it("detects annual charges with only 2 transactions spanning >=330 days", () => {
    const txns = [
      makeTxn({ id: 1, date: "2025-01-10", amount: "-99.00", merchant: "Domain Registrar" }),
      makeTxn({ id: 2, date: "2026-01-08", amount: "-99.00", merchant: "Domain Registrar" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.frequency).toBe("annual");
  });

  it("excludes transactions marked excludedFromAnalysis", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix", excludedFromAnalysis: true }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix", excludedFromAnalysis: true }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-15.99", merchant: "Netflix", excludedFromAnalysis: true }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(0);
  });

  it("separates one-off purchases from recurring at same merchant", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-14.99", merchant: "Amazon" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-14.99", merchant: "Amazon" }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-14.99", merchant: "Amazon" }),
      makeTxn({ id: 4, date: "2026-02-20", amount: "-237.48", merchant: "Amazon" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    const recurring = candidates.filter((c) => c.candidateKey.startsWith("amazon|"));
    expect(recurring.length).toBe(1);
    expect(recurring[0]!.averageAmount).toBeCloseTo(14.99, 1);
  });

  it("detects variable-amount recurring (utility bills)", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-10", amount: "-85.00", merchant: "City Power", category: "utilities" }),
      makeTxn({ id: 2, date: "2026-02-10", amount: "-92.00", merchant: "City Power", category: "utilities" }),
      makeTxn({ id: 3, date: "2026-03-10", amount: "-88.00", merchant: "City Power", category: "utilities" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.frequency).toBe("monthly");
  });

  it("handles quarterly frequency", () => {
    const txns = [
      makeTxn({ id: 1, date: "2025-04-15", amount: "-250.00", merchant: "Insurance Co" }),
      makeTxn({ id: 2, date: "2025-07-15", amount: "-250.00", merchant: "Insurance Co" }),
      makeTxn({ id: 3, date: "2025-10-15", amount: "-250.00", merchant: "Insurance Co" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.frequency).toBe("quarterly");
  });

  it("generates a reason flagged string", () => {
    const txns = [
      makeTxn({ id: 1, date: "2026-01-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 2, date: "2026-02-15", amount: "-15.99", merchant: "Netflix" }),
      makeTxn({ id: 3, date: "2026-03-15", amount: "-15.99", merchant: "Netflix" }),
    ];

    const candidates = detectRecurringCandidates(txns);
    expect(candidates[0]!.reasonFlagged).toBeTruthy();
    expect(candidates[0]!.reasonFlagged.length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run server/recurrenceDetector.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement recurrenceDetector.ts**

Create `server/recurrenceDetector.ts` implementing:
- `recurrenceKey(merchant)` — normalize merchant to grouping key (lowercase, strip POS prefixes, strip trailing references/location, collapse whitespace)
- `buildCandidateKey(merchantKey, avgAmount)` — combine `merchantKey|roundedAmount` for persistence
- `groupTransactions(txns)` — group by key, exclude inflows + excluded
- `bucketByAmount(txns)` — sub-group by amount tolerance (25% / $2 floor)
- `detectFrequency(txns)` — compute intervals, take median, match to known cadences: weekly (+/-2d), biweekly (+/-3d), monthly (+/-5d), quarterly (+/-15d), annual (+/-30d). Filter outlier intervals >2.5x median before computing stdDev.
- `scoreConfidence(txns, freq, category)` — weighted 4-signal composite (intervals 0.35, amounts 0.25, count 0.20, recency 0.20). For variable-amount categories (utilities, insurance, health), use gentler amount penalty (CV multiplier 2.0 vs 3.33).
- `buildReasonFlagged(...)` — human-readable explanation: e.g. "6 charges of ~$15.49 detected monthly at a consistent amount"
- `detectRecurringCandidates(txns)` — full pipeline: group -> bucket -> frequency -> score -> filter (>=0.35) -> sort (confidence desc, then amount desc). Returns `RecurringCandidate[]`.

Key `RecurringCandidate` type:

```typescript
export type RecurringCandidate = {
  candidateKey: string;       // "merchantKey|roundedAmount" for persistence
  merchantKey: string;
  merchantDisplay: string;    // original merchant from most recent txn
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
  averageAmount: number;
  amountStdDev: number;
  confidence: number;         // 0.0 - 1.0
  reasonFlagged: string;
  transactionIds: number[];
  firstSeen: string;          // ISO date
  lastSeen: string;           // ISO date
  expectedNextDate: string;   // ISO date
  category: string;
};
```

Minimum count logic:
- Annual: 2 transactions + >=330 day span between first and last
- All other frequencies: 3 transactions

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/recurrenceDetector.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add server/recurrenceDetector.ts server/recurrenceDetector.test.ts
git commit -m "feat(recurring): add recurrence detection engine

Groups outflow transactions by normalized merchant key, sub-groups by
amount bucket (25% tolerance), detects frequency via median interval
matching, and scores confidence from interval regularity (0.35),
amount consistency (0.25), count (0.20), and recency (0.20).
Candidate key encodes merchant+amount for unique review persistence.
Annual detection allows 2 transactions with >=330d span."
```

---

### Task 5: Storage functions for recurring reviews

**Files:**
- Modify: `server/storage.ts`

- [ ] **Step 1: Add storage functions**

Add to `server/storage.ts`. Import `recurringReviews` from `../shared/schema.js`. Use Drizzle's `onConflictDoUpdate` for atomic upsert on the unique `(userId, candidateKey)` index:

```typescript
import { recurringReviews } from "../shared/schema.js";

export async function upsertRecurringReview(
  userId: number,
  candidateKey: string,
  status: string,
  notes?: string | null,
) {
  const [row] = await db
    .insert(recurringReviews)
    .values({
      userId,
      candidateKey,
      status,
      notes: notes ?? null,
      reviewedAt: status !== "unreviewed" ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [recurringReviews.userId, recurringReviews.candidateKey],
      set: {
        status,
        notes: notes !== undefined ? (notes ?? null) : sql`${recurringReviews.notes}`,
        reviewedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function listRecurringReviewsForUser(userId: number) {
  return db
    .select()
    .from(recurringReviews)
    .where(eq(recurringReviews.userId, userId))
    .orderBy(desc(recurringReviews.reviewedAt));
}
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add server/storage.ts
git commit -m "feat(storage): add recurring review atomic upsert and list functions

Uses onConflictDoUpdate on unique (userId, candidateKey) index for
race-safe upsert. listRecurringReviewsForUser returns all reviews."
```

---

### Task 6: Recurring API routes

**Files:**
- Modify: `server/routes.ts`
- Create: `server/recurring-routes.test.ts`

- [ ] **Step 1: Write route tests**

Create `server/recurring-routes.test.ts` with full coverage:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage.js")>();
  return {
    ...original,
    listAccountsForUser: vi.fn(),
    listTransactionsForUser: vi.fn(),
    listAllTransactionsForExport: vi.fn().mockResolvedValue([]),
    upsertRecurringReview: vi.fn(),
    listRecurringReviewsForUser: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./db.js", () => ({
  db: {}, pool: {}, ensureUserPreferences: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  normalizeEmail: vi.fn((e: string) => e.toLowerCase().trim()),
}));

vi.mock("./csvParser.js", () => ({ parseCSV: vi.fn() }));

import session from "express-session";
import request from "supertest";
import { createApp } from "./routes.js";
import {
  listAllTransactionsForExport,
  upsertRecurringReview,
  listRecurringReviewsForUser,
} from "./storage.js";

function buildApp() {
  const store = new session.MemoryStore();
  return { app: createApp({ sessionStore: store }), store };
}

describe("recurring routes", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("GET /api/recurring-candidates", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/recurring-candidates");
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /api/recurring-reviews/:candidateKey", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .patch("/api/recurring-reviews/netflix%7C15.99")
        .send({ status: "leak" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/recurring-reviews", () => {
    it("returns 401 when not authenticated", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/recurring-reviews");
      expect(res.status).toBe(401);
    });
  });
});
```

Note: The `candidateKey` in the URL is URI-encoded (`|` becomes `%7C`). The route handler uses `decodeURIComponent(req.params.candidateKey)`.

- [ ] **Step 2: Add routes to `server/routes.ts`**

Add three routes before the 404 catch-all:

**`GET /api/recurring-candidates`:**
- Fetch all non-excluded outflow transactions using `listAllTransactionsForExport` (unbounded — no pagination limit)
- Run `detectRecurringCandidates(transactions)`
- Fetch `listRecurringReviewsForUser(userId)` and merge review status into each candidate
- Return `{ candidates: [...], summary: { total, unreviewed, essential, leak, dismissed } }`

**`PATCH /api/recurring-reviews/:candidateKey`:**
- Validate `status` is one of `REVIEW_STATUSES` -> 400 if invalid
- Call `upsertRecurringReview(userId, decodeURIComponent(candidateKey), status, notes)`
- Return updated review row

**`GET /api/recurring-reviews`:**
- Return `listRecurringReviewsForUser(userId)`

Import `detectRecurringCandidates` from `./recurrenceDetector.js`, `REVIEW_STATUSES` from `../shared/schema.js`, and storage functions.

- [ ] **Step 3: Run route tests**

```bash
npx vitest run server/recurring-routes.test.ts
```

Expected: All PASS.

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/recurring-routes.test.ts
git commit -m "feat(recurring): add candidate and review API routes

GET /api/recurring-candidates runs detection engine over all user
transactions (unbounded query via listAllTransactionsForExport) and
merges persisted review status. PATCH /api/recurring-reviews/:candidateKey
does atomic upsert of review decision. Validates status against
REVIEW_STATUSES enum."
```

---

### Task 7: Build Leaks page with review UI

**Files:**
- Create: `client/src/hooks/use-recurring.ts`
- Modify: `client/src/pages/Leaks.tsx`
- Modify: `client/src/index.css`

- [ ] **Step 1: Create use-recurring hook**

Create `client/src/hooks/use-recurring.ts` with:

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type ReviewStatus = "unreviewed" | "essential" | "leak" | "dismissed";

export type RecurringCandidate = {
  candidateKey: string;
  merchantKey: string;
  merchantDisplay: string;
  frequency: string;
  averageAmount: number;
  amountStdDev: number;
  confidence: number;
  reasonFlagged: string;
  transactionIds: number[];
  firstSeen: string;
  lastSeen: string;
  expectedNextDate: string;
  category: string;
  reviewStatus: ReviewStatus;
  reviewNotes: string | null;
};

export type CandidatesResponse = {
  candidates: RecurringCandidate[];
  summary: {
    total: number;
    unreviewed: number;
    essential: number;
    leak: number;
    dismissed: number;
  };
};

export function useRecurringCandidates() {
  return useQuery<CandidatesResponse>({
    queryKey: ["/api/recurring-candidates"],
    queryFn: async () => {
      const res = await fetch("/api/recurring-candidates", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch candidates");
      return res.json();
    },
  });
}

export function useReviewMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      candidateKey,
      status,
      notes,
    }: {
      candidateKey: string;
      status: ReviewStatus;
      notes?: string;
    }) => {
      const res = await fetch(
        `/api/recurring-reviews/${encodeURIComponent(candidateKey)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status, notes }),
        },
      );
      if (!res.ok) throw new Error("Failed to submit review");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-candidates"] });
    },
  });
}
```

- [ ] **Step 2: Replace Leaks.tsx**

Replace `client/src/pages/Leaks.tsx` placeholder with full review UI:

**Filter tabs:** All / Unreviewed / Essential / Leak / Dismissed

**Summary bar:** Counts per status with color indicators

**Candidate cards showing:**
- Merchant name (large, bold)
- Average amount formatted as currency
- Frequency badge (monthly, weekly, etc.)
- Confidence badge (high >=0.75 green, medium 0.50-0.74 amber, low <0.50 muted)
- Last seen date
- Expected next charge date
- Reason flagged text
- Category label

**Action buttons on each card:**
- Essential (green border/icon) — "I need this"
- Leak (amber/red border/icon) — "This is wasteful"
- Dismiss (gray) — "Ignore this"
- Active status is highlighted

**Notes:** Optional text input, visible when card is expanded.

**States:** Loading spinner, empty state ("No recurring patterns detected"), error state.

Style using existing design system patterns from the ledger page (color-mix borders, badge patterns, the dark blue-led palette).

- [ ] **Step 3: Add CSS for Leaks page**

Add to `client/src/index.css` after the existing ledger styles:
- `.leaks-page` — page container
- `.leaks-tabs` / `.leaks-tab` / `.leaks-tab--active` — filter tabs
- `.leaks-summary` / `.leaks-summary-item` — status counts bar
- `.leaks-card` / `.leaks-card--essential` / `--leak` / `--dismissed` — candidate cards with status-specific border colors
- `.leaks-card-header` / `.leaks-card-merchant` / `.leaks-card-amount` — card header
- `.leaks-card-details` — frequency, confidence, dates
- `.leaks-card-reason` — reason flagged text
- `.leaks-card-actions` / `.leaks-action-btn` / `.leaks-action-btn--essential` / `--leak` / `--dismiss` — action buttons
- `.leaks-confidence-badge` / `--high` / `--medium` / `--low`
- `.leaks-empty` / `.leaks-loading` / `.leaks-error`

Status colors: essential = green tones, leak = amber/warm tones, dismissed = muted gray.

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/use-recurring.ts client/src/pages/Leaks.tsx client/src/index.css
git commit -m "feat(client): build recurring leak review page with review actions

Card-based UI showing detected recurring patterns with merchant name,
average amount, frequency, confidence, and reason flagged. Users can
mark each as essential, leak-related, or dismissed. Filter tabs and
summary counts for each review status."
```

---

### Task 8: Tests, documentation, and verification

**Files:**
- Create: `client/src/pages/Leaks.test.tsx`
- Modify: `docs/phase-logs/phase-4-recurring-leak-review-progress.md`
- Modify: `README.md`

- [ ] **Step 1: Write Leaks page tests**

Create `client/src/pages/Leaks.test.tsx` testing:
- Renders page title "Recurring Leak Review"
- Renders filter tabs (All, Unreviewed, Essential, Leak, Dismissed)
- Renders candidate cards when data is returned
- Shows confidence badge
- Shows empty state when no candidates
- Displays summary counts

Mock `fetch` to return sample candidate data (reuse test patterns from `Ledger.test.tsx`).

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass (117+ existing + new tests).

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Update progress log**

Update `docs/phase-logs/phase-4-recurring-leak-review-progress.md`:
- Mark all tasks as done
- Document how recurring candidates are formed (algorithm summary)
- Document review statuses and their meanings
- Document where review outcomes are stored
- Note the CSV parser bug fix and its impact
- Note known tuning opportunities (confidence thresholds, date floor for large datasets)

- [ ] **Step 5: Update README**

Add Phase 4 section to `README.md`:

**Phase 4 -- what's implemented:**
- CSV parser bug fix (debit/credit priority)
- Recurring transaction detection engine
- Review persistence (recurring_reviews table)
- Leaks page with card-based review UI

**Manual verification steps:**
1. Re-upload CSV files — verify transactions now have correct inflow/outflow classification
2. Navigate to Recurring Leak Review
3. See detected recurring patterns (requires uploaded transactions with recurring charges)
4. Mark a candidate as essential/leak/dismissed
5. Switch filter tabs to verify review persists
6. Verify summary counts update
7. Verify empty state when no recurring patterns

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "docs(phase-4): complete progress log, README, and client tests

Phase 4 complete: CSV parser sign bug fixed, recurrence detection engine
built with 4-signal confidence scoring, review persistence via atomic
upsert, and card-based Leaks page. All tests passing."
```
