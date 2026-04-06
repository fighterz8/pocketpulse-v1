inal doc) |

### Final Team Responsibility Summary

| Capability Area | Primary Owner | Secondary Support | Key Outputs |
|---|---|---|---|
| Planning and requirements | Pilar | Nick + Team | Requirements writeup, scope language, use cases |
| Architecture and core build | Nick | Team | All server/client implementation, database schema, classifier |
| Quality assurance and validation | Dominic | Team | QA matrix, defect log, validation checklist |
| Presentation and stakeholder communication | Edward | Pilar + Nick | Slides, demo framing, final document assembly |
| Cross-team review and revision | Entire Team | — | Revision rounds, milestone readiness checks |

### Key Technical Decisions and Rationale

The following decisions were made during development and represent the thinking behind the architecture:

**1. Why a 12-pass state machine instead of a single-pass rule engine?**
A single pass cannot handle conflicting signals. A transaction from "BANK TRANSFER — CREDIT" could match income rules (the word "credit") and transfer rules simultaneously. The pass-ordered system resolves conflicts deterministically: transfer detection (Pass 1) runs first, and later passes can only override if they have a specific override flag set. This makes the classifier's behavior predictable and debuggable.

**2. Why merchantKey-only candidateKey for recurring detection?**
Recurring expense detection is fundamentally a grouping problem — the system needs to decide whether two transactions from the same merchant are part of the same subscription or two different services. Amount-inclusive keys caused the same Netflix subscription to split into two candidates when the price increased by $1. By using merchant identity as the primary grouping signal and reserving amount bucketing only for genuinely divergent charge levels, the detector produces cleaner, more actionable candidates.

**3. Why AUTO_ESSENTIAL_CATEGORIES instead of user-controlled essential marking?**
Categories like housing, utilities, insurance, medical, and debt are objectively non-discretionary for any business. Presenting them to the user as "potential leaks" would be misleading and would reduce trust in the system. By automatically classifying these as essential and hiding them from the leak review interface, the system focuses user attention on spending that is actually discretionary and actionable.

**4. Why userCorrected as a permanent flag rather than a versioned correction history?**
The MVP is designed for a single owner with full knowledge of their own transactions. A permanent flag that prevents automated overrides is simpler to implement and less error-prone than a versioned history. The assumption is that if the user corrected a transaction, they know more about it than the classifier does, and that knowledge should be preserved indefinitely.

**5. Why PostgreSQL instead of SQLite or in-memory storage?**
PostgreSQL was chosen for persistence reliability, session store compatibility, and production deployment readiness. SQLite would have been adequate for development but creates friction when deploying to a cloud environment with multiple instances. PostgreSQL with `connect-pg-simple` also allows session data to persist across server restarts without additional infrastructure.

**6. Why Drizzle ORM instead of raw SQL or another ORM?**
Drizzle provides TypeScript-first type safety directly from the schema definition. The schema in `shared/schema.ts` serves as both the database table definition and the TypeScript type source, eliminating a common source of bugs where database column types and TypeScript types diverge. Drizzle's query builder is also fully type-checked at compile time, which catches query errors before the code runs.

**7. Why Vite + React instead of a server-rendered framework?**
The application's value is in interactive review workflows — the user needs to edit categories, review recurring candidates, and switch date ranges without page reloads. A React SPA with TanStack Query for server state management provides this interactivity efficiently. Vite's hot module replacement also significantly sped up the development cycle, allowing UI changes to appear in the browser within milliseconds of saving a file.

---

# 14. LESSONS LEARNED

### Lesson 1: Real CSV Files Are Messier Than Sample Data

The team's original estimates for the CSV ingestion workstream were based on the assumption that bank exports follow a reasonably consistent format. In practice, the formats varied significantly: column names, date formats, amount signs, and even character encoding differed across institutions. The lesson is that when building a system that ingests data from external sources, the normalization and format-detection layer deserves more upfront design time than it typically receives in planning. Allocating extra time to document known variations before writing ingestion code would have reduced the number of mid-development corrections.

### Lesson 2: A Deterministic Classifier Beats a Flexible One in Production

The initial impulse was to build a flexible, configurable classifier that could handle any input gracefully. In practice, flexibility creates ambiguity — when a transaction could match multiple rules, which one wins? The 12-pass state machine resolved this by making priority explicit and deterministic. Every classification decision can be traced to a specific pass and a specific rule. This made debugging misclassifications significantly easier: instead of asking "why did this transaction get this category?", the team could follow the pass sequence and identify exactly which rule fired. Predictable systems are easier to trust and easier to improve.

### Lesson 3: CSS Architecture Matters More Than It Appears

The dark mode implementation revealed a class of bugs that are surprisingly easy to introduce and difficult to locate: CSS specificity conflicts. When a CSS override rule has higher specificity than a Tailwind utility class, the utility class silently loses — there is no error, no warning, and no obvious indication in the browser that something is wrong until you notice the color is incorrect. The team learned to be more deliberate about where global CSS overrides are written relative to utility classes, and to test dark mode on every new component before moving on rather than treating it as a final-pass concern.

### Lesson 4: User Corrections Are Ground Truth — Design for That Explicitly

