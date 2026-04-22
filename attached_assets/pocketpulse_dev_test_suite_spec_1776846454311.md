# PocketPulse — Dev Test Suite (Classifier + Parser Fidelity)

**Repo:** `fighterz8/pocketpulse-v1`
**Author:** Nick (project lead)
**Supersedes:** `pocketpulse_dev_accuracy_sample_spec.md` (original simple three-button flow)
**Purpose:** A dev-only test suite that lets each of four approved team members independently measure PocketPulse's accuracy on their own data. Produces two complementary reports — one for the classification pipeline, one for the CSV parser — plus a side-by-side team view for milestone documentation.
**Scope:** Two tools, one landing page, one side-by-side view. ~700 lines total. Roughly 6-8 hours of agent work.

---

## 1. Context

The existing `/accuracy-report` page measures classifier *confidence and consistency*, not verified accuracy. It also does not distinguish which classifier subsystem handled a given row — structural rules, the merchant cache, the global seed, or AI fallback all get lumped together. For the team's milestone 3 testing documentation, we need concrete measured numbers that tell a specific story: *"Rules resolve 62% of rows at 97.7% accuracy, the cache resolves 24% at 94% accuracy, AI resolves 14% at 78% accuracy."*

There are two layers where measurement is needed:

1. **Classification layer** — given a parsed transaction, did the pipeline (rules → user-rule → cache → global seed → AI) produce the right category, class, and recurrence? This is where most of the complexity lives and most of the failures happen.
2. **Parser layer** — given a raw CSV row, did `csvParser.ts` extract the correct date, description, amount, and direction? This is deterministic per bank format but subtle mistakes (sign flips, column overflow, preamble skipping) silently cascade into every downstream decision.

The team sees raw upload warnings today (skipped rows, preamble notices, "could not parse date"). They do NOT see *successfully parsed* rows whose parsing was subtly wrong. Parser fidelity in the test suite closes that gap.

Corrections made in either tool are **sandboxed** — they do not modify underlying transactions. This makes both tools re-runnable across time to track improvements.

---

## 2. Architecture overview

### Routes

- `/dev/test-suite` — landing page. Lists past runs for current user, access to either tool, access to team side-by-side.
- `/dev/test-suite/classification/:sampleId?` — classification sampler. With no sampleId: start-new screen. With sampleId: review-or-report screen.
- `/dev/test-suite/parser/:sampleId?` — parser fidelity check. Same structure.
- `/dev/test-suite/team` — side-by-side team view (whitelist of 4 dev accounts only).

### Access control

Two gates:

1. **`DEV_MODE_ENABLED`** — server env var. When not set, all `/api/dev/*` routes return 404. This is the hard off-switch for prod if ever needed.
2. **`users.isDev`** — existing per-user flag (populated via `scripts/add-is-dev.ts`). Only users with `isDev = true` can access routes; the nav link is hidden for everyone else.

For the team side-by-side view, there is a third gate: the `DEV_TEAM_USER_IDS` env var — a comma-separated list of user IDs visible in the side-by-side. All four teammates' IDs go in this list. Nick's test accounts with `isDev = true` but NOT in this list can run the tools but do not appear in the team view. This is the "simple method" per Nick's note: no UI for managing the team list, just an env var.

### What each tool tests

**Tool A — Classification sampler:**
- Pulls 50 random transactions from the user's own data (already parsed and classified)
- For each row: display raw description, amount, and the pipeline's output (category, class, recurrence, `labelSource`, `labelConfidence`)
- User verifies each field independently
- Report: per-dimension accuracy (category / class / recurrence), broken down by `labelSource`, plus a failure-mode table of the most common misclassifications

**Tool B — Parser fidelity check:**
- Pulls 50 random rows from the user's most recent upload (or lets them pick an upload)
- Shows raw CSV cells side-by-side with parsed output (parsed date, parsed description, parsed amount, parsed flowType, ambiguous flag)
- User marks each row "Looks right" or flags specific fields as wrong
- Report: per-field accuracy (date / description / amount / direction), warnings that occurred during that upload, and per-upload totals (rows parsed / rows skipped / warnings count)

---

## 3. Data model

One table per tool. Keeping them separate avoids overloading a single schema with two different verdict shapes.

### `classification_samples`

