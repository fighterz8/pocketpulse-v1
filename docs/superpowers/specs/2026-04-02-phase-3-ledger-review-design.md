# PocketPulse Phase 3 Design: Ledger Review, Editing, and Exclusion Controls

**Date:** 2026-04-02
**Status:** Active design baseline
**Phase:** Phase 3
**Primary Goal:** Turn imported data into a trustworthy review workflow with full transaction display, search/filter, inline editing, exclusion controls, CSV export, and workspace management.

## 1. Context

Phase 2 built the CSV upload pipeline: file queue UI, validation, parsing, classification, and persistence. Phase 3 turns the Ledger placeholder into a full transaction review surface where users can inspect, correct, exclude, and export their imported data.

## 2. Phase 3 Scope

### In Scope
- display normalized transactions in a paginated ledger table
- search by merchant/description
- filter by account, category, transaction class, recurrence type, date range, excluded status
- inline editing of approved fields (date, merchant, amount, category, class, recurrence, exclusion)
- user-corrected row protection (user_corrected flag, label_source set to manual)
- transaction exclusion from analysis with optional reason
- CSV export of filtered/reviewed transactions
- wipe imported data (transactions + uploads, keep accounts)
- reset workspace (transactions + uploads + accounts)

### Out of Scope
- recurring leak detection and review workflow (Phase 4)
- dashboard calculations and reporting (Phase 5)
- AI-assisted labeling

## 3. API Design

### Enhanced existing route
- `GET /api/transactions` -- add query params: search, category, transactionClass, recurrenceType, dateFrom, dateTo, excluded

### New routes
- `PATCH /api/transactions/:id` -- partial update of editable fields; sets userCorrected=true, labelSource=manual
- `DELETE /api/transactions` -- wipe transactions + uploads for user, preserve accounts
- `DELETE /api/workspace-data` -- reset all user data including accounts
- `GET /api/export/transactions` -- CSV download with current filter params

## 4. Editable Fields

| Field | Type | Notes |
|-------|------|-------|
| date | text (ISO) | Transaction date |
| merchant | text | Cleaned merchant name |
| amount | numeric(12,2) | Signed amount |
| category | text | Must be from V1_CATEGORIES |
| transactionClass | text | income, expense, transfer, refund |
| recurrenceType | text | recurring, one-time |
| excludedFromAnalysis | boolean | Toggle exclusion |
| excludedReason | text | Optional reason when excluding |

On any edit: `user_corrected = true`, `label_source = "manual"`.

## 5. Acceptance Criteria

- user can view all imported transactions in a paginated table
- user can search transactions by merchant/description
- user can filter by account, category, class, recurrence, date range, excluded status
- user can edit approved fields inline
- edited rows are marked as user-corrected and protected
- user can exclude/include transactions from analysis
- user can export filtered results as CSV
- user can wipe imported data or reset workspace with confirmation
- destructive actions show clear warnings before executing

### Requirement Traceability
- LD-02: display imported transactions in ledger
- LD-03: assign category (via classifier, editable here)
- LD-03.1: allow manual category change
- LD-03.2: save category overrides
- LD-04: allow exclusion from analysis
- LD-04.1: excluded transactions stored but omitted from calculations
- LD-05: filter/search ledger
- LD-06: edit approved ledger fields