Early versions of the sync and reclassification routines did not check whether a transaction had been user-corrected before modifying it. This meant that running the batch reclassifier would silently undo the user's manual work. The lesson is that any system that applies automated changes to user data needs an explicit protection mechanism designed from the beginning, not added as an afterthought. The `userCorrected` flag was the right solution, but it would have been simpler and less error-prone if it had been part of the original data model rather than retrofitted after the problem was discovered.

### Lesson 5: Monthly Normalization Is Essential for Recurring Cost Comparisons

The initial recurring expense dashboard KPI summed raw transaction amounts for all recurring transactions in the selected period. This produced a misleading number: a $14.99 monthly subscription charged twelve times in a year appeared to cost $179.88 in any month-long window that happened to span a billing cycle boundary twice. The lesson is that when comparing recurring expenses across different billing frequencies (weekly, bi-weekly, monthly, annual), all values must be normalized to a common unit — in this case, a monthly equivalent — before being summed or displayed. This normalization step is not obvious from the requirements but is essential to producing numbers that are both accurate and meaningful.

### Lesson 6: Build Order Determines Refactor Cost

The decision to complete authentication before CSV ingestion, and CSV ingestion before the classifier, and the classifier before the recurring detector, turned out to be more important than it seemed at the time. Because each layer was stable before the next was built on top of it, refactoring within a layer (e.g., redesigning the candidateKey in the detector) did not cascade into adjacent layers. If the classifier and the detector had been built simultaneously, redesigning one would likely have destabilized the other. The lesson is that a strict build order — even at the cost of some short-term speed — reduces total refactor time over the course of the project.

### Lesson 7: Deployment Configuration Should Be Verified Early

The production deployment failure (run command pointing to `./dist/index.cjs`, a file that does not exist) was discovered only when the team attempted to publish the application. This issue could have been identified in Week 1 by running a test build locally and verifying that the compiled output matched the run command. The lesson is that build and run configuration should be validated as part of the initial project setup, not treated as a final-step concern. A deployment that fails at the last moment under time pressure is significantly more stressful than one that is verified early and updated incrementally.

### Lesson 8: Incremental Testing Pays Dividends

Several of the defects logged (D-01 through D-09) were discovered relatively late in the development cycle because they required either real-world CSV data or a specific combination of conditions (OS dark mode + app light mode). The team's lesson is that structured test cases should be written as features are completed, not after all features are complete. A simple test matrix maintained throughout development, even informally, would have surfaced issues like the CSS system color conflict much earlier.

---

# 13. DEFECT LOG — ADDENDUM (Week 6 QA Sprint)

The following defects were discovered during systematic testing of the CSV ingestion pipeline against the 30-file `sample data/` corpus. All five were resolved in the same sprint and are covered by named regression tests in `server/csvParser.test.ts`.

| Defect ID | Bank / File(s) | Severity | Root Cause | Resolution | Test Case |
|---|---|---|---|---|---|
| DEF-009 | Bank of America — `boa_credit_card.csv` | High | `"Posted Date"` header not in `DATE_PATTERNS`; column detection rejected the file entirely | Added `"posted date"` to `DATE_PATTERNS` in `csvParser.ts` | `DEF-009: parses Bank of America credit card CSV (Posted Date header)` |
| DEF-010 | Wells Fargo — all 3 account types | High | No header row in WF exports; parser treated first data row as headers and failed detection | Added `tryPositionalFallback()`: detects headerless format when first cell is a date + second cell is a number; uses col 0 = date, col 1 = signed amount, last text col = description | `DEF-010: parses Wells Fargo headerless CSV (positional column fallback)` |
| DEF-011 | PNC — all 3 account types | High | Column headers `"Withdrawals"` / `"Deposits"` (plural) did not match `"withdrawal"` / `"deposit"` (singular) in `DEBIT_PATTERNS` / `CREDIT_PATTERNS` | Added plural forms to both pattern lists | `DEF-011: parses PNC checking CSV (Withdrawals/Deposits plural headers)` |
| DEF-012 | Chase — checking + savings | High | Type column values `"ACH_DEBIT"` / `"ACH_CREDIT"` not recognized; `isDebit` check required exact match to `"debit"` / `"dr"` / `"deb"`; all Chase amounts became positive (phantom income) | Replaced inline `isDebit` boolean with `classifyTypeColumn()` which uses substring matching (`includes("debit")`, `includes("credit")`) so `"ACH_DEBIT"` and `"ACH_CREDIT"` are handled | `DEF-012: parses Chase checking CSV (ACH_DEBIT/ACH_CREDIT type column)` |
| DEF-013 | Chase — credit card | High | Type column values `"Sale"` / `"Payment"` unrecognized; Priority 2 path called `Math.abs()` then re-signed wrong, converting all pre-signed negative expenses to positive income | `classifyTypeColumn()` recognizes `"sale"` as debit and `"payment"` as credit; unrecognized type values fall back to trusting the amount's existing sign (no `Math.abs()` applied) | `DEF-013: parses Chase credit card CSV (Sale/Payment type column)` |

**Verification:** `npx vitest run server/csvParser.test.ts` — 21 tests pass (16 pre-existing + 5 new regression tests). All 30 sample CSV files parse with `ok: true` and correct amount signs.

---

*PocketPulse — CIS490B Capstone Project, National University*
*Team: Pilar, Dominic, Nick, Edward*
*Report Version: 3.1 | Covering Weeks 1–6*
