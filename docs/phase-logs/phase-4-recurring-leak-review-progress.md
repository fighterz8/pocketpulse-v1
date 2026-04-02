# Phase 4 -- branch progress log

**Branch:** `feature/phase-4-recurring-leak-review`

**Last updated:** 2026-04-02

## Phase 4 implementation scope: **in progress**

Phase 4 fixes the CSV parser sign bug and delivers recurring transaction detection with a review interface for marking patterns as essential, leak-related, or dismissed.

---

## Task tracking

| Task | Status | Summary |
|------|--------|---------|
| **1** -- Branch setup + design spec | done | Created branch, design spec, progress log |
| **2** -- CSV parser sign bug fix | pending | Prefer debit/credit over unsigned Amount column |
| **3** -- recurring_reviews schema | pending | Add table with uniqueIndex on (userId, candidateKey) |
| **4** -- Recurrence detector engine | pending | Grouping, frequency detection, confidence scoring |
| **5** -- Storage functions | pending | Atomic upsert via onConflictDoUpdate |
| **6** -- API routes | pending | Candidate listing, review upsert, review listing |
| **7** -- Leaks page UI | pending | Card-based review with filter tabs and summary |
| **8** -- Tests + documentation | pending | Client tests, progress log, README, full suite |

---

## Requirement traceability

| Requirement | Implementation |
|-------------|---------------|
| RL-01 (detect recurring charges) | recurrenceDetector.ts detection pipeline |
| RL-01.1 (merchant/frequency/average factors) | Merchant grouping, median interval, amount bucketing |
| RL-02 (display in review interface) | Leaks.tsx card-based UI |
| RL-02.1 (required details) | Card shows merchant, avg amount, frequency, last seen, reason |
| RL-03 (mark as essential) | Essential action button + PATCH review endpoint |
| RL-04 (mark as leak) | Leak action button + PATCH review endpoint |
| RL-05 (dismiss) | Dismiss action button + PATCH review endpoint |
| RL-06 (store review results) | recurring_reviews table + atomic upsert |

---

## Files changed

_(updated as tasks complete)_
