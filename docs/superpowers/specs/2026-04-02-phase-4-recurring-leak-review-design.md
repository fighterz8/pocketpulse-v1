# Phase 4 -- Recurring Leak Review Design Spec

**Branch:** `feature/phase-4-recurring-leak-review`

**Date:** 2026-04-02

---

## Overview

Phase 4 has two goals:

1. **Bug fix:** CSV parser sign bug where all transactions are classified as income (debit/credit columns ignored when Amount column present).
2. **Feature:** Detect recurring transaction patterns and present them for user review as essential, leak-related, or dismissed.

---

## CSV Parser Bug Fix

### Root cause

`server/csvParser.ts:159-162` -- when both Amount and Debit/Credit columns exist, the parser uses the unsigned Amount column via `normalizeAmount()`. Most bank CSVs encode debits as positive numbers in a separate Debit column, so Amount stays positive for everything. Downstream: `inferFlowType` returns `"inflow"` for non-negative amounts, and the classifier assigns `"income"` to all non-refund/non-transfer inflows.

### Fix

Invert the column priority: when debit/credit columns are present, always use `deriveSignedAmount` from them. Only fall back to the Amount column when debit/credit are absent.

---

## Recurring Detection Algorithm

### Pipeline

1. **Group** transactions by normalized merchant key (lowercase, strip POS prefixes, collapse whitespace)
2. **Bucket** each group by amount (25% tolerance, $2 floor) to separate recurring charges from one-off purchases at the same merchant
3. **Detect frequency** via median interval matching against known cadences
4. **Score confidence** using 4 weighted signals
5. **Filter** candidates below 0.35 confidence threshold
6. **Sort** by confidence descending, then average amount descending

### Merchant key normalization

```
recurrenceKey(merchant):
  - lowercase + trim
  - strip POS prefixes: SQ *, TST *, SP *
  - strip trailing reference numbers: #12345, *12345
  - collapse internal whitespace
```

### Amount bucketing

Tolerance: 25% of bucket centroid OR $2, whichever is larger. Centroids are running averages. Each bucket is independently tested for frequency.

### Frequency cadences

| Cadence | Expected interval (days) | Tolerance |
|---------|--------------------------|-----------|
| Weekly | 7 | +/-2d |
| Biweekly | 14 | +/-3d |
| Monthly | 30.4 | +/-5d |
| Quarterly | 91.3 | +/-15d |
| Annual | 365 | +/-30d |

Frequency is determined by matching the **median** interval (not mean) to the closest cadence within tolerance.

### Confidence scoring

| Signal | Weight | Formula |
|--------|--------|---------|
| Interval regularity | 0.35 | `max(0, 1.0 - cv * 2)` where cv = stdDev / medianInterval |
| Amount consistency | 0.25 | `max(0, 1.0 - amtCv * 3.33)` (gentler for utilities: `* 2.0`) |
| Transaction count | 0.20 | `min(1.0, (n - 2) / 4)` |
| Recency | 0.20 | Full if last charge <= 1.5x expected; zero if >= 3x |

Minimum thresholds:
- Weekly/biweekly/monthly/quarterly: 3 transactions
- Annual: 2 transactions with >= 330 day span

### Candidate key

Format: `merchantKey|roundedAmount` (e.g. `"amazon|14.99"`). This allows separate reviews for different subscriptions at the same merchant. Stored in `recurring_reviews.candidateKey`.

### Edge cases

- **Price changes:** Split bucket at >20% shift; use recent segment for display
- **Variable amounts (utilities):** Categories `utilities`, `insurance`, `health` get gentler amount CV penalty
- **Missed payments:** Outlier intervals >2.5x median are filtered before stdDev calculation
- **Seasonal charges:** Annual/quarterly detected natively with appropriate tolerances

---

## Schema

### recurring_reviews table

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer FK -> users | cascade delete |
| candidate_key | text | `merchantKey\|roundedAmount` |
| status | text | `unreviewed`, `essential`, `leak`, `dismissed` |
| notes | text | optional user notes |
| reviewed_at | timestamptz | set when status changes |
| created_at | timestamptz | default now |

**Unique index:** `(user_id, candidate_key)` -- enables atomic upsert via `onConflictDoUpdate`.

---

## API

### GET /api/recurring-candidates

Returns detected recurring patterns merged with persisted review status.

Response: `{ candidates: RecurringCandidate[], summary: { total, unreviewed, essential, leak, dismissed } }`

Uses `listAllTransactionsForExport` (unbounded) for full transaction history.

### PATCH /api/recurring-reviews/:candidateKey

Upsert a review decision. Body: `{ status, notes? }`. Validates status against allowed values.

### GET /api/recurring-reviews

Returns all persisted reviews for the user.

---

## Frontend

Card-based review UI on the Leaks page:
- Filter tabs: All / Unreviewed / Essential / Leak / Dismissed
- Summary bar: counts per status
- Candidate cards: merchant, average amount, frequency, confidence badge, reason flagged, action buttons
- Action buttons: Essential (green), Leak (amber), Dismiss (gray)

---

## Acceptance criteria

- [ ] CSV files with debit/credit columns produce correct signed amounts
- [ ] Recurring patterns detected from monthly, quarterly, and annual charge history
- [ ] Candidates display with merchant name, average amount, frequency, confidence, reason
- [ ] Users can mark candidates as essential, leak, or dismissed
- [ ] Review decisions persist across page reloads
- [ ] Empty state shown when no recurring patterns detected
- [ ] All existing tests continue to pass
