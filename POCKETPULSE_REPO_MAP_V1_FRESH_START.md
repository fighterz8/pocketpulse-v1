# PocketPulse V1 — Fresh-Start Scope-Aligned Technical Specification & Repository Map

**Application:** PocketPulse  
**Version Target:** V1 (class-aligned MVP)  
**Document Purpose:** Define the fresh-start V1 build specification for the new PocketPulse repository, using the older prototype repository only as a reference point while keeping implementation/reporting traceable throughout the class.  
**Document Date:** April 1, 2026

---

## Table of Contents

1. [Document Intent and Scope Alignment](#1-document-intent-and-scope-alignment)
2. [V1 Product Definition](#2-v1-product-definition)
3. [Guiding Build Principles](#3-guiding-build-principles)
4. [High-Level Architecture](#4-high-level-architecture)
5. [Repository Structure (V1)](#5-repository-structure-v1)
6. [Feature Scope Matrix](#6-feature-scope-matrix)
7. [Database Model](#7-database-model)
8. [Authentication and Session Rules](#8-authentication-and-session-rules)
9. [API Surface (V1)](#9-api-surface-v1)
10. [Server-Side Processing Services](#10-server-side-processing-services)
11. [Frontend Architecture and Routing](#11-frontend-architecture-and-routing)
12. [Page-by-Page Functional Specification](#12-page-by-page-functional-specification)
13. [Core Processing Pipelines](#13-core-processing-pipelines)
14. [Financial Calculation Rules](#14-financial-calculation-rules)
15. [Data Review, Auditability, and Safety Rules](#15-data-review-auditability-and-safety-rules)
16. [Environment Variables and Build Scripts](#16-environment-variables-and-build-scripts)
17. [Implementation Standards and Documentation Rules](#17-implementation-standards-and-documentation-rules)
18. [GitHub Delivery Rules (Non-Optional)](#18-github-delivery-rules-non-optional)
19. [4-Week Phased Development Plan](#19-4-week-phased-development-plan)
20. [Requirement Traceability Matrix](#20-requirement-traceability-matrix)
21. [Known Gaps, Risks, and Next Actions](#21-known-gaps-risks-and-next-actions)
22. [Future Enhancements (Not V1)](#22-future-enhancements-not-v1)

---

## 1. Document Intent and Scope Alignment

This document intentionally replaces the earlier prototype-oriented repository map. The previous version described a broader product shape, including a dedicated `Analysis` page and supporting analysis route. V1 no longer treats that module as an active deliverable.

The project is also now being built from a **fresh repository baseline**. The earlier repository still exists on GitHub as a legacy prototype reference, but the current working repository should be treated as a clean rebuild, not as a continuation that assumes old files are still present locally.

This specification exists to do five things well:

1. Align the technical documentation to the current class scope.
2. Preserve functionality that already exists and still supports the MVP.
3. Explicitly remove or archive prototype features that would create reporting or scope confusion.
4. Make each retained feature explainable enough for milestone reporting.
5. Force disciplined implementation through phase rules, GitHub cadence rules, and documentation rules.

### 1.1 What changed from the prototype spec

The biggest V1 shifts are:

- The dedicated **Analysis page** is removed from the active product specification.
- Dashboard becomes the primary insight surface.
- `Leaks.tsx` is treated as a **Recurring Leak Review** workflow, not a passive list.
- Full ledger editing remains in scope.
- Wipe/reset controls remain in scope as bounded workspace management features.
- Optional AI-assisted labeling is moved out of the core V1 path.
- GitHub delivery discipline is now part of the technical specification, not an informal expectation.

### 1.2 V1 scope anchor

PocketPulse V1 is a **single-owner web application** for importing CSV transaction files, labeling accounts, normalizing and reviewing transactions, surfacing recurring leak candidates, showing safe-to-spend insight, and exporting reviewed results.

### 1.3 Scope boundaries

#### In Scope
- Login-based single-owner workspace
- Upload one or more CSV files in a single import workflow
- Account labeling and optional last four digits
- Transaction normalization
- Rules-based categorization
- Ledger review and correction
- Transaction exclusion from analysis
- Recurring leak detection and user review actions
- Dashboard with safe-to-spend and summary insight
- CSV export
- Workspace cleanup controls

#### Out of Scope
- Direct bank syncing
- Full accounting platform behavior
- Tax-grade categorization guarantees
- Multi-user permissions
- Automated vendor cancellation or notifications outside the active session
- Dedicated Analysis page
- Analysis-first reporting narrative
- AI as a required dependency for core V1 behavior

### 1.4 Fresh-start repository rule

The current repository should be documented as a **new V1 build**. The old prototype repo may still be used for reference, screenshots, prior logic review, or selective migration, but it is not the active implementation baseline.

Implications:
- do not document prototype files as if they already exist in the fresh repo
- do not assume old branches, scripts, or routes still exist locally
- any reused code from the legacy repo must be reintroduced intentionally, explained, and committed as new work in the fresh repo
- the new repository history should clearly tell the V1 build story from setup to delivery

---

## 2. V1 Product Definition

### 2.1 Product statement

PocketPulse helps a microbusiness owner review cash movement across multiple accounts without needing a full accounting platform. The product is intentionally built around a practical review loop:

**upload -> normalize -> review/edit -> review recurring findings -> inspect dashboard -> export**

### 2.2 Core user value

The user should be able to answer these questions within one session:

- What transactions were imported and from which accounts?
- What needs correction before reporting can be trusted?
- Which repeated charges look essential versus wasteful?
- What is likely safe to spend in the selected period?
- Can the reviewed results be exported cleanly?

### 2.3 Why V1 is intentionally bounded

The class project should favor reviewable logic over fragile automation. CSV import is lower scope and easier to explain than live bank integrations. Manual override is not a weakness in this context; it is part of the trust model.

---

## 3. Guiding Build Principles

### 3.1 Reviewability over magic
Every major output should be traceable to imported data, deterministic rules, or explicit user action.

### 3.2 Utility over novelty
A smaller set of well-documented and testable features is more valuable than a wide prototype surface.

### 3.3 Incremental architecture
The system is designed so upload/normalization, transaction review, recurring review, and dashboard reporting can be completed in phases.

### 3.4 User trust through control
The user must be able to correct transactions, exclude noise from analysis, and override recurring leak outcomes.

### 3.5 Documentation is part of the build
If a feature is added but not documented in the repo, phase log, and milestone summary, it is not considered complete.

### 3.6 Fresh repo over legacy assumptions
The current repository should only contain code that the team intentionally rebuilds or ports into V1. Legacy prototype logic can inform decisions, but it should never silently define current scope, architecture, or completion status.

---

## 4. High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Browser (React SPA)                                                         │
│                                                                              │
│  Auth  →  Upload / Import  →  Ledger / Transaction Review  →  Recurring     │
│                                                          Leak Review         │
│                             ↓                                                │
│                          Dashboard / Export                                  │
│                                                                              │
│                         TanStack Query + Wouter                              │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ HTTP / JSON
┌──────────────────────────────────────▼───────────────────────────────────────┐
│ Express + TypeScript Backend                                                 │
│                                                                              │
│ auth.ts | routes.ts | storage.ts | csvParser.ts | classifier.ts              │
│ recurrenceDetector.ts | cashflow.ts | dateRanges.ts | transactionUtils.ts    │
│                                                                              │
│ Optional future extension: llmLabeler.ts (not core V1 path)                  │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼───────────────────────────────────────┐
│ PostgreSQL                                                                   │
│                                                                              │
│ users | accounts | uploads | transactions | recurring review state |         │
│ session store                                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Key architecture decisions

| Area | V1 Choice | Reason |
|---|---|---|
| App model | Single-page React app | Keeps the review workflow fast and contained |
| Routing | `wouter` | Minimal routing surface |
| Server state | TanStack Query | Good fit for API-backed dashboard and review flows |
| Auth | Session-based auth | Simpler than JWT for a single-owner class project |
| Persistence | PostgreSQL + Drizzle | Type-safe schema sharing and durable storage |
| Import model | Manual CSV workflow | Matches scope and reduces integration risk |
| Classification | Deterministic rules first | Easier to explain, test, and trust |
| Dashboard strategy | Summary-first | Replaces the need for a separate analysis module |

### 4.2 Removed prototype surface

The following are **not active V1 surfaces**:
- `Analysis.tsx`
- `/api/analysis`
- prior-period comparison dashboard expansion
- analysis-only charts and comparison widgets

If the code still exists in the repository, it should be treated as archived prototype material, not active V1 product scope.

---

## 5. Repository Structure (V1)

This section describes the **target structure for the fresh V1 repository**. It is a build target, not a claim that every file already exists on day one.

```text
/
├── shared/
│   └── schema.ts
│
├── server/
│   ├── index.ts
│   ├── db.ts
│   ├── auth.ts
│   ├── routes.ts
│   ├── storage.ts
│   ├── csvParser.ts
│   ├── classifier.ts
│   ├── recurrenceDetector.ts
│   ├── cashflow.ts
│   ├── dateRanges.ts
│   ├── transactionUtils.ts
│   ├── static.ts
│   ├── vite.ts
│   └── llmLabeler.ts              # optional / future extension only
│
├── client/
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── index.css
│       ├── components/
│       │   ├── layout/
│       │   │   └── AppLayout.tsx
│       │   └── ui/
│       ├── hooks/
│       │   ├── use-auth.ts
│       │   ├── use-mobile.tsx
│       │   └── use-toast.ts
│       ├── lib/
│       │   ├── queryClient.ts
│       │   └── utils.ts
│       └── pages/
│           ├── Auth.tsx
│           ├── Dashboard.tsx
│           ├── Upload.tsx
│           ├── Ledger.tsx
│           ├── Leaks.tsx          # V1 meaning: Recurring Leak Review
│           └── not-found.tsx
│
├── script/
│   └── build.ts
│
├── drizzle.config.ts
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json
├── tsconfig.build.json
├── README.md
└── package.json
```

### 5.0.1 Current Phase 1 realized structure snapshot

As of the completed Week 1 auth/account-setup pass, the fresh repo also includes the following implemented files and documentation paths:

```text
/
├── server/
│   ├── public-user.ts
│   ├── project-config.test.ts
│   ├── schema.test.ts
│   ├── auth.test.ts
│   └── routes.test.ts
│
├── client/
│   └── src/
│       ├── App.test.tsx
│       ├── test/
│       │   └── setup.ts
│       ├── hooks/
│       │   └── use-auth.test.tsx
│       └── pages/
│           └── AccountSetup.tsx
│
└── docs/
    ├── phase-logs/
    │   └── phase-1-auth-account-setup-progress.md
    └── superpowers/
        ├── specs/
        │   ├── 2026-04-01-phase-1-auth-account-setup-design.md
        │   └── 2026-04-01-phase-1-auth-visual-foundation-design.md
        └── plans/
            └── 2026-04-01-phase-1-auth-visual-foundation-implementation.md
```

### 5.1 Legacy prototype reference repository

The older prototype repository still exists on GitHub, but it is now a **reference artifact**, not the active codebase.

Rules for using legacy repo material:
1. do not copy large sections of the old repo forward without review
2. port only what supports the current V1 scope
3. when porting old logic, rewrite or clean it where needed so the fresh repo stays coherent
4. every migrated feature must be introduced through a normal feature branch with a clear summary of what was preserved, removed, or simplified

### 5.2 Analysis module rule

If `Analysis.tsx` or related analysis code is ever pulled from the legacy repo, it must remain inactive unless the class scope is formally expanded. The fresh repository should not present analysis-only code as an active V1 deliverable.

---

## 6. Feature Scope Matrix

| Feature | Legacy Repo Status | V1 Status | Notes |
|---|---|---|---|
| Session auth | Implemented | Keep | Core product requirement |
| Registration | Implemented | Keep, but de-emphasize | Useful for workspace bootstrap |
| Multi-file import workflow | Partial / target | Keep and complete | Important for scope alignment |
| Account labeling | Implemented/partial | Keep | Core upload requirement |
| Optional last four digits | Implemented/partial | Keep | Needed for account clarity |
| CSV normalization | Implemented | Keep | Core ingest logic |
| Rules-based categorization | Implemented | Keep | Must remain reviewable |
| Ledger editing | Implemented | Keep | Full review/correction stays in scope |
| Exclude transaction from analysis | Needs explicit V1 support | Keep and complete | Required for ledger workflow |
| Recurring leak detection | Implemented | Keep | Core insight logic |
| Recurring leak review actions | Partial / target | Keep and complete | Essential / leak / dismiss |
| Dashboard safe-to-spend | Implemented | Keep | Primary KPI |
| Dashboard category summary | Partial / target | Keep and simplify | Use chart or table, not analysis sprawl |
| Export | Implemented | Keep | Must reflect reviewed data |
| Wipe data | Implemented | Keep | Workspace management |
| Reset workspace | Implemented | Keep | Workspace management |
| Dedicated Analysis page | Implemented in prototype | Remove from V1 | Archived / inactive |
| `/api/analysis` | Implemented in prototype | Remove from V1 | Not part of active route surface |
| LLM labeling | Optional prototype path | Future-only | Do not make core V1 dependent on it |

---

## 7. Database Model

**Primary source:** `shared/schema.ts`

### 7.1 Phase 1 implemented core tables

#### `users`
| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | Auto-increment |
| `email` | text | Unique, not null |
| `password` | text | Hashed credential |
| `display_name` | text | Required workspace-facing user name |
| `company_name` | text | Single-owner workspace label |
| `created_at` | timestamp | Auditability / onboarding trace |
| `updated_at` | timestamp | Record update trace |

#### `user_preferences`
| Column | Type | Notes |
|---|---|---|
| `user_id` | integer PK/FK | FK → users.id |
| `theme` | text | Default `system` |
| `week_starts_on` | smallint | Default `0` |
| `default_currency` | text | Default `USD` |

#### `accounts`
| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `user_id` | integer | FK → users.id |
| `label` | text | Account label shown in onboarding/shell |
| `last_four` | text | Optional display/reference value |
| `account_type` | text | Optional account classification |
| `created_at` | timestamp | Record creation trace |
| `updated_at` | timestamp | Record update trace |

#### `session`
| Column | Type | Notes |
|---|---|---|
| `sid` | varchar PK | `connect-pg-simple` session identifier |
| `sess` | json | Serialized session payload |
| `expire` | timestamp | Expiry used by session store |

### 7.1.1 Later-phase planned tables

The following remain part of the broader V1 model, but they are **not yet implemented in the completed Phase 1 schema baseline**:

#### `uploads`
| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `user_id` | integer | FK → users.id |
| `account_id` | integer | FK → accounts.id |
| `filename` | text | Original CSV name |
| `row_count` | integer | Parsed row count |
| `uploaded_at` | timestamp | Import timestamp |

#### `transactions`
| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `user_id` | integer | FK → users.id |
| `upload_id` | integer | FK → uploads.id |
| `account_id` | integer | FK → accounts.id |
| `date` | text | ISO date string |
| `amount` | numeric(12,2) | Signed amount |
| `merchant` | text | Cleaned merchant |
| `raw_description` | text | Original imported text |
| `flow_type` | text | inflow / outflow |
| `transaction_class` | text | income / expense / transfer / refund |
| `recurrence_type` | text | recurring / one-time |
| `category` | text | V1 category bucket |
| `label_source` | text | rule / manual / optional future llm |
| `label_confidence` | numeric(5,2) | Rule certainty |
| `label_reason` | text | Reason shown to user/admin |
| `ai_assisted` | boolean | Optional future metadata |
| `user_corrected` | boolean | Protects reviewed rows from reprocess |

### 7.2 V1 required additions or confirmation items

These must be present explicitly in schema and documentation by the end of V1:

#### A. Transaction exclusion state
Add or confirm a field such as:
- `excluded_from_analysis` boolean default false
- optional `excluded_reason` text
- optional `excluded_at` timestamp

**Why it exists:** the user must be able to exclude noise or misleading records from dashboard, leak, and export logic when needed.

#### B. Recurring review outcome persistence
Use either dedicated fields on a recurring findings table or a separate review-state table.

Example approach:
- `recurring_reviews`
  - `id`
  - `user_id`
  - `merchant_key`
  - `status` (`essential`, `leak`, `dismissed`, `unreviewed`)
  - `notes`
  - `updated_at`

Alternative:
- store a normalized review outcome against a recurring candidate key derived from merchant + category + cadence signature.

### 7.3 Recommended V1 categories

V1 should keep category sets manageable and explainable:
- income
- transfers
- utilities
- subscriptions
- insurance
- housing
- groceries
- transportation
- dining
- shopping
- health
- debt
- business_software
- entertainment
- fees
- other

### 7.4 Data preservation rule

Imported source values should remain available for traceability. Any user-edited value should be reviewable alongside the original imported record where possible.

---

## 8. Authentication and Session Rules

### 8.1 Auth model
- Session-based authentication
- Single-owner workspace model
- Login is core V1 behavior
- Registration is allowed for workspace creation/testing but is not the product’s main value proposition

### 8.2 Session expectations
- Authenticated session persists until logout or expiration
- Protected pages require active auth state
- Authenticated users without any accounts must pass through first-account setup before the wider shell
- Logout must fully clear the session

### 8.3 Why this approach fits V1
This project does not need token choreography, role hierarchies, or external identity provider complexity. The auth goal is simply to protect sensitive transaction data and keep the workspace private.

---

## 9. API Surface (V1)

All routes remain prefixed with `/api`.

### 9.1 Core product routes

#### Authentication
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

#### Accounts
- `GET /api/accounts`
- `POST /api/accounts`

#### Uploads
- `POST /api/upload`
- `GET /api/uploads`

#### Transactions
- `GET /api/transactions`
- `PATCH /api/transactions/:id`
- `POST /api/transactions/reprocess`          # operational; not headline feature
- `DELETE /api/transactions`                  # wipe imported data
- `DELETE /api/workspace-data`                # reset workspace

#### Reporting
- `GET /api/cashflow`
- `GET /api/leaks`
- `GET /api/export/summary`
- `GET /api/export/transactions`

### 9.2 V1 route changes from prototype

#### Remove from active V1
- `GET /api/analysis`

Any frontend or server code depending on `/api/analysis` should be removed or archived.

### 9.3 V1 transaction query support

`GET /api/transactions` should support:
- pagination
- account filter
- search
- category filter
- transaction class filter
- recurrence filter
- date range filter
- excluded/non-excluded filter

### 9.4 Workspace management routes

These remain in scope, but are not primary value features:

#### Wipe imported data
Deletes transactions and uploads while preserving account setup.

#### Reset workspace
Deletes transactions, uploads, and accounts to restore a clean workspace.

Both require:
- confirmation UI
- warning copy
- visible success/failure feedback

---

## 10. Server-Side Processing Services

### 10.1 `csvParser.ts`
Purpose:
- validate CSV structure
- detect useful columns
- normalize row values
- return parseable records for downstream processing

V1 expectations:
- reject unsupported or malformed files early
- surface file-level or row-level errors clearly
- support one or more uploads within the same import session

### 10.2 `classifier.ts`
Purpose:
- assign merchant cleanup
- determine class
- assign category
- set initial recurrence hints
- explain why the label was chosen

V1 rule:
- rules must be explainable
- avoid opaque classification logic in the core path

### 10.3 `recurrenceDetector.ts`
Purpose:
- detect recurring or repeated-spend patterns based on merchant similarity, cadence, and amount behavior

V1 rule:
- recurring candidates are suggestions until reviewed
- recurring detection is never treated as perfect truth

### 10.4 `cashflow.ts`
Purpose:
- summarize inflows/outflows
- compute safe-to-spend
- prepare leak metrics and dashboard summaries
- exclude transfers/refunds and excluded rows where appropriate

### 10.5 `dateRanges.ts`
Purpose:
- resolve preset and custom date windows
- keep dashboard behavior deterministic

### 10.6 `transactionUtils.ts`
Purpose:
- amount normalization
- signed amount derivation
- flow-type inference
- safe construction of manual update payloads

### 10.7 `storage.ts`
Purpose:
- isolate data access rules
- keep data operations testable and explicit

### 10.8 `llmLabeler.ts`
V1 policy:
- this is not part of the core required runtime path
- keep only as future extension or experimental module
- do not make core classification, dashboard, or recurring review dependent on it

---

## 11. Frontend Architecture and Routing

### 11.1 Route map

| Path | Component | V1 Meaning |
|---|---|---|
| `/` | `Dashboard` | Primary summary and action surface |
| `/upload` | `Upload` | Multi-file import workflow |
| `/transactions` | `Ledger` | Transaction review, correction, exclusion, export |
| `/leaks` | `Leaks` | Recurring Leak Review |
| `*` | `not-found` | Fallback |

Current Phase 1 implementation note:
- `Auth` and `AccountSetup` are **gated entry states** controlled by auth/session/account presence, not separate headline routes in the protected app map

### 11.2 Removed route
- `/analysis` is no longer an active V1 route.

### 11.3 State strategy
TanStack Query remains the main data-fetching/caching layer. Route state and filter state should remain URL-driven where useful, especially in the ledger.

### 11.4 UX rule
No screen should exist just to look impressive. Each screen must serve the V1 review loop directly.

---

## 12. Page-by-Page Functional Specification

## 12.1 Auth Page (`Auth.tsx`)

### Purpose
Provide secure login and workspace entry.

### Required behavior
- allow login
- show clear invalid-credential errors
- allow registration where workspace bootstrap is needed
- route authenticated users with zero accounts into `AccountSetup`
- route authenticated users with at least one account into the protected app shell

### Why it exists
Sensitive financial data should not be exposed to unauthenticated visitors.

---

## 12.2 Upload Page (`Upload.tsx`)

### Purpose
Manage the import workflow for one or more CSV files.

### V1 required behavior
- add one or more CSV files to an upload queue
- display each file before import is finalized
- allow removing a queued file
- assign account label per file
- allow optional last four digits
- validate format before final import
- show progress and import result
- create an upload record for each import session

### Thought process
Upload is the foundation of everything else. If the system cannot clearly show what is about to be imported and from which account, downstream review becomes unreliable.

### Minimum visible UI elements
- queued file list
- remove button per queued file
- account label input per file
- optional last four field
- import action button
- validation/error area
- success state with next action to review transactions

---

## 12.3 Ledger Page (`Ledger.tsx`)

### Purpose
Serve as the main transaction review and correction surface.

### V1 required behavior
- display normalized transactions in a ledger
- support search and filters
- allow inline correction of important fields
- allow exclusion from analysis
- save user overrides
- mark user-edited rows as protected from automated reprocessing
- export filtered/reviewed results
- expose bounded workspace maintenance actions

### Editable fields
The ledger should explicitly support editing of:
- transaction date
- merchant / description
- amount
- category
- transaction class
- recurrence type
- exclusion status

### What stays in scope
Full ledger editing remains part of V1. This is not treated as feature creep because review and correction are already central to the product concept.

### Workspace management controls
Keep:
- **Wipe Data** — remove transactions and uploads, preserve accounts
- **Reset Workspace** — remove transactions, uploads, and accounts

These controls should appear as operational tools, not as primary marketing features.

### Thought process
The ledger is where trust is earned. If imported data cannot be corrected, the dashboard becomes fragile. If destructive cleanup cannot happen safely, iterative testing becomes painful.

---

## 12.4 Recurring Leak Review (`Leaks.tsx`)

### Purpose
Turn recurring detection into a user-driven review workflow.

### V1 required behavior
- display recurring findings in a dedicated interface
- show merchant/pattern name
- show average amount
- show frequency or recurrence signal
- show last seen date
- show brief reason flagged
- allow marking as **essential**
- allow marking as **leak-related**
- allow **dismiss**
- persist the review outcome

### Recommended card structure
- title / merchant
- average monthly or repeating amount
- reason flagged
- last seen
- frequency / confidence
- action buttons

### Thought process
Recurring logic is inherently probabilistic. The system should surface candidates, not make final financial judgments without user review.

---

## 12.5 Dashboard (`Dashboard.tsx`)

### Purpose
Provide a concise view of reviewed financial insight.

### V1 required behavior
- show safe-to-spend as primary KPI
- show summary insight for income, expenses, and leak-related spend
- support preset or custom date ranges
- recalculate when date range changes
- show chart-based or table-based category summary
- show recurring leak-related findings preview
- allow drilldown into ledger where useful
- allow export

### What was removed
- Advanced Analysis link
- separate analysis navigation
- prior-period comparison heavy analytics
- analysis-only chart surfaces

### Allowed dashboard depth
Dashboard can absorb a small amount of summary visualization from the prototype, but only when it directly supports V1:
- one compact category chart or table
- one recurring findings preview section
- summary cards that actually drive review decisions

### Thought process
Dashboard is not a second ledger and not a mini BI tool. It is the final summary surface for reviewed data.

---

## 13. Core Processing Pipelines

### 13.1 Upload and import pipeline

```text
User selects CSV files
    ↓
Files appear in upload queue
    ↓
User labels account for each file
    ↓
System validates file format
    ↓
System parses accepted files
    ↓
System normalizes rows
    ↓
System stores upload records + transactions
    ↓
User proceeds to Ledger review
```

### 13.2 Transaction labeling pipeline

```text
Raw CSV row
    ↓
deriveSignedAmount()
    ↓
classifyTransaction()
    ↓
detectMonthlyRecurringPatterns()
    ↓
store normalized transaction
    ↓
user reviews / edits / excludes in Ledger
```

### 13.3 Recurring review pipeline

```text
Normalized transactions
    ↓
recurrenceDetector.ts identifies candidate groups
    ↓
candidate list shown in Recurring Leak Review
    ↓
user marks essential / leak / dismissed
    ↓
review state saved
    ↓
dashboard and export reflect reviewed status
```

### 13.4 Reporting pipeline

```text
Reviewed transactions
+ reviewed recurring statuses
+ selected date range
    ↓
cashflow.ts computes summary
    ↓
dashboard renders metrics
    ↓
export routes generate CSV for the selected context
```

---

## 14. Financial Calculation Rules

### 14.1 Safe-to-spend formula

```text
monthFactor = max(1, rangeDays / 30)

recurringIncome_monthly   = recurring inflows / monthFactor
recurringExpenses_monthly = recurring outflows / monthFactor

safeToSpend = recurringIncome_monthly - recurringExpenses_monthly
```

### 14.2 Core calculation rules
- transfers are excluded from spend analysis
- refunds are excluded from recurring expense logic
- rows marked `excluded_from_analysis = true` must be omitted from dashboard and leak calculations
- reviewed recurring outcomes must influence dashboard leak summaries where applicable

### 14.3 Category summary requirement
V1 must support at least one of:
- chart-based category summary, or
- table-based category summary

This requirement belongs in the dashboard, not in a separate analysis page.

### 14.4 Export rule
Exports must reflect:
- reviewed transaction edits
- exclusion state
- recurring review outcomes where applicable
- selected date range / filter context

---

## 15. Data Review, Auditability, and Safety Rules

### 15.1 User correction rule
Any transaction edited by the user must:
- set `user_corrected = true`
- record `label_source = "manual"`
- remain protected from broad automated reprocessing unless intentionally reset

### 15.2 Original-data traceability rule
The system should preserve original imported values wherever possible so the team can explain:
- what was imported
- what was normalized
- what was manually changed

### 15.3 Exclusion rule
Excluded transactions remain stored, but are omitted from analysis/reporting calculations until re-included.

### 15.4 Destructive action safeguards
Wipe and reset actions must include:
- confirmation dialog
- warning language
- visible success/error feedback
- tests for correct deletion scope

### 15.5 Trust rule
The system should never silently overwrite reviewed user decisions during routine reprocessing.

---

## 16. Environment Variables and Build Scripts

### 16.1 Core environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection |
| `SESSION_SECRET` | Yes in production | Session signing |
| `NODE_ENV` | Yes | Environment mode |
| `APP_ORIGIN` | Recommended | Trusted origin / deployment URL |
| `PORT` | Optional | Unified dev/prod listen port (default `5000`) |
| `API_PORT` | Optional | Split-dev proxy target for `dev:vite` mode |

### 16.2 Optional future-only env vars
These should not be required for V1 acceptance:
- `LLM_LABELING_ENABLED`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_MODEL`
- `OPENAI_MODEL`

### 16.3 Build and run scripts

```json
{
  "dev": "tsx server/index.ts",
  "dev:vite": "vite --host 0.0.0.0 --port 5000",
  "build": "tsx script/build.ts",
  "start": "NODE_ENV=production node dist/server/index.js",
  "check": "tsc --noEmit",
  "test": "vitest run",
  "db:push": "drizzle-kit push"
}
```

### 16.4 Build expectation
The repository should support:
- local development
- unified Replit/Cursor preview on port `5000`
- optional split dev mode (`dev:vite` + server on `5001`)
- schema push
- production build
- static serving of the built SPA through the server


### 16.5 Working environment note
Primary workflow assumption:
- code is edited in Cursor connected to Replit over SSH
- Git operations may happen either through the Replit shell or Cursor Git/GitHub tooling
- GitHub remote state is the source of truth, not the editor UI alone

---

## 17. Implementation Standards and Documentation Rules

### 17.1 Code organization rule
Each feature should be implemented with clear separation between:
- UI
- route/controller logic
- business logic
- persistence

### 17.2 Commenting rule
Code comments are required for:
- non-obvious parsing logic
- recurrence detection logic
- safe-to-spend calculation logic
- destructive route handling
- any rule set that could confuse reviewers without context

Do not add comments that merely restate the code. Comments must explain **why** the logic exists or **why** a rule is shaped the way it is.

### 17.3 Documentation update rule
When a feature materially changes behavior, the same phase must update:
- this spec
- relevant README or internal docs
- the phase summary / change log

Current Phase 1 documentation baseline includes:
- branch/worktree progress log
- Week 1 security rationale
- Week 1 iterative process notes
- Week 1 testing approach
- auth visual foundation spec when presentation-facing UI changes are approved

### 17.4 Testing rule
A feature is not complete until there is at least one clear validation path for it:
- manual test steps, or
- automated tests, or
- both

Current Phase 1 verification baseline:
- `Vitest` with separate `server` and `client` projects
- server coverage for config, schema, auth/storage, and route behavior
- client coverage for auth gating and logout state
- manual walkthrough of register → setup → shell → logout

DB-backed auth/storage/route tests require:
- `DATABASE_URL`
- `POCKETPULSE_STORAGE_TESTS=1`

### 17.5 Naming rule
Use names that map back to requirement IDs where practical:
- AU for auth
- UP for upload
- LD for ledger
- RL for recurring review
- DB for dashboard
- EX for export

### 17.6 Legacy migration rule
If code or design ideas are brought over from the legacy GitHub repo, the team must document:
- what was reused
- what was changed
- why the V1 version differs
- which requirement IDs the migrated work now supports

A migrated feature is only considered part of V1 after it has been re-reviewed in the fresh repo context.

### 17.7 Replit + Cursor workflow rule
The active development environment is Replit, with editing through Cursor over SSH. That means repository hygiene matters more, not less. Local editor state, SSH state, and remote GitHub state can drift if not checked deliberately.

---

## 18. GitHub Delivery Rules (Non-Optional)

These rules are part of the technical spec. They are not suggestions.

### 18.0 Fresh-repo baseline rule
The current GitHub repository is the active V1 record. The wiped local restart means the team is rebuilding intentionally from a clean baseline. The older GitHub repo may be consulted, but the new repo history must stand on its own and clearly show how V1 was rebuilt.

### 18.0.1 Remote truth rule
After any commit/push workflow, the team must verify the result against the actual GitHub remote. A push is not considered complete just because Cursor shows a sync indicator or because the local branch looks clean.

Minimum verification after important pushes:
- confirm current branch name
- confirm local working tree status
- confirm latest commit message locally
- confirm the commit appears on the correct GitHub branch

### 18.1 Branching rule
Every meaningful workstream must happen on a feature branch before merge to `main`.

Recommended naming:
- `feature/up-upload-queue`
- `feature/ld-ledger-editing`
- `feature/rl-review-actions`
- `fix/up-csv-validation`
- `docs/db-traceability-update`

### 18.1.1 Replit/Cursor branch handling rule
Because development happens through Cursor via SSH into Replit, branch mistakes are easy to miss. Before starting work each session, verify:
- the repo path is the intended fresh PocketPulse repo
- the checked-out branch is correct
- the branch tracks the expected remote

Do not begin coding on an uncertain branch or inside the wrong Replit workspace.

### 18.2 Push cadence rule
No phase work should remain local-only for more than **24 hours**.

Minimum cadence:
- push at least **once per active work session**
- push at least **once per day** during an active phase
- open or update the phase PR regularly instead of holding all work until the phase end

### 18.2.1 Allowed push methods rule
Pushing through the Replit terminal is acceptable. Pushing through Cursor Git/GitHub extensions is also acceptable.

However, whichever method is used, the team must still verify:
- the commit landed on the intended branch
- the remote branch updated successfully
- no SSH/auth issue silently blocked the push

If Cursor push behavior is ambiguous, fall back to explicit terminal Git commands in Replit.

### 18.3 Commit message rule
Use conventional commits with scoped messages:
- `feat(upload): add queued multi-file import flow`
- `fix(ledger): persist exclusion state correctly`
- `refactor(cashflow): simplify safe-to-spend calculation path`
- `docs(spec): align dashboard section to V1 scope`
- `chore(build): add env example and script cleanup`

### 18.4 Commit summary rule
Every meaningful push must include a brief change summary in one of these places:
- commit body
- PR description
- phase change log entry

Minimum summary content:
1. what changed
2. why it changed
3. what still needs follow-up

### 18.4.1 Legacy porting summary rule
If work is based on code or ideas from the old GitHub repo, the summary must also state:
1. what was ported or reused
2. what was intentionally not ported
3. what was rewritten for the fresh V1 repo

This prevents the new repo from becoming an undocumented copy of the old prototype.

### 18.5 Code comment rule for commits
If a commit introduces non-obvious logic, that same commit must also add or update inline comments explaining the logic. Do not postpone explanation to a later cleanup commit.

### 18.6 Pull request rule
Each phase should have a PR containing:
- phase objective
- completed items
- screenshots or evidence where relevant
- known gaps
- next phase implications

### 18.7 Phase summary rule
At the end of each phase, update a short summary section or log with:
- files changed
- features added/updated
- requirement IDs affected
- blockers or open questions

### 18.8 Reviewer readability rule
A reviewer should be able to understand the change without diff-hunting across unrelated files. Keep commits logically grouped.

### 18.8.1 Main branch protection rule
Do not force-push to `main`. Do not treat `main` as a scratch branch. The fresh repo history should remain readable for milestone review.

### 18.8.2 End-of-session sync rule
At the end of each active session, record one short note in the commit body, PR, or phase log stating:
- current branch
- last completed task
- next intended task

This is especially important when alternating between Replit terminal Git usage and Cursor Git UI.

### 18.9 Emergency exception rule
If a hotfix must go directly to `main`, it still requires:
- proper commit message
- same-day summary note
- follow-up documentation update

---

## 19. 4-Week Phased Development Plan

> **Global phase policy:** Every phase below includes hard GitHub rules. If the code is written but not pushed, summarized, and documented according to the phase rules, that phase is not complete.

### Phase 1 (Week 1): Foundation, Auth, and Project Baseline
**Goal:** Establish the running app, auth flow, schema baseline, and documentation foundation.

#### Technical targets
1. Initialize fresh repository stack
2. Confirm GitHub remote, branch flow, and Replit/Cursor SSH workflow
3. Confirm shared schema base
4. Implement database connection
5. Implement session auth and auth routes
6. Build Auth UI and auth hook
7. Confirm protected routing and layout shell
8. Create initial V1 spec and working README notes

#### Hard GitHub rules
- create a phase branch before writing auth code
- confirm the new repo remote is correct before the first commit of the phase
- push at least once per work session
- every commit must state the affected layer (`auth`, `app`, `db`, `docs`)
- PR must include: auth flow summary, schema baseline summary, GitHub workflow confirmation, and any known security gaps
- phase-end summary must list all created files and the working login path

#### Required end-of-phase summary
- what auth currently supports
- what session behavior is confirmed
- how Replit/Cursor/GitHub workflow was validated
- what is intentionally deferred

#### Week 1 implementation status update
The completed Phase 1 branch now demonstrates:
- register / login / logout / current-user session flow
- first-account onboarding gate before protected-shell access
- protected app shell with placeholder routes for Dashboard, Upload, Ledger, and Leaks
- README setup/manual verification notes
- branch-local progress documentation and Week 1 supporting logs
- automated tests passing for both client and server, including the DB-backed auth/route suites when env-gated integration tests are enabled
- a presentation-focused auth visual foundation pass that improves screenshot/readability quality without changing auth behavior

---

### Phase 2 (Week 2): Upload Workflow, Account Labeling, and Import Validation
**Goal:** Build the multi-file CSV import workflow and persist account-linked uploads.

#### Technical targets
1. Build upload queue UI
2. Support queued file removal before import
3. Add account label and optional last four per file
4. Validate file format before import
5. Create upload records
6. Parse accepted CSV files into normalized transaction candidates
7. Route user to transaction review after import

#### Hard GitHub rules
- no more than one active workday without a remote push
- each push must include a short summary of one of: queue behavior, validation logic, parsing progress, or account labeling
- commits that change parsing logic must include inline comments for non-obvious heuristics
- PR must include screenshots or notes for queued file display, file removal, validation handling, and the branch used for the work
- phase-end summary must list known unsupported CSV edge cases

#### Required end-of-phase summary
- what upload queue behavior is implemented
- what file validation rules are enforced
- what CSV assumptions remain risky

---

### Phase 3 (Week 3): Ledger Review, Editing, and Exclusion Controls
**Goal:** Turn imported data into a trustworthy review workflow.

#### Technical targets
1. Display normalized transactions in ledger
2. Add search and filter support
3. Enable inline editing of approved ledger fields
4. Persist user overrides
5. Implement exclusion-from-analysis support
6. Protect user-corrected rows from broad reprocessing
7. Add export from the ledger context
8. Keep wipe/reset workspace controls available and safe

#### Hard GitHub rules
- every editing-related commit must name the edited behavior clearly (`category override`, `date edit`, `amount edit`, `exclude toggle`)
- destructive action changes require same-commit updates to warning copy and confirmation behavior
- pushes must happen after each completed ledger behavior, not only after the full page is finished
- PR must include before/after notes for edit persistence, exclusion behavior, and any legacy logic that was intentionally reintroduced
- phase-end summary must document exactly which fields are editable and how review state is protected

#### Required end-of-phase summary
- which ledger fields can be edited
- how overrides are stored
- how exclusion affects downstream reporting
- what wipe/reset currently deletes

---

### Phase 4 (Week 4, Part 1): Recurring Leak Review Workflow
**Goal:** Convert recurring detection into a user-decision flow.

#### Technical targets
1. Surface recurring candidates in a dedicated review page
2. Show reason flagged, average amount, recurrence/frequency, and last seen
3. Implement mark essential
4. Implement mark leak-related
5. Implement dismiss
6. Persist recurring review outcomes
7. Feed reviewed outcomes into dashboard/export logic

#### Hard GitHub rules
- candidate-display work and review-action work should not be hidden in the same monolithic commit
- every review-action commit must include a brief note describing the stored state transition
- commits affecting review persistence must reference the storage layer in the summary
- PR must show at least one full candidate lifecycle from detection to saved review state
- phase-end summary must list review statuses and how they alter reporting

#### Required end-of-phase summary
- how recurring candidates are formed
- what statuses exist
- where review outcomes are stored
- what still needs tuning

---

### Phase 5 (Week 4, Part 2): Dashboard, Export, QA, and Documentation Closure
**Goal:** Finalize the V1 insight surface, export logic, and milestone-grade documentation.

#### Technical targets
1. Finalize safe-to-spend display
2. Add summary metrics for income, expenses, and likely leak spend
3. Support preset/custom date range selection
4. Recalculate dashboard when date range changes
5. Add one category summary surface (chart or table)
6. Add recurring findings preview to dashboard
7. Ensure export reflects reviewed transaction and leak state
8. Finalize requirement traceability and phase logs
9. Run QA across the full review loop

#### Hard GitHub rules
- dashboard metrics, date range logic, and export alignment should land in separate readable commits where practical
- every push must include a concise note about what changed in reporting behavior
- documentation updates must happen in the same phase as the feature work they describe
- final PR must include a V1 walkthrough: login -> upload -> review/edit -> recurring review -> dashboard -> export -> optional wipe/reset
- final phase summary must include completed requirements, open gaps, exact archive status of removed prototype analysis code, and any legacy repo material that was intentionally ported into the fresh repo

#### Required end-of-phase summary
- what dashboard now guarantees
- what export reflects
- what remains future work, not V1

---

## 20. Requirement Traceability Matrix

| Requirement ID | Requirement Summary | V1 Status | Primary Area |
|---|---|---|---|
| AU-01 | Login with valid credentials | Retain | Auth |
| AU-01.1 | Redirect to dashboard after valid login | Retain | Auth / Routing |
| AU-01.2 | Invalid login denied with error | Retain | Auth UI |
| AU-02 | Maintain authenticated session | Retain | Auth / Session |
| AU-03 | Logout support | Retain | Auth |
| UP-01 | Upload one or more CSV files in one workflow | Complete / verify | Upload |
| UP-01.1 | Show each uploaded file in queue before import | Complete / verify | Upload |
| UP-01.2 | Remove queued file before import | Complete / verify | Upload |
| UP-02 | Assign account label per file | Retain | Upload / Accounts |
| UP-02.1 | Optional last four digits | Retain | Upload / Accounts |
| UP-03 | Validate uploaded files before import | Retain | Upload / Parsing |
| UP-03.1 | Block unsupported/unreadable files | Retain | Upload / Parsing |
| UP-04 | Parse accepted files | Retain | csvParser |
| UP-05 | Create import record per upload session | Retain | Upload / Storage |
| LD-01 | Normalize imported transactions into unified ledger | Retain | Parsing / Storage |
| LD-01.1 | Minimum normalized fields exist | Retain | Schema |
| LD-02 | Display imported transactions in ledger | Retain | Ledger |
| LD-03 | Assign category using predefined logic | Retain | Classifier |
| LD-03.1 | Allow manual category change | Retain | Ledger |
| LD-03.2 | Save category overrides | Retain | Ledger / Storage |
| LD-04 | Allow exclusion from analysis | Complete for V1 | Ledger / Schema |
| LD-05 | Filter/search ledger | Retain | Ledger |
| RL-01 | Detect recurring charges and repeated spend | Retain | recurrenceDetector |
| RL-01.1 | Use merchant/frequency/average amount factors | Retain | recurrenceDetector |
| RL-02 | Display recurring findings in review interface | Retain | Leaks page |
| RL-02.1 | Show required recurring finding details | Retain | Leaks page |
| RL-03 | Mark recurring finding as essential | Complete for V1 | Leaks page / Storage |
| RL-04 | Mark recurring finding as leak-related | Complete for V1 | Leaks page / Storage |
| RL-05 | Dismiss recurring finding | Complete for V1 | Leaks page / Storage |
| RL-06 | Store recurring review action results | Complete for V1 | Storage / Schema |
| DB-01 | Provide dashboard summary | Retain | Dashboard |
| DB-01.1 | Safe-to-spend as primary metric | Retain | Dashboard |
| DB-01.2 | Show income, expenses, leak spend summary | Retain | Dashboard |
| DB-02 | Allow preset/custom date range | Retain | Dashboard / dateRanges |
| DB-02.1 | Support named preset ranges | Retain | dateRanges |
| DB-03 | Recalculate on date range change | Retain | Dashboard / cashflow |
| DB-04 | Show category summary by chart or table | Complete for V1 | Dashboard |
| DB-05 | Show leak-related findings in dashboard | Retain | Dashboard |
| EX-01 | Allow export summary results as CSV | Retain | Export |
| EX-02 | Export for selected reporting period | Retain | Export / dateRanges |
| EX-03 | Export reflects reviewed transaction and leak status | Complete for V1 | Export / Storage |

**Status meanings**
- **Retain**: already belongs in the V1 spec and remains part of acceptance
- **Complete / verify**: expected to exist already, but must be verified against implementation
- **Complete for V1**: explicitly required to finish V1 alignment, even if prototype treatment was partial

---

## 21. Known Gaps, Risks, and Next Actions

### 21.1 Scope risk
Risk: the team accidentally re-expands into a richer analytics product.  
Response: keep dashboard summary-focused and archive the Analysis page.

### 21.2 CSV variability risk
Risk: file structure differences break normalization.  
Response: improve validation, document assumptions, and preserve file-level error handling.

### 21.3 Trust risk
Risk: misclassification reduces confidence.  
Response: full ledger correction remains in scope, and recurring findings remain reviewable.

### 21.4 Documentation risk
Risk: features are built but difficult to explain for milestone grading.  
Response: enforce requirement IDs, phase summaries, and GitHub summary rules.

### 21.5 Data-loss risk
Risk: wipe/reset actions delete more than intended.  
Response: confirmation flow, precise deletion scope, and explicit tests.

### 21.6 Near-term next actions
1. Confirm fresh repo remote, branch rules, and Replit/Cursor SSH workflow are documented
2. Remove `/analysis` from active routing and V1 docs
3. Confirm upload queue behavior matches the multi-file workflow requirement
4. Confirm or add `excluded_from_analysis`
5. Confirm or add recurring review persistence
6. Finalize dashboard category summary surface
7. Create/maintain phase summary log in the repo

---

## 22. Future Enhancements (Not V1)

These may exist in prototype form or as ideas, but they are not required for V1 acceptance:

- Dedicated Analysis page
- Prior-period comparison dashboards
- LLM-assisted categorization or explanations
- Live bank integrations
- Department or team workspaces
- Automated vendor cancellation or bill negotiation
- Real-time notifications outside the active session

---

## Appendix A — Recommended Phase Summary Template

Use this at the end of each phase in a `PHASE_LOG.md`, PR description, or milestone update.

```md
## Phase X Summary

### Objective
What this phase was supposed to accomplish.

### Completed
- Item
- Item
- Item

### Requirement IDs Affected
- AU-__
- UP-__
- LD-__
- RL-__
- DB-__
- EX-__

### Files Changed
- path/to/file
- path/to/file

### What Changed Technically
Brief summary of behavior changes.

### Why the Change Was Needed
Tie back to scope, trust, usability, or architecture.

### Remaining Gaps
- Item
- Item

### Risks / Follow-Up
- Item
- Item
```

## Appendix B — Recommended Commit Examples

```text
feat(upload): add queued multi-file import workflow
feat(ledger): persist exclusion state and protect edited rows
feat(leaks): save essential/leak/dismiss review outcomes
feat(dashboard): add category summary table and leak preview
fix(parser): reject malformed csv rows with clearer file-level errors
docs(spec): remove analysis module from active V1 scope
chore(build): add env example and production script cleanup
```
