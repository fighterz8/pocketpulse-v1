# PocketPulse — Sections 11 through 14
## Detailed Report Content (Weeks 1–5)

---

# 11. PROCESSES

## 11.1 Risk Management Processes

### Week 1: Foundation Security and Scope Discipline

The first week's risk posture centered on one principle: do not build anything on top of an untrusted base. The highest-risk scenario at this stage was deploying data-processing features (CSV ingestion, transaction review) before the identity and access boundary was properly sealed. A compromised authentication layer would expose all subsequent financial data processing.

Primary risks addressed this week:

**Risk 1 — Weak session trust boundary.**
*Mitigation:* Session management was implemented using `express-session` backed by a PostgreSQL session store (`connect-pg-simple`). Sessions are persisted across server restarts, cookie flags (`httpOnly`, `sameSite: "lax"`, `secure` in production) were set to reduce XSS and CSRF exposure, and session IDs are rotated on login to prevent session fixation attacks. Logout destroys the session record in the database, not just the client cookie.

**Risk 2 — Premature scope expansion.**
*Mitigation:* A strict phased build order was enforced. Authentication and account setup were completed and tested before any CSV ingestion code was written. This reduced the risk of implementing data-handling logic on top of an unstable authorization model.

**Risk 3 — Credential exposure.**
*Mitigation:* Passwords are hashed using `bcrypt` with a salt factor of 12. Plaintext passwords are never stored or logged. The login route uses a consistent response time regardless of whether the user exists, reducing username enumeration through timing attacks.

---

### Week 2: CSV Format Variability and Classification Errors

The most significant technical risk in Week 2 was the variability in CSV formats across different financial institutions. Banks and credit card providers do not follow a universal export format. Column names differ (e.g., "Amount" vs. "Debit" vs. "Transaction Amount"), date formats vary (MM/DD/YYYY vs. YYYY-MM-DD), and some institutions export unsigned amounts with a separate debit/credit column while others use signed values.

**Risk 4 — CSV parsing failures across bank formats.**
*Mitigation:* The import pipeline was built with a flexible column-detection strategy. Rather than requiring a fixed CSV schema, the parser scans header names against a dictionary of known aliases and normalizes to a canonical internal format. Files that cannot be mapped to a minimum set of required fields (date, amount, description) are rejected with a specific error message at the file level, not after import has started. This prevents corrupted data from entering the ledger.

**Risk 5 — Misclassification of expenses as income (and vice versa) from unsigned-amount banks.**
*Mitigation:* A direction hint subsystem was added to the classifier. When a bank exports unsigned amounts, the system inspects the raw description for directional language (e.g., "purchase," "debit," "payment," "credit," "deposit," "withdrawal") before assigning a transaction class. This direction hint is applied in Pass 3b of the classification engine and prevents wholesale misclassification of expense rows as income in unsigned-amount datasets. Amount-range heuristics (Pass 9b) were later added as a second signal: small, round, regularly-spaced amounts are more likely to be recurring subscription charges than one-time expenses.

**Risk 6 — Rule keyword matching too broadly (false positives).**
*Mitigation:* Word-boundary-aware regex matching was introduced in Pass 6. Before this change, a keyword like "SAL" (used for some salary-type descriptions) would incorrectly match a transaction containing "SALAD" or "SALSARITA'S." Switching to regex patterns compiled with `\b` word boundaries eliminated this class of false positive match. All 38+ category rule sets in the classifier now use compiled word-boundary regex rather than plain string `.includes()` checks.

---

### Week 3: Data Integrity During User Correction

**Risk 7 — Automated processes overwriting user corrections.**
*Mitigation:* A `userCorrected` boolean field was added to the transactions table. Once a user manually edits a transaction's category, class, or recurrence type, `userCorrected` is set to `true`. All automated processes — the batch reclassifier, the recurrence sync, and propagation logic — check this flag before touching a row and skip any record where it is set. This ensures that user knowledge is treated as the ground truth and is never silently overwritten by the system.

**Risk 8 — Propagation of corrections causing unintended overrides.**
*Mitigation:* When a user corrects a category, the system propagates that correction to other transactions from the same merchant that were labeled automatically (i.e., `userCorrected = false`). It does not touch other user-corrected rows from the same merchant. This design intentionally preserves disagreements: if a user corrected transaction A to "dining" and transaction B (same merchant) to "entertainment," both corrections stand independently.

---

### Week 4: Detection Accuracy and Dashboard Reliability

