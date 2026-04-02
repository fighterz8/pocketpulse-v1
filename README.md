# PocketPulse

Small-business cashflow analysis web application.

## Current status

**Phase 1** (auth + account setup) merged to `main`.
**Phase 2** (upload + import) on branch `feature/phase-2-upload-import`.
**Phase 3** (ledger review) on branch `feature/phase-3-ledger-review`.

### Phase 3 -- what's implemented

- **Ledger table** (`client/src/pages/Ledger.tsx`): full transaction table with columns for date, merchant, amount, category, class, recurrence, and status badges. Paginated with previous/next controls.
- **Search and filters:** debounced merchant/description search, filter dropdowns for account, category, transaction class, recurrence type, excluded status, and date range (from/to). Clear filters button.
- **Inline editing:** click any row to expand an edit panel with all approved fields (date, merchant, amount, category, class, recurrence, exclusion toggle + reason). Saves via `PATCH /api/transactions/:id` and sets `userCorrected=true`, `labelSource=manual`.
- **Exclusion toggle:** per-row quick exclude/include button directly in the table without opening the full editor.
- **CSV export:** export button downloads filtered transactions as CSV via `GET /api/export/transactions`.
- **Wipe/reset:** Data Management danger zone with two-click confirmation for "Wipe Imported Data" (transactions + uploads) and "Reset Workspace" (everything including accounts).
- **Enhanced API:** `PATCH /api/transactions/:id` (edit with validation), `DELETE /api/transactions` (wipe), `DELETE /api/workspace-data` (reset), `GET /api/export/transactions` (CSV), enhanced `GET /api/transactions` with full filter query params.
- **Storage layer:** `updateTransaction`, `getTransactionById`, `deleteAllTransactionsForUser`, `deleteWorkspaceDataForUser`, `listAllTransactionsForExport`, enhanced `listTransactionsForUser` with 8 filter dimensions.
- **use-transactions hook** (`client/src/hooks/use-transactions.ts`): TanStack Query integration with mutations for update, wipe, and reset.

### Phase 2 -- what's implemented

- **Schema:** `uploads` and `transactions` tables added to `shared/schema.ts` alongside Phase 1 tables (users, accounts, user_preferences, session). V1 category set exported as `V1_CATEGORIES`.
- **CSV parser** (`server/csvParser.ts`): auto-detects date/description/amount columns, supports single-amount and split debit/credit formats, common date formats, quoted fields, currency amounts. Skips bad rows with warnings.
- **Classifier** (`server/classifier.ts`): rules-based keyword matching across 16 V1 categories, transaction class detection (income/expense/transfer/refund), recurrence hints for known subscription merchants.
- **Transaction utilities** (`server/transactionUtils.ts`): amount normalization, signed-amount derivation, flow-type inference, merchant cleanup (POS prefix stripping, title-casing).
- **Upload API:** `POST /api/upload` (multipart CSV + per-file account mapping), `GET /api/uploads` (upload history), `GET /api/transactions` (paginated, optional account filter).
- **Upload UI** (`client/src/pages/Upload.tsx`): drag-and-drop / file picker, queued file list with per-file account selector, file removal, client-side validation (CSV-only, 5 MB, non-empty), import with per-file results and row counts, post-import link to ledger.

### Phase 1 -- what's implemented

- **Backend:** Express app with auth routes (`register`, `login`, `logout`, `me`), account CRUD, health check. Sessions in PostgreSQL via `connect-pg-simple`.
- **Frontend:** React + Wouter + TanStack Query; auth gating, first-account onboarding, protected app shell with sidebar navigation.

