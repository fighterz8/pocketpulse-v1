# Report 3: Recurring Leak Identifier

**Primary files:**  
- `client/src/pages/Leaks.tsx` — Review UI  
- `server/routes.ts` — `/api/recurring-candidates` endpoint with `AUTO_ESSENTIAL_CATEGORIES`  
- `server/recurrenceDetector.ts` — Detection engine (shared with Recurring Expenses)  
- `server/dashboardQueries.ts` — Dashboard "expenseLeaks" summary  
- `shared/schema.ts` — `recurringReviews` table

---

## Purpose

The recurring leak identifier answers: **"Which of this user's recurring charges are discretionary — things they chose to subscribe to and might want to cancel?"**

This powers:
- The **"Subscription Leaks"** page (`/leaks`)
- The **"Subscription Review"** card on the Dashboard
- The pulsing amber dot on the sidebar nav item

---

## Definition of a Leak (Current)

> A **leak** = a discretionary recurring charge the user may want to cancel.  
> Streaming services, forgotten SaaS subscriptions, unused gym memberships.

**Not a leak (auto-handled, never shown in review):**
- `housing` — mortgage, rent
- `utilities` — electric, water, internet, phone bills
- `insurance` — auto, health, home
- `medical` — prescriptions, recurring health services
- `debt` — loan payments, credit card minimums

These 5 categories are defined in:
- `AUTO_ESSENTIAL_CATEGORIES` in `server/routes.ts` (server-side, controls `autoEssential` flag)
- `AUTO_HIDDEN_CATEGORIES` in `client/src/pages/Leaks.tsx` (client-side filter)
- `SIDEBAR_HIDDEN_CATEGORIES` in `client/src/components/layout/AppLayout.tsx` (sidebar dot logic)

**All three must stay in sync manually** — there is no shared constant.

---

## Data Flow

```
listAllTransactionsForExport()
         ↓
detectRecurringCandidates()          ← same engine as Recurring Expenses
         ↓
RecurringCandidate[]
         ↓
listRecurringReviewsForUser()        ← reads recurringReviews table
         ↓
Merge: candidate + review status
  autoEssential = AUTO_ESSENTIAL_CATEGORIES.has(category) && !review
  reviewStatus  = review?.status ?? (autoEssential ? "essential" : "unreviewed")
         ↓
GET /api/recurring-candidates → { candidates: MergedCandidate[], summary }
         ↓
Leaks.tsx filters:
  - Last 6 months only (firstSeen >= 6-month cutoff)
  - Hides AUTO_HIDDEN_CATEGORIES entirely
  - Tab filter: "All" | "Needs Review" | "Confirmed Leaks" | "Essential"
```

---

## The `recurringReviews` Table

```
recurring_reviews
  id           serial PK
  userId       integer FK
  candidateKey text (e.g. "netflix|15.49")
  status       text  ["unreviewed", "essential", "leak", "dismissed"]
  notes        text
  reviewedAt   timestamp
  createdAt    timestamp

UNIQUE INDEX on (userId, candidateKey)
```

Review statuses:
- `unreviewed` — default for new candidates
- `essential` — user confirmed it's a necessary expense
- `leak` — user confirmed it's wasteful / wants to cancel
- `dismissed` — user dismissed it (not a concern right now)

`PATCH /api/recurring-reviews/:candidateKey` — upserts a review record. Uses `decodeURIComponent` on the key because candidate keys contain `|` (e.g. `netflix|15.49`).

---

## Auto-Essential Logic

On the server, when a candidate has no review record AND its category is in `AUTO_ESSENTIAL_CATEGORIES`:

```typescript
const autoEssential = AUTO_ESSENTIAL_CATEGORIES.has(c.category) && !review;
reviewStatus = autoEssential ? "essential" : "unreviewed";
```

This means essential-category candidates appear in the API response with `reviewStatus: "essential"` and `autoEssential: true` even without a DB row in `recurringReviews`.

On the client, `AUTO_HIDDEN_CATEGORIES` completely filters these out of the display — they never appear as cards. The footer note tells the user how many were auto-handled.

---

## 6-Month Time Window

The Leaks page applies a client-side filter: only show candidates where `firstSeen >= sixMonthsAgo`:

```typescript
const sixMonthsAgo = new Date();
sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
const SIX_MONTHS_AGO = sixMonthsAgo.toISOString().slice(0, 10);

const displayed = filtered.filter((c) => c.firstSeen >= SIX_MONTHS_AGO);
```