**Risk 9 — Recurring detection grouping the same merchant into multiple unrelated candidates.**
*Mitigation:* The candidate key design was revised. The original key included both the merchant identifier and an amount bucket, which caused the same recurring charge to appear as two separate candidates if the amount varied slightly across billing cycles (e.g., $14.99 one month, $15.00 the next after a price change). The redesigned key uses only `merchantKey` (a normalized version of the merchant name) as the grouping anchor, with a `bucketIndex` appended only when a single merchant genuinely has two distinct and separate charge levels. This reduced false splits in the leak review interface.

**Risk 10 — Leak monthly amount overstated on the dashboard.**
*Mitigation:* The `leakMonthlyAmount` KPI on the dashboard was initially computed by summing the `monthlyEquivalent` of all recurring candidates, including those the user had not reviewed or had marked as essential. The calculation was corrected to sum only candidates explicitly confirmed by the user as leaks. This made the dashboard figure meaningful rather than an inflated worst-case estimate.

**Risk 11 — Dashboard KPI figures inaccurate when the classifier used raw DB sums.**
*Mitigation:* The recurring expenses KPI was originally sourced from a raw SQL sum of transaction amounts for transactions flagged as recurring, which double-counted charges and ignored the frequency normalization needed for apples-to-apples monthly comparison. The calculation was moved to use the detector's `monthlyEquivalent` values, which normalize weekly, bi-weekly, and monthly charges to a common monthly rate.

---

### Week 5: UI Consistency and Dark Mode Theme Conflicts

**Risk 12 — Dark mode appearance controlled by OS rather than app toggle.**
*Mitigation:* Several input elements in the Ledger (search field, filter dropdowns, date pickers, clear button) were styled using CSS system color keywords (`background: Field; color: FieldText`). These keywords follow the operating system's color scheme, not the application's own dark/light class toggle. On a machine with an OS-level dark theme but the app set to light mode, these inputs rendered black. All four elements were replaced with explicit color values for light mode and a dedicated `html.dark` CSS override block for dark mode, ensuring the app's toggle is the single source of truth for appearance.

**Risk 13 — CSS specificity conflicts breaking themed KPI card colors.**
*Mitigation:* A CSS override rule (`html.dark .kpi-value { color: #f1f5f9 }`) was found to have higher specificity than the Tailwind `dark:text-emerald-400` utility classes used on KPI values. This caused all KPI figures to render in the same plain white regardless of their intended accent color (green for inflow, red for leak totals, etc.). The override was removed, and the Tailwind dark-variant classes were validated as the correct and sufficient mechanism.

---

## 11.2 Change Management Processes

### Week 1: Scope Baseline and Build Discipline

Change management in Week 1 focused on establishing a clear written scope baseline before development began. The formal V1 specification served as the authoritative definition of what the application must do. All implementation decisions were measured against this baseline: if a proposed feature was not in the written spec, it was deferred to a later phase rather than added opportunistically. This prevented scope creep from the first day of development.

A preliminary unofficial prototype had been built earlier to test whether the core PocketPulse concept was viable. That prototype was intentionally set aside when the formal build started, and the repository was opened fresh. The reasoning was that prototype code carries assumptions and shortcuts that are difficult to trace, and that a clean V1 build from a known baseline would be more reliable and auditable for the course submission.

---

### Week 2: Classifier Architecture Change

The initial classification approach was a simple keyword list scan — if the transaction description contained any keyword from a category's list, the category was assigned. This approach was fast to implement but produced a high false positive rate (a transaction at "SALSA VERDE TAQUERIA" would match the "salary" income rule because "SAL" appeared in the string).

The change to a 12-pass state machine with compiled word-boundary regex was a significant mid-development architectural shift. The decision was made after reviewing a set of real-world CSV files and counting misclassifications. The new design is ordered by priority: early passes handle structural signals (transfer detection, refund detection, income detection) that are relatively unambiguous, while later passes (merchant rules, amount-range heuristics) handle the more nuanced cases. The ordering means that a stronger signal in an earlier pass cannot be silently overridden by a weaker signal in a later one without an explicit override flag.

---

### Week 3: Recurring Detection Candidate Key Redesign

The original `candidateKey` for recurring expense detection included the merchant key plus an amount bucket index. The intended purpose was to keep two genuinely different charges from the same merchant (e.g., a $9.99 streaming plan and a $14.99 streaming plan on separate profiles) as separate candidates. In practice, it caused the same charge to split into multiple candidates when billing varied by even a few cents — which is common when taxes or currency rounding are applied.