**Still deferred:** recurring leak detection (Phase 4), dashboard/reporting (Phase 5).

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`, `SESSION_SECRET`, and `APP_ORIGIN` (and `PORT` if needed).
2. `npm install`
3. `npm run db:push` -- applies `shared/schema.ts` (including the `session`, `uploads`, and `transactions` tables) to your database.

## Manual verification

With PostgreSQL available and `npm run dev` running (default [http://localhost:5000](http://localhost:5000)):

### Phase 1 checks (auth)
1. **Register** -- Create account, land in account setup, create first account, enter protected shell.
2. **Invalid login** -- Wrong password shows "Invalid email or password".
3. **Session persistence** -- Reload stays authenticated.
4. **Logout** -- Returns to auth view, no shell access until re-login.

### Phase 2 checks (upload)
1. **Navigate to Upload** -- Click "Upload" in the sidebar; see the drop zone.
2. **Add CSV files** -- Drag or browse to select `.csv` files; files appear in the queue with account selector.
3. **Account assignment** -- If only one account exists, it auto-selects. Otherwise, select an account per file.
4. **Remove queued file** -- Click the X button to remove a file from the queue.
5. **Reject non-CSV** -- Try uploading a non-CSV file; client-side validation rejects it.
6. **Import** -- Click "Import N files"; files are parsed, classified, and stored. Results show per-file row counts.
7. **View results** -- After import, see success banner with link to "Review in Ledger".
8. **Upload history** -- `GET /api/uploads` returns prior upload records.
9. **Transaction listing** -- `GET /api/transactions` returns paginated transactions from the import.

### Phase 3 checks (ledger)
1. **Navigate to Ledger** -- Click "Ledger" in the sidebar; see the transaction table (or empty state if no data).
2. **Pagination** -- If >50 transactions, use Previous/Next to page through.
3. **Search** -- Type in the search box; table filters by merchant/description after brief debounce.
4. **Filter dropdowns** -- Select values in account, category, class, recurrence, excluded status, or date range filters; table updates.
5. **Clear filters** -- "Clear filters" button resets all filters.
6. **Inline edit** -- Click a row; edit panel expands below. Change any field and click Save. Verify the row shows "edited" badge.
7. **Exclusion toggle** -- Click the checkbox column on a row to toggle exclude/include. Verify "excluded" badge appears.
8. **CSV export** -- Click "Export CSV"; browser downloads `pocketpulse-transactions.csv` with current filters applied.
9. **Wipe data** -- In the danger zone, click "Wipe Imported Data", then "Confirm Wipe". Transactions and uploads are deleted; accounts remain.
10. **Reset workspace** -- Click "Reset Workspace", then "Confirm Reset". All data is deleted; redirected to home page.

Automated checks: `npm test` and `npm run check`. Optional: `npm run build` for a production bundle sanity check.

## Stack

TypeScript, Node.js, Express, React, Vite, Wouter, TanStack Query, PostgreSQL, Drizzle ORM, express-session, connect-pg-simple, bcrypt, Vitest.

## Scripts

| Script    | Description                                      |
| --------- | ------------------------------------------------ |
| `npm run dev` | Development: Express on `PORT` (default `5000`) with Vite dev middleware |
| `npm run dev:vite` | Optional split setup: standalone Vite on port 5000; `/api` proxies to `http://localhost:5001` |
| `npm run build` | Production client bundle and compiled server |
| `npm run start` | Production: compiled Express serves API + static SPA |
| `npm run check` | Typecheck with `tsc --noEmit`                    |
| `npm test`    | Run Vitest                                       |
| `npm run db:push` | Push Drizzle schema to the database          |

## Ports

- **Default development** (`npm run dev`): one process on `PORT` (default `5000`); same-origin `/api` and Vite HMR.
- **Optional split** (`dev:vite` + `tsx server/index.ts`): Vite on `5000`; server on `5001`.
- **Production**: `PORT` (default `5000`).

## Evidence and handoff

Phase logs and design specs live in `docs/`. See:
- `docs/phase-logs/phase-1-auth-account-setup-progress.md`
- `docs/phase-logs/phase-2-upload-import-progress.md`
- `docs/phase-logs/phase-3-ledger-review-progress.md`
- `docs/superpowers/specs/2026-04-01-phase-1-auth-account-setup-design.md`
- `docs/superpowers/specs/2026-04-02-phase-2-upload-import-design.md`
- `docs/superpowers/specs/2026-04-02-phase-3-ledger-review-design.md`