**Rationale:** Candidates last seen more than 6 months ago are likely cancelled services. Showing them as "needs review" when they're no longer active would create false urgency.

---

## Dashboard Integration

### "Subscription Review" Card
Reads from `summary.expenseLeaks` in the dashboard API:

```typescript
// dashboardQueries.ts
const leakResult = await db
  .select({ count: count() })
  .from(recurringReviews)
  .where(and(
    eq(recurringReviews.userId, userId),
    eq(recurringReviews.status, "leak")
  ));
```

Count of rows where `status = "leak"`. This is the confirmed leak count — only increments when the user manually marks something as a leak.

`leakMonthlyAmount` on the dashboard is a rough proxy:
```typescript
const leakMonthlyAmount = recurringExpenses > 0
  ? Math.round((recurringExpenses / months) * 100) / 100
  : 0;
```

This is `recurringExpenses ÷ months` — not specific to confirmed leaks. It's the average monthly recurring outflow, which is **not the same thing** as the monthly cost of confirmed leaks. This conflation is a bug.

### Sidebar Dot
`RecurringNavItem` in `AppLayout.tsx`:

```typescript
const SIDEBAR_HIDDEN_CATEGORIES = new Set([
  "housing", "utilities", "insurance", "medical", "debt",
]);

// Fetch /api/recurring-candidates
// Filter to last 6 months, exclude SIDEBAR_HIDDEN_CATEGORIES
// Count where reviewStatus === "unreviewed"
// Dot shows when unreviewedCount > 0
```

Dot pulses when there are unreviewed discretionary recurring candidates in the last 6 months.

---

## What the Leaks Page Shows vs What It Doesn't

### Shown (after filtering):
- Active or recently-seen discretionary recurring charges
- Categories: `entertainment`, `software`, `fitness`, `dining`, `delivery`, `shopping`, `auto`, `gas`, `groceries`, `coffee`, `other`, `fees`, `travel`
- Each card shows: merchant name, frequency, average amount, monthly equivalent, confidence, first/last seen, expected next date, action buttons

### Not shown (auto-hidden):
- `housing` — mortgage, rent ✓ correctly hidden
- `utilities` — electric, internet, phone ✓ correctly hidden
- `insurance` ✓ correctly hidden
- `medical` ✓ correctly hidden
- `debt` ✓ correctly hidden

### Possibly shown incorrectly:
- A restaurant that the user visits every Friday (weekly) could appear as a "leak" — it's detected as recurring dining but is arguably just a habit, not a wasteful subscription
- Grocery store charges won't appear (need ≥3 occurrences at similar amounts — variable groceries don't cluster)
- Amazon charges: may appear if the user has a consistent monthly purchase pattern

---

## Key Disconnect: Leaks ≠ Recurring Expenses

This is the root of the architectural confusion:

| Feature | Data Source | What it measures |
|---|---|---|
| Subscription Leaks page | `detectRecurringCandidates()` + `recurringReviews` table | Candidates for user review |
| Recurring Expenses card | `transactions.recurrenceType` (set by sync) | Transactions tagged recurring |
| Dashboard leak count | `recurringReviews WHERE status = 'leak'` | User-confirmed leaks |
| Dashboard leak amount | `recurringExpenses / months` | Wrong — uses all recurring, not just leaks |

**The systems share the detection engine but diverge immediately after:**

- The Leaks page reads candidates in real-time, overlays DB reviews, and presents a review UI.
- The Recurring Expenses dashboard reads tagged transactions from the DB (requires sync to have run).
- The dashboard leak count correctly reads confirmed leaks from `recurringReviews`.
- The dashboard leak amount is miscalculated — it proxies all recurring expenses, not just confirmed leaks.

---

## Known Structural Weaknesses

### 1. Three-way sync problem
`AUTO_ESSENTIAL_CATEGORIES` (server) and `AUTO_HIDDEN_CATEGORIES` (client, Leaks page) and `SIDEBAR_HIDDEN_CATEGORIES` (client, layout) must always match. They're defined as separate constants in separate files. A bug here (one set having 4 entries while others have 5) causes categories to be hidden in one place and visible in another.

**Fix:** Move the constant to `shared/schema.ts` and import everywhere.