The change was to use `merchantKey` alone as the grouping key and reserve bucket indexing only for cases where a single merchant had two clearly distinct charge levels (defined as a difference greater than a threshold in average amount). This change required a database migration to update existing `candidateKey` values in the `recurring_candidates` table. The migration was applied on startup so existing data was corrected automatically without requiring manual intervention.

---

### Week 4: Leak Review Interface — Subscriptions vs. Habits Split

The original leak review page displayed all recurring findings in a single list. This made it difficult to distinguish between unavoidable software subscriptions and behavioral spending habits (e.g., frequent coffee shop visits, weekly delivery orders). The change was to split the interface into two distinct sections:

- **Subscriptions** — Recurring candidates where `isSubscriptionLike = true`. These are flagged based on signals including: known subscription merchant names, recurring billing language in the description, small fixed amounts, or per-occurrence amounts below $50 combined with high frequency.
- **Habits** — All other recurring candidates. These represent repeated spending patterns that may or may not be waste depending on business context.

This change required adding the `isSubscriptionLike` boolean to the `recurring_candidates` table, computing it during the detection pass, and updating the Leaks page UI to render two separate sections with different header copy and visual treatment.

---

### 11.2.1 Project Scope Change Summary

| Phase | Change | Reason | Impact |
|---|---|---|---|
| Week 1 | Re-sequenced build order (auth before CSV) | Establish stable trust boundary before data processing | Deferred CSV and classification by ~3 days |
| Week 2 | Replaced keyword scan with 12-pass classifier | High false positive rate on real-world data | Improved classification accuracy; increased classifier codebase to ~1,969 lines |
| Week 2 | Added direction hint heuristics for unsigned-amount banks | Some banks export all amounts as positive values | Required additional CSV normalization step |
| Week 3 | Added `userCorrected` flag and propagation protection | Automated processes were overwriting manual fixes | Modified all sync/reclassify routines |
| Week 3 | Redesigned `candidateKey` (merchantKey only) | Amount-bucket key caused false splits in detection | Required DB migration on startup |
| Week 4 | Split Leaks UI into Subscriptions / Habits | Single list was too undifferentiated to be actionable | Added `isSubscriptionLike` signal to detector |
| Week 5 | Removed exclusion feature from Ledger | Simplified UX — exclusion was adding complexity without clear value in the current workflow | Removed ~64 lines of UI, filter dropdown, and edit panel fields |
| Week 5 | Replaced CSS system color keywords on all form inputs | OS dark mode and app dark mode were independent, causing black inputs in light mode | Fixed across search, filter selects, date pickers, clear button |

---

### 11.2.2 Version Control

Version control was used as a formal audit trail throughout the project, not simply as a backup mechanism. The repository (`fighterz8/pocketpulse-v1`) accumulated **165 commits** across the development timeline. The commit history documents not only what changed, but why — commit messages reference the specific technical problem being addressed (e.g., "fix: ledger filter fields show dark in light mode — replace CSS system color keywords," "fix: leakMonthlyAmount now sums confirmed leaks only").

**Branch workflow:** Feature development was conducted on the main branch for this project, with checkpoint commits after each meaningful unit of work. The Replit environment provided automated checkpoint creation, giving the team rollback capability at all meaningful states.

**Key commit milestones:**

| Commit | Description |
|---|---|
| Initial commit | Project scaffolding (Vite + Express + TypeScript) |
| Auth implementation | Session management, bcrypt, protected routes |
| CSV upload pipeline | Multi-file upload, column detection, normalization |
| 12-pass classifier | Word-boundary rules, direction hints, amount heuristics |
| Recurrence detector | candidateKey design, frequency detection, monthlyEquivalent |
| Dashboard KPIs | Safe-to-spend, leak totals, spending by category |
| Dark mode | localStorage persistence, Tailwind dark variants, html.dark CSS |
| Ledger polish | Inline editing, filtering, search, export |
| Leaks UI split | Subscriptions vs. Habits with isSubscriptionLike signal |
| Deployment config | Build + run commands corrected for autoscale production |

---

## 11.3 Quality Assurance Processes

### Week 1: Authentication Trust Boundary Validation

QA in Week 1 concentrated on verifying that the identity boundary worked correctly under normal and adversarial conditions.

### Quality Assurance Validation Matrix (Full Build)

