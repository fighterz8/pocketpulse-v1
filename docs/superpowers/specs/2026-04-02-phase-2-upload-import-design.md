# PocketPulse Phase 2 Design: Upload Workflow, Account Labeling, and Import Validation

**Date:** 2026-04-02
**Status:** Active design baseline
**Phase:** Phase 2
**Primary Goal:** Build the multi-file CSV import workflow and persist account-linked uploads with normalized, classified transactions.

## 1. Context

Phase 1 established the secure workspace foundation: authentication, sessions, protected routing, first-account onboarding, and the app shell with placeholder navigation. Phase 2 turns the Upload placeholder into a working import pipeline.

This design draws from:
- `POCKETPULSE_REPO_MAP_V1_FRESH_START.md` sections 9 (API), 10 (server services), 12.2 (Upload page), 13.1 (upload pipeline), and 13.2 (labeling pipeline)
- `docs/requirements/pocketpulse-v1-requirements-verification-draft.md` requirements UP-01 through UP-05, LD-01, LD-01.1
- Phase 1 design section 15 (deferred work) as the handoff point

## 2. Phase 2 Scope

### In Scope
- multi-file CSV upload queue UI
- queued file removal before import
- per-file account label assignment (from existing accounts)
- optional last-four digits per file
- CSV file format validation before import
- CSV parsing and row extraction
- transaction normalization (amount, merchant, date, flow type)
- rules-based transaction classification (category, transaction class, recurrence hints)
- upload record creation with metadata
- transaction batch persistence
- upload history listing
- basic transaction listing (paginated, account-filterable)
- post-import navigation to transaction review (ledger)

### Out of Scope
- ledger editing, inline correction, or exclusion controls (Phase 3)
- recurring leak detection and review (Phase 4)
- dashboard calculations and reporting (Phase 5)
- export behavior (Phase 5)
- workspace wipe/reset controls (Phase 3)
- AI-assisted labeling

## 3. Design Goals
- make the import pipeline trustworthy by validating before persisting
- preserve raw imported values alongside normalized data for traceability
- keep classification rules deterministic and explainable
- support multiple CSV formats without requiring the user to configure column mappings
- ensure every imported transaction is linked to an account and upload record
- provide clear feedback at every stage: file selection, validation, parsing, and results

## 4. Data Model

### 4.1 `uploads` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `user_id` | integer FK -> users.id | cascade delete |
| `account_id` | integer FK -> accounts.id | cascade delete |
| `filename` | text | original CSV filename |
| `row_count` | integer | parsed transaction count |
| `status` | text | `pending`, `processing`, `complete`, `failed` |
| `error_message` | text | null unless status is `failed` |
| `uploaded_at` | timestamp with tz | defaultNow |

### 4.2 `transactions` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `user_id` | integer FK -> users.id | cascade delete |
| `upload_id` | integer FK -> uploads.id | cascade delete |
| `account_id` | integer FK -> accounts.id | cascade delete |
| `date` | text | ISO date string (YYYY-MM-DD) |
| `amount` | numeric(12,2) | signed amount (negative = outflow) |
| `merchant` | text | cleaned/normalized merchant name |
| `raw_description` | text | original imported description |
| `flow_type` | text | `inflow` or `outflow` |
| `transaction_class` | text | `income`, `expense`, `transfer`, `refund` |
| `recurrence_type` | text | `recurring` or `one-time` (default `one-time`) |
| `category` | text | from V1 category set (default `other`) |
| `label_source` | text | `rule` or `manual` (default `rule`) |
| `label_confidence` | numeric(5,2) | nullable, rule certainty score |
| `label_reason` | text | nullable, human-readable classification reason |
| `ai_assisted` | boolean | default false |
| `user_corrected` | boolean | default false |
| `excluded_from_analysis` | boolean | default false |
| `excluded_reason` | text | nullable |
| `excluded_at` | timestamp with tz | nullable |
| `created_at` | timestamp with tz | defaultNow |

Indexes: `user_id`, `upload_id`, `account_id`, `date`.

## 5. API Design

### 5.1 Upload endpoint

**`POST /api/upload`**
- Accepts `multipart/form-data`
- Body contains one or more CSV files and a JSON metadata field mapping each file to an account ID
- Auth required (401 if unauthenticated)
- Validates: file is CSV, file is parseable, account belongs to user
- Returns: array of upload results (upload ID, row count, status per file)

### 5.2 Upload history

