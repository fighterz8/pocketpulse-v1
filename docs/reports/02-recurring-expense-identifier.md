# Report 2: Recurring Expense Identifier

**Primary file:** `server/recurrenceDetector.ts` (456 lines)  
**Integration:** `POST /api/recurring-candidates/sync` in `server/routes.ts`  
**Dashboard query:** `server/dashboardQueries.ts` (`recurringExpenses` field)

---

## Purpose

The recurring expense identifier answers: **"Which of this user's outflow transactions represent a predictable, repeating financial commitment?"**

This powers:
- The **"Recurring Expenses"** card on the Dashboard (currently showing $474.57)
- The basis for **safe-to-spend** calculations
- The **"Sync to Dashboard"** button on the Leaks page

---

## Architecture Overview

The system has two separate stages that must both run for the dashboard to reflect reality:

```
Stage 1: DETECTION (in-memory, on-demand)
  listAllTransactionsForExport()
         ↓
  detectRecurringCandidates()   ←── recurrenceDetector.ts
         ↓
  RecurringCandidate[]          (not persisted — computed fresh each request)

Stage 2: SYNC (writes to DB, user-triggered)
  POST /api/recurring-candidates/sync
         ↓
  Run detectRecurringCandidates() again
         ↓
  UPDATE transactions SET recurrence_type = 'one-time'  (all outflows, reset)
         ↓
  UPDATE transactions SET recurrence_type = 'recurring' (detected IDs only)
         ↓
  transactions.recurrenceType field is now populated

Stage 3: DASHBOARD QUERY
  buildDashboardSummary() reads SUM(amount) WHERE recurrenceType = 'recurring'
  for the selected month window
```