| Feature | Description | Test Input | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| Registration | New user creates account with username and password | Valid new credentials | Account created; redirected to account setup | Account created; account setup screen displayed | Pass |
| Invalid login | User submits wrong password | Correct username, wrong password | Error message displayed; no access granted | "Invalid credentials" shown; session not created | Pass |
| Session persistence | User closes browser tab and reopens | Authenticated session cookie present | User remains logged in | Session maintained via PostgreSQL session store | Pass |
| Protected routes | Unauthenticated request to `/api/transactions` | No session cookie | 401 Unauthorized response | 401 returned with `{ error: "Unauthorized" }` | Pass |
| Account setup | New user creates a labeled financial account | Account label + optional last four digits | Account stored; user enters main workspace | Account persisted; dashboard loaded | Pass |
| Logout | User clicks logout | Authenticated session | Session destroyed; redirected to login | Session record deleted from DB; cookie cleared | Pass |
| CSV upload — standard format | Upload a bank CSV with Date, Description, Amount columns | Chase/BofA-style CSV | Transactions parsed and displayed in ledger | Normalized transactions appear in ledger | Pass |
| CSV upload — unsigned amounts | Upload a CSV where all amounts are positive with Debit/Credit columns | Some regional bank formats | Correct income/expense classification | Direction hints correctly assign class | Pass |
| CSV upload — malformed file | Upload a file with missing required columns | CSV with no date column | File-level error displayed; import blocked | Error message shown per file; rest of queue unaffected | Pass |
| Category classification | Import transactions from a grocery store, streaming service, coffee shop | Known merchant descriptions | Correct category assigned | Grocery, software, coffee categories correctly assigned | Pass |
| Word-boundary classification | Transaction description contains "SALSARITA'S" | Raw CSV row | Should not match salary income rule | Classified as "dining"; income rule not triggered | Pass |
| Manual category override | User changes a transaction from "other" to "dining" | Ledger inline select | Category updated; `userCorrected = true` | Category saved; propagated to same-merchant auto-labeled rows | Pass |
| Correction propagation protection | User corrects two same-merchant transactions differently | Two rows, same merchant, different categories | Both corrections preserved independently | Neither row overwritten by sync or reclassify | Pass |
| Recurring detection | Import 3+ months of data with a recurring subscription | Netflix/Spotify-style monthly charges | Detected as recurring candidate with monthlyEquivalent | Appears in Subscriptions section with correct monthly amount | Pass |
| Leak monthly total | Mark a recurring candidate as a leak | One confirmed leak of $14.99/month | Dashboard leak KPI = $14.99 | Correct; confirmed-only sum displayed | Pass |
| Safe-to-spend | Import one month with $5,000 income, $3,200 expenses | Known amounts | Safe-to-spend = $1,800 | $1,800 displayed on dashboard | Pass |
| Date range filtering | Change dashboard range from current month to last 3 months | Date range selector | KPIs recalculate for selected range | All KPIs update to reflect selected window | Pass |
| Ledger search | Search for "amazon" in ledger | Partial merchant string | Only Amazon transactions shown | Filtered correctly; case-insensitive | Pass |
| Ledger filter — category | Filter ledger to "dining" only | Category dropdown | Only dining transactions shown | Filter applied; pagination correct | Pass |
| CSV export | Click Export CSV with active category filter | "dining" filter set | Download contains only dining transactions | Correct filtered export generated | Pass |
| Dark mode toggle | Switch from light to dark mode | Toggle in sidebar | All UI elements switch to dark palette | Correct; persisted in localStorage across sessions | Pass |
| Dark mode — form inputs | Check ledger inputs in light mode with OS dark theme | OS dark + app light | Inputs should be white with dark text | Correct after Field/FieldText system color fix | Pass |
| KPI color accuracy — dark mode | View KPI cards in dark mode | Dark mode active | Each KPI value shows its accent color (green/red/etc.) | Correct after CSS specificity fix; colors match light mode intent | Pass |
| Production deployment | Build and deploy to autoscale | `npm run build` + `npm run start` | App serves on PORT with static frontend | Deployed successfully to `.replit.app` domain | Pass |

---

### 11.3.1 Defect Tracking Process

The defect tracking process logged each discovered issue with a description of the affected workflow, the reproduction path, the layer where the problem originated, and the fix applied.

### Defect Log