```ts
// shared/schema.ts
export const classificationSamples = pgTable("classification_samples", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  sampleSize: integer("sample_size").notNull(),
  // Per-dimension accuracy; null until completed.
  categoryAccuracy: numeric("category_accuracy", { precision: 5, scale: 4 }),
  classAccuracy: numeric("class_accuracy", { precision: 5, scale: 4 }),
  recurrenceAccuracy: numeric("recurrence_accuracy", { precision: 5, scale: 4 }),
  // Aggregate counts.
  confirmedCount: integer("confirmed_count").notNull().default(0),
  correctedCount: integer("corrected_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  // Per-row verdicts as JSON. See shape below.
  verdicts: json("verdicts").notNull().default([]),
}, (t) => [
  index("classification_samples_user_id_idx").on(t.userId),
  index("classification_samples_completed_at_idx").on(t.completedAt),
]);
```

**Classification verdict shape:**

```ts
type ClassificationVerdict = {
  transactionId: number;
  // Snapshot of pipeline output AT SAMPLE CREATION TIME.
  // Persisted so later reclassifies don't retroactively invalidate the sample.
  classifierCategory: string;
  classifierClass: string;
  classifierRecurrence: string;
  classifierLabelSource: string;         // "rule" | "cache" | "ai" | "user-rule" | "manual" | "propagated" | "recurring-transfer"
  classifierLabelConfidence: number;
  // User's verdict.
  verdict: "confirmed" | "corrected" | "skipped";
  // Only populated when verdict === "corrected". Each field is null when the
  // user left it as-is; populated with the user's choice when they changed it.
  correctedCategory: string | null;
  correctedClass: string | null;
  correctedRecurrence: string | null;
};
```

### `parser_samples`

```ts
export const parserSamples = pgTable("parser_samples", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Which upload this sample is drawn from. null when the user did not pick
  // a specific upload (we use their most recent).
  uploadId: integer("upload_id").references(() => uploads.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  sampleSize: integer("sample_size").notNull(),
  // Per-field accuracy; null until completed.
  dateAccuracy: numeric("date_accuracy", { precision: 5, scale: 4 }),
  descriptionAccuracy: numeric("description_accuracy", { precision: 5, scale: 4 }),
  amountAccuracy: numeric("amount_accuracy", { precision: 5, scale: 4 }),
  directionAccuracy: numeric("direction_accuracy", { precision: 5, scale: 4 }),
  // Aggregate upload-level stats, captured at sample creation time.
  uploadRowCount: integer("upload_row_count"),
  uploadWarningCount: integer("upload_warning_count"),
  // Counts.
  confirmedCount: integer("confirmed_count").notNull().default(0),
  flaggedCount: integer("flagged_count").notNull().default(0),
  verdicts: json("verdicts").notNull().default([]),
}, (t) => [
  index("parser_samples_user_id_idx").on(t.userId),
  index("parser_samples_upload_id_idx").on(t.uploadId),
]);
```

**Parser verdict shape:**

```ts
type ParserVerdict = {
  transactionId: number;
  // Raw cells from the originating CSV row, reconstructed from the transaction's
  // rawDescription + other stored fields. (See Section 6 for how this is sourced.)
  rawDate: string;
  rawDescription: string;
  rawAmount: string;
  // Parser output stored on the transaction.
  parsedDate: string;
  parsedDescription: string;
  parsedAmount: number;
  parsedFlowType: string;
  parsedAmbiguous: boolean;
  // User's verdict per field; null = looks right, string = description of what's wrong
  // (free text optional, single select typical).
  dateVerdict: "ok" | "wrong-date";
  descriptionVerdict: "ok" | "wrong-description";
  amountVerdict: "ok" | "wrong-amount" | "wrong-sign";
  directionVerdict: "ok" | "wrong-direction";
  // Any free-text note the user wants to leave.
  notes: string | null;
};
```

---

## 4. Tool A — Classification sampler flow

### Start new sample

`POST /api/dev/classification-samples`
- Body: `{ sampleSize: number }` (default 50, capped at 200)
- Selects `sampleSize` random transactions from the user's data where:
  - `userCorrected = false`
  - `excludedFromAnalysis = false`
  - `labelSource IN ('rule', 'cache', 'ai', 'user-rule')` — exclude system-assigned sources like `recurring-transfer` which shouldn't be user-verified in this tool
- Uses `ORDER BY random() LIMIT n` with those filters
- Returns: `{ sampleId, transactions: Array<{ id, date, rawDescription, amount, category, transactionClass, recurrenceType, labelSource, labelConfidence }> }`

### Review UI

Scrollable list of 50 rows, styled to resemble the Ledger. Each row shows:

**Display (left side):**
- Date, raw description, amount (signed and color-coded)
- Three pill badges: category, class, recurrence (matching Ledger conventions)
- Below: `labelSource` pill + `labelConfidence` as small muted text (diagnostic for developer)

**Action (right side):**
- **"Looks right" big button** — single click confirms all three fields as correct
- **Edit toggle** — when clicked, reveals inline editors:
  - Category: dropdown from `V1_CATEGORIES`
  - Class: dropdown from `income` / `expense` / `transfer` / `refund`
  - Recurrence: toggle between `recurring` / `one-time`
  - Each editor has a small "revert" icon to restore the classifier's value if the user changes their mind
- **"Skip" small button** — for rows the reviewer can't confidently verify

Sticky footer shows progress and has the "Submit" button (disabled until ≥ 40 of 50 have a verdict).

### Submit

`PATCH /api/dev/classification-samples/:id`
- Body: `{ verdicts: ClassificationVerdict[] }`
- Validates:
  - All `transactionId` values belong to the user and were in the original sample (guard against tampering)
  - `verdict` is one of `"confirmed" | "corrected" | "skipped"`
  - When `verdict === "corrected"`, at least one `corrected*` field is non-null
  - When `verdict === "corrected"`, any non-null corrected field has a valid value (category in `V1_CATEGORIES`, class in the 4 allowed values, recurrence in the 2 allowed values)
- Computes the three accuracy numbers:
  - `categoryAccuracy = (# rows where correctedCategory is null) / (# non-skipped rows)`
  - Same pattern for `classAccuracy` and `recurrenceAccuracy`
- Sets `completedAt`, persists verdicts, returns the completed sample record

### Report screen

Rendered after submit, also accessible via URL for historical samples.

**Top — three accuracy cards:**

```
Category: 82%        Class: 96%         Recurrence: 68%
(38/46)              (44/46)            (31/46)
```

**Middle — accuracy by labelSource:**

A table showing per-dimension accuracy for each `labelSource` that appeared in the sample. Only rows with non-zero counts render.

```
Source       Count    Category    Class       Recurrence
rule         23       22/23 96%   23/23 100%  18/23 78%
cache        12       11/12 92%   12/12 100%  9/12 75%
ai           9        5/9 56%     9/9 100%    4/9 44%
user-rule    2        2/2 100%    2/2 100%    2/2 100%
```

This is the key diagnostic. Tells the developer *which subsystem is failing* — not just that the overall number is 82%.

**Failure mode tables:**

Three tables, one per dimension. Each shows the top 5 most-frequent misclassifications, format `{classifier_value} → {user_corrected_value}: N`.

Example category table:
```
dining → delivery:    3
shopping → software:  2
other → medical:      2
entertainment → dining: 1
```

If a dimension had zero corrections, show "No misclassifications recorded" instead of an empty table.

**Bottom — sample metadata:**
- Sample ID, timestamp, reviewer email, counts (confirmed / corrected / skipped)
- "Export as JSON" button — downloads the full sample record for milestone docs

---

## 5. Tool B — Parser fidelity check flow

### Start new sample

`POST /api/dev/parser-samples`
- Body: `{ sampleSize: number, uploadId?: number }`. When `uploadId` omitted, picks user's most recent upload.
- Selects `sampleSize` random transactions from that upload where `excludedFromAnalysis = false`
- For each selected transaction, returns:
  - Transaction ID, rawDescription (as stored), amount (as stored), flowType, date, and the ambiguous-flag equivalent (reconstructed from `aiAssisted` since the original `ambiguous` flag is not persisted — see Section 6)
- Returns aggregate upload metadata: `uploadRowCount`, `uploadWarningCount`

### Review UI

Each row shows a two-column layout:

**Left — "What the CSV row looked like":**
- Since we don't persist the raw CSV cells, we reconstruct what's visible: `rawDescription` (stored as-is), raw amount (the stored signed amount converted back to its likely display form), and the stored `date` (ISO) shown in the format the user probably saw.
- This is approximate. A checkbox labeled "Couldn't determine raw row from stored data — flag for manual review" lets users skip when reconstruction is clearly off. Persists as `skipped` verdict.

**Right — "What the parser extracted":**
- Parsed date (ISO)
- Parsed description
- Parsed amount (with sign)
- Parsed flowType (inflow/outflow pill)
- "Ambiguous flag" pill (only shown when true)

**Per-field verdict:**
- Each field has a checkbox/toggle: "OK" (default, green check) or "Wrong" (red X). Clicking Wrong reveals a brief dropdown of common error types for that field (e.g. amount: "Sign flipped", "Wrong value", "Wrong column"). Persisted as the `*Verdict` field in the shape.