**`GET /api/uploads`**
- Returns upload records for authenticated user, ordered by most recent
- Auth required

### 5.3 Transaction listing

**`GET /api/transactions`**
- Query params: `page`, `limit`, `accountId`
- Returns paginated transaction list for authenticated user
- Auth required

## 6. Server Processing Pipeline

### 6.1 CSV Parser (`server/csvParser.ts`)
- Validate file is non-empty and parseable as CSV
- Auto-detect column mapping: date, description/merchant, amount (single column or split debit/credit)
- Support common date formats: MM/DD/YYYY, YYYY-MM-DD, M/D/YYYY, DD/MM/YYYY
- Normalize each row into a canonical shape: `{ date, description, amount }`
- Return file-level errors for unparseable files, row-level warnings for skipped rows
- Preserve raw description for traceability

### 6.2 Transaction Utilities (`server/transactionUtils.ts`)
- `normalizeAmount(raw)`: parse currency strings, handle parenthetical negatives
- `deriveSignedAmount(amount, debit, credit)`: resolve single or split amount columns
- `inferFlowType(signedAmount)`: negative = outflow, positive = inflow
- `normalizeMerchant(raw)`: trim, collapse whitespace, title-case, strip trailing reference numbers

### 6.3 Transaction Classifier (`server/classifier.ts`)
- `classifyTransaction(merchant, amount, flowType)`: returns `{ transactionClass, category, recurrenceType, labelSource, labelConfidence, labelReason }`
- Rules-based: keyword matching on merchant name against category patterns
- Transaction class derived from flow type + merchant patterns (transfers, refunds detected by keywords)
- V1 category set: income, transfers, utilities, subscriptions, insurance, housing, groceries, transportation, dining, shopping, health, debt, business_software, entertainment, fees, other

## 7. Frontend Design

### 7.1 Upload Page (`client/src/pages/Upload.tsx`)

**States:**
1. **Empty queue** -- file picker + drag-and-drop area
2. **Files queued** -- list of files with per-file account selector, optional last-four, remove button; import button enabled
3. **Importing** -- progress indicator, buttons disabled
4. **Results** -- per-file success/failure with row counts; link to `/transactions`

**Minimum UI elements:**
- Drop zone / file input for CSV selection
- Queued file list (filename, size, account selector, optional last-four, remove button)
- Account selector populated from user's accounts (`GET /api/accounts`)
- Validation error display per file
- Import action button
- Success state with navigation to ledger

### 7.2 Upload Hook (`client/src/hooks/use-uploads.ts`)
- Upload mutation: `POST /api/upload` with FormData
- Uploads query: `GET /api/uploads`
- Invalidation on successful upload

## 8. Validation Rules
- Reject non-CSV files (check extension and content-type)
- Reject empty files
- Reject files with no parseable rows after header detection
- Reject files where no date or amount column can be detected
- Each file must be assigned to a valid account owned by the user
- File size limit: 5MB per file (reasonable for CSV transaction exports)

## 9. Error Handling
- File validation errors shown per-file in the queue before import
- Parse errors shown per-file in results after import attempt
- Account ownership violations return 403
- Network/server errors shown as a general error banner

## 10. Acceptance Criteria
Phase 2 is considered complete when:
- a user can select one or more CSV files for upload
- each file can be assigned to an existing account
- files can be removed from the queue before import
- invalid files are rejected with clear error messages
- valid files are parsed, normalized, and classified
- upload records and transactions are persisted
- the user can view upload history
- the user can view a basic transaction list
- after import, the user is directed to review transactions
- all Phase 2 server logic has automated test coverage

### Requirement Traceability
- `UP-01`: upload one or more CSV files in one workflow
- `UP-01.1`: show each uploaded file in queue before import
- `UP-01.2`: remove queued file before import
- `UP-02`: assign account label per file
- `UP-02.1`: optional last four digits
- `UP-03`: validate uploaded files before import
- `UP-03.1`: block unsupported/unreadable files
- `UP-04`: parse accepted files
- `UP-05`: create import record per upload session
- `LD-01`: normalize imported transactions into unified ledger
- `LD-01.1`: minimum normalized fields exist

## 11. Deferred Work
- Full ledger review, editing, and filtering (Phase 3)
- Transaction reprocessing (Phase 3)
- Workspace wipe/reset (Phase 3)
- Recurring leak detection (Phase 4)
- Dashboard and export (Phase 5)