| # | Workflow Affected | Reproduction Steps | Likely Layer | Fix Applied | Verification Result |
|---|---|---|---|---|---|
| D-01 | Category classification | Import a CSV from a restaurant named "SALSARITA'S FRESH MEX" | Classifier — Pass 6 keyword matching | Replaced string `.includes()` with word-boundary regex (`\bsal\b`) in all COMPILED_RULES | Re-importing the same file assigns "dining"; income rule no longer triggers |
| D-02 | Dashboard — Leak KPI | Mark two recurring candidates as leaks; observe dashboard leak total | dashboardQueries — `leakMonthlyAmount` calculation | Corrected to sum `monthlyEquivalent` of confirmed-leak candidates only; previously summed all candidates | Dashboard total now equals sum of marked leaks only |
| D-03 | Dashboard — Recurring Expenses KPI | Compare recurring expenses KPI to actual subscription total | dashboardQueries — `recurringExpenses` source | Replaced raw DB amount sum with detector's `monthlyEquivalent` sum for normalized monthly comparison | KPI correctly reflects normalized monthly cost of recurring charges |
| D-04 | Ledger — Form inputs in light mode | Open ledger on machine with OS dark mode + app in light mode | Frontend CSS — system color keywords | Replaced `background: Field; color: FieldText` with explicit `#ffffff` / `#374151` + `html.dark` overrides | Inputs render white with dark text in light mode regardless of OS theme |
| D-05 | Dashboard — KPI card colors in dark mode | Switch to dark mode; observe all KPI values render in identical white | Frontend CSS — specificity conflict | Removed `html.dark .kpi-value { color: #f1f5f9 }` override which had higher specificity than Tailwind `dark:text-emerald-400` | Each KPI renders its intended accent color (green for inflow, red for leaks, etc.) |
| D-06 | Recurring detection — candidate grouping | Upload 3 months of Netflix data; observe two separate candidates for slightly different amounts | Recurrence Detector — `buildCandidateKey()` | Redesigned key to use `merchantKey` only; bucket index appended only for genuinely distinct charge levels | Single merchant produces one grouped candidate; amount variation within tolerance no longer splits |
| D-07 | Recurring detection — startup state | Restart server after uploading new data; recurring candidates not updated | Server startup — `syncRecurringCandidates` call | Added automatic call to `syncRecurringCandidates()` on server startup after DB connection is established | Candidates are always current after any restart |
| D-08 | Dark mode — multiple UI regions | Inspect progress bar tracks, subscription card text, KPI sub-labels in dark mode | Frontend CSS — missing dark overrides | Added explicit dark overrides for `kpi-label`, `kpi-sub`, `kpi-drill`, subscription card text, hero value `safeColor` | All identified elements render readable text in dark mode |
| D-09 | Production deployment | Click Deploy; build succeeds but app fails to start | Deployment config — run command | Corrected `.replit` run command from `["node", "./dist/index.cjs"]` to `["npm", "run", "start"]` which executes `NODE_ENV=production node dist/server/index.js` | App starts successfully in autoscale environment |

---

### 11.3.2 Technical Review Process

Technical reviews were conducted at the end of each phase to verify that implementation matched the architectural intent before the next phase began.

**Week 1 Technical Review:**
Verification confirmed that the three-layer separation (presentation / application / data) was preserved in the initial codebase. The Express route handlers were kept thin — they validate input, call the storage interface, and return responses. No business logic was embedded directly in routes. The storage interface (`server/storage.ts`) was verified as the exclusive layer touching the database, with all queries expressed through Drizzle ORM rather than raw SQL. Session handling and authentication middleware were verified to apply correctly to all protected routes.

**Week 2 Technical Review:**
The CSV ingestion pipeline was reviewed to confirm that raw file content was never stored in the database (only parsed, normalized records are persisted) and that the classifier operated on normalized merchant strings rather than raw bank descriptions. The 12-pass classifier was reviewed for pass ordering correctness — specifically that direction hints and transfer detection (Passes 1, 3, 3b) run before merchant rule matching (Pass 6), so that structural signals take precedence over keyword matches. The word-boundary regex compilation was spot-checked against known false-positive cases.

**Week 3 Technical Review:**
The `userCorrected` flag implementation was verified across all three code paths that touch transaction fields: the batch reclassifier, the recurrence sync, and the inline edit endpoint. All three were confirmed to check the flag and skip protected rows. The propagation logic was reviewed to confirm it only propagates to auto-labeled rows and never overwrites other user corrections.