**Sticky footer:** progress, "Notes" free-text field (carried onto every verdict), "Submit" button.

### Submit

`PATCH /api/dev/parser-samples/:id`
- Body: `{ verdicts: ParserVerdict[] }`
- Computes per-field accuracy as `(# rows with *Verdict === "ok") / (total non-skipped rows)`
- Persists and returns the completed record

### Report screen

**Top — four accuracy numbers (date, description, amount, direction)** with same raw-fraction-below pattern as Tool A.

**Middle — per-field error breakdown:** table showing counts for each error type across the sample.

**Bottom — upload-level context** (already captured at sample creation):
- Upload ID, upload date, upload row count, upload warning count
- Link to view the upload's warnings (existing UI, not new)

---

## 6. The awkward bit — reconstructing "raw CSV" from stored data

There is a real limitation here, and the spec must acknowledge it honestly rather than pretend otherwise.

PocketPulse does not currently persist the raw CSV row that produced each transaction. It persists the *parsed* output: `rawDescription` (which is really the extracted description column, not the whole CSV row), `amount` (signed, derived), `date` (ISO, parsed), `flowType` (derived). The `ambiguous` flag set during parsing is collapsed into `aiAssisted` downstream.

This means the parser fidelity tool cannot perfectly reconstruct "what the CSV row looked like" without stored raw data.

**Two options. The spec picks option 2.**

**Option 1: Store raw CSV cells per transaction.** New column `rawCells jsonb` on `transactions`. Parser writes the full split-and-unsplit cell array. Reviewer gets a perfect side-by-side. Downside: schema change, one more migration, incremental storage cost, and the rawCells value is effectively immutable dead data once the parser is trusted — an infrequent-access column padding every row forever.

**Option 2: Reconstruction + honesty about the limitation.** The tool displays the stored fields as "parser output" and constructs a best-effort "what the CSV likely contained" view from `rawDescription` + absolute-value-of-amount + original-format-date. The reviewer flags obviously-mangled rows as "cannot evaluate" (skip). The tool's report includes a note that it validates parser output *consistency*, not raw-input fidelity. For catching sign-flip and wrong-column errors (the two meaningful parser bugs in practice) this is sufficient. For catching subtle description truncation it is not.

**Chosen: Option 2.** Rationale: the team's real question is "is our CSV parsing good enough that we trust the downstream numbers?" not "can we audit every byte of every import?" Option 2 answers the real question in 1/3 the complexity. If future analysis reveals a specific parser bug where Option 2's reconstruction is inadequate, revisit with a targeted fix.

The UI must clearly say "Parser output validation" not "Raw CSV audit," and the Submit screen must include one sentence: *"This tool validates the classifier's view of your data; for deeper CSV-layer debugging, re-upload the file and inspect warnings."*

---

## 7. Backend endpoint summary