**Critical issue:** Stage 2 is manual (button click). If the user never clicks "Sync to Dashboard", `recurringExpenses` stays at whatever was persisted at upload time (which is based on the classifier's keyword hints, not the detector). The $474.57 number is based on transactions that were keyword-tagged recurring at upload (Spotify, Netflix, etc.) — NOT on the detector's comprehensive analysis.

---

## Detection Algorithm (Stage 1)

### Step 1 — Transaction Filtering

Only processes:
- `flowType === "outflow"` (spending only)
- `excludedFromAnalysis === false`
- `date >= lookbackCutoff()` (last 18 months — `LOOKBACK_DAYS = 548`)

Inflows are never considered for recurring expense detection.

### Step 2 — Grouping

Transactions are grouped by a normalized key. Two different strategies:

**Strategy A — Category override (housing):**
```
CATEGORY_KEY_OVERRIDES = { "housing" }

key = `__housing_${roundToNearest200(abs(amount))}`
```
This groups all housing transactions (mortgage, rent) by amount bucket regardless of merchant name. A $3,469 mortgage payment on different bank descriptions ("Payment To Lakeview Loan Servicing" vs "- Lakeview Ln Srv Mtg Pymt") both land in `__housing_3400` bucket and are treated as the same recurring charge.

**Strategy B — Merchant key (everything else):**
`recurrenceKey(merchant)` normalizes the merchant name through:
1. Strip leading non-alphanumeric junk (`-`, `–`, `*`)
2. Strip debit card prefix (`-dc NNNN`)
3. Strip POS prefixes (`SQ *`, `TST *`, `POS `)
4. Strip `"Payment To "` prefix
5. Strip trailing URL noise (`.com`, `httpsopenai.c ca null`)
6. Strip trailing account numbers
7. Apply brand aliases (e.g. `chatgpt` or `openai` → `openai`)

**Known gap:** If two merchants produce the same key by coincidence (e.g. "AT&T Wireless" and "AT&T DirecTV" both normalize to `at&t`), they are grouped together and treated as one recurring charge — incorrectly inflating the amount.

### Step 3 — Amount Bucketing

Within each merchant group, transactions are further split into "amount buckets." Each bucket uses a floating centroid with 30% tolerance (floor: $3):

```
AMOUNT_TOLERANCE_PERCENT = 0.30
AMOUNT_TOLERANCE_FLOOR   = 3.0
```

A $50 charge and a $52 charge (4% difference) → same bucket.
A $50 charge and a $75 charge (50% difference) → different buckets.

**Categories with variable amounts** (`utilities`, `insurance`, `medical`, `housing`) use 30% tolerance but get a more lenient amount consistency score (×2.0 coefficient vs ×3.33 for fixed-amount subscriptions).

### Step 4 — Frequency Detection

For each amount bucket with ≥2 transactions, computes intervals between consecutive transaction dates:

```
intervals = [daysBetween(t[0], t[1]), daysBetween(t[1], t[2]), ...]
medianInterval = median(intervals)
```

Matches median against frequency definitions (±tolerance):

| Frequency | Expected days | Tolerance |
|---|---|---|
| weekly | 7 | ±2 days |
| biweekly | 14 | ±3 days |
| monthly | 30.4 | ±6 days |
| quarterly | 91.3 | ±18 days |
| annual | 365 | ±30 days |

Returns `null` (not recurring) if no frequency matches.

**Minimum transactions required:**
- weekly, biweekly, monthly: **3** occurrences
- quarterly: **2** occurrences
- annual: **2** occurrences (with additional rule: must span ≥300 days)

### Step 5 — Confidence Scoring

Four weighted signals:

| Signal | Weight | How computed |
|---|---|---|
| `count` | 0.20 | `min(1.0, (n - 2) / 4)` — plateaus at 6 occurrences |
| `interval` | 0.35 | `max(0, 1 - (stdDev/medianInterval) * 2)` — coefficient of variation |
| `amount` | 0.25 | `max(0, 1 - amtCv * coeff)` — coeff is 2.0 for variable cats, 3.33 for fixed |
| `recency` | 0.20 | Linear decay from 1.0 (≤1.5× interval ago) to 0.0 (≥3.5× interval ago) |

`CONFIDENCE_THRESHOLD = 0.30` — anything below this is discarded.

Additional filter: if `recencyScore === 0` AND `confidence < 0.5` → suppressed (stale cancelled subscription).

### Step 6 — isActive and expectedNextDate

```
isActive = daysBetween(lastCharge, today) <= medianInterval * 2
expectedNextDate = lastCharge + medianInterval days
daysSinceExpected = daysBetween(expectedNextDate, today)
```

### Step 7 — Monthly Normalization

```
MONTHLY_FACTOR = {
  weekly:    4.333,
  biweekly:  2.167,
  monthly:   1,
  quarterly: 1/3,
  annual:    1/12
}

monthlyEquivalent = avgAmount × MONTHLY_FACTOR[frequency]
```

### Step 8 — Sort Order

Candidates sorted: active first, then by `monthlyEquivalent` descending.

---

## Sync Endpoint (Stage 2)

`POST /api/recurring-candidates/sync`

1. Runs `detectRecurringCandidates()` fresh.
2. Collects all `transactionIds` from all candidates.
3. **Resets ALL outflow transactions for the user to `recurrenceType = "one-time"`** (full table reset).
4. Marks detected IDs as `recurrenceType = "recurring"`.
5. Returns `{ recurringCount, oneTimeCount }`.

**Critical flaw: Sync is destructive and user-triggered.**

- If the user never clicks "Sync to Dashboard", the dashboard uses whatever recurrence tags were written at upload time (keyword-only, no frequency analysis).
- After sync, ALL outflow transactions are reclassified. If the user added custom recurrence tags manually, they are wiped.
- The sync resets to "one-time" even income transactions — actually, the WHERE clause filters `flowType = "outflow"` so income is safe, but the comment in code isn't clear about this.

---

## Dashboard Query (Stage 3)

`buildDashboardSummary()` in `dashboardQueries.ts`:

```sql
recurringExpenses = SUM(
  CASE WHEN flowType = 'outflow' AND recurrenceType = 'recurring'
  THEN ABS(amount) ELSE 0 END
)
```

This sums ALL transactions in the selected date window that have `recurrenceType = "recurring"` on the `transactions` table.

**Why the Recurring Expenses card shows $474.57 instead of ~$3,469:**

The selected month window is one calendar month. The mortgage payment ($3,469) only appears once per month. After sync, it should be tagged recurring. But:

1. If sync has never been run → only keyword-tagged items count. The Lakeview mortgage keyword exists in `classifier.ts` ("lakeview loan", "lakeview ln") but the bank description format may not match.
2. If sync has been run → the mortgage IS detected as recurring (via `__housing_3400` bucket) and all 12 instances are tagged. The monthly sum WOULD include it.
3. The $474.57 suggests sync has not been run since the housing detection was added, or the mortgage description doesn't match the classifier keywords.

**Verification needed:** Run sync and check if the card updates to ~$3,469 + $474.57.

---

## What the Recurring Expenses Card Actually Measures

The card sums `recurrenceType = "recurring"` outflows for the selected month. This means:
- It's a **transaction-level tag**, not a detector-level calculation
- It's **point-in-time** — it reflects whatever was tagged when sync last ran
- It's **not normalized** — if a quarterly charge happens to fall in the selected month, it counts full. If it doesn't, it counts zero. The monthly equivalent from the detector is not used here.

**This is a significant accuracy problem for the "Baseline costs" interpretation.** A month where the annual car insurance payment drops will look like a $1,200 spike in recurring expenses even though the monthly equivalent is $100.

---

## Known Structural Weaknesses

1. **Sync is manual.** The biggest single issue. Users will never intuitively find the "Sync to Dashboard" button on the Leaks page.

2. **Amount bucketing is greedy.** The first bucket encountered is used. If a $50 charge appears before a $100 charge, the $50 becomes the centroid. A later $70 charge (40% from $50 → different bucket, 30% from $100 → same bucket) causes non-deterministic grouping depending on order.

3. **18-month lookback is fixed.** New users with only 2 months of data won't have enough occurrences for most monthly charges to reach the minimum 3. The detector needs a minimum-count fallback for short data windows.

4. **Monthly normalization isn't used in the dashboard.** The detector computes `monthlyEquivalent` for each candidate, but the dashboard query ignores it — it sums raw transaction amounts. An annual charge counted in the month it hits is not smoothed.

5. **No persistence of detector results.** Every call to `GET /api/recurring-candidates` re-runs the full detection algorithm across all transactions. With 1,000+ transactions, this is O(n log n) in memory on the server. There's no caching or persistent candidate store.

6. **Housing-only category override.** Only `housing` uses the category-key grouping strategy. Utilities (electric, water, phone) could vary in merchant description formatting too and benefit from this.

---

## Proposed Overhaul Options

### Option A — Auto-sync on Upload (immediate fix)
Trigger sync automatically whenever new transactions are uploaded. The upload route already invalidates all React Query caches — add sync call before or after insertion.

**Benefit:** Removes the manual button entirely.  
**Risk:** Adds ~200ms to upload time. Acceptable.

### Option B — Replace Dashboard Query with Detector Output
Instead of summing `transactions.recurrenceType`, store detector candidates in the DB (`recurring_candidates` table with `candidateKey`, `monthlyEquivalent`, `lastSeen`, `isActive`). The dashboard reads from this table and sums `monthlyEquivalent` for active candidates.

**Benefit:** Correct monthly normalization. No more "quarterly charge spikes."  
**Benefit:** Annual charges get smoothed to 1/12 per month.  
**Risk:** Adds schema migration and a new storage layer.

### Option C — Candidate Persistence + Incremental Updates
Persist candidates with a `detectedAt` timestamp. Re-run detection only on newly uploaded transactions (incremental). Merge into existing candidates. This scales to large datasets without full re-scan.

### Recommended Path
**Immediate:** Option A (auto-sync on upload). This fixes the $474.57 bug.  
**Medium term:** Option B (normalize recurring expenses to monthly equivalent). This makes "Recurring Expenses" a true monthly baseline regardless of when charges land.