**Week 4 Technical Review:**
The dashboard query layer (`server/dashboardQueries.ts`) was reviewed against the functional requirements: `safeToSpend = totalInflow − totalOutflow`, `leakMonthlyAmount` sums only confirmed leaks, and `recurringExpenses` uses detector-normalized monthly equivalents. The recurrence detector was reviewed to confirm that `AUTO_ESSENTIAL_CATEGORIES` (housing, utilities, insurance, medical, debt) are marked as essential automatically and never shown to the user as leak candidates.

**Week 5 Technical Review:**
The production deployment configuration was reviewed. The build pipeline (`npm run build`) was confirmed to execute both `vite build` (frontend → `dist/public`) and `tsc -p tsconfig.build.json` (backend → `dist/server/`). The production server (`server/static.ts`) was verified to serve `dist/public` as static files and fall back to `index.html` for any non-API GET route, supporting full client-side routing in production.

---

# 12. REVISED PROJECT PLAN

The build followed a phased weekly structure that remained largely consistent with the original plan, with the adjustments noted in the change log. The table below reflects what was actually completed versus the original plan.

### Actual Build Sequence vs. Plan

| Phase | Original Plan | Actual Outcome | Notes |
|---|---|---|---|
| Phase 1 | Auth + account setup + visual foundation | Completed as planned | Session management, bcrypt, protected routes, account labeling, design system |
| Phase 2 | CSV upload + validation | Completed with scope expansion | Added direction hints and unsigned-amount handling beyond original spec |
| Phase 3 | Ledger review + editing | Completed with classifier upgrade | Word-boundary regex and 12-pass state machine added during this phase |
| Phase 4 | Recurring review + dashboard + export + final QA | Completed | candidateKey redesign, isSubscriptionLike signal, Subscriptions/Habits split, deployment fix |

### Revised Build Order (Final)

```
Phase 1                  Phase 2                    Phase 3                     Phase 4
Auth + account    →    CSV upload +         →     Ledger review +       →    Recurring review +
setup + visual         validation +               inline editing +            dashboard +
foundation             column detection +          12-pass classifier +        export +
                        direction hints             word-boundary rules         QA + deployment
```

### Updated Workplan Estimates (Actual)

| Work Area | Estimated Hours (Plan) | Actual Effort | Notes |
|---|---|---|---|
| Planning and requirements | 10–15 hrs | ~12 hrs | Scope docs, risk matrix, use cases, requirements |
| UI/UX design and wireframes | 8–12 hrs | ~10 hrs | Dashboard, upload, ledger, leaks mockups |
| Authentication and user management | 10–15 hrs | ~14 hrs | Session, bcrypt, CSRF, protected routes, account setup |
| CSV upload and parsing | 15–20 hrs | ~18 hrs | Multi-file upload, column detection, normalization, direction hints |
| Classification logic and review flow | 15–20 hrs | ~25 hrs | 12-pass classifier, word-boundary regex, propagation, reclassifier |
| Recurring detection | — (not separately estimated) | ~16 hrs | candidateKey, frequency detection, monthlyEquivalent, isSubscriptionLike |
| Dashboard and reporting | 10–15 hrs | ~14 hrs | KPI cards, spending charts, safe-to-spend, date range selector |
| Dark mode and UI polish | — (not separately estimated) | ~8 hrs | CSS overrides, localStorage persistence, specificity fixes |
| Testing and debugging | 10–15 hrs | ~18 hrs | Defect tracking, QA matrix verification, CSV format testing |
| Final presentation and documentation | 8–12 hrs | ~10 hrs | Report, change log, milestone assembly |
| **Total** | **86–124 hrs** | **~145 hrs** | Classifier and detector complexity exceeded original estimates |

---

# 13. PROJECT MANAGEMENT SECTION

### Weekly Phase Assignments (Final)

| Phase | Nick | Pilar | Dominic | Edward |
|---|---|---|---|---|
| Phase 1: Auth + account setup + visual foundation | Primary (implementation) | Primary (documentation, design language) | Support (QA review) | Support (presentation framing) |
| Phase 2: CSV upload + validation + classification | Primary (implementation) | Support (requirements alignment) | Primary (QA, format testing) | Support |
| Phase 3: Ledger review + editing + classifier upgrade | Primary (implementation) | Support (documentation) | Support (defect review) | Support |
| Phase 4: Recurring review + dashboard + export + deployment | Primary (implementation) | Support (documentation, QA narrative) | Primary (QA, defect tracking) | Primary (presentation, final doc) |

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

*PocketPulse — CIS490B Capstone Project, National University*
*Team: Pilar, Dominic, Nick, Edward*
*Report Version: 3.0 | Covering Weeks 1–5*