All routes gated by `requireDev` middleware (extends `requireAuth` + `isDev` check + `DEV_MODE_ENABLED` env var guard). Returns 404 for non-matching requests (not 403 — do not signal the feature's existence).

### Classification tool

- `POST /api/dev/classification-samples` — create
- `GET /api/dev/classification-samples` — list (current user's)
- `GET /api/dev/classification-samples/:id` — fetch one
- `PATCH /api/dev/classification-samples/:id` — submit verdicts

### Parser tool

- `POST /api/dev/parser-samples` — create
- `GET /api/dev/parser-samples` — list
- `GET /api/dev/parser-samples/:id` — fetch one
- `PATCH /api/dev/parser-samples/:id` — submit verdicts

### Team side-by-side

- `GET /api/dev/team-summary` — returns latest completed classification + parser sample for each user ID in `DEV_TEAM_USER_IDS`. Returns only the headline numbers, not the full verdicts. Shape:

```ts
{
  users: Array<{
    userId: number;
    email: string;
    classification: {
      sampleId: number;
      completedAt: string;
      categoryAccuracy: number;
      classAccuracy: number;
      recurrenceAccuracy: number;
      sampleSize: number;
    } | null;
    parser: {
      sampleId: number;
      completedAt: string;
      dateAccuracy: number;
      descriptionAccuracy: number;
      amountAccuracy: number;
      directionAccuracy: number;
      sampleSize: number;
    } | null;
  }>;
}
```

---

## 8. Frontend surface

Four new page files. Keep all styling consistent with the existing Ledger page; do not introduce new design patterns.

- `client/src/pages/dev/TestSuiteIndex.tsx` — landing page
- `client/src/pages/dev/ClassificationSampler.tsx` — handles both review and report states, routed via `:sampleId?`
- `client/src/pages/dev/ParserSampler.tsx` — same shape
- `client/src/pages/dev/TeamSummary.tsx` — side-by-side view

Route registration in `App.tsx` behind an `isDev` guard.

Navigation: **only render** the "Test Suite" nav link when the current user has `isDev = true`. Do NOT add a separate menu — the link lives next to the existing `/accuracy-report` link (which stays in place).

---

## 9. Migration

**New migration:** `drizzle/migrations/0006_dev_test_suite_tables.sql`

Creates the two tables + indexes. Idempotent (uses `CREATE TABLE IF NOT EXISTS`).

Runs automatically via the Drizzle migration runner (Phase 4.6 from prior spec, which already shipped).

---

## 10. Acceptance criteria

- All four existing teammates' user IDs in `DEV_TEAM_USER_IDS` env var, their `users.isDev = true` flag set.
- A non-dev user accessing `/dev/test-suite` sees a 404 (both client render and API response).
- `DEV_MODE_ENABLED=false` causes every `/api/dev/*` route to 404 regardless of `isDev` status.
- A dev user can start, review, and submit a classification sample, see per-dimension and per-labelSource accuracy in the report.
- A dev user can start, review, and submit a parser sample, see per-field accuracy in the report.
- Both reports are reproducible — visiting the sample's URL later shows the same numbers.
- Team side-by-side view renders the 4 whitelisted teammates' latest samples (nulls for teammates with no samples yet).
- No change to any existing production classification, parsing, or dashboard behavior.
- Total new code ≤ 900 lines across backend + frontend.

---

## 11. Out of scope

- Automatic scheduled sampling. Manual only.
- Cross-user aggregation beyond the 4-user side-by-side. No company-wide averages.
- Writing verdicts back into the `transactions` table (explicit: sandbox behavior is a feature).
- Raw CSV cell storage (see Section 6, Option 1 rejected).
- Modifying the existing `/accuracy-report` page. It stays. The test suite complements it.
- Charts, graphs, time-series visualizations. Tables of numbers only.
- CSV export of raw verdicts. JSON export is sufficient.
- Notifications, email digests, team alerts.

---

## 12. Risk and rollback

**Risk: ~10%.** Purely additive backend + frontend. Two new tables; no existing query path touched. Feature-flagged at two levels (env var + per-user flag).

**Rollback:** Set `DEV_MODE_ENABLED=false`. Feature vanishes. Drop the two tables at leisure — they have no inbound references from production code.

---

## 13. Effort and ship order

Two PRs, not one. Ship order:

- **PR 1: Classification sampler + team side-by-side** (~5 hours)
  - Migration + `classification_samples` schema
  - Backend: 4 classification endpoints + team summary endpoint
  - Frontend: landing page + classification sampler + team side-by-side
  - Tests: one end-to-end happy path per endpoint
- **PR 2: Parser fidelity check** (~3 hours)
  - Migration + `parser_samples` schema
  - Backend: 4 parser endpoints
  - Frontend: parser sampler
  - Tests: one end-to-end happy path per endpoint

Rationale for splitting: PR 1 delivers the milestone-3-ready artifact (the headline accuracy numbers by labelSource). PR 2 adds the parser layer, which is higher-value for deep debugging but not strictly required for the milestone doc. Shipping PR 1 first means you have numbers for your team to use in the doc even if PR 2 slips.

---

## 14. Notes for the build agent

- Four teammates will use this. Build it for them, not for Nick. Copy should be plain English; dropdowns should not require reading source code to understand; error states should explain what happened and what to do next.
- Every number on every screen must include its raw fraction below it (`82% (38/46)`). Percentages without denominators are misleading.
- Do NOT add a confidence weighted score or a single composite "overall accuracy" number. The per-dimension per-labelSource breakdown is the point — collapsing it defeats the whole tool.
- The `labelSource` values in the DB include edge cases (`propagated`, `recurring-transfer`, `manual`). The classification sampler filters these out at query time — do not surface them in the report breakdown.
- When reconstructing raw CSV row view (Section 6), do NOT persist reconstructed values — they are display-only in the UI. The DB stores only the actual parser output.
- One squashed commit per PR.
- If `DEV_TEAM_USER_IDS` is missing or malformed, the team side-by-side view should render an informative error, not crash.