### 2. `candidateKey` is amount-dependent
The key format is `"merchantKey|avgAmount.toFixed(2)"`. If the average amount changes (e.g. price increase from $9.99 → $15.49), the key changes. The old review record is orphaned; the new candidate appears as unreviewed.

**Fix:** Use `merchantKey` alone as the review key. The amount is a detail, not an identity.

### 3. No leak cost on dashboard
The dashboard shows "N confirmed leaks" but the monthly dollar amount shown is `recurringExpenses / months`, not the sum of confirmed leak monthly equivalents. A user with $5,000/month in rent (tagged recurring essential) and $30/month in Netflix (tagged leak) would see "$5,030/month" as their leak amount — completely wrong.

**Fix:** Calculate `leakMonthlyAmount` by summing `monthlyEquivalent` from candidates where `reviewStatus = "leak"`.

### 4. Leaks page shows recurring patterns that aren't "leaks"
A recurring habit (every-Friday restaurant, weekly gas station fill-up) is detected as a recurring candidate and shown on the Leaks page. These aren't subscriptions the user forgot about — they're intentional spending patterns.

**Fix:** Add a `subscriptionLikelihood` signal. True subscription leaks tend to have: exact same amount every month, a software/entertainment/fitness category, a merchant with known subscription patterns. Dining, gas, and groceries recurring should either be filtered out or shown in a separate "Habits" section.

### 5. No cancellation guidance
The Leaks page shows that a charge is a potential waste but provides no help with cancellation. A user who marks Netflix as a "leak" needs to know how to cancel it.

**Fix:** Add a `cancelUrl` field to the known-subscription merchant database. Show a "How to cancel →" link on the card.

### 6. Category override categories are always hidden
`housing` uses the `__housing_bucket` key strategy in the detector. This means the mortgage candidate key is `__housing_3400|3469.00`, not `lakeview loan servicing|3469.00`. The `category` field on the candidate is correctly `"housing"`, so it correctly falls into `AUTO_HIDDEN_CATEGORIES` and is hidden from the Leaks page. This part is working correctly.

**But** — if the user's housing transaction is categorized as `other` (e.g. the mortgage description didn't match any housing keyword), it uses the merchant key strategy, gets a non-housing category, and could appear on the Leaks page incorrectly.

---

## Proposed Overhaul Options

### Option A — Shared Constant for Auto-Hidden Categories
Move the essential categories set to `shared/schema.ts`:
```typescript
export const AUTO_ESSENTIAL_CATEGORIES = new Set([
  "housing", "utilities", "insurance", "medical", "debt",
] as const);
```
Import in `routes.ts`, `Leaks.tsx`, and `AppLayout.tsx`. Eliminates the three-way sync bug.

### Option B — Fix the Leak Amount Calculation
In `dashboardQueries.ts`, change `leakMonthlyAmount` to actually sum confirmed leak monthly equivalents:
```sql
SELECT SUM(monthly_equivalent) FROM recurring_candidates 
  JOIN recurring_reviews USING (candidate_key)
  WHERE recurring_reviews.status = 'leak'
  AND recurring_reviews.user_id = $userId
```
Requires persisting candidates (from Report 2, Option B).

### Option C — Add Subscription Signal to Candidates
In `recurrenceDetector.ts`, add a `isSubscriptionLike` boolean:
- `true` if category is `entertainment`, `software`, or `fitness` — OR if exact same amount every time (amountStdDev < $1)
- `false` if category is `dining`, `gas`, `groceries` with variable amounts

Filter the Leaks page to only show subscription-like candidates. Move habit patterns to a separate "Spending Habits" section on the dashboard.

### Option D — Merchant Review Key Redesign
Change `candidateKey` format from `"merchantKey|amount"` to just `"merchantKey"`. Detect price changes as a note on the card ("Price changed from $9.99 to $15.49") rather than creating a new candidate.

### Option E — Known Subscription Database
Maintain a list of ~200 known subscription services (Netflix, Spotify, Hulu, Adobe, OpenAI, etc.) with:
- `cancelUrl`: the exact URL to cancel
- `isTrial`: flag for services that offer free trials that auto-convert
- `isAnnual`: flag for annual-billing services the user might forget about

When a candidate matches a known subscription merchant, enrich the card with this metadata.

### Recommended Path
**Immediate:** Option A (shared constant), Option B (fix leak amount).  
**Medium term:** Option C (subscription signal) + Option D (review key redesign).  
**Long term:** Option E (known subscription database with cancellation links).
